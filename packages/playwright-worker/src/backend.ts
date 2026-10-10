// -*- coding: utf-8 -*-
/**
 * backend.ts
 * Official Playwright browser execution
 * =====================
 * Execute compatible browser operations within an isolated worker process.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ArtifactStore } from '@abr/artifacts';
import type { RedactionRectangle } from '@abr/artifacts';
import { BrowserError, CAPABILITIES, parseAction, parseSession } from '@abr/contracts';
import type {
  ActionResult,
  AxNode,
  BrowserSession,
  BrowserSnapshot,
  Capability,
  CapabilityReport,
  Target,
} from '@abr/contracts';
import { chromium } from 'playwright';
import type { BrowserContext, Locator, Page } from 'playwright';

interface RawNode {
  role?: string;
  name?: string;
  text?: string;
  ref?: string;
  children?: (RawNode | string)[];
  box?: { x: number; y: number; width: number; height: number };
  checked?: boolean | string;
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
}
interface PageState {
  session: BrowserSession;
  context: BrowserContext;
  page: Page;
  paused: boolean;
  snapshotId: string;
  nodes: Map<string, { ref?: string; box?: RawNode['box'] }>;
  tabs: Map<string, Page>;
  cancellation?: AbortController;
}
export interface WorkerConfiguration {
  profileRoot: string;
  artifactRoot: string;
  executablePath?: string;
}
const SUPPORTED: Capability[] = [
  'observe.ax',
  'observe.screenshot',
  'input.pointer',
  'input.keyboard',
  'browser.navigate',
  'browser.tabs',
  'browser.fileDialog',
];

/** PlaywrightBackend owns official browser contexts within one supervised worker. */
export class PlaywrightBackend {
  private readonly sessions = new Map<string, PageState>();
  readonly artifacts: ArtifactStore;

  /**
   * Initialize worker-owned browser and filtered screenshot storage.
   * Args:
   *   configuration (WorkerConfiguration): Trusted local directories and optional browser executable.
   * Returns:
   *   PlaywrightBackend: Initialized browser backend.
   */
  constructor(readonly configuration: WorkerConfiguration) {
    this.artifacts = new ArtifactStore({ root: configuration.artifactRoot, ttlMs: 60000 });
  }

  /**
   * Retrieve an active worker-owned browser session.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   PageState: Owned browser and reference state.
   */
  private state(id: string): PageState {
    const state = this.sessions.get(id);
    if (!state) throw new BrowserError('SESSION_NOT_FOUND', 'Browser session does not exist.');
    if (state.page.isClosed())
      throw new BrowserError('BROWSER_DISCONNECTED', 'Browser page is closed.');
    return state;
  }

  /**
   * Start an official Playwright persistent context using an allocated profile.
   * Args:
   *   value (unknown): Authorized and prepared session configuration.
   * Returns:
   *   Promise<BrowserSession>: Actual browser version and session metadata.
   */
  async create(value: unknown): Promise<BrowserSession> {
    const input = parseSession(value);
    // Require the compatible engine and a policy-allocated single profile segment.
    if (
      input.engine !== 'compatible' ||
      !input.profile.name ||
      !/^[a-zA-Z0-9_-]+$/.test(input.profile.name)
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Worker profile configuration is invalid.');
    if (input.browser === 'custom-chromium' && !this.configuration.executablePath)
      throw new BrowserError('INVALID_ARGUMENT', 'Custom browser executable is not configured.');
    const context = await chromium.launchPersistentContext(
      path.join(this.configuration.profileRoot, input.profile.name),
      {
        headless: input.headless ?? false,
        viewport: null,
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.browser === 'installed-chrome' ? { channel: 'chrome' } : {}),
        ...(input.browser === 'custom-chromium'
          ? { executablePath: this.configuration.executablePath! }
          : {}),
      },
    );
    // Bound browser operations and close contexts that fail metadata initialization.
    try {
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(10000);
      const page = context.pages()[0] ?? (await context.newPage());
      const id = randomUUID();
      const session: BrowserSession = {
        id,
        engine: 'compatible',
        status: 'ready',
        browserVersion: context.browser()?.version() ?? 'unavailable',
        playwrightVersion: '1.64.0',
        platform: `${process.platform}-${process.arch}`,
        capabilities: [...SUPPORTED],
        createdAt: new Date().toISOString(),
        profileId: input.profile.name,
      };
      this.sessions.set(id, {
        session,
        context,
        page,
        paused: false,
        snapshotId: randomUUID(),
        nodes: new Map(),
        tabs: new Map([['tab-1', page]]),
      });
      return session;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  /**
   * Return a complete capability report for the official worker.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   CapabilityReport: Supported operations and explicit unavailable reasons.
   */
  capabilities(id: string): CapabilityReport {
    this.state(id);
    const unsupported: CapabilityReport['unsupported'] = {};
    // Report every known capability not provided by this compatible tool adapter.
    for (const capability of CAPABILITIES)
      if (!SUPPORTED.includes(capability))
        unsupported[capability] = 'UNAVAILABLE_IN_COMPATIBLE_TOOL_ADAPTER';
    return { supported: [...SUPPORTED], unsupported };
  }

  /**
   * Read the current URL directly from the official browser connection.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   string: Current browser URL.
   */
  currentUrl(id: string): string {
    return this.state(id).page.url();
  }

  /**
   * Convert the official AI accessibility snapshot to the shared node model.
   * Args:
   *   raw (RawNode | string): Node returned by Playwright.
   *   state (PageState): Session reference map.
   *   nodeId (string): Snapshot-local path identifier.
   * Returns:
   *   AxNode: Standardized node with source references and CSS bounds.
   */
  private node(raw: RawNode | string, state: PageState, nodeId: string): AxNode {
    // Text fragments receive stable identifiers within this one snapshot.
    if (typeof raw === 'string')
      return { nodeId, role: 'text', name: raw.slice(0, 4096), states: [] };
    const result: AxNode = {
      nodeId,
      role: raw.role ?? 'text',
      states: [],
      ...(raw.name !== undefined || raw.text !== undefined
        ? { name: (raw.name ?? raw.text ?? '').slice(0, 4096) }
        : {}),
    };
    if (raw.disabled) result.states.push('disabled');
    if (raw.checked) result.states.push('checked');
    if (raw.expanded) result.states.push('expanded');
    if (raw.active) result.states.push('focused');
    if (raw.box) result.bounds = { ...raw.box, space: 'viewport-css' };
    state.nodes.set(nodeId, {
      ...(raw.ref ? { ref: raw.ref } : {}),
      ...(raw.box ? { box: raw.box } : {}),
    });
    // Preserve tree order and limit every individual text value.
    if (raw.text && raw.role !== 'text' && !raw.children)
      result.children = [
        { nodeId: `${nodeId}-text`, role: 'text', name: raw.text.slice(0, 4096), states: [] },
      ];
    if (raw.children)
      result.children = raw.children.map((child, index) =>
        this.node(child, state, `${nodeId}-${index}`),
      );
    return result;
  }

  /**
   * Capture an official versioned accessibility snapshot and tab metadata.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Standardized snapshot using official public APIs.
   */
  async observe(id: string): Promise<BrowserSnapshot> {
    const state = this.state(id);
    const raw = (await state.page.ariaSnapshotJSON({
      mode: 'ai',
      boxes: true,
      depth: 32,
      timeout: 10000,
    })) as RawNode[];
    state.snapshotId = randomUUID();
    state.nodes.clear();
    const root: AxNode = {
      nodeId: 'root',
      role: 'document',
      name: await state.page.title(),
      states: [],
      children: raw.map((node, index) => this.node(node, state, `node-${index}`)),
    };
    // Admit references only after the complete bounded tree has been constructed.
    if (state.nodes.size > 5000)
      throw new BrowserError('DESKTOP_BUSY', 'Accessibility snapshot exceeds its node quota.');
    const pages = state.context.pages();
    for (const page of pages)
      if (![...state.tabs.values()].includes(page)) state.tabs.set(randomUUID(), page);
    const tabs = [];
    for (const [tabId, page] of state.tabs)
      if (!page.isClosed())
        tabs.push({
          id: tabId,
          title: await page.title(),
          url: page.url(),
          active: page === state.page,
        });
    // The read-only metric query reports browser DPR without changing page state.
    const dpr = await state.page.evaluate(() => window.devicePixelRatio);
    return {
      sessionId: id,
      snapshotId: state.snapshotId,
      timestamp: new Date().toISOString(),
      windowId: `pw-window-${id}`,
      tabId: tabs.find((tab) => tab.active)?.id ?? 'tab-1',
      root,
      scale: { dpr, zoom: 1 },
      source: 'playwright-accessibility',
      url: state.page.url(),
      tabs,
    };
  }

  /**
   * Resolve an accessibility reference to an official Playwright locator.
   * Args:
   *   state (PageState): Current session reference map.
   *   target (Target): Validated browser target.
   * Returns:
   *   Locator: Official locator for the current snapshot reference.
   */
  private locator(state: PageState, target: Target): Locator {
    if (target.kind !== 'ax-node' || target.snapshotId !== state.snapshotId)
      throw new BrowserError('TARGET_STALE', 'A current browser observation is required.');
    const entry = state.nodes.get(target.nodeId);
    if (!entry?.ref || !/^[a-zA-Z0-9_-]+$/.test(entry.ref))
      throw new BrowserError(
        'TARGET_NOT_FOUND',
        'Target has no current interactive browser reference.',
      );
    return state.page.locator(`aria-ref=${entry.ref}`);
  }

  /**
   * Resolve a coordinate target within the selected compatible page.
   * Args:
   *   state (PageState): Owned browser session state.
   *   target (Target): Validated coordinate or accessibility target.
   * Returns:
   *   object: CSS viewport point for official pointer input.
   */
  private point(state: PageState, target: Target): { x: number; y: number } {
    if (target.kind === 'coordinate') {
      if (target.windowId !== `pw-window-${state.session.id}`)
        throw new BrowserError('TARGET_NOT_FOUND', 'Coordinate window ownership is invalid.');
      if (target.space !== 'viewport-css')
        throw new BrowserError(
          'UNSUPPORTED_CAPABILITY',
          'Compatible pointer coordinates require CSS viewport units.',
        );
      return { x: target.x, y: target.y };
    }
    if (target.snapshotId !== state.snapshotId)
      throw new BrowserError('TARGET_STALE', 'Browser target has expired.');
    const box = state.nodes.get(target.nodeId)?.box;
    if (!box) throw new BrowserError('TARGET_NOT_FOUND', 'Target has no visible pointer bounds.');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /**
   * Execute one compatible operation using the official Playwright implementation.
   * Args:
   *   value (unknown): Strict action request.
   * Returns:
   *   Promise<ActionResult>: Actual execution path and post-action snapshot identifier.
   */
  async execute(value: unknown): Promise<ActionResult> {
    const input = parseAction(value);
    const state = this.state(input.sessionId);
    if (state.paused) throw new BrowserError('DESKTOP_BUSY', 'Browser input is paused.');
    const startedAt = new Date().toISOString();
    const cancellation = new AbortController();
    state.cancellation = cancellation;
    const options = { signal: cancellation.signal, timeout: input.timeoutMs ?? 10000 };
    let actualStrategy: ActionResult['actualStrategy'];
    let executionPath: ActionResult['executionPath'] = 'playwright-cdp';
    // Execute each declared operation under the selected browser context.
    try {
      switch (input.action) {
        case 'navigate': {
          // Retry only navigation transport failures and retain an explicit upper bound.
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await state.page.goto(String(input.args?.url), {
                ...options,
                waitUntil: 'domcontentloaded',
              });
              break;
            } catch (error) {
              if (attempt === 2 || !String(error).includes('net::ERR_CONNECTION_RESET'))
                throw error;
            }
          }
          break;
        }
        case 'go-back':
          await state.page.goBack({ ...options, waitUntil: 'domcontentloaded' });
          break;
        case 'click':
        case 'double-click': {
          if (input.target!.kind === 'ax-node') {
            const locator = this.locator(state, input.target!);
            if (input.action === 'click') await locator.click(options);
            else await locator.dblclick(options);
          } else {
            const point = this.point(state, input.target!);
            await state.page.mouse.click(point.x, point.y, {
              clickCount: input.action === 'click' ? 1 : 2,
            });
          }
          break;
        }
        case 'pointer-move': {
          const point = this.point(state, input.target!);
          await state.page.mouse.move(point.x, point.y);
          break;
        }
        case 'key-press':
          await state.page.keyboard.press(
            [...((input.args?.modifiers as string[]) ?? []), String(input.args?.key)].join('+'),
          );
          break;
        case 'type-text': {
          const text = String(input.args?.text);
          if (input.args?.strategy === 'ime')
            throw new BrowserError(
              'UNSUPPORTED_CAPABILITY',
              'Compatible IME composition is unavailable.',
            );
          if (input.args?.strategy === 'auto' && /[^\x00-\x7f]/.test(text)) {
            await state.page.keyboard.insertText(text);
            actualStrategy = 'playwright-insert-text';
          } else {
            // Check cancellation between characters while retaining official keyboard semantics.
            for (const character of text) {
              cancellation.signal.throwIfAborted();
              await state.page.keyboard.type(character);
            }
            actualStrategy = 'playwright-keyboard';
          }
          break;
        }
        case 'scroll': {
          if (input.target) {
            const point = this.point(state, input.target);
            await state.page.mouse.move(point.x, point.y);
          }
          const factor = input.args?.unit === 'line' ? 40 : 1;
          await state.page.mouse.wheel(
            Number(input.args?.deltaX ?? 0) * factor,
            Number(input.args?.deltaY) * factor,
          );
          break;
        }
        case 'drag':
          await this.locator(state, input.args?.source as Target).dragTo(
            this.locator(state, input.args?.destination as Target),
            options,
          );
          break;
        case 'switch-tab': {
          const page = state.tabs.get(String(input.args?.tabId));
          if (!page || page.isClosed())
            throw new BrowserError('TARGET_NOT_FOUND', 'Requested browser tab is unavailable.');
          await page.bringToFront();
          state.page = page;
          break;
        }
        case 'choose-file': {
          const locator = input.target
            ? this.locator(state, input.target)
            : state.page.locator('input[type=file]');
          if ((await locator.count()) !== 1)
            throw new BrowserError(
              'TARGET_NOT_FOUND',
              'File input requires one unambiguous target.',
            );
          await locator.setInputFiles(String(input.args?.filePath), options);
          executionPath = 'playwright-script';
          break;
        }
        default:
          throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Compatible operation is unavailable.');
      }
      const snapshot = await this.observe(input.sessionId);
      return {
        requestId: input.requestId,
        actionId: randomUUID(),
        sessionId: input.sessionId,
        status: 'succeeded',
        executionPath,
        startedAt,
        finishedAt: new Date().toISOString(),
        snapshotIdAfter: snapshot.snapshotId,
        ...(actualStrategy ? { actualStrategy } : {}),
      };
    } finally {
      delete state.cancellation;
    }
  }

  /**
   * Capture and filter sensitive PNG regions before transferring any bytes.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   Promise<object>: Worker-private artifact identifier and filtered byte count.
   */
  async screenshot(id: string): Promise<{ blobId: string; byteLength: number }> {
    const state = this.state(id);
    const protectedInputs = await state.page
      .locator(
        'input[type=password], input[autocomplete="cc-number"], input[autocomplete="cc-csc"]',
      )
      .all();
    const dpr = await state.page.evaluate(() => window.devicePixelRatio);
    const regions: RedactionRectangle[] = [];
    // Map sensitive CSS bounds into the screenshot's actual device pixels.
    for (const input of protectedInputs) {
      const box = await input.boundingBox();
      if (box)
        regions.push({
          x: box.x * dpr,
          y: box.y * dpr,
          width: box.width * dpr,
          height: box.height * dpr,
        });
    }
    const bytes = await state.page.screenshot({ type: 'png', scale: 'device', timeout: 10000 });
    const blobId = await this.artifacts.putPng(id, bytes, regions);
    return { blobId, byteLength: (await this.artifacts.read(blobId, id)).bytes.length };
  }

  /**
   * Read a bounded portion of worker-private filtered screenshot bytes.
   * Args:
   *   id (string): Active browser session identifier.
   *   blobId (string): Worker-owned screenshot artifact.
   *   offset (number): Byte offset within the artifact.
   * Returns:
   *   Promise<string>: Base64 representation of a bounded transfer chunk.
   */
  async artifactChunk(id: string, blobId: string, offset: number): Promise<string> {
    const artifact = await this.artifacts.read(blobId, id);
    if (!Number.isInteger(offset) || offset < 0 || offset > artifact.bytes.length)
      throw new BrowserError('INVALID_ARGUMENT', 'Screenshot transfer offset is invalid.');
    return artifact.bytes.subarray(offset, offset + 524288).toString('base64');
  }

  /**
   * Interrupt ongoing browser operations through their cancellation signal.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   void: Completion of cancellation notification.
   */
  cancel(id: string): void {
    this.sessions.get(id)?.cancellation?.abort();
  }

  /**
   * Pause further browser input while preserving the visible session.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   void: Completion of pause state update.
   */
  pause(id: string): void {
    const state = this.state(id);
    state.paused = true;
    state.cancellation?.abort();
  }

  /**
   * Resume browser input after explicit user intervention.
   * Args:
   *   id (string): Active browser session identifier.
   * Returns:
   *   void: Completion of resume state update.
   */
  resume(id: string): void {
    this.state(id).paused = false;
  }

  /**
   * Close a worker-owned browser context idempotently.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<void>: Completion of browser resource release.
   */
  async close(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.cancellation?.abort();
    await state.context.close();
    this.sessions.delete(id);
  }

  /**
   * Close every browser context and filtered screenshot cache.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of worker cleanup.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
    await this.artifacts.close();
  }
}
