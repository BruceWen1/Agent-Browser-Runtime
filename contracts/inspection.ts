// -*- coding: utf-8 -*-
/**
 * inspection.ts
 * Platform-independent coordinate authorization geometry
 * =====================
 * Resolve current semantic controls and bind coordinate input to stable inspection evidence.
 */
import type {
  ActionRequest,
  AxNode,
  BrowserSnapshot,
  CoordinateSpace,
  Target,
} from './browser-api.js';
import { BrowserError } from './errors.js';

export type CoordinateTarget = Extract<Target, { kind: 'coordinate' }>;
const CONTAINER_ROLES = new Set(['window', 'document', 'group', 'application']);
const BLOCKED_STATES = new Set([
  'disabled',
  'offscreen',
  'hidden',
  'invisible',
  'protected',
  'password',
]);

/**
 * Collect explicit coordinate references including both drag endpoints.
 * Args:
 *   input (ActionRequest): Validated caller operation.
 * Returns:
 *   CoordinateTarget[]: Coordinate targets in their requested endpoint order.
 */
export function coordinateReferences(input: ActionRequest): CoordinateTarget[] {
  const references = [
    input.target,
    ...(input.action === 'drag'
      ? [input.args?.source as Target, input.args?.destination as Target]
      : []),
  ];
  return references.filter((target): target is CoordinateTarget => target?.kind === 'coordinate');
}

/**
 * Convert a declared coordinate space into verified physical origin and scale.
 * Args:
 *   snapshot (BrowserSnapshot): Read-only geometry context.
 *   space (CoordinateSpace): Declared point or rectangle space.
 * Returns:
 *   object: Physical origin and scale with effective DPR applied exactly once.
 */
function physicalTransform(snapshot: BrowserSnapshot, space: CoordinateSpace) {
  if (space === 'screen-physical') return { x: 0, y: 0, scale: 1 };
  if (
    !snapshot.geometry ||
    (space === 'viewport-css' && !snapshot.geometry.viewportMetricsVerified)
  )
    throw new BrowserError(
      'UNSUPPORTED_CAPABILITY',
      'Inspection coordinate conversion is unverified.',
    );
  const origin =
    space === 'viewport-css' ? snapshot.geometry.viewportOrigin : snapshot.geometry.windowOrigin;
  return {
    ...origin,
    scale: space === 'viewport-css' ? snapshot.scale.dpr : snapshot.geometry.monitorScale,
  };
}

/**
 * Check a coordinate against one current semantic rectangle in a consistent space.
 * Args:
 *   snapshot (BrowserSnapshot): Independent current semantic observation.
 *   target (CoordinateTarget): Caller point bound to the observed window.
 *   bounds (NonNullable<AxNode['bounds']>): Visible node rectangle.
 * Returns:
 *   boolean: Whether the point lies within the rectangle's half-open boundaries.
 */
function contains(
  snapshot: BrowserSnapshot,
  target: CoordinateTarget,
  bounds: NonNullable<AxNode['bounds']>,
): boolean {
  // Compatible dispatch uses CSS points directly and does not claim OS screen conversion.
  if (
    snapshot.source === 'playwright-accessibility' &&
    target.space === 'viewport-css' &&
    bounds.space === target.space
  )
    return (
      target.x >= bounds.x &&
      target.y >= bounds.y &&
      target.x < bounds.x + bounds.width &&
      target.y < bounds.y + bounds.height
    );
  const point = physicalTransform(snapshot, target.space);
  const rectangle = physicalTransform(snapshot, bounds.space);
  const x = Math.round(point.x + target.x * point.scale);
  const y = Math.round(point.y + target.y * point.scale);
  const left = rectangle.x + bounds.x * rectangle.scale;
  const top = rectangle.y + bounds.y * rectangle.scale;
  return (
    x >= left &&
    y >= top &&
    x < left + bounds.width * rectangle.scale &&
    y < top + bounds.height * rectangle.scale
  );
}

/**
 * Resolve all current semantic controls in the unique ancestry chain under a coordinate.
 * Args:
 *   snapshot (BrowserSnapshot): Validated independent inspection.
 *   target (CoordinateTarget): Caller coordinate with owned window identity.
 * Returns:
 *   AxNode[]: Visible semantic ancestry for unified operation authorization.
 */
export function coordinateTargets(snapshot: BrowserSnapshot, target: CoordinateTarget): AxNode[] {
  if (snapshot.windowId !== target.windowId)
    throw new BrowserError('TARGET_STALE', 'Coordinate inspection belongs to another window.');
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y))
    throw new BrowserError('INVALID_ARGUMENT', 'Coordinate inspection requires finite points.');
  const hits: { node: AxNode; path: number[] }[] = [];
  let blocked = false;
  /**
   * Traverse visible metadata while retaining semantic ancestry and protected hit boundaries.
   * Args:
   *   node (AxNode): Current privacy-filtered subtree.
   *   path (number[]): Snapshot-local ancestry path.
   * Returns:
   *   void: Completion of bounded semantic hit collection.
   */
  function visit(node: AxNode, path: number[]): void {
    const bounds = node.bounds;
    const hit =
      bounds !== undefined &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      contains(snapshot, target, bounds);
    // Protected or unavailable controls contribute a rejection instead of a usable pointer target.
    if (node.states.some((state) => BLOCKED_STATES.has(state)) || node.role === 'password') {
      if (hit) blocked = true;
      return;
    }
    if (hit && !CONTAINER_ROLES.has(node.role)) hits.push({ node, path });
    for (const [index, child] of (node.children ?? []).entries()) visit(child, [...path, index]);
  }
  visit(snapshot.root, []);
  if (blocked)
    throw new BrowserError(
      'TARGET_OCCLUDED',
      'Coordinate intersects a protected or unavailable control.',
    );
  if (hits.length === 0)
    throw new BrowserError('TARGET_NOT_FOUND', 'Coordinate has no verified semantic control.');
  // Independent overlapping branches provide no trustworthy z-order for semantic authorization.
  for (const [index, hit] of hits.entries()) {
    for (const other of hits.slice(index + 1)) {
      const ancestor = hit.path.length <= other.path.length ? hit.path : other.path;
      const descendant = hit.path.length <= other.path.length ? other.path : hit.path;
      if (!ancestor.every((part, offset) => descendant[offset] === part))
        throw new BrowserError(
          'UNSUPPORTED_CAPABILITY',
          'Coordinate semantic controls overlap ambiguously.',
        );
    }
  }
  return hits.map((hit) => hit.node);
}

/**
 * Produce stable semantic identity without control values or temporary focus states.
 * Args:
 *   nodes (AxNode[]): Current authorized semantic controls.
 * Returns:
 *   object[]: Stable node IDs, roles, labels, and declared geometry.
 */
export function semanticIdentity(nodes: AxNode[]) {
  return nodes
    .map((node) => ({
      nodeId: node.nodeId,
      role: node.role,
      name: node.name ?? null,
      bounds: node.bounds ?? null,
    }))
    .sort((first, second) => first.nodeId.localeCompare(second.nodeId));
}

/**
 * Revalidate inspected coordinate semantics immediately before actual adapter dispatch.
 * Args:
 *   input (ActionRequest): Exact caller action with coordinate endpoints.
 *   inspection (BrowserSnapshot): Private authorization observation.
 *   current (BrowserSnapshot): Independent fresh observation inside the adapter input owner.
 * Returns:
 *   void: Admission only when current coordinate identity and semantic geometry match.
 */
export function validateCoordinateInspection(
  input: ActionRequest,
  inspection: BrowserSnapshot,
  current: BrowserSnapshot,
): void {
  if (
    inspection.sessionId !== input.sessionId ||
    current.sessionId !== input.sessionId ||
    inspection.source !== current.source ||
    inspection.windowId !== current.windowId ||
    inspection.tabId !== current.tabId ||
    inspection.url !== current.url ||
    JSON.stringify(inspection.scale) !== JSON.stringify(current.scale) ||
    JSON.stringify(inspection.geometry) !== JSON.stringify(current.geometry)
  )
    throw new BrowserError(
      'TARGET_STALE',
      'Coordinate inspection page or geometry changed before input.',
    );
  for (const target of coordinateReferences(input)) {
    const before = semanticIdentity(coordinateTargets(inspection, target));
    const after = semanticIdentity(coordinateTargets(current, target));
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new BrowserError('TARGET_STALE', 'Coordinate semantic controls changed before input.');
  }
}
