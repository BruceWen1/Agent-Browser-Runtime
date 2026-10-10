// -*- coding: utf-8 -*-
/**
 * stdio.ts
 * Local MCP transport entry point
 * =====================
 * Serve one authorized runtime over a bounded standard input protocol channel.
 */
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Runtime } from '@abr/core';

import { createMcpServer } from './server.js';
import type { McpDependencies } from './server.js';

/**
 * Serve browser tools through the official MCP stdio factory.
 * Args:
 *   runtime (Runtime): Authorized browser coordinator.
 *   dependencies (McpDependencies): Trusted approval and artifact services.
 * Returns:
 *   StdioServerHandle: Handle for controlled transport shutdown.
 */
export function serveRuntime(runtime: Runtime, dependencies: McpDependencies): StdioServerHandle {
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 4 * 1024 * 1024,
  });
  return serveStdio(() => createMcpServer(runtime, dependencies), { transport });
}
