// -*- coding: utf-8 -*-
/**
 * models.ts
 * Browser output model validation
 * =====================
 * Validate adapter-produced snapshots, capability reports, and action results.
 */
import * as z from 'zod/v4';

import { BROWSER_ERROR_CODES, BrowserError } from './errors.js';
import { CAPABILITIES } from './validation.js';

// Output schemas reject fields that have not been admitted to the public contract.
export const errorSchema = z.strictObject({
  code: z.enum(BROWSER_ERROR_CODES),
  message: z.string().max(1024),
  retryable: z.boolean(),
  nextAction: z.string().optional(),
});
export const actionResultSchema = z.strictObject({
  requestId: z.string().min(1),
  actionId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'approval-required', 'cancelled']),
  executionPath: z.enum([
    'playwright-cdp',
    'os-input',
    'chromium-observer',
    'playwright-script',
    'not-executed',
  ]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  snapshotIdAfter: z.string().optional(),
  approvalId: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  error: errorSchema.optional(),
  actualStrategy: z
    .enum(['playwright-keyboard', 'playwright-insert-text', 'os-keyboard', 'os-unicode', 'os-ime'])
    .optional(),
});
export const capabilityReportSchema = z.strictObject({
  supported: z.array(z.enum(CAPABILITIES)),
  unsupported: z.partialRecord(z.enum(CAPABILITIES), z.string().min(1)),
});
const point = z.strictObject({ x: z.number(), y: z.number() });
const bounds = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  space: z.enum(['viewport-css', 'window-dip', 'screen-physical']),
});
// Recursive nodes preserve strict fields throughout the complete accessibility tree.
export const axNodeSchema = z.strictObject({
  nodeId: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  value: z.string().optional(),
  states: z.array(z.string()),
  bounds: bounds.optional(),
  get children() {
    return z.array(axNodeSchema).optional();
  },
});
export const snapshotSchema = z.strictObject({
  sessionId: z.string().min(1),
  snapshotId: z.string().min(1),
  timestamp: z.iso.datetime(),
  windowId: z.string().min(1),
  tabId: z.string().optional(),
  root: axNodeSchema,
  scale: z.strictObject({ dpr: z.number().positive(), zoom: z.number().positive() }),
  source: z.enum(['os-accessibility', 'chromium-accessibility', 'playwright-accessibility']),
  url: z.string().optional(),
  tabs: z
    .array(
      z.strictObject({ id: z.string(), title: z.string(), url: z.string(), active: z.boolean() }),
    )
    .optional(),
  geometry: z
    .strictObject({
      windowOrigin: point,
      viewportOrigin: point,
      monitorScale: z.number().positive(),
    })
    .optional(),
});

/**
 * Validate a browser adapter output without changing its contents.
 *
 * Args:
 *   schema (z.ZodType): Shared output schema.
 *   value (unknown): Adapter-produced result.
 * Returns:
 *   void: Completion of boundary validation.
 */
export function validateOutput(schema: z.ZodType, value: unknown): void {
  // Classify malformed adapter responses as application boundary failures.
  if (!schema.safeParse(value).success)
    throw new BrowserError('INTERNAL_ERROR', 'Adapter output violates its contract.');
}
