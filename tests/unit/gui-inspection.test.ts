// -*- coding: utf-8 -*-
/**
 * gui-inspection.test.ts
 * GUI private inspection and OS dispatcher cache boundaries
 * =====================
 * Exercise real adapter dispatch through explicit in-memory native-channel doubles.
 */
import { ChildProcess } from 'node:child_process';

import type { AxNode, BrowserSnapshot } from '@abr/contracts';
import { GuiEngine } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

/** GuiInspectionDouble exposes native fixture geometry without creating a browser or OS input. */
class GuiInspectionDouble extends GuiEngine {
  readonly inputs: Record<string, unknown>[] = [];
  sensitiveName = 'Delete message';

  /**
   * Seed one owned metadata session and a closed in-memory desktop channel.
   * Args:
   *   None.
   * Returns:
   *   GuiInspectionDouble: Real GUI adapter with explicit native doubles.
   */
  constructor() {
    super({
      agentExecutable: 'unused-agent',
      runtimeDirectory: 'owned-runtime',
      profileRoot: 'owned-profiles',
      /**
       * Reject actual browser resolution in this dispatcher-only test.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Unexpected process failure.
       */
      async resolveBrowser() {
        throw new Error('This unit test has no browser process.');
      },
      /**
       * Reject actual screenshot persistence in this dispatcher-only test.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Unexpected capture failure.
       */
      async putScreenshot() {
        throw new Error('This unit test has no capture process.');
      },
    });
    this.sessions.set('owned', {
      metadata: {
        id: 'owned',
        engine: 'gui',
        status: 'ready',
        browserVersion: 'unit-double',
        platform: 'unit-double',
        capabilities: [],
        createdAt: new Date().toISOString(),
        profileId: 'owned',
      },
      process: new ChildProcess(),
      windowId: 'owned-window',
      cancelled: false,
    });
    Reflect.set(this, 'agent', Promise.resolve({ call: this.desktopCall.bind(this) }));
  }

  /**
   * Return fixture observation or record one native-operation double.
   * Args:
   *   method (string): Closed desktop operation name.
   *   params (Record<string, unknown>): Owned native request parameters.
   * Returns:
   *   Promise<unknown>: Native acknowledgement or independent fixture geometry.
   */
  private async desktopCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'desktop.input') {
      this.inputs.push(params);
      return { executed: true };
    }
    if (method !== 'desktop.observe') throw new Error('Unexpected native test operation.');
    const controls: AxNode[] = [
      {
        nodeId: 'safe',
        role: 'button',
        name: 'Activate',
        states: [],
        bounds: { x: 20, y: 20, width: 100, height: 40, space: 'screen-physical' },
      },
      {
        nodeId: 'sensitive',
        role: 'button',
        name: this.sensitiveName,
        states: [],
        bounds: { x: 200, y: 20, width: 100, height: 40, space: 'screen-physical' },
      },
    ];
    return {
      windowId: 'owned-window',
      url: 'http://127.0.0.1/',
      root: { nodeId: 'root', role: 'window', states: [], children: controls },
      scale: { dpr: 1, zoom: 1 },
      geometry: {
        windowOrigin: { x: 0, y: 0 },
        viewportOrigin: { x: 0, y: 0 },
        monitorScale: 1,
        viewportMetricsVerified: false,
      },
    };
  }

  /**
   * Read the cached public caller observation without changing its identity.
   * Args:
   *   None.
   * Returns:
   *   BrowserSnapshot | undefined: Current GUI caller-reference cache.
   */
  cachedSnapshot(): BrowserSnapshot | undefined {
    return this.session('owned').snapshot;
  }
}

/**
 * Verify a real GUI mixed-drag dispatch preserves the public AX source after private inspection.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of cache and single native-operation double assertions.
 */
async function preserveGuiCaller(): Promise<void> {
  const engine = new GuiInspectionDouble();
  const caller = await engine.observe('owned');
  const inspection = await engine.inspectionSnapshot('owned');
  expect(inspection.snapshotId).not.toBe(caller.snapshotId);
  expect(engine.cachedSnapshot()?.snapshotId).toBe(caller.snapshotId);
  const result = await engine.execute(
    {
      requestId: 'mixed',
      sessionId: 'owned',
      action: 'drag',
      args: {
        source: { kind: 'ax-node', snapshotId: caller.snapshotId, nodeId: 'safe' },
        destination: {
          kind: 'coordinate',
          windowId: caller.windowId,
          space: 'screen-physical',
          x: 250,
          y: 40,
        },
      },
    },
    inspection,
  );
  expect(result.status).toBe('succeeded');
  expect(engine.inputs).toHaveLength(1);
  expect(engine.inputs[0]).toMatchObject({ kind: 'drag', x: 70, y: 40, endX: 250, endY: 40 });
}

/**
 * Verify a changed real-adapter semantic witness prevents native dispatch.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of pre-input semantic freshness assertions.
 */
async function rejectGuiSemanticChange(): Promise<void> {
  const engine = new GuiInspectionDouble();
  const inspection = await engine.inspectionSnapshot('owned');
  engine.sensitiveName = 'Payment';
  await expect(
    engine.execute(
      {
        requestId: 'changed',
        sessionId: 'owned',
        action: 'click',
        target: {
          kind: 'coordinate',
          windowId: inspection.windowId,
          space: 'screen-physical',
          x: 250,
          y: 40,
        },
      },
      inspection,
    ),
  ).rejects.toMatchObject({ code: 'TARGET_STALE' });
  expect(engine.inputs).toHaveLength(0);
}

test('GUI private inspection preserves mixed-drag AX caller references', preserveGuiCaller);
test(
  'GUI coordinate dispatch rejects changed approved semantics before native input',
  rejectGuiSemanticChange,
);
