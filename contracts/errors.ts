// -*- coding: utf-8 -*-
/**
 * errors.ts
 * Typed browser runtime failures
 * =====================
 * Preserve stable error codes and bounded diagnostic messages.
 */
import type { BrowserErrorCode } from './browser-api.js';
export const BROWSER_ERROR_CODES: readonly BrowserErrorCode[] = [
  'INVALID_ARGUMENT',
  'SESSION_NOT_FOUND',
  'SESSION_CLOSED',
  'UNSUPPORTED_CAPABILITY',
  'PERMISSION_REQUIRED',
  'APPROVAL_REQUIRED',
  'POLICY_DENIED',
  'TARGET_STALE',
  'TARGET_NOT_FOUND',
  'TARGET_OCCLUDED',
  'FOCUS_LOST',
  'DESKTOP_BUSY',
  'INPUT_BACKEND_UNAVAILABLE',
  'BROWSER_DISCONNECTED',
  'TIMEOUT',
  'INTERNAL_ERROR',
] as const;

/** BrowserError represents a recoverable or terminal runtime operation failure. */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly retryable: boolean;
  readonly nextAction?: string;

  /**
   * Construct a typed runtime failure.
   *
   * Args:
   *   code (BrowserErrorCode): Stable public error identifier.
   *   message (string): Diagnostic text excluding confidential input.
   *   retryable (boolean): Whether repeating a safe read is appropriate.
   *   nextAction (string | undefined): Suggested recovery operation.
   * Returns:
   *   BrowserError: Initialized typed error.
   */
  constructor(code: BrowserErrorCode, message: string, retryable = false, nextAction?: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.retryable = retryable;
    // Preserve the distinction between an omitted and present recovery hint.
    if (nextAction !== undefined) this.nextAction = nextAction;
  }

  /**
   * Produce the public JSON error payload.
   *
   * Args:
   *   None.
   * Returns:
   *   object: Stable error information suitable for protocol responses.
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.nextAction ? { nextAction: this.nextAction } : {}),
    };
  }
}

/**
 * Normalize an unknown adapter failure without exposing its original payload.
 *
 * Args:
 *   error (unknown): Failure raised by an adapter or operation.
 * Returns:
 *   BrowserError: Safe typed failure for the application boundary.
 */
export function normalizeError(error: unknown): BrowserError {
  // Preserve already classified failures and mask unexpected details.
  if (error instanceof BrowserError) return error;
  return new BrowserError('INTERNAL_ERROR', 'The operation failed unexpectedly.');
}
