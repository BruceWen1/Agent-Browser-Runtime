// -*- coding: utf-8 -*-
/**
 * geometry.ts
 * Desktop target geometry validation
 * =====================
 * Resolve observed targets into physical screen coordinates with strict freshness checks.
 */
import { BrowserError } from '@abr/contracts';
import type { AxNode, BrowserSnapshot, Target } from '@abr/contracts';

/**
 * Find a semantic node within one observed tree.
 * Args:
 *   root (AxNode): Observed subtree.
 *   id (string): Snapshot node identifier.
 * Returns:
 *   AxNode | undefined: Matching semantic node.
 */
export function findAxNode(root: AxNode, id: string): AxNode | undefined {
  // Search the current node before its descendants.
  if (root.nodeId === id) return root;
  for (const child of root.children ?? []) {
    const node = findAxNode(child, id);
    if (node) return node;
  }
  return undefined;
}

/**
 * Resolve a target after checking current window geometry and semantic identity.
 * Args:
 *   target (Target): Caller-selected semantic or coordinate reference.
 *   previous (BrowserSnapshot): Snapshot originally given to the caller.
 *   current (BrowserSnapshot): Fresh read immediately before input.
 * Returns:
 *   object: Validated physical screen point.
 */
export function physicalPoint(
  target: Target,
  previous: BrowserSnapshot,
  current: BrowserSnapshot,
): { x: number; y: number } {
  // A moved, scaled, navigated, or rebound browser requires a new caller observation.
  if (
    previous.windowId !== current.windowId ||
    previous.tabId !== current.tabId ||
    previous.url !== current.url ||
    JSON.stringify(previous.geometry) !== JSON.stringify(current.geometry) ||
    JSON.stringify(previous.scale) !== JSON.stringify(current.scale)
  )
    throw new BrowserError(
      'TARGET_STALE',
      'Window geometry or page identity changed.',
      true,
      'browser_observe',
    );
  let x: number;
  let y: number;
  let space: string;
  // Validate semantic bounds against a fresh OS accessibility observation.
  if (target.kind === 'ax-node') {
    if (target.snapshotId !== previous.snapshotId)
      throw new BrowserError('TARGET_STALE', 'Snapshot reference has expired.');
    const old = findAxNode(previous.root, target.nodeId);
    const node = findAxNode(current.root, target.nodeId);
    if (!node || !old)
      throw new BrowserError('TARGET_NOT_FOUND', 'Semantic target is unavailable.');
    if (
      node.states.some((state) =>
        ['disabled', 'offscreen', 'protected', 'password'].includes(state),
      )
    )
      throw new BrowserError(
        'TARGET_OCCLUDED',
        'Semantic target is unavailable for pointer input.',
      );
    if (
      node.role !== old.role ||
      node.name !== old.name ||
      JSON.stringify(node.bounds) !== JSON.stringify(old.bounds)
    )
      throw new BrowserError('TARGET_STALE', 'Semantic target changed after observation.');
    if (!node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0)
      throw new BrowserError('TARGET_NOT_FOUND', 'Semantic target has no actionable bounds.');
    x = node.bounds.x + node.bounds.width / 2;
    y = node.bounds.y + node.bounds.height / 2;
    space = node.bounds.space;
  } else {
    if (target.windowId !== current.windowId)
      throw new BrowserError('TARGET_STALE', 'Coordinate belongs to another window.');
    ({ x, y, space } = target);
  }
  // Preserve physical coordinates and require explicit conversion metadata for other spaces.
  if (space === 'screen-physical') return { x: Math.round(x), y: Math.round(y) };
  if (!current.geometry)
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Coordinate conversion metadata is unavailable.',
    );
  // CSS geometry requires browser viewport measurements beyond OS window DPI.
  if (space === 'viewport-css' && !current.geometry.viewportMetricsVerified)
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Browser CSS viewport metrics are unverified.',
    );
  const origin =
    space === 'viewport-css' ? current.geometry.viewportOrigin : current.geometry.windowOrigin;
  const scale = space === 'viewport-css' ? current.scale.dpr : current.geometry.monitorScale;
  return { x: Math.round(origin.x + x * scale), y: Math.round(origin.y + y * scale) };
}
