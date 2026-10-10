// -*- coding: utf-8 -*-
/**
 * artifacts.test.ts
 * Controlled artifact storage verification
 * =====================
 * Verify ownership, expiry, quotas, protected pixels, and inert trace export.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ArtifactStore } from '@abr/artifacts';
import type { TraceEvent } from '@abr/artifacts';
import { EngineRegistry, Runtime } from '@abr/core';
import sharp from 'sharp';
import { expect, test } from 'vitest';

import { StubEngine, UnitGuard } from '../helpers/stub-engine.js';

/**
 * Verify artifact ownership, mutation isolation, and deterministic expiry.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of storage lifecycle assertions.
 */
async function verifyOwnership(): Promise<void> {
  let now = 1000;
  const store = new ArtifactStore({
    root: path.join(tmpdir(), 'abr-artifact-memory-test'),
    ttlMs: 100,
    now: () => now,
  });
  const id = await store.put('session-a', 'application/json', Buffer.from('{}'));
  await expect(store.read(id, 'session-b')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const first = await store.read(id, 'session-a');
  first.bytes[0] = 0;
  expect((await store.read(id)).bytes.toString()).toBe('{}');
  now = 1100;
  await expect(store.read(id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await expect(store.read('../outside')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await store.close();
}

/**
 * Verify size and total quota limits reject additional allocations.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of storage resource limit assertions.
 */
async function verifyQuotas(): Promise<void> {
  const store = new ArtifactStore({
    root: path.join(tmpdir(), 'abr-artifact-memory-test'),
    maxBytes: 4,
    maxTotalBytes: 4,
  });
  await expect(store.put('s', 'application/json', Buffer.alloc(5))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  });
  await store.put('s', 'application/json', Buffer.alloc(4));
  await expect(store.put('s', 'application/json', Buffer.alloc(1))).rejects.toMatchObject({
    code: 'DESKTOP_BUSY',
  });
  await store.close();
}

/**
 * Verify protected screenshot pixels are replaced before storage.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of PNG decode and pixel confidentiality assertions.
 */
async function verifyPixels(): Promise<void> {
  const store = new ArtifactStore({ root: path.join(tmpdir(), 'abr-artifact-memory-test') });
  const source = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const id = await store.putPng('s', source, [{ x: 2, y: 2, width: 5, height: 5 }]);
  const artifact = await store.read(id);
  const image = await sharp(artifact.bytes).raw().toBuffer({ resolveWithObject: true });
  const index = (3 * image.info.width + 3) * image.info.channels;
  expect([...image.data.subarray(index, index + 3)]).toEqual([0, 0, 0]);
  expect(image.data[0]).toBe(255);
  await expect(store.putPng('s', Buffer.from('<svg/>'))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  });
  await store.close();
}

/**
 * Verify trace exports remove argument fields and escape HTML content.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of trace confidentiality assertions.
 */
async function verifyTrace(): Promise<void> {
  const store = new ArtifactStore({ root: path.join(tmpdir(), 'abr-artifact-memory-test') });
  store.record({
    sessionId: 's',
    event: '<script>example</script>',
    text: 'secret-input',
    token: 'secret-token',
  } as TraceEvent);
  const json = await store.read(await store.exportTrace('s', 'json'));
  expect(json.bytes.toString()).not.toContain('secret-input');
  expect(json.bytes.toString()).not.toContain('secret-token');
  const html = await store.read(await store.exportTrace('s', 'html'));
  expect(html.bytes.toString()).not.toContain('<script>');
  expect(html.bytes.toString()).toContain('&lt;script&gt;');
  await store.close();
}

/** ProtectedEngine returns a protected control for observation privacy tests. */
class ProtectedEngine extends StubEngine {
  /**
   * Return a protected control containing a synthetic sensitive value.
   * Args:
   *   id (string): Test session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Protected test control snapshot.
   */
  override async observe(id: string) {
    const snapshot = await super.observe(id);
    snapshot.root.states = ['protected'];
    snapshot.root.name = 'sensitive-label';
    snapshot.root.value = 'secret-value';
    return snapshot;
  }
}

/**
 * Verify protected values are filtered before public observation and caching.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of accessibility privacy assertions.
 */
async function verifyProtectedValues(): Promise<void> {
  const registry = new EngineRegistry();
  registry.register(new ProtectedEngine());
  const runtime = new Runtime(registry, new UnitGuard());
  const session = await runtime.create({
    engine: 'compatible',
    browser: 'bundled-chromium',
    profile: { mode: 'ephemeral' },
  });
  const snapshot = await runtime.observe(session.id);
  expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  expect(snapshot.root.value).toBe('[REDACTED]');
  await runtime.closeAll();
}

test('artifact ownership and expiry isolate stored bytes', verifyOwnership);
test('artifact quotas reject excessive allocations', verifyQuotas);
test('protected screenshot pixels are removed before storage', verifyPixels);
test('trace exports filter input values and remain inert HTML', verifyTrace);
test('protected accessibility values are filtered before exposure', verifyProtectedValues);
