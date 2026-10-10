// -*- coding: utf-8 -*-
/**
 * inspection.test.ts
 * Actual Chromium independent inspection verification
 * =====================
 * Verify readonly CDP geometry, coordinate consent, and preserved official ARIA references in a headless browser.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ArtifactStore } from '@abr/artifacts';
import type { ActionRequest, AxNode } from '@abr/contracts';
import { defaultConfiguration, EngineRegistry, PolicyEngine, Runtime } from '@abr/core';
import { CompatibleEngine, resolveBrowserBinary } from '@abr/playwright-worker';
import { expect, test } from 'vitest';

import { startFixture } from '../../helpers/fixture-server.js';

/**
 * Locate an exact accessible fixture name in current browser metadata.
 * Args:
 *   root (AxNode): Browser accessibility subtree.
 *   name (string): Exact public accessible name.
 *   role (string | undefined): Optional semantic role constraint.
 * Returns:
 *   AxNode | undefined: Matching public fixture control or outcome.
 */
function find(root: AxNode, name: string, role?: string): AxNode | undefined {
  // Match fixture semantics before traversing bounded descendants.
  if (root.name === name && (!role || root.role === role)) return root;
  // Preserve the observed tree while searching its children.
  for (const child of root.children ?? []) {
    const match = find(child, name, role);
    if (match) return match;
  }
  return undefined;
}

/**
 * Select the interior of one actual CSS viewport control.
 * Args:
 *   node (AxNode): Observed public fixture control.
 *   windowId (string): Owned browser window identity.
 * Returns:
 *   NonNullable<ActionRequest['target']>: Coordinate target using verified CSS geometry.
 */
function center(node: AxNode, windowId: string): NonNullable<ActionRequest['target']> {
  const bounds = node.bounds;
  // Require actual browser CSS bounds rather than inferring a screen transform.
  if (!bounds || bounds.space !== 'viewport-css')
    throw new Error('Actual fixture CSS geometry is required.');
  return {
    kind: 'coordinate',
    windowId,
    space: 'viewport-css',
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/**
 * Verify actual independent inspection and consent without acquiring desktop focus.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of browser outcomes, preserved references, and undispatched consent assertions.
 */
async function verifyInspection(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-headless-inspection-'));
  const fixture = await startFixture();
  const configuration = defaultConfiguration();
  configuration.policy.sensitiveTargetPatterns = ['Query'];
  const policy = new PolicyEngine(configuration, root);
  const artifacts = new ArtifactStore({ root: path.join(root, 'artifacts') });
  const official = resolveBrowserBinary({
    engine: 'compatible',
    browser: 'bundled-chromium',
    profile: { mode: 'ephemeral' },
  });
  const engine = new CompatibleEngine({
    executablePath: official.executable,
    profileRoot: policy.profileRoot,
    artifactRoot: path.join(root, 'worker-artifacts'),
    /**
     * Store only controlled masked browser artifacts.
     * Args:
     *   sessionId (string): Owned browser session.
     *   bytes (Buffer): Masked PNG bytes.
     * Returns:
     *   Promise<string>: Controlled artifact identifier.
     */
    putScreenshot(sessionId, bytes) {
      return artifacts.putPng(sessionId, bytes);
    },
  });
  const registry = new EngineRegistry();
  registry.register(engine);
  const runtime = new Runtime(registry, policy);
  let stage = 'create';
  // Retain owned browser resources until their close acknowledgement releases the profile.
  try {
    const session = await runtime.create({
      engine: 'compatible',
      browser: 'custom-chromium',
      profile: { mode: 'ephemeral' },
      headless: true,
    });
    expect(session.browserVersion).toBe(official.version);
    stage = 'navigate';
    expect(
      await runtime.execute({
        requestId: 'inspection-navigate',
        sessionId: session.id,
        action: 'navigate',
        args: { url: fixture.url },
      }),
    ).toMatchObject({ status: 'succeeded' });
    stage = 'caller-observation';
    const caller = await runtime.observe(session.id);
    const button = find(caller.root, 'Activate', 'button');
    const query = find(caller.root, 'Query', 'textbox');
    expect(button).toBeDefined();
    expect(query).toBeDefined();
    stage = 'independent-observation';
    const independent = await engine.inspectionSnapshot(session.id);
    expect(independent.snapshotId).not.toBe(caller.snapshotId);
    expect(independent.url).toBe(caller.url);
    expect(independent.windowId).toBe(caller.windowId);
    expect(find(independent.root, 'Activate', 'button')?.bounds?.space).toBe('viewport-css');
    expect(JSON.stringify(independent)).not.toContain('fixture-secret');
    // Execute the original official ARIA reference after independent CDP inspection.
    stage = 'original-reference';
    expect(
      await runtime.execute({
        requestId: 'inspection-original-reference',
        sessionId: session.id,
        action: 'click',
        target: { kind: 'ax-node', snapshotId: caller.snapshotId, nodeId: button!.nodeId },
      }),
    ).toMatchObject({ status: 'succeeded', executionPath: 'playwright-cdp' });
    stage = 'original-reference-outcome';
    expect(find((await engine.inspectionSnapshot(session.id)).root, '1')).toBeDefined();
    // Completed input requires a fresh public snapshot before selecting another control.
    stage = 'fresh-coordinate-observation';
    const current = await runtime.observe(session.id);
    stage = 'coordinate';
    expect(
      await runtime.execute({
        requestId: 'inspection-coordinate',
        sessionId: session.id,
        action: 'click',
        target: center(find(current.root, 'Activate', 'button')!, current.windowId),
      }),
    ).toMatchObject({ status: 'succeeded', executionPath: 'playwright-cdp' });
    stage = 'coordinate-outcome';
    expect(find((await engine.inspectionSnapshot(session.id)).root, '2')).toBeDefined();
    // Configured sensitive coordinates stop at consent without a synthetic approval decision.
    stage = 'coordinate-consent';
    const pending = await runtime.execute({
      requestId: 'inspection-coordinate-consent',
      sessionId: session.id,
      action: 'click',
      target: center(query!, caller.windowId),
    });
    expect(pending).toMatchObject({
      status: 'approval-required',
      executionPath: 'not-executed',
    });
    expect(policy.approvalStatus(pending.approvalId!).status).toBe('pending');
    stage = 'consent-outcome';
    const after = await engine.inspectionSnapshot(session.id);
    expect(find(after.root, 'Query', 'textbox')?.states).not.toContain('focused');
    expect(find(after.root, 'Activate', 'button')?.states).toContain('focused');
    stage = 'close';
    await runtime.close(session.id);
    expect(await readdir(policy.profileRoot)).toEqual([]);
  } catch (error) {
    // Identify only the public test phase while preserving the actual typed failure cause.
    throw new Error(`Headless inspection failed during ${stage}.`, { cause: error });
  } finally {
    await runtime.closeAll();
    await artifacts.close();
    await fixture.close();
    // Remove only the exact directly allocated test directory after browser release.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-headless-inspection-')
    )
      throw new Error('Invalid independent inspection cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'actual readonly CDP preserves ARIA references and gates coordinate consent',
  verifyInspection,
  60000,
);
