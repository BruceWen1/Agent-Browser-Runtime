// -*- coding: utf-8 -*-
/**
 * fake-engine.ts
 * Isolated browser protocol test engine
 * =====================
 * Simulate browser state for deterministic tests without desktop or browser processes.
 */
import { randomUUID } from 'node:crypto';

import { BrowserError, CAPABILITIES, validateCoordinateInspection } from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  AxNode,
  BrowserEngine,
  BrowserSession,
  BrowserSnapshot,
  Capability,
  CapabilityReport,
  CreateSessionRequest,
  Engine,
} from '@abr/contracts';

interface FakeState {
  session: BrowserSession;
  url: string;
  snapshotId: string;
  paused: boolean;
  text: string;
  activations: number;
  scrollY: number;
  history: string[];
}
export interface FakeEvent {
  sessionId: string;
  requestId: string;
  action: string;
}
export type ScreenshotSink = (sessionId: string, bytes: Buffer) => Promise<string>;

// The PNG is a fixed single-pixel fixture containing no user-derived data.
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==',
  'base64',
);
const SUPPORTED: Capability[] = [
  'observe.ax',
  'input.pointer',
  'input.keyboard',
  'browser.navigate',
  'browser.tabs',
  'browser.fileDialog',
];

/** FakeBrowserEngine is available only through the explicit testing package entry point. */
export class FakeBrowserEngine implements BrowserEngine {
  readonly events: FakeEvent[] = [];
  private readonly sessions = new Map<string, FakeState>();

  /**
   * Initialize a deterministic test adapter.
   * Args:
   *   kind (Engine): Public interface being tested.
   *   screenshotSink (ScreenshotSink | undefined): Optional controlled artifact writer.
   * Returns:
   *   FakeBrowserEngine: Test adapter with no physical input path.
   */
  constructor(
    readonly kind: Engine = 'compatible',
    private readonly screenshotSink?: ScreenshotSink,
  ) {}

  /**
   * Retrieve a fake state owned by the requested session.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   FakeState: Owned simulated state.
   */
  private state(id: string): FakeState {
    const state = this.sessions.get(id);
    if (!state) throw new BrowserError('SESSION_NOT_FOUND', 'Test session does not exist.');
    return state;
  }

  /**
   * Create an isolated in-memory browser session.
   * Args:
   *   input (CreateSessionRequest): Authorized session request.
   * Returns:
   *   Promise<BrowserSession>: Metadata explicitly labeled as a test browser.
   */
  async create(input: CreateSessionRequest): Promise<BrowserSession> {
    const id = randomUUID();
    const session: BrowserSession = {
      id,
      engine: this.kind,
      status: 'ready',
      browserVersion: 'fake-test-only',
      platform: 'fake-test-only',
      capabilities: [...SUPPORTED, ...(this.screenshotSink ? ['observe.screenshot' as const] : [])],
      createdAt: new Date().toISOString(),
      profileId: input.profile.name ?? randomUUID(),
    };
    this.sessions.set(id, {
      session,
      url: 'about:blank',
      snapshotId: randomUUID(),
      paused: false,
      text: '',
      activations: 0,
      scrollY: 0,
      history: [],
    });
    return structuredClone(session);
  }

  /**
   * Report supported simulated behavior and explicit unsupported reasons.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<CapabilityReport>: Complete fake capability declaration.
   */
  async capabilities(id: string): Promise<CapabilityReport> {
    const supported = this.state(id).session.capabilities;
    const unsupported: CapabilityReport['unsupported'] = {};
    // Every known capability receives either support or an explicit test-only reason.
    for (const capability of CAPABILITIES)
      if (!supported.includes(capability)) unsupported[capability] = 'UNAVAILABLE_IN_TEST_ENGINE';
    return { supported: [...supported], unsupported };
  }

  /**
   * Return the current simulated browser URL.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<string>: Current test URL.
   */
  async currentUrl(id: string): Promise<string> {
    return this.state(id).url;
  }

  /**
   * Build a deterministic test accessibility tree.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Current simulated tree and state values.
   */
  async observe(id: string): Promise<BrowserSnapshot> {
    const state = this.state(id);
    const root: AxNode = {
      nodeId: 'root',
      role: 'document',
      name: 'ABR fixture',
      states: [],
      children: [
        {
          nodeId: 'activate',
          role: 'button',
          name: 'Activate',
          states: [],
          bounds: { x: 20, y: 20, width: 120, height: 40, space: 'viewport-css' },
        },
        {
          nodeId: 'query',
          role: 'textbox',
          name: 'Query',
          value: state.text,
          states: [],
          bounds: { x: 20, y: 80, width: 200, height: 30, space: 'viewport-css' },
        },
        { nodeId: 'counter', role: 'text', name: String(state.activations), states: [] },
      ],
    };
    return {
      sessionId: id,
      snapshotId: state.snapshotId,
      timestamp: new Date().toISOString(),
      windowId: `window-${id}`,
      tabId: 'tab-1',
      root,
      scale: { dpr: 1, zoom: 1 },
      source:
        this.kind === 'compatible'
          ? 'playwright-accessibility'
          : this.kind === 'native'
            ? 'chromium-accessibility'
            : 'os-accessibility',
      url: state.url,
      tabs: [{ id: 'tab-1', title: 'ABR fixture', url: state.url, active: true }],
    };
  }

  /**
   * Produce independent test geometry without changing the public reference snapshot ID.
   * Args:
   *   id (string): Owned fake session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Explicit fake inspection with unit-scale viewport metadata.
   */
  async inspectionSnapshot(id: string): Promise<BrowserSnapshot> {
    const snapshot = await this.observe(id);
    return {
      ...snapshot,
      snapshotId: randomUUID(),
      geometry: {
        windowOrigin: { x: 0, y: 0 },
        viewportOrigin: { x: 0, y: 0 },
        monitorScale: 1,
        viewportMetricsVerified: true,
      },
    };
  }

  /**
   * Store a fixed fixture PNG through the test artifact writer.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<object>: Controlled artifact reference.
   */
  async screenshot(id: string): Promise<{ mimeType: 'image/png'; blobId: string }> {
    this.state(id);
    if (!this.screenshotSink)
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Test screenshot storage is unavailable.');
    return { mimeType: 'image/png', blobId: await this.screenshotSink(id, FIXTURE_PNG) };
  }

  /**
   * Apply a simulated operation without generating physical or trusted input.
   * Args:
   *   input (ActionRequest): Validated simulated operation.
   *   inspection (BrowserSnapshot | undefined): Independent coordinate authorization witness.
   * Returns:
   *   Promise<ActionResult>: Result explicitly identifying the unexecuted physical path.
   */
  async execute(input: ActionRequest, inspection?: BrowserSnapshot): Promise<ActionResult> {
    const state = this.state(input.sessionId);
    const startedAt = new Date().toISOString();
    if (state.paused) throw new BrowserError('DESKTOP_BUSY', 'Test session is paused.');
    // Reproduce semantic freshness checks without injecting physical or trusted input.
    if (inspection)
      validateCoordinateInspection(
        input,
        inspection,
        await this.inspectionSnapshot(input.sessionId),
      );
    // Verify stale references and cross-session coordinate ownership independently.
    if (input.target?.kind === 'ax-node' && input.target.snapshotId !== state.snapshotId)
      throw new BrowserError('TARGET_STALE', 'Test target has expired.');
    if (
      input.target?.kind === 'coordinate' &&
      input.target.windowId !== `window-${input.sessionId}`
    )
      throw new BrowserError('TARGET_NOT_FOUND', 'Coordinate window belongs to another session.');
    switch (input.action) {
      case 'navigate':
        state.history.push(state.url);
        state.url = String(input.args?.url);
        break;
      case 'go-back':
        state.url = state.history.pop() ?? state.url;
        break;
      case 'click':
      case 'double-click':
        state.activations += input.action === 'double-click' ? 2 : 1;
        break;
      case 'type-text':
        state.text += String(input.args?.text);
        break;
      case 'scroll':
        state.scrollY += Number(input.args?.deltaY);
        break;
      case 'key-press':
      case 'pointer-move':
      case 'drag':
      case 'choose-file':
      case 'switch-tab':
        break;
      default:
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Test operation is unavailable.');
    }
    this.events.push({
      sessionId: input.sessionId,
      requestId: input.requestId,
      action: input.action,
    });
    state.snapshotId = randomUUID();
    return {
      requestId: input.requestId,
      sessionId: input.sessionId,
      actionId: randomUUID(),
      status: 'succeeded',
      executionPath: 'not-executed',
      startedAt,
      finishedAt: new Date().toISOString(),
      snapshotIdAfter: state.snapshotId,
    };
  }

  /**
   * Pause simulated input.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<void>: Completion of state update.
   */
  async pause(id: string): Promise<void> {
    this.state(id).paused = true;
  }

  /**
   * Resume simulated input.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<void>: Completion of state update.
   */
  async resume(id: string): Promise<void> {
    this.state(id).paused = false;
  }

  /**
   * Release a simulated session idempotently.
   * Args:
   *   id (string): Fake session identifier.
   * Returns:
   *   Promise<void>: Completion of in-memory cleanup.
   */
  async close(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
