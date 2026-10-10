// -*- coding: utf-8 -*-
/**
 * stdio.test.ts
 * MCP client interoperability verification
 * =====================
 * Exercise the real stdio transport using isolated browser-free session state.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Read a structured object from a normal MCP tool result.
 * Args:
 *   result (CallToolResult): Result received by the official client.
 * Returns:
 *   Record<string, unknown>: Parsed public tool payload.
 */
function payload(result: CallToolResult): Record<string, unknown> {
  // Prefer structured content and preserve compatibility with text-only hosts.
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const text = result.content?.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') throw new Error('MCP tool result has no JSON payload.');
  return JSON.parse(text.text) as Record<string, unknown>;
}

/**
 * Verify catalog discovery, calls, rejection, and protocol-only standard output.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of real client and child process assertions.
 */
async function verifyStdio(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['tests/helpers/fake-server.mjs'],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      ABR_TEST_DATA_DIR: root,
    },
    stderr: 'pipe',
    maxBufferSize: 4 * 1024 * 1024,
  });
  const client = new Client({ name: 'abr-integration', version: '0.1.0' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.toString('utf8');
  });
  // Keep the disposable server and its private data root bounded to this test.
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(21);
    expect(tools.tools.some((tool) => tool.name === 'browser_action_approve')).toBe(false);
    expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    const session = payload(
      await client.callTool({
        name: 'browser_session_create',
        arguments: {
          engine: 'compatible',
          browser: 'bundled-chromium',
          profile: { mode: 'ephemeral' },
        },
      }),
    );
    const sessionId = String(session.id);
    expect(session.browserVersion).toBe('fake-test-only');
    const capabilities = payload(
      await client.callTool({ name: 'browser_capabilities', arguments: { sessionId } }),
    );
    expect(capabilities.supported).toContain('input.pointer');
    const navigation = await client.callTool({
      name: 'browser_navigate',
      arguments: { sessionId, requestId: 'navigate', url: 'http://127.0.0.1:1234/' },
    });
    expect(payload(navigation).status).toBe('succeeded');
    const snapshot = payload(
      await client.callTool({ name: 'browser_observe', arguments: { sessionId } }),
    );
    const target = { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: 'activate' };
    const click = { name: 'browser_click', arguments: { sessionId, requestId: 'click', target } };
    const first = payload(await client.callTool(click));
    const duplicate = payload(await client.callTool(click));
    expect(duplicate.actionId).toBe(first.actionId);
    const waiting = payload(
      await client.callTool({
        name: 'browser_wait_for',
        arguments: { sessionId, query: { role: 'button', name: 'Activate' }, state: 'visible' },
      }),
    );
    expect(waiting.nodeId).toBe('activate');
    const screenshot = await client.callTool({
      name: 'browser_screenshot',
      arguments: { sessionId },
    });
    expect(screenshot.content?.some((block) => block.type === 'image')).toBe(true);
    const blobId = String(payload(screenshot).blobId);
    const artifact = payload(
      await client.callTool({
        name: 'browser_artifact_read',
        arguments: { blobId, offset: 0, maxBytes: 8 },
      }),
    );
    expect(Buffer.from(String(artifact.data), 'base64')).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(artifact.nextOffset).toBe(8);
    const exported = payload(
      await client.callTool({
        name: 'browser_trace_export',
        arguments: { sessionId, format: 'html' },
      }),
    );
    expect(typeof exported.blobId).toBe('string');
    const denied = await client.callTool({
      name: 'browser_navigate',
      arguments: { sessionId, requestId: 'denied', url: 'https://example.com/' },
    });
    expect(denied.isError).toBe(true);
    expect((payload(denied).error as Record<string, unknown>).code).toBe('POLICY_DENIED');
    const invalid = await client
      .callTool({
        name: 'browser_capabilities',
        arguments: { sessionId, approvalToken: 'secret-should-not-be-logged' },
      })
      .catch(() => undefined);
    expect(invalid === undefined || invalid.isError === true).toBe(true);
    expect(diagnostics).not.toContain('secret-should-not-be-logged');
    await client.callTool({ name: 'browser_session_close', arguments: { sessionId } });
    expect(
      payload(await client.callTool({ name: 'browser_session_list', arguments: {} })).sessions,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId, status: 'closed' })]),
    );
  } finally {
    await client.close();
    await transport.close();
    // The test root is a directly allocated child of the system temporary directory.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-mcp-')
    )
      throw new Error('Invalid integration cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('official MCP client lists and calls browser tools over stdio', verifyStdio);
