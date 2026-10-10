// -*- coding: utf-8 -*-
/**
 * mcp.test.ts
 * Production compatible MCP verification
 * =====================
 * Exercise actual browser behavior through the product command and official MCP client.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

import { startFixture } from '../../helpers/fixture-server.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Retrieve the structured payload of a tool invocation.
 * Args:
 *   result (ToolResult): Official client response.
 * Returns:
 *   Record<string, unknown>: Public structured result.
 */
function payload(result: ToolResult): Record<string, unknown> {
  if (!result.structuredContent) throw new Error('Structured MCP output is required.');
  return result.structuredContent as Record<string, unknown>;
}

/**
 * Locate a controlled fixture node by semantic role and name.
 * Args:
 *   node (AxNode): Standardized accessibility subtree.
 *   role (string): Required semantic role.
 *   name (string): Exact accessible name.
 * Returns:
 *   AxNode | undefined: Matching node.
 */
function find(node: AxNode, role: string, name: string): AxNode | undefined {
  if (node.role === role && node.name === name) return node;
  for (const child of node.children ?? []) {
    const result = find(child, role, name);
    if (result) return result;
  }
  return undefined;
}

/**
 * Verify the full product MCP workflow on an actual headed browser.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of browser outcome, privacy, and profile assertions.
 */
async function verifyProductMcp(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-product-mcp-'));
  const fixture = await startFixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/cli/dist/main.js', 'mcp', 'serve', '--stdio'],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ABR_DATA_DIR: root,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'abr-product-test', version: '0.1.0' });
  let diagnostics = '';
  transport.stderr?.on('data', (bytes: Buffer) => {
    diagnostics += bytes.toString();
  });
  // Release all owned product, browser, and fixture resources after verification.
  try {
    await client.connect(transport);
    const session = payload(
      await client.callTool({
        name: 'browser_session_create',
        arguments: {
          engine: 'compatible',
          browser: 'bundled-chromium',
          profile: { mode: 'ephemeral' },
          headless: false,
        },
      }),
    );
    const sessionId = String(session.id);
    expect(session.browserVersion).not.toBe('fake-test-only');
    expect(
      (
        await client.callTool({
          name: 'browser_navigate',
          arguments: { sessionId, requestId: 'navigate', url: fixture.url },
        })
      ).isError,
    ).not.toBe(true);
    const snapshot = payload(
      await client.callTool({ name: 'browser_observe', arguments: { sessionId } }),
    ) as unknown as BrowserSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    const textbox = find(snapshot.root, 'textbox', 'Query');
    expect(textbox).toBeDefined();
    await client.callTool({
      name: 'browser_click',
      arguments: {
        sessionId,
        requestId: 'focus',
        target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: textbox!.nodeId },
      },
    });
    const typed = payload(
      await client.callTool({
        name: 'browser_type_text',
        arguments: {
          sessionId,
          requestId: 'type',
          text: 'fixture-typed-value',
          strategy: 'keyboard',
        },
      }),
    );
    expect(typed.status).toBe('succeeded');
    expect(typed.actualStrategy).toBe('playwright-keyboard');
    const updated = payload(
      await client.callTool({ name: 'browser_observe', arguments: { sessionId } }),
    ) as unknown as BrowserSnapshot;
    expect(JSON.stringify(updated.root)).toContain('fixture-typed-value');
    const button = find(updated.root, 'button', 'Activate');
    await client.callTool({
      name: 'browser_click',
      arguments: {
        sessionId,
        requestId: 'activate',
        target: { kind: 'ax-node', snapshotId: updated.snapshotId, nodeId: button!.nodeId },
      },
    });
    const outcome = payload(
      await client.callTool({ name: 'browser_observe', arguments: { sessionId } }),
    ) as unknown as BrowserSnapshot;
    expect(find(outcome.root, 'text', '1')).toBeDefined();
    const screenshot = await client.callTool({
      name: 'browser_screenshot',
      arguments: { sessionId },
    });
    expect(screenshot.content?.some((content) => content.type === 'image')).toBe(true);
    const denied = payload(
      await client.callTool({
        name: 'browser_navigate',
        arguments: { sessionId, requestId: 'denied', url: 'https://example.com/' },
      }),
    );
    expect((denied.error as Record<string, unknown>).code).toBe('POLICY_DENIED');
    await client.callTool({ name: 'browser_session_close', arguments: { sessionId } });
    expect(await readdir(path.join(root, 'profiles'))).toEqual([]);
    expect(diagnostics).not.toContain('fixture-typed-value');
  } finally {
    await client.close();
    await transport.close();
    await fixture.close();
    // Remove only the test root allocated directly beneath the temporary directory.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-product-mcp-')
    )
      throw new Error('Invalid product test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'product MCP controls actual compatible browser and cleans isolated profiles',
  verifyProductMcp,
  60000,
);
