// -*- coding: utf-8 -*-
/**
 * inspection.ts
 * Independent Chromium semantic inspection
 * =====================
 * Read bounded CDP accessibility and viewport geometry while preserving Playwright ARIA references.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { BrowserError, snapshotSchema, validateOutput } from '@abr/contracts';
import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import type { BrowserContext, CDPSession, Page } from 'playwright';

interface InspectionNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored: boolean;
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}
interface ViewportMetrics {
  dpr: number;
  zoom: number;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  visualScale: number;
  visualOffsetX: number;
  visualOffsetY: number;
}
interface ProtocolMetrics {
  cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssVisualViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    zoom?: number;
  };
  visualViewport: { clientWidth: number; clientHeight: number; scale: number };
}

/**
 * Bound a readonly browser operation by the complete inspection deadline.
 * Args:
 *   operation (Promise<T>): Already started readonly protocol operation.
 *   deadline (number): Absolute monotonic deadline in milliseconds.
 * Returns:
 *   Promise<T>: Operation result received before the complete deadline.
 */
async function bounded<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A timed-out read remains independent from every input-dispatch path.
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BrowserError('TIMEOUT', 'Semantic inspection exceeded its deadline.')),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Derive viewport metadata from official browser CSS and physical layout measurements.
 * Args:
 *   value (ProtocolMetrics): Readonly Page.getLayoutMetrics response.
 * Returns:
 *   ViewportMetrics: Verified CSS viewport and actual physical-to-CSS pixel ratio.
 */
export function inspectionMetrics(value: ProtocolMetrics): ViewportMetrics {
  const visual = value.cssVisualViewport;
  const physical = value.visualViewport;
  const layout = value.cssLayoutViewport;
  // Pixel ratios require both actual browser measurements and matching independent axes.
  if (!visual || !physical || !layout || !visual.zoom)
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Readonly CSS layout metrics are unavailable.',
    );
  const ratioX = physical.clientWidth / visual.clientWidth;
  const ratioY = physical.clientHeight / visual.clientHeight;
  const metrics = {
    dpr: ratioX,
    zoom: visual.zoom,
    width: Math.min(visual.clientWidth, layout.clientWidth),
    height: Math.min(visual.clientHeight, layout.clientHeight),
    scrollX: layout.pageX,
    scrollY: layout.pageY,
    visualScale: visual.scale,
    visualOffsetX: visual.offsetX,
    visualOffsetY: visual.offsetY,
  };
  if (
    !Object.values(metrics).every(Number.isFinite) ||
    !Number.isFinite(ratioY) ||
    metrics.dpr <= 0 ||
    metrics.zoom <= 0 ||
    metrics.width <= 0 ||
    metrics.height <= 0 ||
    Math.abs(ratioX - ratioY) > 0.00001 ||
    physical.scale !== visual.scale ||
    metrics.visualScale !== 1 ||
    metrics.visualOffsetX !== 0 ||
    metrics.visualOffsetY !== 0
  )
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Readonly viewport pixel metrics are unverified.',
    );
  return metrics;
}

/**
 * Convert one verified axis-aligned DOM border quad into CSS viewport bounds.
 * Args:
 *   quad (number[]): CDP DOM.getBoxModel border quad in CSS viewport coordinates.
 * Returns:
 *   AxNode['bounds']: Exact enclosing axis-aligned rectangle.
 */
export function inspectionBounds(quad: number[]): NonNullable<AxNode['bounds']> {
  // Reject malformed and transformed quadrilaterals instead of inferring pointer ownership.
  if (quad.length !== 8 || quad.some((value) => !Number.isFinite(value)))
    throw new BrowserError('UNSUPPORTED_CAPABILITY', 'DOM inspection geometry is unavailable.');
  const [left, top, right, secondY, thirdX, bottom, fourthX, fourthY] = quad as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    Math.abs(top - secondY) > 0.01 ||
    Math.abs(right - thirdX) > 0.01 ||
    Math.abs(left - fourthX) > 0.01 ||
    Math.abs(bottom - fourthY) > 0.01 ||
    right < left ||
    bottom < top
  )
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Transformed DOM geometry requires a separately verified hit-test adapter.',
    );
  return { x: left, y: top, width: right - left, height: bottom - top, space: 'viewport-css' };
}

/**
 * Normalize browser AX roles without manufacturing accessible semantics.
 * Args:
 *   node (InspectionNode): Browser-reported accessibility node.
 * Returns:
 *   string: Portable role or the complete browser role for policy inspection.
 */
function inspectionRole(node: InspectionNode): string {
  const role = typeof node.role?.value === 'string' ? node.role.value : 'none';
  // Chromium uses internal names for documents and cached text fragments.
  if (role === 'RootWebArea' || role === 'WebArea') return 'document';
  if (role === 'StaticText' || role === 'InlineTextBox') return 'text';
  if (role === 'generic' || role === 'none') return 'group';
  return role;
}

/** IndependentInspection owns one readonly CDP channel and preserves caller ARIA state. */
export class IndependentInspection {
  private channel: CDPSession | undefined;
  private startup: Promise<CDPSession> | undefined;
  private generation = 0;
  private closed = false;

  /**
   * Bind a readonly inspector to one owned page and context.
   * Args:
   *   context (BrowserContext): Worker-owned official Chromium context.
   *   page (Page): Exact current page whose frame geometry is inspected.
   * Returns:
   *   IndependentInspection: An initially disconnected readonly inspector.
   */
  constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  /**
   * Open the official readonly AX domain while retaining stable CDP node identities.
   * Args:
   *   deadline (number): Absolute deadline for channel creation and domain activation.
   * Returns:
   *   Promise<CDPSession>: Owned channel independent of the injected ARIA reference map.
   */
  private async session(deadline: number): Promise<CDPSession> {
    if (this.closed)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Private inspection channel is closed.');
    if (this.channel) return this.channel;
    if (!this.startup) {
      const generation = this.generation;
      this.startup = this.context.newCDPSession(this.page).then(async (channel) => {
        try {
          // A late connection never survives replacement or closure of its originating inspector.
          if (this.closed || generation !== this.generation)
            throw new BrowserError('BROWSER_DISCONNECTED', 'Inspection startup was superseded.');
          await bounded(channel.send('Accessibility.enable'), deadline);
          if (this.closed || generation !== this.generation)
            throw new BrowserError('BROWSER_DISCONNECTED', 'Inspection startup was superseded.');
          this.channel = channel;
          return channel;
        } catch (error) {
          await channel.detach().catch(() => undefined);
          throw error;
        }
      });
    }
    try {
      return await bounded(this.startup, deadline);
    } catch (error) {
      this.generation += 1;
      this.startup = undefined;
      throw error;
    }
  }

  /**
   * Build a complete bounded single-frame semantic tree with real DOM layout rectangles.
   * Args:
   *   sessionId (string): Runtime-owned session identity.
   *   tabId (string): Existing worker tab identity without modifying its reference cache.
   * Returns:
   *   Promise<BrowserSnapshot>: Independent CSS inspection or an explicit unsupported result.
   */
  async read(sessionId: string, tabId: string): Promise<BrowserSnapshot> {
    const deadline = performance.now() + 8000;
    // Cross-frame transforms and visual zoom retain an explicit verification boundary.
    if (this.page.frames().length !== 1)
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Coordinate inspection requires verified single-frame CSS geometry.',
      );
    const url = this.page.url();
    const channel = await this.session(deadline);
    const metrics = inspectionMetrics(
      await bounded(channel.send('Page.getLayoutMetrics'), deadline),
    );
    const frameTree = await bounded(channel.send('Page.getFrameTree'), deadline);
    const frameId = frameTree.frameTree.frame.id;
    if (frameTree.frameTree.childFrames?.length || frameTree.frameTree.frame.url !== url)
      throw new BrowserError('TARGET_STALE', 'Page frame structure changed during inspection.');
    const raw = (await bounded(channel.send('Accessibility.getFullAXTree'), deadline))
      .nodes as InspectionNode[];
    if (!raw.length || raw.length > 5000)
      throw new BrowserError('DESKTOP_BUSY', 'Complete AX inspection exceeds its node quota.');
    const nodes = new Map<string, InspectionNode>();
    const converted = new Map<string, AxNode>();
    // Read complete browser nodes and retain stable backend identities without copying values.
    for (const node of raw) {
      if (!node.nodeId || nodes.has(node.nodeId))
        throw new BrowserError('TARGET_STALE', 'Browser AX inspection identities are incomplete.');
      nodes.set(node.nodeId, node);
      const states: string[] = [];
      for (const property of node.properties ?? []) {
        if (
          ['disabled', 'focused', 'checked', 'selected', 'expanded'].includes(property.name) &&
          property.value.value === true
        )
          states.push(property.name);
      }
      const result: AxNode = {
        nodeId: `cdp-${frameId}-${node.nodeId}`,
        role: inspectionRole(node),
        states,
        ...(typeof node.name?.value === 'string' ? { name: node.name.value.slice(0, 4096) } : {}),
      };
      if (node.backendDOMNodeId) {
        const description = await bounded(
          channel.send('DOM.describeNode', { backendNodeId: node.backendDOMNodeId }),
          deadline,
        );
        const attributes = new Map<string, string>();
        const pairs = description.node.attributes ?? [];
        // Read existing DOM sensitivity metadata by exact backend identity without retaining input values.
        for (let index = 0; index < pairs.length; index += 2)
          attributes.set(pairs[index]!.toLowerCase(), pairs[index + 1]!);
        const autocomplete = (attributes.get('autocomplete') ?? '').toLowerCase();
        if (
          attributes.has('data-sensitive') ||
          attributes.get('type')?.toLowerCase() === 'password' ||
          autocomplete
            .split(/[ \t\r\n\f\v]+/)
            .some(
              (token) =>
                token.startsWith('cc-') ||
                ['current-password', 'new-password', 'one-time-code'].includes(token),
            )
        )
          result.states.push('protected');
        // Box-model absence is accepted for non-layout fragments; stale DOM identities fail the whole read.
        try {
          const model = await bounded(
            channel.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId }),
            deadline,
          );
          result.bounds = inspectionBounds(model.model.border);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('Could not compute box model'))
            throw error;
          if (
            ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'spinbutton'].includes(
              result.role,
            )
          )
            throw new BrowserError(
              'UNSUPPORTED_CAPABILITY',
              'Interactive AX geometry is unavailable.',
            );
        }
      }
      converted.set(node.nodeId, result);
    }
    const roots = raw.filter((node) => !node.parentId || !nodes.has(node.parentId));
    if (roots.length !== 1 || inspectionRole(roots[0]!) !== 'document')
      throw new BrowserError('TARGET_STALE', 'Complete AX inspection root is ambiguous.');
    const seen = new Set<string>();
    /**
     * Assemble actual browser child relationships without admitting partial or cyclic subtrees.
     * Args:
     *   identifier (string): Browser-provided AX node identifier.
     *   depth (number): Current complete-tree depth.
     * Returns:
     *   AxNode: Bounded complete semantic subtree.
     */
    const assemble = (identifier: string, depth: number): AxNode => {
      if (depth > 32 || seen.has(identifier) || !converted.has(identifier))
        throw new BrowserError('TARGET_STALE', 'Complete AX inspection structure is unavailable.');
      seen.add(identifier);
      const result = converted.get(identifier)!;
      const children: AxNode[] = [];
      for (const child of nodes.get(identifier)!.childIds ?? [])
        children.push(assemble(child, depth + 1));
      if (children.length) result.children = children;
      return result;
    };
    const root = assemble(roots[0]!.nodeId, 0);
    if (seen.size !== raw.length)
      throw new BrowserError(
        'TARGET_STALE',
        'Browser AX inspection omitted an unreachable branch.',
      );
    /**
     * Remove complete protected subtrees before clipping their visible CSS bounds.
     * Args:
     *   node (AxNode): Private complete browser AX subtree.
     * Returns:
     *   void: Completion of privacy filtering and visible viewport clipping.
     */
    const protect = (node: AxNode): void => {
      const name = node.name ?? '';
      const fieldOrLabel = [
        'textbox',
        'combobox',
        'spinbutton',
        'checkbox',
        'radio',
        'switch',
        'text',
        'label',
      ].includes(node.role);
      if (
        fieldOrLabel &&
        !node.states.includes('protected') &&
        /(?:^|[^A-Za-z0-9_])card(?:$|[^A-Za-z0-9_])/i.test(name)
      )
        node.states.push('protected');
      if (node.states.includes('protected')) {
        node.name = 'Protected input';
        node.children = [];
      }
      // CSS pointer authorization uses only the visible viewport intersection of actual quads.
      if (node.bounds) {
        const bounds = node.bounds;
        const right = Math.min(metrics.width, bounds.x + bounds.width);
        const bottom = Math.min(metrics.height, bounds.y + bounds.height);
        bounds.x = Math.max(0, bounds.x);
        bounds.y = Math.max(0, bounds.y);
        bounds.width = Math.max(0, right - bounds.x);
        bounds.height = Math.max(0, bottom - bounds.y);
      }
      for (const child of node.children ?? []) protect(child);
    };
    protect(root);
    const title = root.name ?? '';
    const finalMetrics = inspectionMetrics(
      await bounded(channel.send('Page.getLayoutMetrics'), deadline),
    );
    const finalFrame = await bounded(channel.send('Page.getFrameTree'), deadline);
    if (
      this.page.url() !== url ||
      this.page.frames().length !== 1 ||
      finalFrame.frameTree.frame.id !== frameId ||
      finalFrame.frameTree.frame.url !== url ||
      finalFrame.frameTree.childFrames?.length ||
      JSON.stringify(metrics) !== JSON.stringify(finalMetrics)
    )
      throw new BrowserError(
        'TARGET_STALE',
        'Browser viewport changed during semantic inspection.',
      );
    const snapshot: BrowserSnapshot = {
      sessionId,
      snapshotId: randomUUID(),
      timestamp: new Date().toISOString(),
      windowId: `pw-window-${sessionId}`,
      tabId,
      root,
      scale: { dpr: metrics.dpr, zoom: metrics.zoom },
      source: 'playwright-accessibility',
      url,
      tabs: [{ id: tabId, title, url, active: true }],
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 3 * 1024 * 1024)
      throw new BrowserError('DESKTOP_BUSY', 'Complete inspection exceeds its private IPC quota.');
    validateOutput(snapshotSchema, snapshot);
    return snapshot;
  }

  /**
   * Release the owned readonly CDP channel before context or page replacement.
   * Args:
   *   None: The inspector owns its currently attached channel.
   * Returns:
   *   Promise<void>: Completion of private channel release.
   */
  async close(): Promise<void> {
    const channel = this.channel;
    this.channel = undefined;
    this.startup = undefined;
    this.generation += 1;
    this.closed = true;
    if (channel) await channel.detach().catch(() => undefined);
  }
}
