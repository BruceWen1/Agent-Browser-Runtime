// -*- coding: utf-8 -*-
/**
 * logging.ts
 * Structured diagnostic output
 * =====================
 * Record bounded operation metadata exclusively on standard error.
 */
import { pino } from 'pino';
import type { Logger } from 'pino';

/**
 * Create the diagnostic logger with confidential field redaction.
 * Args:
 *   level (string): Validated local logging level.
 * Returns:
 *   Logger: JSON logger writing to standard error.
 */
export function createLogger(level = 'info'): Logger {
  return pino(
    {
      level,
      base: null,
      redact: {
        paths: ['text', 'password', 'cookie', 'token', 'filePath', 'url'],
        censor: '[REDACTED]',
      },
    },
    process.stderr,
  );
}
