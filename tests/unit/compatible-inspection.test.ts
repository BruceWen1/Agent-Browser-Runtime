// -*- coding: utf-8 -*-
/**
 * compatible-inspection.test.ts
 * Compatible semantic inspection boundary tests
 * =====================
 * Exercise production readonly inspection and dispatch with explicit protocol doubles and no browser launch.
 */
import os from 'node:os';
import path from 'node:path';

import type { ActionRequest, BrowserSnapshot } from '@abr/contracts';
import { expect, test } from 'vitest';

import { PlaywrightBackend } from '../../packages/playwright-worker/src/backend.js';
import {
  IndependentInspection,
  inspectionBounds,
  inspectionMetrics,
} from '../../packages/playwright-worker/src/inspection.js';

type InspectionContext = ConstructorParameters<typeof IndependentInspection>[0];
type InspectionPage = ConstructorParameters<typeof IndependentInspection>[1];
type InspectionSession = Awaited<ReturnType<InspectionContext['newCDPSession']>>;

const sessionId = 'compatible-owned';
const callerSnapshotId = 'caller-original-snapshot';
const coordinate = {
  kind: 'coordinate' as const,
  x: 250,
  y: 35,
  space: 'viewport-css' as const,
  windowId: `pw-window-${sessionId}`,
};

/** ProtocolDouble exposes explicit CDP and page responses without providing a production fallback. */
class ProtocolDouble {
  readonly methods: string[] = [];
  readonly inputs: string[] = [];
  readonly selectors: string[] = [];
  destinationName = 'Drop here';
  frameCount = 1;
  malformedChildren = false;
  protectDestination = false;
  changeDuringDrag = false;
  detachCount = 0;
  readonly ariaCache = { reference: 'caller-ref' };

  /**
   * Provide complete explicit browser AX node relationships for the test protocol.
   * Args:
   *   None: Public fixture labels and fixed backend IDs define this double.
   * Returns:
   *   object[]: A root and two independently positioned semantic controls.
   */
  nodes() {
    return [
      {
        nodeId: '1',
        ignored: false,
        backendDOMNodeId: 1,
        role: { value: 'RootWebArea' },
        name: { value: 'Card reader fixture' },
        childIds: ['2', '3'],
      },
      {
        nodeId: '2',
        parentId: '1',
        ignored: false,
        backendDOMNodeId: 2,
        role: { value: 'button' },
        name: { value: 'Drag item' },
        childIds: this.malformedChildren ? ['2'] : [],
      },
      {
        nodeId: '3',
        parentId: '1',
        ignored: false,
        backendDOMNodeId: 3,
        role: { value: this.protectDestination ? 'textbox' : 'button' },
        name: { value: this.destinationName },
        value: { value: 'private-fixture-value' },
        childIds: [],
      },
    ];
  }

  /**
   * Answer only the readonly CDP operations used by the production inspector.
   * Args:
   *   method (string): Official CDP method identifier.
   *   params (object | undefined): Explicit backend-node selector.
   * Returns:
   *   Promise<object>: Fixed public protocol response or an unexpected-method failure.
   */
  async send(method: string, params?: { backendNodeId?: number }) {
    this.methods.push(method);
    if (method === 'Accessibility.enable') return {};
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'frame-1', url: this.url() } } };
    if (method === 'Page.getLayoutMetrics')
      return {
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 300 },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          offsetX: 0,
          offsetY: 0,
          clientWidth: 400,
          clientHeight: 300,
          scale: 1,
          zoom: 1,
        },
        visualViewport: { clientWidth: 400, clientHeight: 300, scale: 1 },
      };
    if (method === 'Accessibility.getFullAXTree') return { nodes: this.nodes() };
    if (method === 'DOM.describeNode')
      return {
        node: {
          attributes:
            this.protectDestination && params?.backendNodeId === 3
              ? ['autocomplete', 'cc-number']
              : [],
        },
      };
    if (method === 'DOM.getBoxModel') {
      const quad =
        params?.backendNodeId === 1
          ? [0, 0, 400, 0, 400, 300, 0, 300]
          : params?.backendNodeId === 2
            ? [10, 20, 110, 20, 110, 50, 10, 50]
            : [200, 20, 300, 20, 300, 50, 200, 50];
      return { model: { border: quad } };
    }
    throw new Error('Unexpected readonly protocol method.');
  }

  /**
   * Record release of the owned test channel.
   * Args:
   *   None: The explicit double owns no native browser resources.
   * Returns:
   *   Promise<void>: Completion of the recorded release.
   */
  async detach(): Promise<void> {
    this.detachCount++;
  }

  /**
   * Supply the test's independently owned CDP session.
   * Args:
   *   None: The inspector supplies its retained test page.
   * Returns:
   *   Promise<CDPSession>: Explicit readonly protocol double.
   */
  async newCDPSession(): Promise<InspectionSession> {
    return this as unknown as InspectionSession;
  }

  /**
   * Return the test page's frame inventory.
   * Args:
   *   None: Frame count is an explicit unsupported-boundary fixture.
   * Returns:
   *   object[]: Fixed single-frame or multi-frame inventory.
   */
  frames() {
    return Array.from({ length: this.frameCount }, () => ({}));
  }

  /**
   * Reject page-script evaluation from the independent policy inspector.
   * Args:
   *   None: Readonly metrics are supplied exclusively through CDP.
   * Returns:
   *   never: Page-script execution fails the readonly boundary test.
   */
  evaluate(): never {
    throw new Error('Readonly inspection executed page script.');
  }

  /**
   * Supply one loopback fixture URL as the current browser identity.
   * Args:
   *   None: The double performs no network request.
   * Returns:
   *   string: Public fixture identity.
   */
  url(): string {
    return 'http://127.0.0.1/inspection';
  }

  /**
   * Enforce the inspector's protocol-only title metadata boundary.
   * Args:
   *   None: Browser AX metadata supplies the public inspection title.
   * Returns:
   *   never: Any page-title evaluation fails the readonly boundary test.
   */
  title(): never {
    throw new Error('Readonly inspection requested page title evaluation.');
  }

  /**
   * Keep the explicit owned page available during the boundary test.
   * Args:
   *   None: This double has no running browser process.
   * Returns:
   *   boolean: False for the retained test page.
   */
  isClosed(): boolean {
    return false;
  }

  /**
   * Reject every ARIA snapshot call from readonly policy inspection.
   * Args:
   *   None: The caller reference cache is deliberately retained.
   * Returns:
   *   never: Any cache-overwriting snapshot call fails the test.
   */
  ariaSnapshotJSON(): never {
    throw new Error('Inspection overwrote caller ARIA cache.');
  }

  /**
   * Resolve only the retained caller ARIA reference used by mixed drag.
   * Args:
   *   selector (string): Exact official ARIA reference selector.
   * Returns:
   *   object: A retained locator with actual-fixture CSS bounds.
   */
  locator(selector: string) {
    this.selectors.push(selector);
    if (selector !== 'aria-ref=caller-ref') throw new Error('Caller ARIA identity changed.');
    return { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 30 }) };
  }

  /**
   * Record the fixture's explicit mouse commands.
   * Args:
   *   None: Production dispatch selects these methods directly.
   * Returns:
   *   object: Pointer-command recorders for the test page.
   */
  get mouse() {
    return {
      click: async () => {
        this.inputs.push('click');
      },
      move: async (x: number, y: number) => {
        this.inputs.push(`move:${x},${y}`);
        if (this.changeDuringDrag && x === 250) this.destinationName = 'Pay';
      },
      down: async () => {
        this.inputs.push('down');
      },
      up: async () => {
        this.inputs.push('up');
      },
    };
  }

  /**
   * Record trusted drag cancellation within the owned page.
   * Args:
   *   None: Production cleanup selects the Escape key explicitly.
   * Returns:
   *   object: Fixed keyboard cancellation recorder.
   */
  get keyboard() {
    return {
      press: async (key: string) => {
        this.inputs.push(`key:${key}`);
      },
    };
  }

  /**
   * Complete explicit context cleanup without opening or closing a real browser.
   * Args:
   *   None: This test supplies protocol doubles only.
   * Returns:
   *   Promise<void>: Completed test cleanup.
   */
  async close(): Promise<void> {}
}

/** BackendDouble substitutes only post-action observation and retains production policy dispatch. */
class BackendDouble extends PlaywrightBackend {
  returnedSnapshot?: BrowserSnapshot;

  /**
   * Return an explicit post-action observation after real production dispatch has completed.
   * Args:
   *   None: No actual browser or injected ARIA machinery runs in the unit test.
   * Returns:
   *   Promise<BrowserSnapshot>: Explicit independent test observation.
   */
  override async observe(): Promise<BrowserSnapshot> {
    return this.returnedSnapshot!;
  }
}

/**
 * Install one explicit page and caller-reference double into the real backend.
 * Args:
 *   page (ProtocolDouble): Readonly browser protocol fixture.
 * Returns:
 *   object: Production backend and retained caller reference state.
 */
function backendFixture(page: ProtocolDouble) {
  const backend = new BackendDouble({
    profileRoot: path.join(os.tmpdir(), 'abr-unit-profiles'),
    artifactRoot: path.join(os.tmpdir(), 'abr-unit-artifacts'),
  });
  const state = {
    page,
    context: page,
    session: { id: sessionId },
    paused: false,
    snapshotId: callerSnapshotId,
    nodes: new Map([
      ['caller-source', { ref: 'caller-ref', box: { x: 10, y: 20, width: 100, height: 30 } }],
    ]),
    tabs: new Map([['tab-1', page]]),
  };
  (Reflect.get(backend, 'sessions') as Map<string, unknown>).set(sessionId, state);
  return { backend, state };
}

/**
 * Verify independent inspection preserves both caller snapshot and retained ARIA identity.
 * Args:
 *   None: Explicit protocol doubles provide complete AX and DOM metadata.
 * Returns:
 *   Promise<void>: Completed preservation and actual-geometry checks.
 */
async function preservesCallerReferences(): Promise<void> {
  const page = new ProtocolDouble();
  const { backend, state } = backendFixture(page);
  const nodes = state.nodes;
  const first = await backend.inspectionSnapshot(sessionId);
  const second = await backend.inspectionSnapshot(sessionId);
  expect(first.snapshotId).not.toBe(second.snapshotId);
  expect(first.root.children?.[1]?.bounds).toMatchObject({
    x: 200,
    y: 20,
    width: 100,
    height: 30,
    space: 'viewport-css',
  });
  expect(first.geometry).toBeUndefined();
  expect(state.snapshotId).toBe(callerSnapshotId);
  expect(state.nodes).toBe(nodes);
  expect(state.nodes.get('caller-source')?.ref).toBe('caller-ref');
  expect(page.ariaCache.reference).toBe('caller-ref');
  expect(page.methods.filter((method) => method === 'Accessibility.enable')).toHaveLength(1);
  await backend.shutdown();
}

/**
 * Verify incomplete geometry or AX relationships produce explicit refusal.
 * Args:
 *   None: Frame, transformed-quad, and cyclic-tree boundaries are explicit test inputs.
 * Returns:
 *   Promise<void>: Completed unsupported and stale-structure assertions.
 */
async function unsupportedGeometry(): Promise<void> {
  expect(() => inspectionBounds([0, 0, 10, 2, 10, 10, 0, 10])).toThrowError(
    'Transformed DOM geometry',
  );
  const page = new ProtocolDouble();
  const inspector = new IndependentInspection(
    page as unknown as InspectionContext,
    page as unknown as InspectionPage,
  );
  page.frameCount = 2;
  await expect(inspector.read(sessionId, 'tab-1')).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
  });
  page.frameCount = 1;
  page.malformedChildren = true;
  await expect(inspector.read(sessionId, 'tab-1')).rejects.toMatchObject({ code: 'TARGET_STALE' });
  await inspector.close();
}

/**
 * Verify independent official layout measurements supply actual pixel ratios and zoom.
 * Args:
 *   None: Public protocol dimensions exercise both independent axes and missing metadata.
 * Returns:
 *   void: Completed readonly metric and explicit-refusal assertions.
 */
function readonlyMetrics(): void {
  const protocol = {
    cssLayoutViewport: { pageX: 20, pageY: 40, clientWidth: 400, clientHeight: 300 },
    cssVisualViewport: {
      pageX: 20,
      pageY: 40,
      offsetX: 0,
      offsetY: 0,
      clientWidth: 400,
      clientHeight: 300,
      scale: 1,
      zoom: 1.25,
    },
    visualViewport: { clientWidth: 800, clientHeight: 600, scale: 1 },
  };
  expect(inspectionMetrics(protocol)).toMatchObject({
    dpr: 2,
    zoom: 1.25,
    scrollX: 20,
    scrollY: 40,
  });
  expect(() =>
    inspectionMetrics({
      ...protocol,
      visualViewport: { clientWidth: 800, clientHeight: 450, scale: 1 },
    }),
  ).toThrowError('Readonly viewport pixel metrics are unverified');
  expect(() =>
    inspectionMetrics({
      ...protocol,
      cssVisualViewport: {
        pageX: 20,
        pageY: 40,
        offsetX: 0,
        offsetY: 0,
        clientWidth: 400,
        clientHeight: 300,
        scale: 1,
      },
    }),
  ).toThrowError('Readonly CSS layout metrics are unavailable');
}

/**
 * Verify private input metadata removes values and complete protected subtrees.
 * Args:
 *   None: A public synthetic card field tests the production privacy boundary.
 * Returns:
 *   Promise<void>: Completed private metadata exclusion checks.
 */
async function privateInspection(): Promise<void> {
  const page = new ProtocolDouble();
  page.protectDestination = true;
  page.destinationName = 'Card';
  const inspector = new IndependentInspection(
    page as unknown as InspectionContext,
    page as unknown as InspectionPage,
  );
  const snapshot = await inspector.read(sessionId, 'tab-1');
  expect(snapshot.root.name).toBe('Card reader fixture');
  expect(snapshot.root.children?.[1]).toMatchObject({
    name: 'Protected input',
    states: ['protected'],
    children: [],
  });
  expect(JSON.stringify(snapshot)).not.toContain('private-fixture-value');
  await inspector.close();
}

/**
 * Verify missing or changed authorization context prevents pointer dispatch.
 * Args:
 *   None: Coordinate semantics change from a fixture drop control to a payment control.
 * Returns:
 *   Promise<void>: Completed pre-dispatch refusal checks.
 */
async function rejectsChangedSemantics(): Promise<void> {
  const page = new ProtocolDouble();
  const { backend } = backendFixture(page);
  const input: ActionRequest = {
    sessionId,
    requestId: 'semantic-click',
    action: 'click',
    target: coordinate,
  };
  await expect(backend.execute(input)).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  const witness = await backend.inspectionSnapshot(sessionId);
  page.destinationName = 'Pay';
  await expect(backend.execute(input, witness)).rejects.toMatchObject({ code: 'TARGET_STALE' });
  expect(page.inputs).toEqual([]);
  page.destinationName = 'Drop here';
  await expect(
    backend.execute({ ...input, target: { ...coordinate, space: 'screen-physical' } }, witness),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(page.inputs).toEqual([]);
  await backend.shutdown();
}

/**
 * Verify mixed drag retains the caller AX reference through independent coordinate inspection.
 * Args:
 *   None: A retained AX source and public CSS destination define the drag.
 * Returns:
 *   Promise<void>: Completed dispatch identity and held-button cleanup checks.
 */
async function mixedDragReferences(): Promise<void> {
  const page = new ProtocolDouble();
  const { backend, state } = backendFixture(page);
  const witness = await backend.inspectionSnapshot(sessionId);
  backend.returnedSnapshot = witness;
  const input: ActionRequest = {
    sessionId,
    requestId: 'mixed-drag',
    action: 'drag',
    args: {
      source: { kind: 'ax-node', snapshotId: callerSnapshotId, nodeId: 'caller-source' },
      destination: coordinate,
    },
  };
  const result = await backend.execute(input, witness);
  expect(result.status).toBe('succeeded');
  expect(page.selectors).toEqual(['aria-ref=caller-ref']);
  expect(state.snapshotId).toBe(callerSnapshotId);
  expect(page.inputs).toEqual(['move:60,35', 'down', 'move:250,35', 'up']);
  page.changeDuringDrag = true;
  await expect(
    backend.execute({ ...input, requestId: 'changed-drag' }, witness),
  ).rejects.toMatchObject({ code: 'TARGET_STALE' });
  expect(page.inputs.slice(-2)).toEqual(['key:Escape', 'up']);
  await backend.shutdown();
}

test(
  'independent readonly CDP inspection preserves caller ARIA references',
  preservesCallerReferences,
);
test('incomplete or transformed inspection geometry remains explicit', unsupportedGeometry);
test(
  'official readonly layout metrics derive actual pixel ratio without page getters',
  readonlyMetrics,
);
test('inspection removes protected values and preserves document titles', privateInspection);
test('coordinate semantics are revalidated before pointer dispatch', rejectsChangedSemantics);
test('mixed drag keeps caller references and releases canceled pointer state', mixedDragReferences);
