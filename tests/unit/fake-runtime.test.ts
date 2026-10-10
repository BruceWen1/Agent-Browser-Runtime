// -*- coding: utf-8 -*-
/**
 * fake-runtime.test.ts
 * Browser-free runtime workflow verification
 * =====================
 * Verify navigation, observation, input, stale references, and unsupported semantics.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineRegistry, PolicyEngine, Runtime, readConfiguration } from '@abr/core';
import { FakeBrowserEngine } from '@abr/core/testing';
import { expect, test } from 'vitest';

/**
 * Verify a complete authorized browser-free runtime workflow.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of workflow and cleanup assertions.
 */
async function verifyWorkflow(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-fake-'));
  const policy = new PolicyEngine(await readConfiguration('config/abr.config.example.yaml'), root);
  const registry = new EngineRegistry();
  const engine = new FakeBrowserEngine();
  registry.register(engine);
  const runtime = new Runtime(registry, policy);
  // Complete cleanup even when an intermediate workflow assertion fails.
  try {
    const session = await runtime.create({
      engine: 'compatible',
      browser: 'bundled-chromium',
      profile: { mode: 'ephemeral' },
    });
    expect(session.browserVersion).toBe('fake-test-only');
    const denied = await runtime.execute({
      requestId: 'denied',
      sessionId: session.id,
      action: 'navigate',
      args: { url: 'https://example.com/' },
    });
    expect(denied.error?.code).toBe('POLICY_DENIED');
    expect(engine.events).toHaveLength(0);
    expect(
      (
        await runtime.execute({
          requestId: 'navigate',
          sessionId: session.id,
          action: 'navigate',
          args: { url: 'http://127.0.0.1:1234/' },
        })
      ).status,
    ).toBe('succeeded');
    const snapshot = await runtime.observe(session.id);
    const click = {
      requestId: 'click',
      sessionId: session.id,
      action: 'click',
      target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: 'activate' },
    };
    expect((await runtime.execute(click)).executionPath).toBe('not-executed');
    const stale = await runtime.execute({ ...click, requestId: 'stale' });
    expect(stale.error?.code).toBe('TARGET_STALE');
    expect(
      (
        await runtime.execute({
          requestId: 'text',
          sessionId: session.id,
          action: 'type-text',
          args: { text: 'fixture text', strategy: 'keyboard' },
        })
      ).status,
    ).toBe('succeeded');
    const updated = await runtime.observe(session.id);
    expect(updated.root.children?.find((node) => node.nodeId === 'query')?.value).toBe(
      'fixture text',
    );
    const ime = await runtime.execute({
      requestId: 'ime',
      sessionId: session.id,
      action: 'type-text',
      args: { text: 'fixture', strategy: 'ime' },
    });
    expect(ime.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await runtime.capabilities(session.id)).unsupported['input.ime']).toBe(
      'UNAVAILABLE_IN_TEST_ENGINE',
    );
    await runtime.closeAll();
    expect(runtime.list()[0]!.status).toBe('closed');
  } finally {
    await runtime.closeAll();
    // The root was allocated directly by this test beneath the system temporary directory.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-fake-')
    )
      throw new Error('Invalid test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('authorized fake workflow preserves strict paths and declared capabilities', verifyWorkflow);
