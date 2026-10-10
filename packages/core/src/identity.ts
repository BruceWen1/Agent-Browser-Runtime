// -*- coding: utf-8 -*-
/**
 * identity.ts
 * Stable operation identity
 * =====================
 * Preserve request identity across equivalent object property orderings.
 */
import { createHash } from 'node:crypto';

/**
 * Serialize JSON data with stable property ordering.
 * Args:
 *   value (unknown): JSON-compatible operation data.
 * Returns:
 *   string: Canonical representation preserving array order.
 */
export function canonicalJson(value: unknown): string {
  // Arrays preserve order and recursively canonicalize their members.
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  // Objects sort their keys before serializing member values.
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Compute a stable operation digest.
 * Args:
 *   value (unknown): JSON-compatible operation data.
 * Returns:
 *   string: SHA256 digest of the canonical payload.
 */
export function requestDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
