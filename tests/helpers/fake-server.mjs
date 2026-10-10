// -*- coding: utf-8 -*-
/**
 * fake-server.mjs
 * Isolated MCP integration server
 * =====================
 * Serve the injected test browser under real configuration and authorization.
 */
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { EngineRegistry, PolicyEngine, Runtime, readConfiguration } from '@abr/core';
import { FakeBrowserEngine } from '@abr/core/testing';
import { serveRuntime } from '@abr/mcp-server';
import { ArtifactStore } from '@abr/artifacts';

/**
 * Start the test-only MCP process.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of configuration and transport initialization.
 */
async function main() {
  const started = performance.now();
  // Require an explicit test root instead of using the user's production data directory.
  if (!process.env.ABR_TEST_DATA_DIR) throw new Error('The test data root is required.');
  const policy = new PolicyEngine(
    await readConfiguration('config/abr.config.example.yaml'),
    process.env.ABR_TEST_DATA_DIR,
  );
  const registry = new EngineRegistry();
  const artifacts = new ArtifactStore({
    root: path.join(process.env.ABR_TEST_DATA_DIR, 'artifacts'),
  });
  registry.register(
    new FakeBrowserEngine('compatible', (sessionId, bytes) => artifacts.putPng(sessionId, bytes)),
  );
  const runtime = new Runtime(registry, policy, { audit: (event) => artifacts.record(event) });
  const handle = serveRuntime(runtime, { policy, artifacts, dispose: () => artifacts.close() });
  // Tear down protocol state when the disposable test process is interrupted.
  process.on('SIGINT', () => {
    void handle.close();
  });
  console.error(
    JSON.stringify({ event: 'test-mcp-ready', durationMs: performance.now() - started }),
  );
}

// Initialize the disposable integration process from its script entry point.
await main();
