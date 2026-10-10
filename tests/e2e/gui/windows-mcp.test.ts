// -*- coding: utf-8 -*-
/**
 * windows-mcp.test.ts
 * Windows physical GUI product MCP verification
 * =====================
 * Exercise authorized OS input through the production command and official MCP stdio client.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { snapshotSchema, validateOutput } from '@abr/contracts';
import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import { defaultConfiguration } from '@abr/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, test } from 'vitest';

import { startFixture } from '../../helpers/fixture-server.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Retrieve a structured MCP object while retaining safe typed failure metadata.
 * Args:
 *   result (ToolResult): Official client tool response.
 * Returns:
 *   Record<string, unknown>: Successful structured protocol payload.
 */
function payload(result: ToolResult): Record<string, unknown> {
  if (!result.structuredContent) throw new Error('Structured GUI MCP output is required.');
  const value = result.structuredContent as Record<string, unknown>;
  // Report bounded error codes without printing protocol payloads or submitted values.
  if (result.isError) {
    const code = (value.error as { code?: unknown } | undefined)?.code;
    throw new Error(
      typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)
        ? `GUI MCP tool failed with ${code}.`
        : 'GUI MCP tool failed.',
    );
  }
  return value;
}

/**
 * Invoke one canonical product tool through the official MCP client.
 * Args:
 *   client (Client): Connected production client.
 *   name (string): Canonical browser tool name.
 *   args (Record<string, unknown>): Strict tool arguments.
 * Returns:
 *   Promise<Record<string, unknown>>: Successful structured tool result.
 */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payload(await client.callTool({ name, arguments: args }));
}

/**
 * Find an exact accessible fixture name in a public system observation.
 * Args:
 *   root (AxNode): Privacy-filtered OS accessibility subtree.
 *   name (string): Exact fixture accessible name.
 *   role (string | undefined): Optional semantic role constraint.
 * Returns:
 *   AxNode | undefined: Matching public fixture node.
 */
function find(root: AxNode, name: string, role?: string): AxNode | undefined {
  if (root.name === name && (!role || root.role === role)) return root;
  for (const child of root.children ?? []) {
    const found = find(child, name, role);
    if (found) return found;
  }
  return undefined;
}

/**
 * Read one strict GUI snapshot from the production MCP observation tool.
 * Args:
 *   client (Client): Connected production client.
 *   sessionId (string): Owned GUI browser identity.
 * Returns:
 *   Promise<BrowserSnapshot>: Validated OS accessibility observation.
 */
async function observe(client: Client, sessionId: string): Promise<BrowserSnapshot> {
  const snapshot = (await call(client, 'browser_observe', {
    sessionId,
  })) as unknown as BrowserSnapshot;
  validateOutput(snapshotSchema, snapshot);
  expect(snapshot.source).toBe('os-accessibility');
  expect(snapshot.sessionId).toBe(sessionId);
  expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
  return snapshot;
}

/**
 * Wait for a public fixture outcome by reading fresh snapshots only.
 * Args:
 *   client (Client): Connected production client.
 *   sessionId (string): Owned GUI browser identity.
 *   name (string): Exact accessible outcome name.
 *   role (string | undefined): Optional semantic role constraint.
 * Returns:
 *   Promise<BrowserSnapshot>: Fresh snapshot containing the visible requested outcome.
 */
async function waitForNode(
  client: Client,
  sessionId: string,
  name: string,
  role?: string,
): Promise<BrowserSnapshot> {
  // Retry observation while the native accessibility provider publishes the actual page state.
  for (let attempt = 0; attempt < 30; attempt++) {
    const snapshot = await observe(client, sessionId);
    if (find(snapshot.root, name, role)) return snapshot;
    await delay(100);
  }
  throw new Error('GUI fixture accessibility outcome did not become available.');
}

/**
 * Verify one guarded product GUI workflow and kernel-confirmed profile release.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of real OS outcomes, privacy, protocol, and cleanup assertions.
 */
async function verifyGuiMcp(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-gui-mcp-'));
  const fixture = await startFixture();
  const config = defaultConfiguration();
  config.runtime.defaultEngine = 'gui';
  config.runtime.actionTimeoutMs = 15000;
  config.gui.agentExecutable = path.resolve('target/debug/abr-desktop-agent.exe');
  const configFile = path.join(root, 'test-config.json');
  // Bind the test to its freshly built agent and independent local configuration.
  await writeFile(configFile, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  const typedText = 'ABR MCP native';
  const queryCanary = 'gui-mcp-query-canary';
  const url = `${fixture.url}?privacy=${queryCanary}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/cli/dist/main.js', 'mcp', 'serve', '--stdio', '--config', configFile],
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
    maxBufferSize: 4 * 1024 * 1024,
  });
  const client = new Client({ name: 'abr-gui-product-test', version: '0.1.0' });
  let protocolMessages = 0;
  let protocolErrors = 0;
  let invalidProtocolMessages = 0;
  let diagnosticLeak = false;
  let diagnosticTail = '';
  let sessionId: string | undefined;
  let sessionClosed = false;
  let cleanupVerified = false;
  let cleanupError: unknown;
  /**
   * Count public JSON-RPC frames without retaining payloads or screenshot data.
   * Args:
   *   message (JSONRPCMessage): Frame parsed by the official stdio transport.
   * Returns:
   *   void: Completion of the protocol-only output check.
   */
  transport.onmessage = (message): void => {
    protocolMessages++;
    if (message.jsonrpc !== '2.0') invalidProtocolMessages++;
  };
  /**
   * Count invalid or malformed stdout frames without retaining raw diagnostics.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of the bounded protocol error counter update.
   */
  transport.onerror = (): void => {
    protocolErrors++;
  };
  /**
   * Count client protocol failures without forwarding payload-bearing error messages.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of the bounded client error counter update.
   */
  client.onerror = (): void => {
    protocolErrors++;
  };
  /**
   * Detect fixture text or URL-query leakage across stderr chunk boundaries.
   * Args:
   *   bytes (Buffer): Production diagnostics chunk.
   * Returns:
   *   void: Completion of the streaming privacy check.
   */
  transport.stderr?.on('data', (bytes: Buffer): void => {
    const content = diagnosticTail + bytes.toString('utf8');
    diagnosticLeak ||= [typedText, 'fixture-secret', queryCanary].some((value) =>
      content.includes(value),
    );
    diagnosticTail = content.slice(-256);
  });
  // Close the owned session before deleting its allocated profile and application data.
  try {
    await client.connect(transport);
    const session = await call(client, 'browser_session_create', {
      engine: 'gui',
      browser: 'bundled-chromium',
      profile: { mode: 'ephemeral' },
      locale: 'en-US',
      headless: false,
    });
    sessionId = String(session.id);
    expect(session).toMatchObject({ engine: 'gui', status: 'ready' });
    expect(session.browserVersion).not.toBe('unverified');
    expect(session.browserVersion).not.toBe('fake-test-only');
    const capabilities = await call(client, 'browser_capabilities', { sessionId });
    expect(capabilities.supported).toEqual(
      expect.arrayContaining([
        'observe.ax',
        'observe.screenshot',
        'input.pointer',
        'input.keyboard',
        'browser.navigate',
      ]),
    );
    expect(
      await call(client, 'browser_navigate', { sessionId, requestId: 'gui-mcp-navigate', url }),
    ).toMatchObject({ status: 'succeeded', executionPath: 'os-input' });
    let snapshot = await waitForNode(client, sessionId, 'Activate', 'button');
    expect(snapshot.url).toBe(new URL(url).href);
    const button = find(snapshot.root, 'Activate', 'button')!;
    expect(
      await call(client, 'browser_click', {
        sessionId,
        requestId: 'gui-mcp-activate',
        target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: button.nodeId },
      }),
    ).toMatchObject({ status: 'succeeded', executionPath: 'os-input' });
    snapshot = await waitForNode(client, sessionId, '1');
    const query = find(snapshot.root, 'Query', 'textbox');
    expect(query).toBeDefined();
    expect(
      await call(client, 'browser_click', {
        sessionId,
        requestId: 'gui-mcp-query-focus',
        target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: query!.nodeId },
      }),
    ).toMatchObject({ status: 'succeeded', executionPath: 'os-input' });
    expect(
      await call(client, 'browser_type_text', {
        sessionId,
        requestId: 'gui-mcp-text',
        text: typedText,
        strategy: 'auto',
      }),
    ).toMatchObject({
      status: 'succeeded',
      executionPath: 'os-input',
      actualStrategy: 'os-unicode',
    });
    snapshot = await observe(client, sessionId);
    expect(find(snapshot.root, 'Query', 'textbox')?.value === typedText).toBe(true);
    const screenshot = payload(
      await client.callTool({ name: 'browser_screenshot', arguments: { sessionId } }),
    );
    expect(screenshot.mimeType).toBe('image/png');
    expect(typeof screenshot.blobId).toBe('string');
    // Validate controlled artifact bytes for both inline and larger screenshot responses.
    const artifact = await call(client, 'browser_artifact_read', {
      blobId: screenshot.blobId,
      offset: 0,
      maxBytes: 8,
    });
    expect(artifact.sessionId).toBe(sessionId);
    expect(artifact.mimeType).toBe('image/png');
    expect(Buffer.from(String(artifact.data), 'base64')).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(await call(client, 'browser_session_close', { sessionId })).toMatchObject({
      sessionId,
      status: 'closed',
    });
    sessionClosed = true;
    expect((await call(client, 'browser_session_list', {})).sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId, status: 'closed' })]),
    );
    expect(await readdir(path.join(root, 'profiles'))).toEqual([]);
    cleanupVerified = true;
    expect(protocolMessages).toBeGreaterThan(10);
    expect(protocolErrors).toBe(0);
    expect(invalidProtocolMessages).toBe(0);
    expect(diagnosticLeak).toBe(false);
  } finally {
    // Retry owned cleanup only when the test body has not obtained a closed-session acknowledgement.
    try {
      if (sessionId && !sessionClosed) {
        const closed = await call(client, 'browser_session_close', { sessionId });
        sessionClosed = closed.status === 'closed';
      }
      if (sessionClosed && (await readdir(path.join(root, 'profiles'))).length === 0)
        cleanupVerified = true;
    } catch (error) {
      cleanupError = error;
    }
    await client.close();
    await transport.close();
    await fixture.close();
    expect(diagnosticLeak).toBe(false);
    // Preserve unverified browser resources for inspection when process cleanup failed.
    if (cleanupVerified) {
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('abr-gui-mcp-')
      )
        throw new Error('Invalid GUI MCP cleanup root.');
      await rm(root, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
  }
}

test.skipIf(
  process.env.ABR_GUI_E2E !== '1' ||
    process.platform !== 'win32' ||
    !existsSync('target/debug/abr-desktop-agent.exe'),
)(
  'production MCP uses actual Windows OS input and releases its owned native browser profile',
  verifyGuiMcp,
  90000,
);
