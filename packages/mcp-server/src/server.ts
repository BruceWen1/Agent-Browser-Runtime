// -*- coding: utf-8 -*-
/**
 * server.ts
 * Browser MCP tool adapter
 * =====================
 * Expose strict session and action tools through the official MCP server interface.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  ACTION_TO_TOOL,
  BrowserError,
  MCP_TOOLS,
  normalizeError,
  toolInputSchema,
  validate,
} from '@abr/contracts';
import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import type { PolicyEngine, Runtime } from '@abr/core';
import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server';

export interface McpArtifactAccess {
  read(blobId: string): Promise<{ sessionId: string; mimeType: string; bytes: Buffer }>;
  exportTrace(sessionId: string, format: 'json' | 'html'): Promise<string>;
}
export interface McpDependencies {
  policy: PolicyEngine;
  artifacts?: McpArtifactAccess;
  audit?: (event: { event: string; tool: string; code?: string }) => void;
  dispose?: () => Promise<void>;
}

// Tool descriptions explain public capabilities and required workflow semantics.
const DESCRIPTIONS: Record<string, string> = {
  browser_session_create: 'Create an isolated browser session with an explicit execution engine.',
  browser_session_list: 'List browser sessions owned by the current local user.',
  browser_session_close: 'Close a browser session and release its owned resources.',
  browser_capabilities: 'Report supported capabilities and explicit unavailability reasons.',
  browser_observe: 'Read a versioned accessibility snapshot for target selection.',
  browser_screenshot: 'Capture a privacy-filtered browser image as a controlled artifact.',
  browser_click: 'Click a current snapshot node or a window-owned coordinate.',
  browser_double_click: 'Double-click a current snapshot node or a window-owned coordinate.',
  browser_pointer_move: 'Move the pointer to a current browser target.',
  browser_key_press: 'Press a key with explicitly selected keyboard modifiers.',
  browser_type_text: 'Submit text using a declared keyboard or IME strategy.',
  browser_scroll: 'Scroll a browser region using explicit pixel or line units.',
  browser_drag: 'Drag between two browser-owned targets.',
  browser_navigate: 'Navigate to a destination permitted by the session origin policy.',
  browser_go_back: 'Return to the previous browser history entry.',
  browser_switch_tab: 'Select a tab owned by the current browser session.',
  browser_choose_file: 'Choose an authorized upload file after a local user decision.',
  browser_wait_for: 'Wait for an accessibility role and name to satisfy the requested state.',
  browser_approval_status: 'Read local approval state and bounded review metadata.',
  browser_trace_export: 'Export the session operation trace as a controlled artifact.',
  browser_artifact_read: 'Read an owned, unexpired browser artifact.',
};

/**
 * Convert a result to the plain JSON object accepted by the MCP wire contract.
 * Args:
 *   value (unknown): Validated public result data.
 * Returns:
 *   JSONObject: Serializable result object.
 */
function jsonObject(value: unknown): JSONObject {
  return JSON.parse(JSON.stringify(value)) as JSONObject;
}

/**
 * Format a normal tool result with structured and text representations.
 * Args:
 *   value (unknown): Public result object.
 * Returns:
 *   CallToolResult: Structured MCP response.
 */
function toolResult(value: unknown): CallToolResult {
  const data = jsonObject(value);
  const status = data.status;
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(status === 'failed' || status === 'cancelled' || status === 'approval-required'
      ? { isError: true }
      : {}),
  };
}

/**
 * Select snapshot nodes while retaining matching descendant ancestry.
 * Args:
 *   node (AxNode): Accessibility subtree.
 *   params (Record<string, unknown>): Validated depth and textual filters.
 *   depth (number): Current tree depth.
 * Returns:
 *   AxNode | undefined: Selected node subtree when relevant.
 */
function projectNode(node: AxNode, params: Record<string, unknown>, depth = 1): AxNode | undefined {
  const matchesRole = !params.role || node.role === params.role;
  const matchesName =
    !params.nameContains || (node.name ?? '').includes(String(params.nameContains));
  const children: AxNode[] = [];
  // Keep descendant matches within the requested maximum depth.
  if (depth < Number(params.depth ?? 32)) {
    for (const child of node.children ?? []) {
      const selected = projectNode(child, params, depth + 1);
      if (selected) children.push(selected);
    }
  }
  if (!matchesRole || !matchesName) {
    if (children.length === 0) return undefined;
  }
  const result = { ...node, children };
  return result;
}

/**
 * Locate a node using a role and optional literal accessible name.
 * Args:
 *   node (AxNode): Accessibility subtree to search.
 *   query (Record<string, unknown>): Validated semantic query.
 * Returns:
 *   AxNode | undefined: First matching node in tree order.
 */
function queryNode(node: AxNode, query: Record<string, unknown>): AxNode | undefined {
  const name = String(query.name ?? '');
  const matchesName =
    !query.name ||
    (query.match === 'contains' ? (node.name ?? '').includes(name) : node.name === name);
  // Select a direct match before recursively inspecting descendants.
  if (node.role === query.role && matchesName) return node;
  for (const child of node.children ?? []) {
    const result = queryNode(child, query);
    if (result) return result;
  }
  return undefined;
}

/**
 * Wait for a semantic target using bounded read-only observations.
 * Args:
 *   runtime (Runtime): Authorized browser coordinator.
 *   params (Record<string, unknown>): Validated wait query and state.
 * Returns:
 *   Promise<object>: Snapshot and target identifiers satisfying the condition.
 */
async function waitFor(runtime: Runtime, params: Record<string, unknown>): Promise<object> {
  const deadline = Date.now() + Number(params.timeoutMs ?? 10000);
  // Reobserve under current origin policy until the requested state or deadline.
  while (Date.now() < deadline) {
    const snapshot = await runtime.observe(String(params.sessionId));
    const node = queryNode(snapshot.root, params.query as Record<string, unknown>);
    const visible =
      node !== undefined && !node.states.includes('hidden') && !node.states.includes('invisible');
    const matched =
      params.state === 'absent'
        ? !node
        : params.state === 'hidden'
          ? !visible
          : params.state === 'focused'
            ? node?.states.includes('focused')
            : visible;
    if (matched)
      return {
        status: 'succeeded',
        snapshotId: snapshot.snapshotId,
        ...(node ? { nodeId: node.nodeId } : {}),
      };
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new BrowserError(
    'TIMEOUT',
    'Accessibility wait deadline exceeded.',
    true,
    'browser_observe',
  );
}

/**
 * Dispatch one validated MCP tool into the authorized runtime.
 * Args:
 *   name (string): Registered public tool name.
 *   params (Record<string, unknown>): Canonically validated parameters.
 *   runtime (Runtime): Browser coordinator.
 *   dependencies (McpDependencies): Approval and controlled artifact services.
 * Returns:
 *   Promise<CallToolResult>: Public protocol response.
 */
async function dispatch(
  name: string,
  params: Record<string, unknown>,
  runtime: Runtime,
  dependencies: McpDependencies,
): Promise<CallToolResult> {
  const sessionId = String(params.sessionId ?? '');
  const action = Object.entries(ACTION_TO_TOOL).find((entry) => entry[1] === name)?.[0];
  // All mutating tools share strict argument validation and runtime authorization.
  if (action) {
    const { sessionId: owner, requestId, target, ...args } = params;
    return toolResult(
      await runtime.execute({
        sessionId: owner,
        requestId,
        action,
        ...(target ? { target } : {}),
        args,
      }),
    );
  }
  // Read and lifecycle tools remain separate from mutation and approval decisions.
  switch (name) {
    case 'browser_session_create':
      return toolResult(await runtime.create(params));
    case 'browser_session_list':
      return toolResult({ sessions: runtime.list() });
    case 'browser_session_close':
      await runtime.close(sessionId);
      return toolResult({ sessionId, status: 'closed' });
    case 'browser_capabilities':
      return toolResult(await runtime.capabilities(sessionId));
    case 'browser_observe': {
      const snapshot = await runtime.observe(sessionId);
      const root = projectNode(snapshot.root, params) ?? {
        nodeId: snapshot.root.nodeId,
        role: snapshot.root.role,
        states: [],
        children: [],
      };
      return toolResult({ ...snapshot, root } satisfies BrowserSnapshot);
    }
    case 'browser_wait_for':
      return toolResult(await waitFor(runtime, params));
    case 'browser_approval_status':
      return toolResult(dependencies.policy.approvalStatus(String(params.approvalId)));
    case 'browser_screenshot': {
      if (params.region)
        throw new BrowserError(
          'UNSUPPORTED_CAPABILITY',
          'Region capture is unavailable in this adapter.',
        );
      const image = await runtime.screenshot(sessionId);
      if (!dependencies.artifacts) return toolResult(image);
      const artifact = await dependencies.artifacts.read(image.blobId);
      // Inline small PNGs; larger images remain controlled artifacts.
      if (artifact.sessionId !== sessionId)
        throw new BrowserError('POLICY_DENIED', 'Screenshot artifact ownership is invalid.');
      if (artifact.bytes.length > 524288) return toolResult(image);
      return {
        ...toolResult(image),
        content: [
          { type: 'image', mimeType: 'image/png', data: artifact.bytes.toString('base64') },
          { type: 'text', text: JSON.stringify(image) },
        ],
      };
    }
    case 'browser_artifact_read': {
      if (!dependencies.artifacts)
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Artifact storage is unavailable.');
      const artifact = await dependencies.artifacts.read(String(params.blobId));
      if (!runtime.list().some((session) => session.id === artifact.sessionId))
        throw new BrowserError('POLICY_DENIED', 'Artifact session ownership is invalid.');
      const offset = Number(params.offset ?? 0);
      const end = Math.min(artifact.bytes.length, offset + Number(params.maxBytes ?? 524288));
      if (offset > artifact.bytes.length)
        throw new BrowserError('INVALID_ARGUMENT', 'Artifact offset is outside its content.');
      return toolResult({
        blobId: params.blobId,
        sessionId: artifact.sessionId,
        mimeType: artifact.mimeType,
        data: artifact.bytes.subarray(offset, end).toString('base64'),
        offset,
        totalBytes: artifact.bytes.length,
        ...(end < artifact.bytes.length ? { nextOffset: end } : {}),
      });
    }
    case 'browser_trace_export': {
      if (!dependencies.artifacts)
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Trace storage is unavailable.');
      if (!runtime.list().some((session) => session.id === sessionId))
        throw new BrowserError('SESSION_NOT_FOUND', 'Trace session does not exist.');
      return toolResult({
        blobId: await dependencies.artifacts.exportTrace(
          sessionId,
          params.format === 'html' ? 'html' : 'json',
        ),
      });
    }
    default:
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Tool capability is unavailable.');
  }
}

/**
 * Register the full browser tool catalog on the official MCP server.
 * Args:
 *   runtime (Runtime): Authorized browser coordinator.
 *   dependencies (McpDependencies): Approval, artifact, and audit services.
 * Returns:
 *   McpServer: Registered stdio-ready server.
 */
export function createMcpServer(runtime: Runtime, dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'abr', version: '0.1.0' });
  // Register every tool from the canonical shared manifest.
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: DESCRIPTIONS[tool.name]!, inputSchema: toolInputSchema(tool) },
      /**
       * Validate and handle one MCP invocation.
       * Args:
       *   input (Record<string, unknown>): Parameters parsed by the SDK.
       * Returns:
       *   Promise<CallToolResult>: Structured success or safe typed failure.
       */
      async function handleTool(input) {
        dependencies.audit?.({ event: 'tool-request', tool: tool.name });
        // Classify application errors within normal tool responses.
        try {
          validate(tool.name, input);
          const result = await dispatch(tool.name, input, runtime, dependencies);
          dependencies.audit?.({ event: 'tool-response', tool: tool.name });
          return result;
        } catch (error) {
          const failure = normalizeError(error);
          dependencies.audit?.({ event: 'tool-error', tool: tool.name, code: failure.code });
          return { ...toolResult({ error: failure.toJSON() }), isError: true };
        }
      },
    );
  }
  // Close runtime-owned sessions when the host closes its protocol connection.
  server.server.onclose = () => {
    void runtime
      .closeAll()
      .then(() => dependencies.dispose?.())
      .catch(() => dependencies.audit?.({ event: 'runtime-cleanup-error', tool: 'connection' }));
  };
  return server;
}
