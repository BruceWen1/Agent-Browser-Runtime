// -*- coding: utf-8 -*-
/**
 * engine.ts
 * Supervised compatible browser adapter
 * =====================
 * Isolate official Playwright execution behind bounded inherited IPC requests.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { BrowserError, validate } from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  BrowserEngine,
  BrowserSession,
  BrowserSnapshot,
  CapabilityReport,
  CreateSessionRequest,
} from '@abr/contracts';

import type { WorkerConfiguration } from './backend.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface CompatibleOptions extends WorkerConfiguration {
  putScreenshot: (sessionId: string, bytes: Buffer) => Promise<string>;
}

/** WorkerClient exchanges bounded RPC messages over one supervised fork channel. */
class WorkerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly ready: Promise<void>;

  /**
   * Start a hidden worker and await its inherited-channel readiness signal.
   * Args:
   *   None.
   * Returns:
   *   WorkerClient: Supervised browser worker connection.
   */
  constructor() {
    const environment: Record<string, string> = {};
    // Forward only runtime prerequisites and omit debugger or credential environment values.
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'LOCALAPPDATA',
      'USERPROFILE',
      'HOME',
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'PLAYWRIGHT_BROWSERS_PATH',
    ])
      if (process.env[key]) environment[key] = process.env[key]!;
    this.child = fork(fileURLToPath(new URL('./worker-main.js', import.meta.url)), [], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new BrowserError('TIMEOUT', 'Browser worker startup timed out.'));
      }, 10000);
      this.child.on('message', (message: unknown) => {
        // All responses preserve the canonical IPC schema and frame size limit.
        try {
          if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 4 * 1024 * 1024)
            throw new BrowserError('INVALID_ARGUMENT', 'Worker response exceeds the frame limit.');
          validate('ipc-response', message);
          const response = message as {
            requestId: string;
            ok: boolean;
            result?: unknown;
            error?: { code: string; message: string; retryable: boolean };
          };
          if (response.requestId === 'worker-ready') {
            clearTimeout(timer);
            resolve();
            return;
          }
          const pending = this.pending.get(response.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(response.requestId);
          if (response.ok) pending.resolve(response.result);
          else {
            const failure = response.error!;
            pending.reject(
              new BrowserError(
                failure.code as ConstructorParameters<typeof BrowserError>[0],
                failure.message,
                failure.retryable,
              ),
            );
          }
        } catch {
          this.fail(
            new BrowserError('BROWSER_DISCONNECTED', 'Browser worker response is invalid.'),
          );
          this.child.kill();
        }
      });
      this.child.once('error', () => {
        clearTimeout(timer);
        reject(new BrowserError('BROWSER_DISCONNECTED', 'Browser worker could not start.'));
      });
      this.child.once('exit', () => {
        clearTimeout(timer);
        reject(new BrowserError('BROWSER_DISCONNECTED', 'Browser worker exited.'));
        this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Browser worker exited.'));
      });
    });
    // Consume child diagnostics without forwarding arbitrary browser output to MCP stdout.
    this.child.stderr?.resume();
  }

  /**
   * Reject every outstanding request after a worker transport failure.
   * Args:
   *   error (BrowserError): Safe transport failure.
   * Returns:
   *   void: Completion of pending request cleanup.
   */
  private fail(error: BrowserError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Send a bounded RPC request to the ready browser worker.
   * Args:
   *   method (string): Registered worker operation.
   *   params (object): Validated operation parameters.
   *   timeoutMs (number): Bounded transport response deadline.
   * Returns:
   *   Promise<unknown>: Serializable worker response.
   */
  async call(method: string, params: object, timeoutMs = 20000): Promise<unknown> {
    await this.ready;
    if (!this.child.connected)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Browser worker connection is closed.');
    const requestId = randomUUID();
    const request = { schemaVersion: 1, requestId, method, params };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 4 * 1024 * 1024)
      throw new BrowserError('INVALID_ARGUMENT', 'Worker request exceeds the frame limit.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BrowserError('TIMEOUT', 'Browser worker response timed out.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send(request, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new BrowserError('BROWSER_DISCONNECTED', 'Browser worker transport failed.'));
        }
      });
    });
  }

  /**
   * Release the browser worker after its resources have been closed.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of worker shutdown.
   */
  async close(): Promise<void> {
    await this.call('shutdown', {}).catch(() => undefined);
    if (this.child.connected) this.child.disconnect();
    this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Browser worker is closed.'));
  }
}

/** CompatibleEngine exposes official Playwright semantics through a lazy supervised worker. */
export class CompatibleEngine implements BrowserEngine {
  readonly kind = 'compatible' as const;
  private client: WorkerClient | undefined;
  private startup: Promise<WorkerClient> | undefined;
  private readonly sessions = new Set<string>();

  /**
   * Initialize the lazy compatible adapter.
   * Args:
   *   options (CompatibleOptions): Trusted worker paths and filtered screenshot sink.
   * Returns:
   *   CompatibleEngine: Adapter that starts its worker on first session creation.
   */
  constructor(readonly options: CompatibleOptions) {}

  /**
   * Start and initialize one shared supervised worker.
   * Args:
   *   None.
   * Returns:
   *   Promise<WorkerClient>: Initialized worker connection.
   */
  private async worker(): Promise<WorkerClient> {
    if (this.client) return this.client;
    if (!this.startup)
      this.startup = (async () => {
        const client = new WorkerClient();
        const configuration: WorkerConfiguration = {
          profileRoot: this.options.profileRoot,
          artifactRoot: this.options.artifactRoot,
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
        };
        try {
          await client.call('initialize', configuration);
          this.client = client;
          return client;
        } catch (error) {
          await client.close();
          throw error;
        } finally {
          this.startup = undefined;
        }
      })();
    return this.startup;
  }

  /**
   * Create a worker-owned official browser session.
   * Args:
   *   input (CreateSessionRequest): Authorized allocated profile request.
   * Returns:
   *   Promise<BrowserSession>: Actual browser metadata.
   */
  async create(input: CreateSessionRequest): Promise<BrowserSession> {
    const session = (await (await this.worker()).call('create', input, 30000)) as BrowserSession;
    this.sessions.add(session.id);
    return session;
  }

  /**
   * Read current browser capabilities.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<CapabilityReport>: Complete support and unavailable reason report.
   */
  async capabilities(id: string): Promise<CapabilityReport> {
    return (await (
      await this.worker()
    ).call('capabilities', { sessionId: id })) as CapabilityReport;
  }

  /**
   * Read a current official accessibility snapshot.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Current browser observation.
   */
  async observe(id: string): Promise<BrowserSnapshot> {
    return (await (await this.worker()).call('observe', { sessionId: id })) as BrowserSnapshot;
  }

  /**
   * Read the current URL for immediate origin authorization.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<string>: Current trusted browser URL.
   */
  async currentUrl(id: string): Promise<string> {
    return (await (await this.worker()).call('currentUrl', { sessionId: id })) as string;
  }

  /**
   * Dispatch one strict operation to the official browser worker.
   * Args:
   *   input (ActionRequest): Validated authorized operation.
   * Returns:
   *   Promise<ActionResult>: Actual compatible execution result.
   */
  async execute(input: ActionRequest): Promise<ActionResult> {
    return (await (
      await this.worker()
    ).call('execute', input, (input.timeoutMs ?? 10000) + 10000)) as ActionResult;
  }

  /**
   * Transfer filtered screenshot chunks into runtime-owned artifact storage.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<object>: Public controlled screenshot reference.
   */
  async screenshot(id: string): Promise<{ mimeType: 'image/png'; blobId: string }> {
    const client = await this.worker();
    const capture = (await client.call('screenshot', { sessionId: id })) as {
      blobId: string;
      byteLength: number;
    };
    if (
      !Number.isInteger(capture.byteLength) ||
      capture.byteLength <= 0 ||
      capture.byteLength > 8 * 1024 * 1024
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Filtered screenshot size is invalid.');
    const chunks: Buffer[] = [];
    let offset = 0;
    // Transfer bounded chunks instead of embedding full image data in one IPC frame.
    while (offset < capture.byteLength) {
      const encoded = (await client.call('artifactChunk', {
        sessionId: id,
        blobId: capture.blobId,
        offset,
      })) as string;
      const chunk = Buffer.from(encoded, 'base64');
      if (chunk.length === 0 || chunk.length > 524288 || offset + chunk.length > capture.byteLength)
        throw new BrowserError('INVALID_ARGUMENT', 'Screenshot transfer chunk is invalid.');
      chunks.push(chunk);
      offset += chunk.length;
    }
    return {
      mimeType: 'image/png',
      blobId: await this.options.putScreenshot(id, Buffer.concat(chunks)),
    };
  }

  /**
   * Cancel outstanding input using the worker's operation controller.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<void>: Completion of cancellation notification.
   */
  async cancel(id: string): Promise<void> {
    await this.client?.call('cancel', { sessionId: id });
  }

  /**
   * Pause browser input while preserving its context.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<void>: Completion of pause acknowledgement.
   */
  async pause(id: string): Promise<void> {
    await (await this.worker()).call('pause', { sessionId: id });
  }

  /**
   * Resume the paused official browser session.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<void>: Completion of resume acknowledgement.
   */
  async resume(id: string): Promise<void> {
    await (await this.worker()).call('resume', { sessionId: id });
  }

  /**
   * Close a context and release the idle worker when no sessions remain.
   * Args:
   *   id (string): Browser session identifier.
   * Returns:
   *   Promise<void>: Completion of owned process cleanup.
   */
  async close(id: string): Promise<void> {
    if (!this.sessions.has(id)) return;
    await this.client?.call('close', { sessionId: id });
    this.sessions.delete(id);
    if (this.sessions.size === 0) {
      await this.client?.close();
      this.client = undefined;
    }
  }
}
