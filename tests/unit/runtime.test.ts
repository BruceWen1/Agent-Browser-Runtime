// -*- coding: utf-8 -*-
/**
 * runtime.test.ts
 * Browser coordinator lifecycle tests
 * =====================
 * Verify concurrency, request identity, stale targets, and resource release.
 */
import { BrowserError } from '@abr/contracts';
import { EngineRegistry, Runtime } from '@abr/core';
import { expect, test } from 'vitest';

import { StubEngine, UnitGuard } from '../helpers/stub-engine.js';

const configuration = {
  engine: 'compatible',
  browser: 'bundled-chromium',
  profile: { mode: 'ephemeral' },
};

/**
 * Construct a coordinator with explicit test adapters and authorization.
 * Args:
 *   None.
 * Returns:
 *   object: Runtime and controllable adapter instances.
 */
function setup() {
  const registry = new EngineRegistry();
  const engine = new StubEngine();
  const guard = new UnitGuard();
  registry.register(engine);
  return { runtime: new Runtime(registry, guard, { maxSessions: 1 }), engine, guard, registry };
}

/**
 * Verify duplicate request identity and payload collision handling.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of execution identity assertions.
 */
async function verifyIdentity(): Promise<void> {
  const { runtime, engine } = setup();
  const session = await runtime.create(configuration);
  const action = {
    requestId: 'one',
    sessionId: session.id,
    action: 'navigate',
    args: { url: 'http://127.0.0.1/' },
  };
  const results = await Promise.all([runtime.execute(action), runtime.execute(action)]);
  expect(results[0]).toEqual(results[1]);
  expect(engine.executed).toBe(1);
  await expect(
    runtime.execute({ ...action, args: { url: 'http://localhost/' } }),
  ).rejects.toBeInstanceOf(BrowserError);
  await runtime.closeAll();
}

/**
 * Verify startup reservations, immutable metadata, and idempotent close.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of lifecycle and resource limit assertions.
 */
async function verifyLifecycle(): Promise<void> {
  const { runtime, engine, registry } = setup();
  expect(() => registry.register(engine)).toThrow(BrowserError);
  expect(() => registry.get('native')).toThrow(BrowserError);
  const results = await Promise.allSettled([
    runtime.create(configuration),
    runtime.create(configuration),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const session = runtime.list()[0]!;
  session.engine = 'gui';
  expect(runtime.list()[0]!.engine).toBe('compatible');
  await Promise.all([runtime.close(session.id), runtime.close(session.id)]);
  expect(engine.closed).toBe(1);
  expect(runtime.list()[0]!.status).toBe('closed');
  await expect(runtime.observe(session.id)).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
}

/**
 * Verify pause behavior and stale target rejection after resumption.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of paused and expired reference assertions.
 */
async function verifyReferences(): Promise<void> {
  const { runtime, engine } = setup();
  const session = await runtime.create(configuration);
  await runtime.observe(session.id);
  await runtime.pause(session.id);
  expect(
    (
      await runtime.execute({
        requestId: 'paused',
        sessionId: session.id,
        action: 'navigate',
        args: { url: 'http://127.0.0.1/' },
      })
    ).error?.code,
  ).toBe('DESKTOP_BUSY');
  await runtime.resume(session.id);
  const result = await runtime.execute({
    requestId: 'stale',
    sessionId: session.id,
    action: 'click',
    target: { kind: 'ax-node', snapshotId: 'snapshot-test', nodeId: 'button-test' },
  });
  expect(result.error?.code).toBe('TARGET_STALE');
  expect(engine.executed).toBe(0);
  await runtime.closeAll();
}

/**
 * Verify a racing rejected request cannot release another input owner.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of ownership and timeout assertions.
 */
async function verifyOwnership(): Promise<void> {
  const { runtime, guard } = setup();
  const session = await runtime.create(configuration);
  let release!: () => void;
  guard.block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runtime.execute({
    requestId: 'first',
    sessionId: session.id,
    action: 'navigate',
    args: { url: 'http://127.0.0.1/' },
  });
  const second = await runtime.execute({
    requestId: 'second',
    sessionId: session.id,
    action: 'navigate',
    args: { url: 'http://127.0.0.1/' },
  });
  expect(second.error?.code).toBe('DESKTOP_BUSY');
  expect(runtime.list()[0]!.status).toBe('busy');
  release();
  expect((await first).status).toBe('succeeded');
  await runtime.closeAll();
}

test('request retries execute once and changed payloads are rejected', verifyIdentity);
test('session creation capacity and close ownership are stable', verifyLifecycle);
test('paused sessions and expired snapshots reject input', verifyReferences);
test('racing requests preserve the active authorization owner', verifyOwnership);
