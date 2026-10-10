// -*- coding: utf-8 -*-
/**
 * inspection.test.ts
 * Platform-independent coordinate inspection geometry
 * =====================
 * Verify effective DPR, rounding, semantic ancestry, and stable privacy-safe witness comparison.
 */
import { coordinateTargets, semanticIdentity, validateCoordinateInspection } from '@abr/contracts';
import type { BrowserSnapshot, CoordinateTarget } from '@abr/contracts';
import { expect, test } from 'vitest';

const snapshot: BrowserSnapshot = {
  sessionId: 'owned',
  snapshotId: 'inspection',
  timestamp: new Date().toISOString(),
  windowId: 'owned-window',
  tabId: 'owned-tab',
  url: 'http://127.0.0.1/',
  source: 'chromium-accessibility',
  scale: { dpr: 2.5, zoom: 2 },
  geometry: {
    windowOrigin: { x: -1200, y: 100 },
    viewportOrigin: { x: -1190, y: 200 },
    monitorScale: 1.25,
    viewportMetricsVerified: true,
  },
  root: {
    nodeId: 'root',
    role: 'document',
    states: [],
    children: [
      {
        nodeId: 'button',
        role: 'button',
        name: 'Delete message',
        states: [],
        bounds: { x: -950, y: 390, width: 100, height: 60, space: 'screen-physical' },
        children: [
          {
            nodeId: 'label',
            role: 'text',
            name: 'Delete message',
            states: [],
            bounds: { x: -945, y: 395, width: 90, height: 40, space: 'screen-physical' },
          },
        ],
      },
    ],
  },
};
const target: CoordinateTarget = {
  kind: 'coordinate',
  windowId: 'owned-window',
  x: 100,
  y: 80,
  space: 'viewport-css',
};

/**
 * Verify effective DPR is applied once and the semantic ancestry chain is retained.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of negative-origin, zoom, and ancestry assertions.
 */
function effectiveScale(): void {
  expect(coordinateTargets(snapshot, target).map((node) => node.nodeId)).toEqual([
    'button',
    'label',
  ]);
  const unverified = structuredClone(snapshot);
  unverified.geometry!.viewportMetricsVerified = false;
  expect(() => coordinateTargets(unverified, target)).toThrow('unverified');
  expect(() => coordinateTargets(snapshot, { ...target, windowId: 'foreign' })).toThrow(
    'another window',
  );
}

/**
 * Verify witness comparison excludes values and transient focus while binding labels and bounds.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of semantic stability and privacy-safe identity assertions.
 */
function stableIdentity(): void {
  const current = structuredClone(snapshot);
  current.snapshotId = 'fresh-independent';
  current.root.children![0]!.value = 'private-fixture-value';
  current.root.children![0]!.states = ['focused', 'hovered'];
  const input = { requestId: 'owned-action', sessionId: 'owned', action: 'click', target };
  expect(() => validateCoordinateInspection(input, snapshot, current)).not.toThrow();
  expect(JSON.stringify(semanticIdentity(coordinateTargets(current, target)))).not.toContain(
    'private-fixture-value',
  );
  current.root.children![0]!.name = 'Payment';
  expect(() => validateCoordinateInspection(input, snapshot, current)).toThrow(
    'semantic controls changed',
  );
  current.root.children![0]!.name = 'Delete message';
  current.root.children![0]!.bounds!.x += 1;
  expect(() => validateCoordinateInspection(input, snapshot, current)).toThrow(
    'semantic controls changed',
  );
}

/**
 * Verify unavailable controls and unrelated overlapping branches cannot authorize coordinates.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of protected and ambiguous geometry rejection assertions.
 */
function rejectUnavailable(): void {
  const protectedSnapshot = structuredClone(snapshot);
  protectedSnapshot.root.children![0]!.states.push('protected');
  expect(() => coordinateTargets(protectedSnapshot, target)).toThrow('protected');
  const overlapping = structuredClone(snapshot);
  overlapping.root.children!.push({
    ...overlapping.root.children![0]!,
    nodeId: 'other-branch',
    children: [],
  });
  expect(() => coordinateTargets(overlapping, target)).toThrow('overlap ambiguously');
}

test('coordinate inspection converts negative origins and effective DPR once', effectiveScale);
test(
  'inspection witnesses bind stable names and bounds while omitting values and focus',
  stableIdentity,
);
test(
  'coordinate inspection rejects protected controls and ambiguous semantic branches',
  rejectUnavailable,
);
