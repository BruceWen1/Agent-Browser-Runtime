// -*- coding: utf-8 -*-
/**
 * native.test.ts
 * Native adapter startup boundaries
 * =====================
 * Verify explicit custom-build selection and preservation of native engine identity.
 */
import { NativeEngine } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

/**
 * Verify Native requires a compiled custom build before opening any process.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of explicit availability boundary assertions.
 */
async function boundary(): Promise<void> {
  const engine = new NativeEngine({
    agentExecutable: 'missing-agent',
    runtimeDirectory: 'owned-runtime',
    profileRoot: 'owned-profiles',
    upstreamCommit: '0'.repeat(40),
    upstreamVersion: '0.0.0.0',
    /**
     * Reject unexpected binary resolution in this preflight-only test.
     * Args:
     *   None.
     * Returns:
     *   Promise<never>: Unexpected-start failure.
     */
    async resolveBrowser() {
      throw new Error('Browser resolution must remain gated.');
    },
    /**
     * Reject unexpected screenshot storage in this preflight-only test.
     * Args:
     *   None.
     * Returns:
     *   Promise<never>: Unexpected-capture failure.
     */
    async putScreenshot() {
      throw new Error('Capture must remain gated.');
    },
  });
  expect(engine.kind).toBe('native');
  await expect(
    engine.create({
      engine: 'native',
      browser: 'bundled-chromium',
      profile: { mode: 'ephemeral', name: 'owned' },
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
}

test('Native startup preserves identity and requires an explicit compiled custom build', boundary);
