// -*- coding: utf-8 -*-
/**
 * native-engine.ts
 * Chromium browser observation adapter
 * =====================
 * Authenticate a pinned read-only browser observer and reuse validated OS input.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { BrowserError, snapshotSchema, validateOutput } from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  AxNode,
  BrowserSession,
  BrowserSnapshot,
  BrowserTab,
  CapabilityReport,
  CreateSessionRequest,
} from '@abr/contracts';

import { AgentClient } from './client.js';
import { GuiEngine } from './gui-engine.js';
import type { GuiOptions } from './gui-engine.js';

export interface NativeOptions extends Omit<GuiOptions, 'launchBrowser'> {
  upstreamCommit: string;
  upstreamVersion: string;
  sensitivePatterns?: string[];
}
interface ObserverState {
  channel: AgentClient;
  metadata: { browserCommit: string; browserVersion: string };
  browserWindowId?: string;
}
interface TabMapping {
  tabs: BrowserTab[];
  nodes: AxNode[];
  fingerprint: string;
  windowId: string;
}
interface TabSwitchValidation {
  sessionId: string;
  fingerprint: string;
  deadline: number;
  validated: boolean;
}

/**
 * Collect browser chrome tab controls while excluding page document subtrees.
 * Args:
 *   root (AxNode): Privacy-filtered OS accessibility subtree.
 * Returns:
 *   AxNode[]: Browser tab controls in accessibility traversal order.
 */
function chromeTabs(root: AxNode): AxNode[] {
  // Page accessibility roles carry no browser chrome authority.
  if (root.role === 'document') return [];
  if (root.role === 'tab' && root.states.includes('browser-tab')) return [root];
  return (root.children ?? []).flatMap(chromeTabs);
}

/**
 * Normalize canonically equivalent tab labels for an exact title comparison.
 * Args:
 *   title (string): Browser or OS accessibility tab title.
 * Returns:
 *   string: Unicode-normalized title with its original whitespace preserved.
 */
function tabTitle(title: string): string {
  return title.normalize('NFC');
}

/**
 * Detect an embedded tab button that would receive a tab-center pointer click.
 * Args:
 *   root (AxNode): Browser tab accessibility subtree.
 *   x (number): Rounded physical pointer coordinate on the horizontal axis.
 *   y (number): Rounded physical pointer coordinate on the vertical axis.
 * Returns:
 *   boolean: Whether the pointer would activate an embedded button.
 */
function embeddedButtonAt(root: AxNode, x: number, y: number): boolean {
  const bounds = root.bounds;
  // Close and audio buttons remain distinct controls within the browser tab strip.
  if (
    root.role === 'button' &&
    bounds?.space === 'screen-physical' &&
    x >= bounds.x &&
    y >= bounds.y &&
    x < bounds.x + bounds.width &&
    y < bounds.y + bounds.height
  )
    return true;
  return (root.children ?? []).some((child) => embeddedButtonAt(child, x, y));
}

/**
 * Launch a browser and authenticate its exact inherited observer bootstrap.
 * Args:
 *   options (NativeOptions): Pinned build identity and owned socket paths.
 *   executable (string): Verified custom browser executable.
 *   args (string[]): Isolated ordinary browser startup arguments.
 *   profileId (string): Policy-allocated profile identity.
 * Returns:
 *   Promise<object>: Owned process and its authenticated observer connection.
 */
async function launchObserver(
  options: NativeOptions,
  executable: string,
  args: string[],
  profileId: string,
): Promise<{ process: ChildProcessWithoutNullStreams; observer: ObserverState }> {
  await mkdir(options.runtimeDirectory, { recursive: true, mode: 0o700 });
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\abr-observer-${randomUUID()}`
      : path.join(options.runtimeDirectory, `observer-${randomUUID()}.sock`);
  const secret = randomBytes(32).toString('hex');
  const child = spawn(executable, [...args, '--abr-observer'], {
    stdio: 'pipe',
    windowsHide: false,
  });
  // Keep raw browser diagnostics inside the supervised process boundary.
  child.stderr.resume();
  child.stdin.end(
    JSON.stringify({ schemaVersion: 1, secret, endpoint, profileId, parentPid: process.pid }) +
      '\n',
  );
  let channel: AgentClient | undefined;
  try {
    const metadata = await new Promise<{ browserCommit: string; browserVersion: string }>(
      (resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(
            new BrowserError(
              'UNSUPPORTED_CAPABILITY',
              'Pinned Chromium observer bootstrap is unavailable.',
            ),
          );
        }, 15000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(
            new BrowserError(
              'INPUT_BACKEND_UNAVAILABLE',
              'Native browser executable failed to start.',
            ),
          );
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(
            new BrowserError(
              'BROWSER_DISCONNECTED',
              'Native browser exited during observer bootstrap.',
            ),
          );
        });
        child.stdout.on('data', (bytes: Buffer) => {
          output += bytes.toString('utf8');
          if (output.length > 8192) {
            clearTimeout(timer);
            child.kill();
            reject(
              new BrowserError(
                'INVALID_ARGUMENT',
                'Native observer startup metadata exceeds its limit.',
              ),
            );
            return;
          }
          if (!output.includes('\n')) return;
          try {
            const value = JSON.parse(output.split('\n')[0]!) as Record<string, unknown>;
            if (
              value.schemaVersion !== 1 ||
              value.protocolVersion !== 1 ||
              value.endpoint !== endpoint ||
              value.profileId !== profileId ||
              value.pid !== child.pid ||
              value.observerVersion !== '0.1.0' ||
              value.browserCommit !== options.upstreamCommit ||
              value.browserVersion !== options.upstreamVersion
            )
              throw new BrowserError(
                'UNSUPPORTED_CAPABILITY',
                'Native observer build identity does not match the pinned manifest.',
              );
            clearTimeout(timer);
            resolve({
              browserCommit: options.upstreamCommit,
              browserVersion: options.upstreamVersion,
            });
          } catch (error) {
            clearTimeout(timer);
            reject(
              error instanceof BrowserError
                ? error
                : new BrowserError('INVALID_ARGUMENT', 'Native observer metadata is invalid.'),
            );
          }
        });
      },
    );
    channel = await AgentClient.connectOwnedProcess(child, endpoint);
    const hello = (await channel.authenticate('observer', secret)) as Record<string, unknown>;
    if (
      hello.browserCommit !== metadata.browserCommit ||
      hello.browserVersion !== metadata.browserVersion ||
      hello.profileId !== profileId ||
      hello.protocolVersion !== 1
    )
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Native observer handshake identity changed.',
      );
    return { process: child, observer: { channel, metadata } };
  } catch (error) {
    channel?.closeChannel();
    child.kill();
    throw error;
  }
}

/** NativeEngine observes Chromium browser state while inheriting the external OS input path. */
export class NativeEngine extends GuiEngine {
  private readonly observers: Map<string, ObserverState>;
  private readonly tabSwitchValidation = new AsyncLocalStorage<TabSwitchValidation>();
  private creating = false;

  /**
   * Assemble a native observer using the same owned GUI process and input coordinator.
   * Args:
   *   options (NativeOptions): Pinned browser identity and shared native services.
   * Returns:
   *   NativeEngine: Opt-in pinned observer adapter.
   */
  constructor(private readonly nativeOptions: NativeOptions) {
    const observers = new Map<string, ObserverState>();
    super(
      {
        ...nativeOptions,
        /**
         * Launch and bind one private observer to its runtime session.
         * Args:
         *   executable (string): Custom Chromium executable.
         *   args (string[]): Isolated browser launch arguments.
         *   sessionId (string): Runtime-owned browser identity.
         *   profileId (string): Policy-allocated profile identity.
         * Returns:
         *   Promise<ChildProcess>: Authenticated owned browser process.
         */
        async launchBrowser(executable, args, sessionId, profileId) {
          const launched = await launchObserver(nativeOptions, executable, args, profileId);
          observers.set(sessionId, launched.observer);
          return launched.process;
        },
      },
      'native',
    );
    this.observers = observers;
  }

  /**
   * Retrieve an authenticated observer for one owned browser session.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   ObserverState: Pinned authenticated read-only observer.
   */
  private observer(sessionId: string): ObserverState {
    this.session(sessionId);
    const observer = this.observers.get(sessionId);
    if (!observer)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Native observer session is unavailable.');
    return observer;
  }

  /**
   * Create a custom native session and verify browser-to-OS window ownership.
   * Args:
   *   input (CreateSessionRequest): Explicit custom Chromium session selection.
   * Returns:
   *   Promise<BrowserSession>: Exact pinned native browser metadata.
   */
  override async create(input: CreateSessionRequest): Promise<BrowserSession> {
    if (input.browser !== 'custom-chromium')
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Native sessions require a compiled custom Chromium observer build.',
      );
    if (this.creating)
      throw new BrowserError('DESKTOP_BUSY', 'Native browser startup is already in progress.');
    this.creating = true;
    let created: BrowserSession | undefined;
    try {
      const session = await super.create(input);
      created = session;
      const observer = this.observer(session.id);
      const windows = (await observer.channel.call('observer.listWindows', {})) as {
        windowId: string;
        osWindowId?: string;
      }[];
      const window = windows.find(
        (window) => window.osWindowId === this.session(session.id).windowId,
      );
      if (!window)
        throw new BrowserError(
          'UNSUPPORTED_CAPABILITY',
          'Observer and OS window mapping is unverified on this platform.',
        );
      observer.browserWindowId = window.windowId;
      return {
        ...session,
        browserCommit: observer.metadata.browserCommit,
        browserVersion: observer.metadata.browserVersion,
      };
    } catch (error) {
      if (created) await this.close(created.id).catch(() => undefined);
      // Close only browser state allocated by the failed native startup.
      for (const [id] of this.observers)
        if (!this.sessions.has(id)) {
          this.observers.get(id)!.channel.closeChannel();
          this.observers.delete(id);
        }
      throw error;
    } finally {
      this.creating = false;
    }
  }

  /**
   * Query stable native tabs belonging exclusively to the bound browser window.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<BrowserTab[]>: Browser-owned stable tab identities and committed URLs.
   */
  private async tabs(sessionId: string): Promise<BrowserTab[]> {
    const observer = this.observer(sessionId);
    const tabs = (await observer.channel.call('observer.listTabs', {
      windowId: observer.browserWindowId,
    })) as BrowserTab[];
    // Validate stable browser identities before using tab order for OS target mapping.
    if (
      !Array.isArray(tabs) ||
      tabs.length === 0 ||
      tabs.some(
        (tab) =>
          !tab ||
          typeof tab.id !== 'string' ||
          tab.id.length === 0 ||
          typeof tab.title !== 'string' ||
          typeof tab.active !== 'boolean' ||
          (tab.url !== undefined && typeof tab.url !== 'string'),
      ) ||
      new Set(tabs.map((tab) => tab.id)).size !== tabs.length ||
      tabs.filter((tab) => tab.active).length !== 1
    )
      throw new BrowserError('INTERNAL_ERROR', 'Native tab identities violate their contract.');
    if (!tabs.find((tab) => tab.active)?.url)
      throw new BrowserError('PERMISSION_REQUIRED', 'Native committed tab URL is unavailable.');
    return tabs;
  }

  /**
   * Bind authoritative tab order to visible OS browser chrome controls.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<TabMapping>: Unambiguous native-to-OS tab mapping and freshness fingerprint.
   */
  private async tabMapping(sessionId: string): Promise<TabMapping> {
    const record = this.session(sessionId);
    const observer = this.observer(sessionId);
    const windows = (await observer.channel.call('observer.listWindows', {})) as {
      windowId: string;
      osWindowId?: string;
    }[];
    // Require one authoritative browser window for the exact retained OS identity.
    if (!Array.isArray(windows))
      throw new BrowserError('INTERNAL_ERROR', 'Native window inventory violates its contract.');
    const mapped = windows.filter((window) => window?.osWindowId === record.windowId);
    if (
      mapped.length !== 1 ||
      !observer.browserWindowId ||
      mapped[0]?.windowId !== observer.browserWindowId ||
      windows.filter((window) => window?.windowId === observer.browserWindowId).length !== 1
    )
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Native browser-to-OS window mapping is ambiguous or unavailable.',
      );
    const tabs = await this.tabs(sessionId);
    const raw = (await this.desktopOperation('desktop.observe', {
      sessionId,
      sensitivePatterns: this.nativeOptions.sensitivePatterns ?? [],
    })) as Pick<BrowserSnapshot, 'root' | 'scale' | 'geometry' | 'windowId'>;
    // Keep the OS tree private to chrome targeting and preserve native public observations.
    const snapshot: BrowserSnapshot = {
      sessionId,
      snapshotId: randomUUID(),
      timestamp: new Date().toISOString(),
      windowId: raw.windowId,
      root: raw.root,
      scale: raw.scale,
      ...(raw.geometry ? { geometry: raw.geometry } : {}),
      source: 'os-accessibility',
    };
    validateOutput(snapshotSchema, snapshot);
    if (snapshot.windowId !== record.windowId)
      throw new BrowserError('TARGET_STALE', 'Native tab strip OS window identity changed.');
    const nodes = chromeTabs(snapshot.root);
    const titles = tabs.map((tab) => tabTitle(tab.title));
    const selected = nodes.filter((node) => node.states.includes('selected'));
    // Stable browser IDs require unique exact titles and matching order in both inventories.
    if (
      nodes.length !== tabs.length ||
      titles.some((title) => title.length === 0) ||
      new Set(titles).size !== titles.length ||
      new Set(nodes.map((node) => node.nodeId)).size !== nodes.length ||
      nodes.some((node, index) => tabTitle(node.name ?? '') !== titles[index]) ||
      selected.length !== 1 ||
      nodes.findIndex((node) => node.states.includes('selected')) !==
        tabs.findIndex((tab) => tab.active)
    )
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Native tab order, titles, or selected state cannot be mapped unambiguously.',
      );
    const windowBounds = snapshot.root.bounds;
    // Require visible physical bounds inside the bound browser window for every mapped tab.
    if (
      !windowBounds ||
      windowBounds.space !== 'screen-physical' ||
      windowBounds.width <= 0 ||
      windowBounds.height <= 0 ||
      nodes.some((node) => {
        const bounds = node.bounds;
        return (
          node.states.some((state) =>
            ['disabled', 'offscreen', 'protected', 'password'].includes(state),
          ) ||
          !bounds ||
          bounds.space !== 'screen-physical' ||
          bounds.width <= 1 ||
          bounds.height <= 1 ||
          bounds.x < windowBounds.x ||
          bounds.y < windowBounds.y ||
          bounds.x + bounds.width > windowBounds.x + windowBounds.width ||
          bounds.y + bounds.height > windowBounds.y + windowBounds.height
        );
      })
    )
      throw new BrowserError(
        'TARGET_OCCLUDED',
        'Native browser tabs require visible physical bounds within their owned window.',
      );
    // Reject overlapping tab rectangles whose center could select another browser control.
    for (const [index, node] of nodes.entries()) {
      const bounds = node.bounds!;
      const x = Math.round(bounds.x + bounds.width / 2);
      const y = Math.round(bounds.y + bounds.height / 2);
      if (
        embeddedButtonAt(node, x, y) ||
        nodes.some((other, otherIndex) => {
          const otherBounds = other.bounds!;
          return (
            otherIndex !== index &&
            x >= otherBounds.x &&
            y >= otherBounds.y &&
            x < otherBounds.x + otherBounds.width &&
            y < otherBounds.y + otherBounds.height
          );
        })
      )
        throw new BrowserError(
          'UNSUPPORTED_CAPABILITY',
          'Native browser tab pointer targets overlap ambiguously.',
        );
    }
    // Read the authoritative list again to detect a concurrent tab-strip mutation.
    if (JSON.stringify(tabs) !== JSON.stringify(await this.tabs(sessionId)))
      throw new BrowserError('TARGET_STALE', 'Native tab identities changed during observation.');
    return {
      tabs,
      nodes,
      windowId: record.windowId,
      fingerprint: JSON.stringify({
        browserWindowId: observer.browserWindowId,
        windowId: record.windowId,
        tabs,
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          name: node.name,
          states: node.states,
          bounds: node.bounds,
        })),
        windowBounds,
        geometry: snapshot.geometry,
        scale: snapshot.scale,
      }),
    };
  }

  /**
   * Read browser-owned native capabilities and external OS input support.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<CapabilityReport>: Explicit combined read-only and OS-input capability matrix.
   */
  override async capabilities(sessionId: string): Promise<CapabilityReport> {
    this.observer(sessionId);
    const report = await super.capabilities(sessionId);
    if (!report.supported.includes('observe.ax')) report.supported.push('observe.ax');
    delete report.unsupported['observe.ax'];
    // Advertise tab switching only when the current native window has an exact OS mapping.
    if (report.supported.includes('browser.tabs')) {
      try {
        await this.tabMapping(sessionId);
      } catch (error) {
        if (
          !(error instanceof BrowserError) ||
          ![
            'UNSUPPORTED_CAPABILITY',
            'TARGET_OCCLUDED',
            'TARGET_STALE',
            'TARGET_NOT_FOUND',
          ].includes(error.code)
        )
          throw error;
        report.supported = report.supported.filter((capability) => capability !== 'browser.tabs');
        report.unsupported['browser.tabs'] =
          'Current native browser tabs require an unambiguous visible OS chrome mapping.';
      }
    }
    return report;
  }

  /**
   * Read the committed URL from the browser process without page script execution.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<string>: Active tab committed URL.
   */
  override async currentUrl(sessionId: string): Promise<string> {
    const active = (await this.tabs(sessionId)).find((tab) => tab.active);
    if (!active) throw new BrowserError('TARGET_NOT_FOUND', 'Native active tab is unavailable.');
    if (!active.url)
      throw new BrowserError('PERMISSION_REQUIRED', 'Native committed tab URL is unavailable.');
    return active.url;
  }

  /**
   * Read the active browser AX cache and measured viewport while preserving OS window identity.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<BrowserSnapshot>: Browser-owned read-only accessibility snapshot.
   */
  protected override async buildSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    const record = this.session(sessionId);
    const observer = this.observer(sessionId);
    const tabs = await this.tabs(sessionId);
    const active = tabs.find((tab) => tab.active);
    if (!active) throw new BrowserError('TARGET_NOT_FOUND', 'Native active tab is unavailable.');
    const raw = (await observer.channel.call('observer.readAccessibility', {
      tabId: active.id,
      limit: 6000,
      treeDepth: 32,
      sensitivePatterns: this.nativeOptions.sensitivePatterns ?? [],
    })) as Pick<BrowserSnapshot, 'root' | 'scale' | 'geometry' | 'url'> & { osWindowId?: string };
    if (raw.osWindowId !== record.windowId || !raw.url || raw.url !== active.url)
      throw new BrowserError(
        'TARGET_STALE',
        'Native AX window or committed page identity changed.',
      );
    const snapshot: BrowserSnapshot = {
      sessionId,
      snapshotId: randomUUID(),
      timestamp: new Date().toISOString(),
      windowId: record.windowId,
      tabId: active.id,
      tabs,
      root: raw.root,
      scale: raw.scale,
      ...(raw.url ? { url: raw.url } : {}),
      ...(raw.geometry ? { geometry: raw.geometry } : {}),
      source: 'chromium-accessibility',
    };
    validateOutput(snapshotSchema, snapshot);
    const validation = this.tabSwitchValidation.getStore();
    // Revalidate chrome geometry inside the inherited shared input lease immediately before click.
    if (validation && validation.sessionId === sessionId && !validation.validated) {
      const mapping = await this.tabMapping(sessionId);
      if (mapping.fingerprint !== validation.fingerprint)
        throw new BrowserError('TARGET_STALE', 'Native browser tab mapping changed before input.');
      if (Date.now() >= validation.deadline)
        throw new BrowserError('TIMEOUT', 'Native tab validation exceeded the action deadline.');
      validation.validated = true;
    }
    return structuredClone(snapshot);
  }

  /**
   * Switch a stable native tab through one validated browser chrome OS click.
   * Args:
   *   input (ActionRequest): Authorized action with a browser-owned stable tab ID.
   *   inspection (BrowserSnapshot | undefined): Independent coordinate authorization witness.
   * Returns:
   *   Promise<ActionResult>: Physical input completion with a verified active native tab.
   */
  override async execute(
    input: ActionRequest,
    inspection?: BrowserSnapshot,
  ): Promise<ActionResult> {
    // Preserve the shared GUI execution path for every action outside native tab mapping.
    if (input.action !== 'switch-tab') return super.execute(input, inspection);
    const record = this.session(input.sessionId);
    const tabId = input.args?.tabId;
    if (typeof tabId !== 'string' || tabId.length === 0)
      throw new BrowserError('INVALID_ARGUMENT', 'Native tab switching requires a stable tab ID.');
    record.cancelled = false;
    const deadline = Date.now() + (input.timeoutMs ?? 10000);
    const startedAt = new Date().toISOString();
    const mapping = await this.tabMapping(input.sessionId);
    const index = mapping.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1)
      throw new BrowserError('TARGET_NOT_FOUND', 'Requested native browser tab is unavailable.');
    const bounds = mapping.nodes[index]!.bounds!;
    // Supply the inherited coordinate resolver with a native caller observation when needed.
    if (!record.snapshot) await this.observe(input.sessionId);
    if (Date.now() >= deadline)
      throw new BrowserError('TIMEOUT', 'Native tab mapping exceeded the action deadline.');
    if (record.cancelled)
      throw new BrowserError('FOCUS_LOST', 'Native tab switch was cancelled before pointer input.');
    const validation: TabSwitchValidation = {
      sessionId: input.sessionId,
      fingerprint: mapping.fingerprint,
      deadline,
      validated: false,
    };
    const translated: ActionRequest = {
      ...input,
      action: 'click',
      args: {},
      timeoutMs: Math.max(1, deadline - Date.now()),
      target: {
        kind: 'coordinate',
        windowId: mapping.windowId,
        space: 'screen-physical',
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
      },
    };
    // Scope the pre-click revalidation to this action while GuiEngine owns shared OS input.
    const result = await this.tabSwitchValidation.run(validation, () => super.execute(translated));
    if (
      !validation.validated ||
      result.status !== 'succeeded' ||
      result.executionPath !== 'os-input'
    )
      throw new BrowserError('INTERNAL_ERROR', 'Native tab switch input provenance is unverified.');
    // Observe active identity without replaying the physical click during publication delays.
    while (Date.now() < deadline) {
      if (record.cancelled)
        throw new BrowserError('FOCUS_LOST', 'Native tab switch verification was cancelled.');
      const tabs = await this.tabs(input.sessionId);
      if (!tabs.some((tab) => tab.id === tabId))
        throw new BrowserError('TARGET_STALE', 'Requested native tab closed after pointer input.');
      if (tabs.find((tab) => tab.active)?.id === tabId) {
        const after = await this.observe(input.sessionId);
        if (after.tabId === tabId && Date.now() < deadline)
          return {
            ...result,
            startedAt,
            finishedAt: new Date().toISOString(),
            snapshotIdAfter: after.snapshotId,
          };
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    throw new BrowserError(
      'TIMEOUT',
      'Native tab activation was not observed before the deadline.',
    );
  }

  /**
   * Close the read-only channel and its shared owned browser input resources.
   * Args:
   *   sessionId (string): Runtime-owned browser identity.
   * Returns:
   *   Promise<void>: Completion of native browser resource cleanup.
   */
  override async close(sessionId: string): Promise<void> {
    this.observers.get(sessionId)?.channel.closeChannel();
    this.observers.delete(sessionId);
    await super.close(sessionId);
  }
}
