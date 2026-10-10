// -*- coding: utf-8 -*-
/**
 * control-ui.ts
 * Independent local handover supervisor
 * =====================
 * Validate inherited native UI events and dispatch session-scoped pause, resume, and stop requests.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { BrowserError } from '@abr/contracts';

export type LocalControlEvent = 'pause' | 'resume' | 'stop';

/** LocalControlCapabilities reports actual separately registered user controls. */
export interface LocalControlCapabilities {
  buttons: boolean;
  hotkeyPause: boolean;
  forcedStop: boolean;
  initialNoActivate: boolean;
}

/** LocalControlOptions bind the trusted UI to one application-owned browser session. */
export interface LocalControlOptions {
  executable: string;
  sessionId: string;
  inputProcessId: number;
  onEvent: (event: LocalControlEvent, sessionId: string) => Promise<void>;
  onFailure?: (error: BrowserError, sessionId: string) => void | Promise<void>;
}

/**
 * Validate one closed native control event and its exact owned session identity.
 * Args:
 *   value (unknown): Parsed line from the inherited child output channel.
 *   sessionId (string): Application-owned session assigned during startup.
 * Returns:
 *   object: Validated ready or user control event.
 */
export function parseLocalControlEvent(
  value: unknown,
  sessionId: string,
): {
  event: 'ready' | LocalControlEvent;
  capabilities?: LocalControlCapabilities;
} {
  // Reject unknown metadata and foreign sessions before invoking any application lifecycle method.
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserError('INVALID_ARGUMENT', 'Local control event is malformed.');
  const event = value as Record<string, unknown>;
  const allowed =
    event.event === 'ready'
      ? ['schemaVersion', 'sessionId', 'event', 'capabilities']
      : ['schemaVersion', 'sessionId', 'event'];
  // Only the separately created UI process can provide one of these closed event records.
  if (
    event.schemaVersion !== 1 ||
    event.sessionId !== sessionId ||
    typeof event.event !== 'string' ||
    !['ready', 'pause', 'resume', 'stop'].includes(event.event) ||
    Object.keys(event).some((field) => !allowed.includes(field))
  )
    throw new BrowserError(
      'INVALID_ARGUMENT',
      'Local control event does not match its owned session.',
    );
  // Ready capabilities describe actual OS registrations and contain boolean fields exclusively.
  if (event.event === 'ready') {
    if (
      !event.capabilities ||
      typeof event.capabilities !== 'object' ||
      Array.isArray(event.capabilities)
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Local control capabilities are malformed.');
    const capabilities = event.capabilities as Record<string, unknown>;
    const fields = ['buttons', 'hotkeyPause', 'forcedStop', 'initialNoActivate'];
    if (
      Object.keys(capabilities).length !== fields.length ||
      fields.some((field) => typeof capabilities[field] !== 'boolean') ||
      !capabilities.buttons ||
      !capabilities.forcedStop ||
      !capabilities.initialNoActivate
    )
      throw new BrowserError(
        'INVALID_ARGUMENT',
        'Required local control capabilities are unavailable.',
      );
    return {
      event: 'ready',
      capabilities: { ...capabilities } as unknown as LocalControlCapabilities,
    };
  }
  return { event: event.event as LocalControlEvent };
}

/** LocalControlUi owns one independent native UI process and its protected inherited channel. */
export class LocalControlUi {
  private closed = false;
  private stopped = false;
  private ready = false;
  private queued = Promise.resolve();
  private eventWindow = 0;
  private eventCount = 0;

  /**
   * Bind an already supervised child to one session event handler.
   * Args:
   *   child (ChildProcessWithoutNullStreams): Separately created native UI process.
   *   options (LocalControlOptions): Exact session and protected lifecycle callbacks.
   *   capabilities (LocalControlCapabilities): Actual native ready capability state.
   * Returns:
   *   LocalControlUi: Session-scoped native user surface supervisor.
   */
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: LocalControlOptions,
    readonly capabilities: Readonly<LocalControlCapabilities>,
  ) {}

  /**
   * Create an independent native surface through inherited startup metadata only.
   * Args:
   *   options (LocalControlOptions): Owned session, executable, and lifecycle callback.
   * Returns:
   *   Promise<LocalControlUi>: Ready session-bound native UI with actual hotkey capability.
   */
  static async start(options: LocalControlOptions): Promise<LocalControlUi> {
    // Native implementations are explicit per platform and retain a clear unavailable result.
    if (process.platform !== 'win32')
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'The independent local control UI is available on Windows.',
      );
    // Session metadata cannot contain text values, paths, or command-line control characters.
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.sessionId))
      throw new BrowserError('INVALID_ARGUMENT', 'Local control session identity is invalid.');
    // Foreground eligibility targets the authenticated application-owned input process only.
    if (
      !Number.isInteger(options.inputProcessId) ||
      options.inputProcessId < 1 ||
      options.inputProcessId > 0xffffffff ||
      options.inputProcessId === process.pid
    )
      throw new BrowserError(
        'INVALID_ARGUMENT',
        'Local control input process identity is invalid.',
      );
    const child = spawn(options.executable, ['--control'], { windowsHide: true, stdio: 'pipe' });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    // Deliver bootstrap data exclusively through the private inherited input channel.
    child.stdin.end(
      JSON.stringify({
        schemaVersion: 1,
        sessionId: options.sessionId,
        parentPid: process.pid,
        inputProcessId: options.inputProcessId,
      }),
    );
    return new Promise<LocalControlUi>((resolve, reject) => {
      let surface: LocalControlUi | undefined;
      let settled = false;
      let output = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const timer = setTimeout(
        () => fail(new BrowserError('TIMEOUT', 'The local control surface did not become ready.')),
        10000,
      );

      /**
       * Reject startup or close an invalid running native UI with a safe failure callback.
       * Args:
       *   error (BrowserError): Stable safe UI failure category.
       * Returns:
       *   void: Completed helper shutdown and application failure notification.
       */
      function fail(error: BrowserError): void {
        clearTimeout(timer);
        child.kill();
        // Running failures reach the application so it can release or pause owned automation.
        if (settled) surface?.fail(error);
        else {
          settled = true;
          reject(error);
        }
      }
      child.once('error', () =>
        fail(
          new BrowserError(
            'INPUT_BACKEND_UNAVAILABLE',
            'The local control executable is unavailable.',
          ),
        ),
      );
      child.once('close', () => {
        // Intentional session close and explicit stop retain their completed lifecycle state.
        if (surface?.closed || surface?.stopped) return;
        fail(
          new BrowserError('BROWSER_DISCONNECTED', 'The independent local control process exited.'),
        );
      });
      child.stdout.on('data', (chunk: Buffer) => {
        // A malformed or oversized inherited channel cannot trigger session operations.
        try {
          output += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(output) > 4096)
            throw new BrowserError('INVALID_ARGUMENT', 'Local control output exceeds its quota.');
          let ending = output.indexOf('\n');
          // Decode each bounded event in strict process and session order.
          while (ending !== -1) {
            const line = output.slice(0, ending);
            output = output.slice(ending + 1);
            const event = parseLocalControlEvent(JSON.parse(line) as unknown, options.sessionId);
            if (!surface) {
              // The initial ready handshake precedes every interactive control request.
              if (event.event !== 'ready' || !event.capabilities)
                throw new BrowserError(
                  'INVALID_ARGUMENT',
                  'Local control input preceded its ready handshake.',
                );
              surface = new LocalControlUi(child, options, Object.freeze(event.capabilities));
              surface.ready = true;
              settled = true;
              clearTimeout(timer);
              resolve(surface);
            } else {
              // Repeated ready messages cannot replace the already negotiated user surface.
              if (event.event === 'ready')
                throw new BrowserError(
                  'INVALID_ARGUMENT',
                  'Local control ready state was repeated.',
                );
              surface.dispatch(event.event);
            }
            ending = output.indexOf('\n');
          }
        } catch {
          fail(
            new BrowserError('INVALID_ARGUMENT', 'The native local control channel is invalid.'),
          );
        }
      });
    });
  }

  /**
   * Dispatch validated physical user controls while preserving pause/resume ordering.
   * Args:
   *   event (LocalControlEvent): Closed local user event bound to this session.
   * Returns:
   *   void: Queued lifecycle request or immediate forced stop callback.
   */
  private dispatch(event: LocalControlEvent): void {
    // Ignore events after session disposal or a completed local stop request.
    if (!this.ready || this.closed || this.stopped) return;
    const now = Date.now();
    // Rate limits preserve bounded callback scheduling even if the helper becomes invalid.
    if (now - this.eventWindow >= 1000) {
      this.eventWindow = now;
      this.eventCount = 0;
    }
    this.eventCount += 1;
    if (this.eventCount > 20) {
      this.fail(
        new BrowserError('INVALID_ARGUMENT', 'Local control input rate exceeds its quota.'),
      );
      return;
    }
    // Stop reaches the Core immediately and prevents queued resume requests from executing.
    if (event === 'stop') {
      this.stopped = true;
      void this.options
        .onEvent('stop', this.options.sessionId)
        .catch(() =>
          this.fail(new BrowserError('INTERNAL_ERROR', 'The owned session stop request failed.')),
        );
      return;
    }
    this.queued = this.queued
      .then(async () => {
        if (this.closed || this.stopped) return;
        await this.options.onEvent(event, this.options.sessionId);
      })
      .catch(() =>
        this.fail(new BrowserError('INTERNAL_ERROR', 'The owned session control request failed.')),
      );
  }

  /**
   * Close the owned user surface and notify the application of a safe capability failure.
   * Args:
   *   error (BrowserError): Stable session control failure.
   * Returns:
   *   void: Child disposal and optional safe application failure callback.
   */
  private fail(error: BrowserError): void {
    // Deliver at most one failure while releasing only this independently spawned process.
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
    // Application cleanup failures stay scoped to this already closed native surface.
    try {
      void Promise.resolve(this.options.onFailure?.(error, this.options.sessionId)).catch(() => {});
    } catch {
      /* The owned helper has already been closed before the callback is invoked. */
    }
  }

  /**
   * Dispose the control process when its owned browser session closes.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of independent local process teardown.
   */
  async close(): Promise<void> {
    // Repeated session cleanup leaves the already closed surface in a stable state.
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        clearTimeout(timer);
        resolve();
      } else this.child.kill();
    });
  }
}
