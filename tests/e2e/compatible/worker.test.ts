// -*- coding: utf-8 -*-
/**
 * worker.test.ts
 * Official browser worker smoke verification
 * =====================
 * Verify real headed browser startup, observation, pointer input, and resource cleanup.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ArtifactStore } from '@abr/artifacts';
import type { AxNode } from '@abr/contracts';
import { PolicyEngine, readConfiguration } from '@abr/core';
import { CompatibleEngine } from '@abr/playwright-worker';
import { expect, test } from 'vitest';

import { startFixture } from '../../helpers/fixture-server.js';

/**
 * Locate a fixture node by role and accessible name.
 * Args:
 *   node (AxNode): Current standardized accessibility tree.
 *   role (string): Required semantic role.
 *   name (string): Required accessible name.
 * Returns:
 *   AxNode | undefined: Matched tree node.
 */
function find(node: AxNode, role: string, name: string): AxNode | undefined {
  if (node.role === role && node.name === name) return node;
  for (const child of node.children ?? []) {
    const result = find(child, role, name);
    if (result) return result;
  }
  return undefined;
}

/**
 * Verify actual official browser behavior through the supervised worker.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of headed browser and filtered PNG assertions.
 */
async function verifyWorker(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-compatible-'));
  const fixture = await startFixture();
  const policy = new PolicyEngine(await readConfiguration('config/abr.config.example.yaml'), root);
  const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const engine = new CompatibleEngine({
    profileRoot: policy.profileRoot,
    artifactRoot: path.join(root, 'worker-artifacts'),
    putScreenshot: (id, bytes) => artifacts.putPng(id, bytes),
  });
  let sessionId: string | undefined;
  // Release worker, profile, fixture, and image resources across every outcome.
  try {
    const prepared = await policy.prepareSession({
      engine: 'compatible',
      browser: 'bundled-chromium',
      profile: { mode: 'ephemeral' },
      headless: false,
    });
    const session = await engine.create(prepared);
    sessionId = session.id;
    await policy.created(session, prepared);
    expect(session.playwrightVersion).toBe('1.64.0');
    expect(session.browserVersion).not.toBe('fake-test-only');
    expect(await engine.currentUrl(session.id)).toBe('about:blank');
    await engine.execute({
      requestId: 'navigate',
      sessionId: session.id,
      action: 'navigate',
      args: { url: fixture.url },
    });
    const snapshot = await engine.observe(session.id);
    const button = find(snapshot.root, 'button', 'Activate');
    expect(button).toBeDefined();
    const result = await engine.execute({
      requestId: 'click',
      sessionId: session.id,
      action: 'click',
      target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: button!.nodeId },
    });
    expect(result.executionPath).toBe('playwright-cdp');
    const changed = await engine.observe(session.id);
    expect(find(changed.root, 'text', '1'), JSON.stringify(changed.root)).toBeDefined();
    const image = await engine.screenshot(session.id);
    expect((await artifacts.read(image.blobId, session.id)).bytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await engine.close(session.id);
    await policy.closed(session);
    sessionId = undefined;
  } finally {
    if (sessionId) await engine.close(sessionId);
    await artifacts.close();
    await fixture.close();
    // Recursively remove only the directly allocated owned test root.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-compatible-')
    )
      throw new Error('Invalid browser test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('official headed browser completes a supervised worker smoke workflow', verifyWorker, 60000);
