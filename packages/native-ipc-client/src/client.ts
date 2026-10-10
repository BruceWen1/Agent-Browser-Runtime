// -*- coding: utf-8 -*-
/**
 * client.ts
 * Current-user desktop agent supervisor
 * =====================
 * Bootstrap the native agent through inherited input and authenticate protected local IPC.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { BrowserError, validate } from '@abr/contracts';
import type { BrowserErrorCode } from '@abr/contracts';

import { authenticationProof, verifyAuthenticationChallenge } from './authentication.js';
import type { AuthenticationNamespace } from './authentication.js';
import { FrameDecoder, encodeFrame } from './framing.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** AgentClient owns one authenticated local desktop transport and its supervised process. */
export class AgentClient {
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new FrameDecoder();
  private disconnected = false;
  private authenticated = false;

  /**
   * Bind a supervised process to its protected local socket.
   * Args:
   *   process (ChildProcessWithoutNullStreams): Bootstrap agent process.
   *   socket (Socket): Current-user local named pipe or Unix socket.
   * Returns:
   *   AgentClient: Connected protocol client.
   */
  private constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly socket: Socket,
  ) {
    // Validate every complete response before resolving its corresponding request.
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const message of this.decoder.feed(chunk)) {
          validate('ipc-response', message);
          const response = message as {
            requestId: string;
            ok: boolean;
            result?: unknown;
            error?: { code: BrowserErrorCode; message: string; retryable: boolean };
          };
          const pending = this.pending.get(response.requestId);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(response.requestId);
          if (response.ok) pending.resolve(response.result);
          else
            pending.reject(
              new BrowserError(
                response.error!.code,
                response.error!.message,
                response.error!.retryable,
              ),
            );
        }
      } catch {
        this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native agent response is invalid.'));
        socket.destroy();
      }
    });
    socket.on('error', () =>
      this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native agent transport failed.')),
    );
    socket.on('close', () =>
      this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native agent connection closed.')),
    );
    process.once('exit', () => {
      socket.destroy();
      this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native agent exited.'));
    });
  }

  /**
   * Start a hidden native process and complete current-user secret authentication.
   * Args:
   *   executable (string): Verified locally built native agent executable.
   *   runtimeDirectory (string): Owned runtime directory for local socket metadata.
   * Returns:
   *   Promise<AgentClient>: Authenticated protected local protocol client.
   */
  static async start(executable: string, runtimeDirectory: string): Promise<AgentClient> {
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const secret = randomBytes(32).toString('hex');
    const instance = randomUUID();
    const child = spawn(executable, ['--instance', instance, '--runtime-dir', runtimeDirectory], {
      stdio: 'pipe',
      windowsHide: true,
    });
    child.stderr.resume();
    // Deliver the startup secret only through inherited standard input.
    child.stdin.end(secret + '\n');
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new BrowserError('TIMEOUT', 'Native agent bootstrap timed out.'));
        }, 10000);
        child.once('error', () => {
          clearTimeout(timer);
          reject(
            new BrowserError(
              'INPUT_BACKEND_UNAVAILABLE',
              'Native agent executable is unavailable.',
            ),
          );
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new BrowserError('BROWSER_DISCONNECTED', 'Native agent exited during bootstrap.'));
        });
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.length > 4096) {
            child.kill();
            clearTimeout(timer);
            reject(
              new BrowserError('INVALID_ARGUMENT', 'Native bootstrap metadata exceeds its limit.'),
            );
            return;
          }
          if (!output.includes('\n')) return;
          try {
            const record = JSON.parse(output.split('\n')[0]!) as {
              schemaVersion: number;
              endpoint: string;
              pid: number;
            };
            if (
              record.schemaVersion !== 1 ||
              typeof record.endpoint !== 'string' ||
              record.pid !== child.pid
            )
              throw new Error('Invalid bootstrap identity.');
            clearTimeout(timer);
            resolve(record.endpoint);
          } catch {
            clearTimeout(timer);
            reject(new BrowserError('INVALID_ARGUMENT', 'Native bootstrap identity is invalid.'));
          }
        });
      });
      let connected: Socket | undefined;
      // Retry the short startup race while the protected endpoint is being created.
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          connected = await new Promise<Socket>((resolve, reject) => {
            const socket = createConnection(endpoint);
            socket.once('connect', () => resolve(socket));
            socket.once('error', (error) => {
              socket.destroy();
              reject(error);
            });
          });
          break;
        } catch {
          await delay(50);
        }
      }
      if (!connected)
        throw new BrowserError(
          'INPUT_BACKEND_UNAVAILABLE',
          'Protected native endpoint is unavailable.',
        );
      const client = new AgentClient(child, connected);
      await client.authenticate('agent', secret);
      return client;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  /**
   * Connect a supervised browser process to its verified protected observer endpoint.
   * Args:
   *   child (ChildProcessWithoutNullStreams): Owned browser process with private bootstrap pipes.
   *   endpoint (string): Endpoint verified against inherited launch metadata.
   * Returns:
   *   Promise<AgentClient>: Versioned local channel awaiting observer authentication.
   */
  static async connectOwnedProcess(
    child: ChildProcessWithoutNullStreams,
    endpoint: string,
  ): Promise<AgentClient> {
    // Retry only local connection startup while retaining the original browser identity.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const connection = createConnection(endpoint);
          connection.once('connect', () => resolve(connection));
          connection.once('error', (error) => {
            connection.destroy();
            reject(error);
          });
        });
        return new AgentClient(child, socket);
      } catch {
        if (child.exitCode !== null || attempt === 39)
          throw new BrowserError(
            'BROWSER_DISCONNECTED',
            'Native observer endpoint is unavailable.',
          );
        await delay(50);
      }
    }
    throw new BrowserError('BROWSER_DISCONNECTED', 'Native observer endpoint is unavailable.');
  }

  /**
   * Release a browser observer connection while leaving browser cleanup to its supervisor.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of owned local channel cleanup.
   */
  closeChannel(): void {
    this.socket.destroy();
    this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native observer connection is closed.'));
  }

  /**
   * Authenticate both participants without transmitting the inherited bootstrap key.
   * Args:
   *   namespace (AuthenticationNamespace): Fixed desktop or browser observer authority.
   *   secret (string): Key inherited exclusively by the supervised process.
   * Returns:
   *   Promise<unknown>: Authenticated closed hello metadata for the selected protocol.
   */
  async authenticate(namespace: AuthenticationNamespace, secret: string): Promise<unknown> {
    // Each protected connection completes one mutually authenticated exchange.
    if (this.authenticated)
      throw new BrowserError('INVALID_ARGUMENT', 'Local connection is already authenticated.');
    const serverPid = this.processIdentifier();
    const clientNonce = randomBytes(32).toString('hex');
    try {
      const response = await this.call(`${namespace}.challenge`, { authVersion: 2, clientNonce });
      const challenge = verifyAuthenticationChallenge(
        response,
        secret,
        namespace,
        serverPid,
        clientNonce,
      );
      const result = await this.call(`${namespace}.hello`, {
        authVersion: 2,
        clientNonce,
        serverNonce: challenge.serverNonce,
        clientProof: authenticationProof(
          secret,
          namespace,
          'client',
          serverPid,
          clientNonce,
          challenge.serverNonce,
        ),
      });
      // Admit application operations only after the peer confirms the same authentication version.
      if (
        !result ||
        typeof result !== 'object' ||
        (result as { authVersion?: unknown }).authVersion !== 2
      )
        throw new BrowserError('POLICY_DENIED', 'Local authentication confirmation is invalid.');
      this.authenticated = true;
      return result;
    } catch (error) {
      this.closeChannel();
      throw error;
    }
  }

  /**
   * Read the supervised process identity for targeted local foreground authorization.
   * Args:
   *   None.
   * Returns:
   *   number: PID of the already authenticated owned process.
   */
  processIdentifier(): number {
    if (this.disconnected || !this.process.pid)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Native process identity is unavailable.');
    return this.process.pid;
  }

  /**
   * Reject all pending operations after a transport failure.
   * Args:
   *   error (BrowserError): Safe classified connection failure.
   * Returns:
   *   void: Completion of pending operation release.
   */
  private fail(error: BrowserError): void {
    this.disconnected = true;
    for (const record of this.pending.values()) {
      clearTimeout(record.timer);
      record.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Submit one bounded versioned native operation.
   * Args:
   *   method (string): Registered native agent operation.
   *   params (Record<string, unknown>): Strict operation-specific parameters.
   *   timeoutMs (number): Maximum response wait duration.
   * Returns:
   *   Promise<unknown>: Parsed native operation result.
   */
  async call(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    // Application operations require the completed mutually authenticated connection.
    if (
      !this.authenticated &&
      !['agent.challenge', 'agent.hello', 'observer.challenge', 'observer.hello'].includes(method)
    )
      throw new BrowserError('PERMISSION_REQUIRED', 'Local connection authentication is required.');
    // Reject new operations after process or transport ownership has ended.
    if (this.disconnected || this.socket.destroyed)
      throw new BrowserError('BROWSER_DISCONNECTED', 'Native agent is disconnected.');
    if (this.pending.size >= 32)
      throw new BrowserError('DESKTOP_BUSY', 'Native request concurrency is exhausted.');
    const requestId = randomUUID();
    const request = { schemaVersion: 1, requestId, method, params };
    validate('ipc-request', request);
    const frame = encodeFrame(request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BrowserError('TIMEOUT', 'Native operation deadline exceeded.'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new BrowserError('BROWSER_DISCONNECTED', 'Native transport write failed.'));
        }
      });
    });
  }

  /**
   * Close the owned native process and protected transport.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of protocol and process cleanup.
   */
  async close(): Promise<void> {
    if (!this.socket.destroyed) await this.call('desktop.shutdown', {}).catch(() => undefined);
    this.socket.destroy();
    this.process.kill();
    this.fail(new BrowserError('BROWSER_DISCONNECTED', 'Native client is closed.'));
  }
}
