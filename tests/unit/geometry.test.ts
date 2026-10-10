// -*- coding: utf-8 -*-
/**
 * geometry.test.ts
 * Physical input geometry checks
 * =====================
 * Verify negative monitor coordinates, scale conversion, and stale semantic rejection.
 */
import type { BrowserSnapshot } from '@abr/contracts';
import { physicalPoint } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

const snapshot: BrowserSnapshot = {
  sessionId: 'owned',
  snapshotId: 'reference',
  timestamp: new Date().toISOString(),
  windowId: 'window',
  url: 'http://127.0.0.1/',
  root: {
    nodeId: 'root',
    role: 'window',
    states: [],
    children: [
      {
        nodeId: 'button',
        role: 'button',
        name: 'Activate',
        states: [],
        bounds: { x: -1000, y: 200, width: 100, height: 40, space: 'screen-physical' },
      },
    ],
  },
  geometry: {
    windowOrigin: { x: -1200, y: 100 },
    viewportOrigin: { x: -1190, y: 200 },
    monitorScale: 1.25,
    viewportMetricsVerified: true,
  },
  scale: { dpr: 1.25, zoom: 1 },
  source: 'os-accessibility',
};

/**
 * Verify physical and DIP conversions across a negative-coordinate monitor.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of multi-monitor geometry assertions.
 */
function convert(): void {
  expect(
    physicalPoint(
      { kind: 'ax-node', snapshotId: 'reference', nodeId: 'button' },
      snapshot,
      snapshot,
    ),
  ).toEqual({ x: -950, y: 220 });
  expect(
    physicalPoint(
      { kind: 'coordinate', x: 100, y: 80, space: 'window-dip', windowId: 'window' },
      snapshot,
      snapshot,
    ),
  ).toEqual({ x: -1075, y: 200 });
  expect(
    physicalPoint(
      { kind: 'coordinate', x: 100, y: 80, space: 'viewport-css', windowId: 'window' },
      snapshot,
      snapshot,
    ),
  ).toEqual({ x: -1065, y: 300 });
  const zoomed = { ...snapshot, scale: { dpr: 2.5, zoom: 2 } };
  expect(
    physicalPoint(
      { kind: 'coordinate', x: 100, y: 80, space: 'viewport-css', windowId: 'window' },
      zoomed,
      zoomed,
    ),
  ).toEqual({ x: -940, y: 400 });
}

/**
 * Verify geometry, page, window, and target identity changes reject input.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of stale and inaccessible target assertions.
 */
function reject(): void {
  const target = { kind: 'ax-node' as const, snapshotId: 'reference', nodeId: 'button' };
  const moved = structuredClone(snapshot);
  moved.root.children![0]!.bounds!.x += 1;
  expect(() => physicalPoint(target, snapshot, moved)).toThrow('changed');
  const changedPage = { ...snapshot, url: 'http://localhost/' };
  expect(() => physicalPoint(target, snapshot, changedPage)).toThrow('identity');
  const scaled = { ...snapshot, scale: { dpr: 1.5, zoom: 1 } };
  expect(() => physicalPoint(target, snapshot, scaled)).toThrow('geometry');
  expect(() => physicalPoint({ ...target, snapshotId: 'expired' }, snapshot, snapshot)).toThrow(
    'expired',
  );
  const disabled = structuredClone(snapshot);
  disabled.root.children![0]!.states.push('disabled');
  expect(() => physicalPoint(target, snapshot, disabled)).toThrow('unavailable');
}

test('desktop geometry converts negative screen coordinates and 125 percent DPI', convert);
test('desktop geometry rejects changed pages, moved nodes, scaling, and disabled targets', reject);
