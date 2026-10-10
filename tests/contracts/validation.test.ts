// -*- coding: utf-8 -*-
/**
 * validation.test.ts
 * Contract boundary verification
 * =====================
 * Verify schema interoperability and rejection of ambiguous or unauthorized input.
 */
import { readFileSync } from 'node:fs';

import {
  BROWSER_ERROR_CODES,
  BrowserError,
  MCP_TOOLS,
  normalizeError,
  parseAction,
  parseSession,
  toolInputSchema,
  validate,
} from '@abr/contracts';
import { expect, test } from 'vitest';

/**
 * Construct a small valid value for a tool schema.
 *
 * Args:
 *   schema (Record<string, unknown>): Schema describing a required input.
 * Returns:
 *   unknown: Representative input covering each advertised schema branch.
 */
function minimal(schema: Record<string, unknown>): unknown {
  // Select literal and union branches before evaluating primitive types.
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.oneOf)) return minimal(schema.oneOf[0] as Record<string, unknown>);
  // Populate exactly the required fields of strict objects.
  if (schema.type === 'object') {
    const result: Record<string, unknown> = {};
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    // Recursively populate the object's required property values.
    for (const key of (schema.required ?? []) as string[]) result[key] = minimal(properties[key]!);
    return result;
  }
  // Generate representative primitive values satisfying documented constraints.
  if (schema.type === 'array') return [];
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  if (schema.format === 'uri') return 'http://127.0.0.1/';
  return 'example';
}

/**
 * Verify every advertised tool accepts valid input and rejects extra fields.
 *
 * Args:
 *   None.
 * Returns:
 *   void: Completion of manifest and converter boundary checks.
 */
function verifyTools(): void {
  expect(MCP_TOOLS).toHaveLength(21);
  expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(21);
  // Exercise canonical and SDK validators for every public tool.
  for (const tool of MCP_TOOLS) {
    const input = minimal(tool.inputSchema as Record<string, unknown>) as Record<string, unknown>;
    validate(tool.name, input);
    expect(toolInputSchema(tool).safeParse(input).success).toBe(true);
    expect(() => validate(tool.name, { ...input, approvalToken: 'unauthorized' })).toThrow(
      BrowserError,
    );
    expect(
      toolInputSchema(tool).safeParse({ ...input, approvalToken: 'unauthorized' }).success,
    ).toBe(false);
  }
  expect(MCP_TOOLS.some((tool) => tool.name === 'browser_action_approve')).toBe(false);
}

/**
 * Verify supplied examples and reject a target containing both union branches.
 *
 * Args:
 *   None.
 * Returns:
 *   void: Completion of example and target union checks.
 */
function verifyExamples(): void {
  // Check the original example artifacts against their actual runtime contracts.
  for (const [schema, filename] of [
    ['action', 'action-click'],
    ['session', 'browser-session'],
    ['browser-event', 'gui-event-trace'],
  ]) {
    const example = JSON.parse(readFileSync(`examples/${filename}.json`, 'utf8')) as unknown;
    validate(schema!, example);
  }
  expect(() =>
    parseAction({
      requestId: 'a',
      sessionId: 's',
      action: 'click',
      target: { kind: 'ax-node', snapshotId: 'x', nodeId: 'n', x: 1, y: 2, windowId: 'w' },
    }),
  ).toThrow(BrowserError);
}

/**
 * Verify argument ownership and engine-specific session constraints.
 *
 * Args:
 *   None.
 * Returns:
 *   void: Completion of reserved field and session mode checks.
 */
function verifySemantics(): void {
  expect(() =>
    parseAction({
      requestId: 'a',
      sessionId: 's',
      action: 'navigate',
      args: {
        requestId: 'replacement',
        url: 'http://127.0.0.1/',
      },
    }),
  ).toThrow(BrowserError);
  expect(() =>
    parseAction({ requestId: 'a', sessionId: 's', action: 'evaluate', args: {} }),
  ).toThrow(BrowserError);
  expect(() =>
    parseSession({
      engine: 'gui',
      browser: 'installed-chrome',
      profile: { mode: 'ephemeral' },
      headless: true,
    }),
  ).toThrow(BrowserError);
  expect(() =>
    parseSession({
      engine: 'compatible',
      browser: 'bundled-chromium',
      profile: { mode: 'persistent' },
    }),
  ).toThrow(BrowserError);
}

/**
 * Verify mutually exclusive IPC responses and safe error normalization.
 *
 * Args:
 *   None.
 * Returns:
 *   void: Completion of response and diagnostic confidentiality checks.
 */
function verifyResponses(): void {
  validate('ipc-response', { schemaVersion: 1, requestId: 'a', ok: true, result: {} });
  expect(() =>
    validate('ipc-response', {
      schemaVersion: 1,
      requestId: 'a',
      ok: true,
      result: {},
      error: { code: 'INTERNAL_ERROR', message: 'error', retryable: false },
    }),
  ).toThrow(BrowserError);
  expect(new Set(BROWSER_ERROR_CODES).size).toBe(16);
  expect(normalizeError(new Error('secret-value')).toJSON().message).not.toContain('secret-value');
}

test('all tool inputs preserve strict canonical and SDK validation', verifyTools);
test('examples validate and mixed target unions are rejected', verifyExamples);
test('reserved fields and invalid engine configurations are rejected', verifySemantics);
test('IPC responses are exclusive and unexpected errors are masked', verifyResponses);
