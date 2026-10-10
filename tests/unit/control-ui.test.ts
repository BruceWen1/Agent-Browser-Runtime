// -*- coding: utf-8 -*-
/**
 * control-ui.test.ts
 * Session-scoped handover protocol verification
 * =====================
 * Verify independent native control records retain closed fields and exact owned session identity.
 */
import { expect, test } from 'vitest';

import { parseLocalControlEvent } from '../../packages/native-ipc-client/src/control-ui.js';

/**
 * Verify native ready capabilities and pause/resume/stop events match one owned session.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of closed control protocol acceptance and rejection assertions.
 */
function controlEventBoundaries(): void {
  const sessionId = 'owned-session';
  const ready = {
    schemaVersion: 1,
    sessionId,
    event: 'ready',
    capabilities: { buttons: true, hotkeyPause: false, forcedStop: true, initialNoActivate: true },
  };
  expect(parseLocalControlEvent(ready, sessionId)).toEqual({
    event: 'ready',
    capabilities: ready.capabilities,
  });
  // Native hotkey registration failure remains an explicit negotiated capability.
  expect(parseLocalControlEvent(ready, sessionId).capabilities?.hotkeyPause).toBe(false);
  for (const event of ['pause', 'resume', 'stop']) {
    expect(parseLocalControlEvent({ schemaVersion: 1, sessionId, event }, sessionId)).toEqual({
      event,
    });
  }
  expect(() =>
    parseLocalControlEvent(
      { schemaVersion: 1, sessionId: 'foreign-session', event: 'stop' },
      sessionId,
    ),
  ).toThrow();
  expect(() =>
    parseLocalControlEvent({ schemaVersion: 1, sessionId, event: 'approve' }, sessionId),
  ).toThrow();
  expect(() =>
    parseLocalControlEvent(
      { schemaVersion: 1, sessionId, event: 'pause', approve: true },
      sessionId,
    ),
  ).toThrow();
  expect(() =>
    parseLocalControlEvent(
      { ...ready, capabilities: { ...ready.capabilities, initialNoActivate: false } },
      sessionId,
    ),
  ).toThrow();
  expect(() =>
    parseLocalControlEvent(
      { ...ready, capabilities: { ...ready.capabilities, execute: true } },
      sessionId,
    ),
  ).toThrow();
  expect(() => parseLocalControlEvent({ ...ready, schemaVersion: 2 }, sessionId)).toThrow();
  expect(() => parseLocalControlEvent(null, sessionId)).toThrow();
}

test(
  'independent handover protocol is closed and bound to one owned session',
  controlEventBoundaries,
);
