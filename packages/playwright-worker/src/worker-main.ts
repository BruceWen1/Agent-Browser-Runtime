// -*- coding: utf-8 -*-
/**
 * worker-main.ts
 * Supervised Playwright worker entry point
 * =====================
 * Serve bounded browser requests exclusively through the inherited parent IPC channel.
 */
import { performance } from 'node:perf_hooks';

import {
  BrowserError,
  normalizeError,
  snapshotSchema,
  validate,
  validateOutput,
} from '@abr/contracts';
import type { BrowserSnapshot } from '@abr/contracts';

import { PlaywrightBackend } from './backend.js';
import type { WorkerConfiguration } from './backend.js';

interface Request {
  schemaVersion: 1;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}
let backend: PlaywrightBackend | undefined;

/**
 * Dispatch a trusted parent request to the browser worker.
 * Args:
 *   request (Request): Validated bounded parent IPC request.
 * Returns:
 *   Promise<unknown>: Serializable operation result.
 */
async function dispatch(request: Request): Promise<unknown> {
  const params = request.params;
  // Admit worker initialization once using inherited channel configuration.
  if (request.method === 'initialize') {
    if (backend) throw new BrowserError('INVALID_ARGUMENT', 'Worker is already initialized.');
    if (typeof params.profileRoot !== 'string' || typeof params.artifactRoot !== 'string')
      throw new BrowserError('INVALID_ARGUMENT', 'Worker directories are invalid.');
    backend = new PlaywrightBackend(params as unknown as WorkerConfiguration);
    return { ready: true, playwrightVersion: '1.64.0' };
  }
  if (!backend) throw new BrowserError('BROWSER_DISCONNECTED', 'Worker has not been initialized.');
  const id = String(params.sessionId ?? '');
  // Map the fixed inherited-channel protocol to browser operations.
  switch (request.method) {
    case 'create':
      return backend.create(params);
    case 'capabilities':
      return backend.capabilities(id);
    case 'observe':
      return backend.observe(id);
    case 'inspectionSnapshot':
      return backend.inspectionSnapshot(id);
    case 'currentUrl':
      return backend.currentUrl(id);
    case 'execute':
      if (
        !params.input ||
        Object.keys(params).some((key) => !['input', 'inspection'].includes(key))
      )
        throw new BrowserError('INVALID_ARGUMENT', 'Worker execution metadata is invalid.');
      if (params.inspection) validateOutput(snapshotSchema, params.inspection);
      return backend.execute(params.input, params.inspection as BrowserSnapshot | undefined);
    case 'screenshot':
      return backend.screenshot(id);
    case 'artifactChunk':
      return backend.artifactChunk(id, String(params.blobId), Number(params.offset));
    case 'cancel':
      backend.cancel(id);
      return null;
    case 'pause':
      backend.pause(id);
      return null;
    case 'resume':
      backend.resume(id);
      return null;
    case 'close':
      await backend.close(id);
      return null;
    case 'shutdown':
      await backend.shutdown();
      return null;
    default:
      throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Worker method is unavailable.');
  }
}

/**
 * Validate and answer one inherited IPC message with bounded diagnostics.
 * Args:
 *   value (unknown): Message received from the parent process.
 * Returns:
 *   Promise<void>: Completion of response transmission.
 */
async function handleMessage(value: unknown): Promise<void> {
  let requestId = 'invalid-request';
  const started = performance.now();
  // Validate framing size and schema before invoking any worker method.
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4 * 1024 * 1024)
      throw new BrowserError('INVALID_ARGUMENT', 'Worker request exceeds the frame limit.');
    validate('ipc-request', value);
    const request = value as Request;
    requestId = request.requestId;
    const result = await dispatch(request);
    process.send?.({ schemaVersion: 1, requestId, ok: true, result: result ?? null });
  } catch (error) {
    let failure = normalizeError(error);
    // Classify browser transport and cancellation failures without original URL text.
    if (error instanceof Error && error.name === 'TimeoutError')
      failure = new BrowserError('TIMEOUT', 'Browser operation deadline exceeded.');
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.message.includes('Target page, context or browser has been closed'))
    )
      failure = new BrowserError('BROWSER_DISCONNECTED', 'Browser operation was interrupted.');
    process.send?.({ schemaVersion: 1, requestId, ok: false, error: failure.toJSON() });
  }
  process.stderr.write(
    JSON.stringify({
      event: 'worker-request-finished',
      requestId,
      durationMs: performance.now() - started,
    }) + '\n',
  );
}

/**
 * Start the supervised browser worker and report startup duration.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of listener initialization.
 */
function main(): void {
  const started = performance.now();
  if (!process.send) throw new Error('The inherited parent IPC channel is required.');
  // Receive requests through the protected fork channel rather than a network endpoint.
  process.on('message', (value: unknown) => {
    void handleMessage(value);
  });
  // Release browser processes after the parent loses its inherited IPC connection.
  process.on('disconnect', () => {
    void (backend?.shutdown() ?? Promise.resolve()).finally(() => {
      process.exitCode = 0;
    });
  });
  process.send({ schemaVersion: 1, requestId: 'worker-ready', ok: true, result: { ready: true } });
  process.stderr.write(
    JSON.stringify({ event: 'worker-ready', durationMs: performance.now() - started }) + '\n',
  );
}

// Initialize the dedicated worker process from its executable module.
main();
