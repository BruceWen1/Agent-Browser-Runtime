// -*- coding: utf-8 -*-
/**
 * windows.test.ts
 * Windows browser physical input verification
 * =====================
 * Validate owned browser AX outcomes and privacy through actual native OS input.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ArtifactStore } from '@abr/artifacts';
import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import { EngineRegistry, PolicyEngine, Runtime, defaultConfiguration } from '@abr/core';
import { GuiEngine } from '@abr/native-ipc-client';
import { resolveBrowserBinary } from '@abr/playwright-worker';
import sharp from 'sharp';
import { expect, test } from 'vitest';

import { startFixture } from '../../helpers/fixture-server.js';

/**
 * Find an exact accessible name in an observed native tree.
 * Args:
 *   root (AxNode): Native semantic subtree.
 *   name (string): Exact fixture accessible name.
 *   role (string | undefined): Optional semantic role constraint.
 * Returns:
 *   AxNode | undefined: Matching native node.
 */
function find(root: AxNode, name: string, role?: string): AxNode | undefined {
  // Match the current semantic node before traversing its bounded descendants.
  if (root.name === name && (!role || root.role === role)) return root;
  // Search the current snapshot without querying browser script state.
  for (const child of root.children ?? []) {
    const found = find(child, name, role);
    if (found) return found;
  }
  return undefined;
}

/**
 * Find the physical rectangle of a privacy-filtered protected control.
 * Args:
 *   root (AxNode): Complete native accessibility subtree.
 * Returns:
 *   AxNode | undefined: Protected control retaining only safe geometry.
 */
function protectedControl(root: AxNode): AxNode | undefined {
  // Prefer the sensitive control itself over a generic protected container.
  if (
    root.role === 'textbox' &&
    root.states.includes('protected') &&
    root.bounds?.space === 'screen-physical'
  )
    return root;
  // Traverse safe descendants while preserving the source observation.
  for (const child of root.children ?? []) {
    const found = protectedControl(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Verify real GUI keyboard, semantic pointer input, masked capture, and cleanup.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of native browser outcome assertions.
 */
async function physical(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'abr-gui-e2e-'));
  const fixture = await startFixture();
  const config = defaultConfiguration();
  const policy = new PolicyEngine(config, directory);
  const artifacts = new ArtifactStore({ root: path.join(directory, 'artifacts') });
  const registry = new EngineRegistry();
  const gui = new GuiEngine({
    agentExecutable: path.resolve('target/debug/abr-desktop-agent.exe'),
    runtimeDirectory: path.join(directory, 'runtime'),
    profileRoot: policy.profileRoot,
    /**
     * Resolve the matched official browser binary for physical GUI input.
     * Args:
     *   input (CreateSessionRequest): Browser selection.
     * Returns:
     *   Promise<object>: Existing binary and official version metadata.
     */
    async resolveBrowser(input) {
      return resolveBrowserBinary(input);
    },
    /**
     * Store a masked native capture for verification.
     * Args:
     *   sessionId (string): Owned GUI session.
     *   bytes (Buffer): Masked capture PNG.
     * Returns:
     *   Promise<string>: Controlled artifact identifier.
     */
    putScreenshot(sessionId, bytes) {
      return artifacts.putPng(sessionId, bytes);
    },
  });
  registry.register(gui);
  const runtime = new Runtime(registry, policy, {
    actionTimeoutMs: 15000,
    /**
     * Report safe lifecycle failure metadata for native cleanup diagnostics.
     * Args:
     *   event (AuditEvent): Safe runtime audit record.
     * Returns:
     *   void: Completion of failure-only test diagnostics.
     */
    audit(event) {
      if (event.event.includes('close-failed') || event.event.includes('cancel-failed'))
        console.error(JSON.stringify(event));
    },
  });
  try {
    const session = await runtime.create({
      engine: 'gui',
      browser: 'bundled-chromium',
      profile: { mode: 'ephemeral' },
      locale: 'en-US',
    });
    const result = await runtime.execute({
      requestId: 'navigate',
      sessionId: session.id,
      action: 'navigate',
      args: { url: fixture.url },
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'succeeded',
      executionPath: 'os-input',
    });
    let snapshot: BrowserSnapshot = await runtime.observe(session.id);
    // Wait for fixture accessibility without replaying navigation or pointer input.
    for (let attempt = 0; attempt < 30 && !find(snapshot.root, 'Activate'); attempt++) {
      await delay(100);
      snapshot = await runtime.observe(session.id);
    }
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    const button = find(snapshot.root, 'Activate', 'button');
    expect(button).toBeDefined();
    const clicked = await runtime.execute({
      requestId: 'click',
      sessionId: session.id,
      action: 'click',
      target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: button!.nodeId },
    });
    expect(clicked, JSON.stringify(clicked)).toMatchObject({
      status: 'succeeded',
      executionPath: 'os-input',
    });
    await delay(200);
    snapshot = await runtime.observe(session.id);
    expect(find(snapshot.root, '1')).toBeDefined();
    const query = find(snapshot.root, 'Query', 'textbox');
    expect(query).toBeDefined();
    expect(
      await runtime.execute({
        requestId: 'query-focus',
        sessionId: session.id,
        action: 'click',
        target: { kind: 'ax-node', snapshotId: snapshot.snapshotId, nodeId: query!.nodeId },
      }),
    ).toMatchObject({ status: 'succeeded' });
    expect(
      await runtime.execute({
        requestId: 'text',
        sessionId: session.id,
        action: 'type-text',
        args: { text: 'ABR native 中文', strategy: 'auto' },
      }),
    ).toMatchObject({ status: 'succeeded', actualStrategy: 'os-unicode' });
    snapshot = await runtime.observe(session.id);
    expect(find(snapshot.root, 'Query', 'textbox')?.value).toBe('ABR native 中文');
    const capture = await runtime.screenshot(session.id);
    const png = (await artifacts.read(capture.blobId, session.id)).bytes;
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const protectedNode = protectedControl(snapshot.root);
    expect(protectedNode?.bounds).toBeDefined();
    expect(protectedNode?.name).toBe('Protected input');
    expect(protectedNode?.value).toBe('[REDACTED]');
    expect(snapshot.geometry?.windowOrigin).toBeDefined();
    const bounds = protectedNode!.bounds!;
    const origin = snapshot.geometry!.windowOrigin;
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Verify an interior sensitive-field pixel using the public physical window geometry.
    const x = Math.round(bounds.x + bounds.width / 2 - origin.x);
    const y = Math.round(bounds.y + bounds.height / 2 - origin.y);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(info.width);
    expect(y).toBeLessThan(info.height);
    const pixel = (y * info.width + x) * info.channels;
    expect(Array.from(data.subarray(pixel, pixel + 3))).toEqual([0, 0, 0]);
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'public-input-evidence', samples: fixture.inputEvidence() }),
    );
    console.error(JSON.stringify(await gui.diagnostics().catch(() => ({ unavailable: true }))));
    throw error;
  } finally {
    const cleanup = await Promise.allSettled(
      runtime.list().map((session) => runtime.close(session.id)),
    );
    const failure = cleanup.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') console.error('Native close failure:', failure.reason);
    await artifacts.close();
    await fixture.close();
    if (
      path.dirname(directory) === path.resolve(tmpdir()) &&
      path.basename(directory).startsWith('abr-gui-e2e-')
    )
      await rm(directory, { recursive: true, force: true });
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

test.skipIf(
  process.env.ABR_GUI_E2E !== '1' ||
    process.platform !== 'win32' ||
    !existsSync('target/debug/abr-desktop-agent.exe'),
)('Windows actual OS input changes owned browser state and produces masked PNG', physical, 60000);
