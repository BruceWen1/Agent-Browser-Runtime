/** Exhaustive error declarations. Exported by TASK-002 through core/contracts. */
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
