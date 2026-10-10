// -*- coding: utf-8 -*-
/**
 * gui-engine.ts
 * OS browser input adapter
 * =====================
 * Own isolated browser processes and route observation and input through the native agent.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BrowserError,
  CAPABILITIES,
  snapshotSchema,
  validateCoordinateInspection,
  validateOutput,
} from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  AxNode,
  BrowserEngine,
  BrowserSession,
  BrowserSnapshot,
  BrowserTab,
  Capability,
  CapabilityReport,
  CreateSessionRequest,
  Target,
} from '@abr/contracts';

import { AgentClient } from './client.js';
import { findAxNode, physicalPoint } from './geometry.js';
import { prepareGuiPreferences } from './profile-preferences.js';

export interface DesktopConnection {
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface GuiOptions {
  agentExecutable: string;
  runtimeDirectory: string;
  profileRoot: string;
  resolveBrowser: (input: CreateSessionRequest) => Promise<{ executable: string; version: string }>;
  putScreenshot: (sessionId: string, bytes: Buffer) => Promise<string>;
  sensitivePatterns?: string[];
  launchBrowser?: (
    executable: string,
    args: string[],
    sessionId: string,
    profileId: string,
  ) => Promise<ChildProcess>;
}
interface OwnedSession {
  metadata: BrowserSession;
  process: ChildProcess;
  windowId: string;
  snapshot?: BrowserSnapshot;
  cancelled: boolean;
}

/**
 * Find a public focused text control for post-input outcome verification.
 * Args:
 *   root (AxNode): Privacy-filtered native subtree.
 * Returns:
 *   AxNode | undefined: Focused public text control.
 */
function focusedText(root: AxNode): AxNode | undefined {
  // Select a focused public text control for bounded outcome verification.
  if (
    ['textbox', 'combobox'].includes(root.role) &&
    root.states.includes('focused') &&
    !root.states.includes('protected')
  )
    return root;
  // Search descendants without retaining protected field values.
  for (const child of root.children ?? []) {
    const found = focusedText(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Collect browser tabs identified outside page document subtrees.
 * Args:
 *   root (AxNode): Privacy-filtered OS accessibility tree.
 *   url (string | undefined): Verified active document URL.
 * Returns:
 *   BrowserTab[]: Chrome tab identities with the active URL when available.
 */
function browserTabs(root: AxNode, url?: string): BrowserTab[] {
  // Exclude webpage tab roles from browser chrome tab management.
  if (root.role === 'document') return [];
  // Admit only native browser-chrome tab identities and their observed selection state.
  if (root.role === 'tab' && root.states.includes('browser-tab'))
    return [
      {
        id: root.nodeId,
        title: root.name ?? '',
        active: root.states.includes('selected'),
        ...(root.states.includes('selected') && url ? { url } : {}),
      },
    ];
  return (root.children ?? []).flatMap((node) => browserTabs(node, url));
}

/** GuiEngine owns browser processes while DesktopAgent enforces physical input ownership. */
export class GuiEngine implements BrowserEngine {
  protected readonly sessions = new Map<string, OwnedSession>();
  private agent: Promise<AgentClient> | undefined;
  private static inputOwner: string | undefined;

  /**
   * Initialize the isolated GUI adapter.
   * Args:
   *   options (GuiOptions): Verified binary resolution and owned application paths.
   *   kind ('gui' | 'native'): Adapter identity recorded in sessions and execution metadata.
   * Returns:
   *   GuiEngine: Lazy native browser adapter.
   */
  constructor(
    private readonly options: GuiOptions,
    readonly kind: 'gui' | 'native' = 'gui',
  ) {}

  /**
   * Start or retrieve the single protected desktop agent.
   * Args:
   *   None.
   * Returns:
   *   Promise<AgentClient>: Authenticated current-user desktop agent.
   */
  private client(): Promise<AgentClient> {
    // Keep one agent instance per application assembly.
    this.agent ??= AgentClient.start(this.options.agentExecutable, this.options.runtimeDirectory);
    return this.agent;
  }

  /**
   * Invoke a registered native operation for an already scoped browser adapter.
   * Args:
   *   method (string): Closed desktop agent operation name.
   *   params (Record<string, unknown>): Bound operation parameters.
   * Returns:
   *   Promise<unknown>: Validated native operation result.
   */
  protected async desktopOperation(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.client()).call(method, params);
  }

  /**
   * Retrieve an owned live GUI session.
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   OwnedSession: Browser process and its bound native window.
   */
  protected session(id: string): OwnedSession {
    const record = this.sessions.get(id);
    if (!record) throw new BrowserError('SESSION_NOT_FOUND', 'GUI session is unavailable.');
    if (record.process.exitCode !== null || record.process.signalCode !== null)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Owned GUI browser exited.');
    return record;
  }

  /**
   * Launch an isolated ordinary browser and bind its owned top-level window.
   * Args:
   *   input (CreateSessionRequest): Validated profile and browser selection.
   * Returns:
   *   Promise<BrowserSession>: Bound GUI session metadata.
   */
  async create(input: CreateSessionRequest): Promise<BrowserSession> {
    if (input.headless)
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'GUI requires a visible desktop browser.');
    const agent = await this.client();
    const browser = await this.options.resolveBrowser(input);
    const profileId = input.profile.name;
    if (!profileId || !/^[A-Za-z0-9_-]+$/.test(profileId))
      throw new BrowserError('INVALID_ARGUMENT', 'Owned GUI profile identifier is required.');
    const args = [
      `--user-data-dir=${path.join(this.options.profileRoot, profileId)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--force-renderer-accessibility',
      ...(input.locale ? [`--lang=${input.locale}`] : []),
      'about:blank',
    ];
    await prepareGuiPreferences(path.join(this.options.profileRoot, profileId));
    // Start the browser without debugging endpoints or page execution interfaces.
    const id = randomUUID();
    let child: ChildProcess;
    // Release the lazy agent if a browser-specific bootstrap fails before binding.
    try {
      child = this.options.launchBrowser
        ? await this.options.launchBrowser(browser.executable, args, id, profileId)
        : spawn(browser.executable, args, { stdio: 'ignore', windowsHide: false });
    } catch (error) {
      if (this.sessions.size === 0) {
        await agent.close();
        this.agent = undefined;
      }
      throw error;
    }
    let startupError = false;
    child.once('error', () => {
      startupError = true;
    });
    try {
      let windowId: string | undefined;
      // Retry observation while the owned process creates its initial browser window.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (startupError || !child.pid || child.exitCode !== null)
          throw new BrowserError('BROWSER_DISCONNECTED', 'Owned browser startup failed.');
        const windows = (await agent.call('desktop.listWindows', { pid: child.pid })) as {
          windowId: string;
          pid: number;
        }[];
        const match = windows.find((window) => window.pid === child.pid);
        if (match) {
          windowId = match.windowId;
          break;
        }
        await delay(100);
      }
      if (!windowId || !child.pid)
        throw new BrowserError('TIMEOUT', 'Owned browser window did not become available.');
      await agent.call('desktop.bind', { sessionId: id, pid: child.pid, windowId });
      // Read embedded metadata through the native backend when the version is unavailable.
      if (browser.version === 'unverified') {
        const actual = (await agent
          .call('desktop.browserVersion', { executable: browser.executable })
          .catch(() => undefined)) as { version?: string } | undefined;
        if (actual?.version) browser.version = actual.version;
      }
      const report = await this.readCapabilities(agent);
      const metadata: BrowserSession = {
        id,
        engine: this.kind,
        status: 'ready',
        browserVersion: browser.version,
        platform: process.platform,
        capabilities: report.supported,
        createdAt: new Date().toISOString(),
        profileId,
      };
      this.sessions.set(id, { metadata, process: child, windowId, cancelled: false });
      return structuredClone(metadata);
    } catch (error) {
      child.kill();
      await agent.call('desktop.unbind', { sessionId: id }).catch(() => undefined);
      if (this.sessions.size === 0) {
        await agent.close();
        this.agent = undefined;
      }
      throw error;
    }
  }

  /**
   * Read actual native backend capabilities and expose complete unavailable reasons.
   * Args:
   *   agent (AgentClient): Authenticated native connection.
   * Returns:
   *   Promise<CapabilityReport>: Actual desktop capability matrix.
   */
  private async readCapabilities(agent: AgentClient): Promise<CapabilityReport> {
    const doctor = (await agent.call('desktop.doctor', {})) as {
      input: boolean;
      atomicNavigate?: boolean;
      accessibility: boolean;
      screenCapture: boolean;
      fileDialog?: boolean;
      tabs?: boolean;
      ime?: boolean;
      reason?: string;
    };
    const supported: Capability[] = [];
    if (doctor.accessibility) supported.push('observe.ax');
    if (doctor.screenCapture) supported.push('observe.screenshot');
    if (doctor.input) supported.push('window.focus', 'input.pointer', 'input.keyboard');
    // Browser navigation requires one native operation that retains the complete input lease.
    if (doctor.input && doctor.atomicNavigate === true) supported.push('browser.navigate');
    if (doctor.ime) supported.push('input.ime');
    if (doctor.fileDialog && doctor.input) supported.push('browser.fileDialog');
    if (doctor.tabs && doctor.input) supported.push('browser.tabs');
    const unsupported: CapabilityReport['unsupported'] = {};
    for (const capability of CAPABILITIES)
      if (!supported.includes(capability))
        unsupported[capability] =
          capability === 'browser.navigate' && doctor.atomicNavigate !== true
            ? 'Atomic OS browser navigation is unavailable in this desktop backend.'
            : (doctor.reason ?? 'GUI capability has no validated native implementation.');
    return { supported, unsupported };
  }

  /**
   * Read the current native capability matrix.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<CapabilityReport>: Supported native operations and reasons.
   */
  async capabilities(sessionId: string): Promise<CapabilityReport> {
    this.session(sessionId);
    return this.readCapabilities(await this.client());
  }

  /**
   * Read safe native diagnostic metadata from an already running agent.
   * Args:
   *   None.
   * Returns:
   *   Promise<unknown>: Native capability and input contention counters.
   */
  async diagnostics(): Promise<unknown> {
    if (!this.agent)
      throw new BrowserError('INPUT_BACKEND_UNAVAILABLE', 'Native agent is not running.');
    return (await this.agent).call('desktop.doctor', {});
  }

  /**
   * Read the owned desktop agent PID for a trusted session control surface.
   * Args:
   *   sessionId (string): Live owned browser session.
   * Returns:
   *   Promise<number>: Authenticated desktop agent process identity.
   */
  async inputProcessId(sessionId: string): Promise<number> {
    this.session(sessionId);
    return (await this.client()).processIdentifier();
  }

  /**
   * Read native accessibility while retrying transient provider publication races.
   * Args:
   *   sessionId (string): Bound browser session.
   * Returns:
   *   Promise<unknown>: Complete privacy-filtered native observation.
   */
  private async nativeObservation(sessionId: string): Promise<unknown> {
    // Retry read-only provider publication without repeating physical input.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await (
          await this.client()
        ).call('desktop.observe', {
          sessionId,
          sensitivePatterns: this.options.sensitivePatterns ?? [],
        });
      } catch (error) {
        if (
          !(error instanceof BrowserError) ||
          !['TARGET_STALE', 'TARGET_NOT_FOUND'].includes(error.code) ||
          attempt === 19
        )
          throw error;
        await delay(50);
      }
    }
    throw new BrowserError('TARGET_STALE', 'Accessibility observation did not settle.');
  }

  /**
   * Build an independent browser snapshot exclusively through OS accessibility.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<BrowserSnapshot>: Standardized read-only native snapshot.
   */
  protected async buildSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    const record = this.session(sessionId);
    const raw = (await this.nativeObservation(sessionId)) as Pick<
      BrowserSnapshot,
      'root' | 'url' | 'geometry' | 'scale' | 'windowId'
    >;
    const snapshot: BrowserSnapshot = {
      root: raw.root,
      windowId: raw.windowId,
      scale: raw.scale,
      ...(raw.url ? { url: new URL(raw.url).href } : {}),
      ...(raw.geometry ? { geometry: raw.geometry } : {}),
      sessionId,
      snapshotId: randomUUID(),
      timestamp: new Date().toISOString(),
      source: 'os-accessibility',
    };
    snapshot.tabs = browserTabs(snapshot.root, snapshot.url);
    const active = snapshot.tabs.find((tab) => tab.active);
    if (active) snapshot.tabId = active.id;
    validateOutput(snapshotSchema, snapshot);
    if (snapshot.windowId !== record.windowId)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Native window ownership changed.');
    return structuredClone(snapshot);
  }

  /**
   * Publish one caller observation while retaining its target reference cache.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<BrowserSnapshot>: Public target-selection snapshot.
   */
  async observe(sessionId: string): Promise<BrowserSnapshot> {
    const snapshot = await this.buildSnapshot(sessionId);
    this.session(sessionId).snapshot = snapshot;
    return structuredClone(snapshot);
  }

  /**
   * Read current policy geometry while preserving caller AX references.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<BrowserSnapshot>: Independent read-only semantic inspection.
   */
  async inspectionSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    return this.buildSnapshot(sessionId);
  }

  /**
   * Read the trusted browser chrome URL without page script execution.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<string>: Canonical address-bar URL.
   */
  async currentUrl(sessionId: string): Promise<string> {
    const record = this.session(sessionId);
    const raw = (await (await this.client()).call('desktop.currentUrl', { sessionId })) as {
      url?: string;
      windowId: string;
    };
    if ((raw.windowId && raw.windowId !== record.windowId) || !raw.url)
      throw new BrowserError('PERMISSION_REQUIRED', 'Trusted current URL is unavailable.');
    return new URL(raw.url).href;
  }

  /**
   * Capture a masked browser window and transfer bounded memory chunks.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<object>: Controlled PNG artifact identifier.
   */
  async screenshot(sessionId: string): Promise<{ mimeType: 'image/png'; blobId: string }> {
    this.session(sessionId);
    const agent = await this.client();
    const capture = (await agent.call(
      'desktop.capture',
      { sessionId, sensitivePatterns: this.options.sensitivePatterns ?? [] },
      15000,
    )) as {
      captureId: string;
      length: number;
    };
    if (
      !Number.isSafeInteger(capture.length) ||
      capture.length <= 0 ||
      capture.length > 32 * 1024 * 1024
    )
      throw new BrowserError('INTERNAL_ERROR', 'Native capture length is invalid.');
    const chunks: Buffer[] = [];
    let offset = 0;
    // Read masked capture bytes without exposing raw capture paths or buffers to MCP.
    while (offset < capture.length) {
      const chunk = (await agent.call('desktop.readCapture', {
        sessionId,
        captureId: capture.captureId,
        offset,
        maxBytes: 524288,
      })) as { data: string };
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.length === 0 || bytes.length > 524288 || offset + bytes.length > capture.length)
        throw new BrowserError('INTERNAL_ERROR', 'Native capture chunk is invalid.');
      chunks.push(bytes);
      offset += bytes.length;
    }
    return {
      mimeType: 'image/png',
      blobId: await this.options.putScreenshot(sessionId, Buffer.concat(chunks)),
    };
  }

  /**
   * Dispatch one action under application and OS desktop input exclusivity.
   * Args:
   *   input (ActionRequest): Strict authorized action envelope.
   *   inspection (BrowserSnapshot | undefined): Independent coordinate authorization witness.
   * Returns:
   *   Promise<ActionResult>: Completed physical input result.
   */
  async execute(input: ActionRequest, inspection?: BrowserSnapshot): Promise<ActionResult> {
    const record = this.session(input.sessionId);
    if (GuiEngine.inputOwner)
      throw new BrowserError('DESKTOP_BUSY', 'Another session owns desktop input.');
    GuiEngine.inputOwner = input.sessionId;
    record.cancelled = false;
    const startedAt = new Date().toISOString();
    const args = input.args ?? {};
    try {
      // Release input ownership even when the supervised agent startup fails.
      const agent = await this.client();
      const previous = record.snapshot;
      const current = await this.observe(input.sessionId);
      // Bind physical coordinate input to the private semantics authorized by Core.
      if (inspection) validateCoordinateInspection(input, inspection, current);
      // Preserve the caller's reference while using a new observation for target validation.
      record.snapshot = previous ?? current;
      /**
       * Resolve one caller reference against fresh native geometry.
       * Args:
       *   target (Target): Caller-selected target.
       * Returns:
       *   object: Physical screen point.
       */
      const point = (target: Target): { x: number; y: number } => {
        if (target.kind === 'coordinate' && inspection) {
          // Retain existing caller page and geometry freshness when a public reference is present.
          if (previous) physicalPoint(target, previous, current);
          return physicalPoint(target, inspection, current);
        }
        if (!previous) throw new BrowserError('TARGET_STALE', 'A caller observation is required.');
        return physicalPoint(target, previous, current);
      };
      /**
       * Submit bounded physical input while preserving cancellation state.
       * Args:
       *   params (Record<string, unknown>): Explicit input operation.
       * Returns:
       *   Promise<unknown>: Native completion acknowledgement.
       */
      const send = async (params: Record<string, unknown>): Promise<unknown> => {
        if (record.cancelled) throw new BrowserError('FOCUS_LOST', 'Physical input was cancelled.');
        return agent.call(
          'desktop.input',
          { sessionId: input.sessionId, timeoutMs: input.timeoutMs ?? 10000, ...params },
          (input.timeoutMs ?? 10000) + 1000,
        );
      };
      let actualStrategy: ActionResult['actualStrategy'];
      // Map browser commands to explicit OS input sequences with no script fallback.
      if (input.action === 'focus')
        await agent.call('desktop.focus', { sessionId: input.sessionId });
      else if (input.action === 'navigate') {
        await send({ kind: 'navigate', url: args.url });
      } else if (input.action === 'go-back') await send({ kind: 'key', key: 'Alt+Left' });
      else if (input.action === 'key-press')
        await send({
          kind: 'key',
          key: [...((args.modifiers as string[]) ?? []), String(args.key)].join('+'),
        });
      else if (input.action === 'type-text') {
        const response = (await send({
          kind: 'text',
          text: args.text,
          strategy: args.strategy ?? 'auto',
        })) as { actualStrategy?: ActionResult['actualStrategy'] };
        actualStrategy = response.actualStrategy;
      } else if (input.action === 'drag') {
        const start = point(args.source as Target);
        const end = point(args.destination as Target);
        await send({ kind: 'drag', ...start, endX: end.x, endY: end.y });
      } else if (['click', 'double-click', 'pointer-move', 'scroll'].includes(input.action)) {
        const position = input.target ? point(input.target) : {};
        const kind = {
          click: 'click',
          'double-click': 'doubleClick',
          'pointer-move': 'move',
          scroll: 'scroll',
        }[input.action];
        await send({
          kind,
          ...position,
          ...(input.action === 'scroll'
            ? { deltaX: args.deltaX ?? 0, deltaY: args.deltaY, unit: args.unit ?? 'pixel' }
            : {}),
        });
      } else if (input.action === 'choose-file') {
        if (!input.target)
          throw new BrowserError(
            'INVALID_ARGUMENT',
            'File selection requires an observed input target.',
          );
        await send({ kind: 'click', ...point(input.target) });
        await agent.call(
          'desktop.chooseFile',
          {
            sessionId: input.sessionId,
            path: path.resolve(String(args.filePath)),
            timeoutMs: input.timeoutMs ?? 10000,
          },
          (input.timeoutMs ?? 10000) + 1000,
        );
      } else if (input.action === 'switch-tab') {
        const tab = findAxNode(current.root, String(args.tabId));
        if (!tab || tab.role !== 'tab' || !tab.states.includes('browser-tab'))
          throw new BrowserError('TARGET_NOT_FOUND', 'Owned browser tab is unavailable.');
        await send({
          kind: 'click',
          ...physicalPoint(
            { kind: 'ax-node', snapshotId: current.snapshotId, nodeId: tab.nodeId },
            current,
            current,
          ),
        });
      } else
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Action has no native implementation.');
      // Record a post-input observation so completion includes live browser state.
      const after = await this.observe(input.sessionId);
      const typedControl = focusedText(after.root);
      // Verify public control values without exposing confidential submitted text in errors.
      if (
        input.action === 'type-text' &&
        typedControl?.value !== undefined &&
        !typedControl.value.includes(String(args.text))
      )
        throw new BrowserError(
          'INTERNAL_ERROR',
          'The observed text outcome differs from the requested submission.',
        );
      const expectedUrl = input.action === 'navigate' ? new URL(String(args.url)).href : undefined;
      if (expectedUrl && after.url !== expectedUrl) {
        // Poll the address bar during navigation without replaying any input.
        let settled = after.url === expectedUrl;
        for (let attempt = 0; attempt < 40 && !settled; attempt++) {
          await delay(100);
          settled = (await this.currentUrl(input.sessionId)) === expectedUrl;
        }
        if (!settled) throw new BrowserError('TIMEOUT', 'Navigation outcome was not observed.');
      }
      return {
        requestId: input.requestId,
        actionId: randomUUID(),
        sessionId: input.sessionId,
        status: 'succeeded',
        executionPath: 'os-input',
        startedAt,
        finishedAt: new Date().toISOString(),
        snapshotIdAfter: after.snapshotId,
        ...(actualStrategy ? { actualStrategy } : {}),
      };
    } finally {
      delete record.snapshot;
      GuiEngine.inputOwner = undefined;
    }
  }

  /**
   * Cancel subsequent input and release native held keys and buttons.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<void>: Completion of native cancellation.
   */
  async cancel(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.cancelled = true;
    await (await this.client()).call('desktop.cancel', { sessionId });
  }

  /**
   * Pause native input for human handover.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<void>: Completion of handover cancellation.
   */
  async pause(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
  }

  /**
   * Revalidate window ownership before resuming automation.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<void>: Completion of fresh native observation.
   */
  async resume(sessionId: string): Promise<void> {
    await (await this.client()).call('desktop.focus', { sessionId });
    await this.observe(sessionId);
  }

  /**
   * Release only the bound process and its native agent state.
   * Args:
   *   sessionId (string): Owned browser session.
   * Returns:
   *   Promise<void>: Completion of GUI resource release.
   */
  async close(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const agent = await this.client();
    await this.cancel(sessionId).catch(() => undefined);
    let processEnded = false;
    // Prefer a kernel-confirmed close against the native agent's original process handle.
    try {
      const result = (await agent.call('desktop.closeProcess', { sessionId })) as {
        processEnded?: boolean;
      };
      processEnded = result.processEnded === true;
    } catch (error) {
      if (!(error instanceof BrowserError) || error.code !== 'UNSUPPORTED_CAPABILITY') throw error;
    }
    await agent.call('desktop.unbind', { sessionId }).catch(() => undefined);
    // Await process exit before the shared policy releases the owned browser profile.
    if (!processEnded && record.process.exitCode === null && record.process.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new BrowserError('TIMEOUT', 'Owned browser did not exit.')),
          10000,
        );
        record.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        record.process.kill();
      });
    }
    if (processEnded) record.process.unref();
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) {
      await agent.close();
      this.agent = undefined;
    }
  }
}
