// -*- coding: utf-8 -*-
/**
 * privacy.ts
 * Accessibility privacy filtering
 * =====================
 * Remove protected field values before caching or exposing browser observations.
 */
import type { AxNode, BrowserSnapshot } from '@abr/contracts';

/**
 * Filter protected input values within an accessibility subtree.
 * Args:
 *   node (AxNode): Adapter-produced accessibility subtree.
 * Returns:
 *   AxNode: Copy containing privacy-filtered field values.
 */
function filterNode(node: AxNode): AxNode {
  const result = { ...node };
  // Protected controls preserve their target identity and geometric information.
  if (
    node.states.includes('protected') ||
    node.states.includes('password') ||
    node.role === 'password'
  ) {
    result.value = '[REDACTED]';
    result.name = 'Protected input';
    result.children = [];
    return result;
  }
  if (node.children) result.children = node.children.map(filterNode);
  return result;
}

/**
 * Filter protected fields in a complete browser snapshot.
 * Args:
 *   snapshot (BrowserSnapshot): Validated adapter observation.
 * Returns:
 *   BrowserSnapshot: Privacy-filtered observation.
 */
export function filterSnapshot(snapshot: BrowserSnapshot): BrowserSnapshot {
  return { ...snapshot, root: filterNode(snapshot.root) };
}
