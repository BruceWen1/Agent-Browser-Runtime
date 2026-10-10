// -*- coding: utf-8 -*-
/**
 * native-tabs.test.ts
 * Native browser tab identity and OS input mapping
 * =====================
 * Exercise real adapter dispatch against explicit in-memory observer and desktop doubles.
 */
import { ChildProcess } from 'node:child_process';

import type { ActionRequest, AxNode, BrowserSnapshot, BrowserTab } from '@abr/contracts';
import { NativeEngine } from '@abr/native-ipc-client';
import type { AgentClient } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

const sessionId = 'native-owned';
const windowId = 'owned-hwnd';
const browserWindowId = 'browser-7';

/**
 * Create a visible physical browser chrome tab node.
 * Args:
 *   title (string): Exact browser-owned title.
 *   index (number): Tab order in the owned browser window.
 * Returns:
 *   AxNode: Explicit OS accessibility tab double.
 */
function osTab(title: string, index: number): AxNode {
  return {
    nodeId: `uia-tab-${index}`,
    role: 'tab',
    name: title,
    states: ['browser-tab', ...(index === 0 ? ['selected'] : [])],
    bounds: {
      x: -900 + index * 220,
      y: 120,
      width: 200,
      height: 40,
      space: 'screen-physical',
    },
  };
}

/** NativeTabHarness exposes authenticated in-memory channels without launching a process. */
class NativeTabHarness extends NativeEngine {
  readonly authoritativeTabs: BrowserTab[] = [
    { id: 'tab-41', title: 'First fixture', url: 'http://127.0.0.1/first', active: true },
    { id: 'tab-42', title: 'Second fixture', url: 'http://127.0.0.1/second', active: false },
  ];
  windows = [{ windowId: browserWindowId, osWindowId: windowId }];
  osRoot: AxNode = {
    nodeId: 'os-browser',
    role: 'window',
    states: [],
    bounds: { x: -1000, y: 100, width: 1000, height: 700, space: 'screen-physical' },
    children: [osTab('First fixture', 0), osTab('Second fixture', 1)],
  };
  readonly inputs: Record<string, unknown>[] = [];
  readonly desktopMethods: string[] = [];
  readonly observerMethods: string[] = [];
  osObservations = 0;
  activateOnInput = true;
  closeOnInput = false;
  cancelOnInput = false;
  pollActiveAfter = 0;
  activeReadsAfterInput = 0;
  beforeOsObserve?: (count: number) => void;

  /**
   * Install explicit observer and desktop channel doubles in the real adapter.
   * Args:
   *   None.
   * Returns:
   *   NativeTabHarness: Isolated dispatch harness with no physical browser or input.
   */
  constructor() {
    super({
      agentExecutable: 'unused-agent',
      runtimeDirectory: 'owned-runtime',
      profileRoot: 'owned-profiles',
      upstreamCommit: '0'.repeat(40),
      upstreamVersion: '0.0.0.0',
      /**
       * Reject unexpected real browser resolution.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Explicit unexpected-process failure.
       */
      async resolveBrowser() {
        throw new Error('This unit harness uses in-memory channels.');
      },
      /**
       * Reject unexpected screenshot storage.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Explicit unexpected-capture failure.
       */
      async putScreenshot() {
        throw new Error('This unit harness has no screenshot output.');
      },
    });
    this.sessions.set(sessionId, {
      metadata: {
        id: sessionId,
        engine: 'native',
        status: 'ready',
        browserVersion: '0.0.0.0',
        platform: 'unit-double',
        capabilities: [],
        createdAt: new Date().toISOString(),
        profileId: 'owned',
      },
      process: new ChildProcess(),
      windowId,
      cancelled: false,
    });
    // Inject doubles at existing private channel boundaries and retain real inherited dispatch.
    Reflect.set(this, 'agent', Promise.resolve({ call: this.desktopCall.bind(this) }));
    const observers = Reflect.get(this, 'observers') as Map<string, unknown>;
    observers.set(sessionId, {
      channel: { call: this.observerCall.bind(this) } as unknown as AgentClient,
      metadata: { browserCommit: '0'.repeat(40), browserVersion: '0.0.0.0' },
      browserWindowId,
    });
  }

  /**
   * Return synthetic authoritative browser state for closed read-only methods.
   * Args:
   *   method (string): Observer operation name.
   *   params (Record<string, unknown>): Scoped browser query parameters.
   * Returns:
   *   Promise<unknown>: Deep-copied browser state double.
   */
  private async observerCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.observerMethods.push(method);
    // Assert that every tab inventory targets the authoritative browser window ID.
    if (method === 'observer.listWindows') return structuredClone(this.windows);
    if (method === 'observer.listTabs') {
      expect(params.windowId).toBe(browserWindowId);
      if (this.inputs.length > 0 && this.pollActiveAfter > 0) {
        this.activeReadsAfterInput++;
        if (this.activeReadsAfterInput >= this.pollActiveAfter) this.activateSecond();
      }
      return structuredClone(this.authoritativeTabs);
    }
    if (method === 'observer.readAccessibility') {
      const tab = this.authoritativeTabs.find((tab) => tab.id === params.tabId)!;
      return {
        osWindowId: windowId,
        url: tab.url,
        root: {
          nodeId: `native-page-${tab.id}`,
          role: 'document',
          states: [],
          // Page tab-role content deliberately uses the requested native tab ID.
          children: [{ nodeId: 'tab-42', role: 'tab', states: ['browser-tab', 'selected'] }],
        },
        scale: { dpr: 1.25, zoom: 1 },
        geometry: {
          windowOrigin: { x: -1000, y: 100 },
          viewportOrigin: { x: -1000, y: 180 },
          monitorScale: 1.25,
          viewportMetricsVerified: true,
        },
      };
    }
    throw new Error('Unexpected observer operation.');
  }

  /**
   * Return synthetic OS chrome state and record one inherited input dispatch.
   * Args:
   *   method (string): Desktop operation name.
   *   params (Record<string, unknown>): Owned desktop operation parameters.
   * Returns:
   *   Promise<unknown>: Explicit desktop acknowledgement or accessibility tree.
   */
  private async desktopCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.desktopMethods.push(method);
    if (method === 'desktop.observe') {
      expect(params.sessionId).toBe(sessionId);
      this.osObservations++;
      this.beforeOsObserve?.(this.osObservations);
      return {
        windowId,
        root: structuredClone(this.osRoot),
        scale: { dpr: 1.25, zoom: 1 },
        geometry: {
          windowOrigin: { x: -1000, y: 100 },
          viewportOrigin: { x: -1000, y: 180 },
          monitorScale: 1.25,
          viewportMetricsVerified: false,
        },
      };
    }
    if (method === 'desktop.input') {
      this.inputs.push(structuredClone(params));
      if (this.activateOnInput) this.activateSecond();
      if (this.closeOnInput) this.authoritativeTabs.pop();
      if (this.cancelOnInput) this.session(sessionId).cancelled = true;
      return { accepted: true };
    }
    if (method === 'desktop.doctor')
      return { input: true, accessibility: true, screenCapture: true, tabs: true };
    throw new Error('Unexpected desktop operation.');
  }

  /**
   * Change the synthetic selected browser tab in both authoritative and OS state.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of the explicit tab activation double.
   */
  private activateSecond(): void {
    for (const [index, tab] of this.authoritativeTabs.entries()) tab.active = index === 1;
    for (const [index, node] of this.osRoot.children!.entries())
      node.states = ['browser-tab', ...(index === 1 ? ['selected'] : [])];
  }

  /**
   * Read the snapshot cached by the adapter after a verified tab switch.
   * Args:
   *   None.
   * Returns:
   *   BrowserSnapshot | undefined: Current public native snapshot.
   */
  publicSnapshot(): BrowserSnapshot | undefined {
    return this.session(sessionId).snapshot;
  }
}

/**
 * Create one stable native browser tab action envelope.
 * Args:
 *   timeoutMs (number): Action deadline including mapping and outcome verification.
 * Returns:
 *   ActionRequest: Requested second native tab switch.
 */
function switchRequest(timeoutMs = 1000): ActionRequest {
  return {
    requestId: 'owned-tab-request',
    sessionId,
    action: 'switch-tab',
    args: { tabId: 'tab-42' },
    timeoutMs,
  };
}

/**
 * Verify stable browser IDs become exactly one OS click while native snapshots stay public.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of mapping, identity, and execution-path assertions.
 */
async function switchMappedTab(): Promise<void> {
  const engine = new NativeTabHarness();
  const before = await engine.observe(sessionId);
  const result = await engine.execute({
    ...switchRequest(),
    expectedSnapshotId: before.snapshotId,
  });
  expect(result).toMatchObject({
    requestId: 'owned-tab-request',
    sessionId,
    executionPath: 'os-input',
    status: 'succeeded',
  });
  expect(engine.inputs).toHaveLength(1);
  expect(engine.inputs[0]).toMatchObject({ sessionId, kind: 'click', x: -580, y: 140 });
  expect(engine.osObservations).toBe(2);
  expect(engine.publicSnapshot()).toMatchObject({
    source: 'chromium-accessibility',
    root: { nodeId: 'native-page-tab-42' },
    tabId: 'tab-42',
    windowId,
    snapshotId: result.snapshotIdAfter,
  });
  expect(new Set(engine.observerMethods)).toEqual(
    new Set(['observer.listWindows', 'observer.listTabs', 'observer.readAccessibility']),
  );
  expect(new Set(engine.desktopMethods)).toEqual(new Set(['desktop.observe', 'desktop.input']));
}

/**
 * Reject ambiguous, hidden, or mismatched browser-to-OS tab mappings before input.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of unsafe mapping rejection assertions.
 */
async function rejectUnsafeMappings(): Promise<void> {
  const duplicate = new NativeTabHarness();
  duplicate.authoritativeTabs[1]!.title = duplicate.authoritativeTabs[0]!.title;
  duplicate.osRoot.children![1]!.name = duplicate.authoritativeTabs[0]!.title;
  const reordered = new NativeTabHarness();
  reordered.osRoot.children!.reverse();
  const wrongWindow = new NativeTabHarness();
  wrongWindow.windows[0]!.osWindowId = 'foreign-hwnd';
  const duplicateWindow = new NativeTabHarness();
  duplicateWindow.windows.push({ windowId: 'browser-other', osWindowId: windowId });
  const selectedMismatch = new NativeTabHarness();
  selectedMismatch.osRoot.children![0]!.states = ['browser-tab'];
  selectedMismatch.osRoot.children![1]!.states.push('selected');
  const hidden = new NativeTabHarness();
  hidden.osRoot.children![1]!.states.push('offscreen');
  const outside = new NativeTabHarness();
  outside.osRoot.children![1]!.bounds!.x = 2000;
  const overlap = new NativeTabHarness();
  overlap.osRoot.children![1]!.bounds!.x = -900;
  const closeButton = new NativeTabHarness();
  closeButton.osRoot.children![1]!.children = [
    {
      nodeId: 'close-tab',
      role: 'button',
      states: [],
      bounds: { x: -590, y: 130, width: 20, height: 20, space: 'screen-physical' },
    },
  ];
  const onlyPage = new NativeTabHarness();
  onlyPage.osRoot.children = [
    { nodeId: 'page', role: 'document', states: [], children: [osTab('Second fixture', 1)] },
  ];
  // Each inventory defect must fail before the inherited desktop input method.
  for (const [engine, code] of [
    [duplicate, 'UNSUPPORTED_CAPABILITY'],
    [reordered, 'UNSUPPORTED_CAPABILITY'],
    [wrongWindow, 'UNSUPPORTED_CAPABILITY'],
    [duplicateWindow, 'UNSUPPORTED_CAPABILITY'],
    [selectedMismatch, 'UNSUPPORTED_CAPABILITY'],
    [hidden, 'TARGET_OCCLUDED'],
    [outside, 'TARGET_OCCLUDED'],
    [overlap, 'UNSUPPORTED_CAPABILITY'],
    [closeButton, 'UNSUPPORTED_CAPABILITY'],
    [onlyPage, 'UNSUPPORTED_CAPABILITY'],
  ] as const) {
    await expect(engine.execute(switchRequest())).rejects.toMatchObject({ code });
    expect(engine.inputs).toHaveLength(0);
  }
}

/**
 * Verify a layout mutation is detected by the validation inside inherited input exclusivity.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of fresh geometry rejection assertions.
 */
async function rejectChangedLayout(): Promise<void> {
  const engine = new NativeTabHarness();
  /**
   * Move the OS tab immediately before the second chrome observation.
   * Args:
   *   count (number): Desktop observation ordinal.
   * Returns:
   *   void: Completion of the synthetic concurrent layout mutation.
   */
  engine.beforeOsObserve = (count: number): void => {
    if (count === 2) engine.osRoot.children![1]!.bounds!.x += 1;
  };
  await expect(engine.execute(switchRequest())).rejects.toMatchObject({ code: 'TARGET_STALE' });
  expect(engine.inputs).toHaveLength(0);
  expect(engine.osObservations).toBe(2);
}

/**
 * Verify publication delays are polled without replaying the OS click.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of active identity and single-input assertions.
 */
async function pollWithoutInputRetry(): Promise<void> {
  const engine = new NativeTabHarness();
  engine.activateOnInput = false;
  engine.pollActiveAfter = 4;
  await expect(engine.execute(switchRequest())).resolves.toMatchObject({ status: 'succeeded' });
  expect(engine.inputs).toHaveLength(1);
  expect(engine.activeReadsAfterInput).toBeGreaterThanOrEqual(4);
  expect(engine.publicSnapshot()?.tabId).toBe('tab-42');
}

/**
 * Verify timeout, cancellation, and post-input tab removal never replay physical input.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of failed-outcome and cancellation assertions.
 */
async function rejectFailedOutcome(): Promise<void> {
  const unchanged = new NativeTabHarness();
  unchanged.activateOnInput = false;
  await expect(unchanged.execute(switchRequest(200))).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(unchanged.inputs).toHaveLength(1);
  const cancelled = new NativeTabHarness();
  cancelled.cancelOnInput = true;
  await expect(cancelled.execute(switchRequest())).rejects.toMatchObject({ code: 'FOCUS_LOST' });
  expect(cancelled.inputs).toHaveLength(1);
  const closed = new NativeTabHarness();
  closed.activateOnInput = false;
  closed.closeOnInput = true;
  await expect(closed.execute(switchRequest())).rejects.toMatchObject({ code: 'TARGET_STALE' });
  expect(closed.inputs).toHaveLength(1);
}

/**
 * Verify unsupported tab mapping is reflected by live capability reporting.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of native supported and unavailable capability assertions.
 */
async function reportMappingCapability(): Promise<void> {
  const engine = new NativeTabHarness();
  expect((await engine.capabilities(sessionId)).supported).toContain('browser.tabs');
  engine.osRoot.children!.reverse();
  const report = await engine.capabilities(sessionId);
  expect(report.supported).not.toContain('browser.tabs');
  expect(report.unsupported['browser.tabs']).toMatch(/unambiguous visible OS chrome mapping/);
  expect(report.supported).toContain('observe.ax');
  expect(engine.inputs).toHaveLength(0);
}

test(
  'Native stable tab IDs map to one OS click and preserve native public snapshots',
  switchMappedTab,
);
test(
  'Native tabs reject ambiguous mappings, foreign HWNDs, hidden controls, and page roles',
  rejectUnsafeMappings,
);
test(
  'Native tabs revalidate changed chrome bounds before inherited physical dispatch',
  rejectChangedLayout,
);
test(
  'Native tabs poll delayed authoritative activation without input retry',
  pollWithoutInputRetry,
);
test(
  'Native tabs report failed activation, cancellation, and target closure without retry',
  rejectFailedOutcome,
);
test(
  'Native tab capabilities require a current exact visible Chrome strip mapping',
  reportMappingCapability,
);

/**
 * Verify native policy inspection keeps public Chromium AX caller references intact.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of native private snapshot and cache preservation assertions.
 */
async function preserveNativeInspectionCache(): Promise<void> {
  const engine = new NativeTabHarness();
  const caller = await engine.observe(sessionId);
  const inspection = await engine.inspectionSnapshot(sessionId);
  expect(inspection.source).toBe('chromium-accessibility');
  expect(inspection.snapshotId).not.toBe(caller.snapshotId);
  expect(engine.publicSnapshot()?.snapshotId).toBe(caller.snapshotId);
  expect(engine.inputs).toHaveLength(0);
}

test(
  'Native private inspection preserves Chromium AX caller reference caches',
  preserveNativeInspectionCache,
);
