// -*- coding: utf-8 -*-
/**
 * capabilities.test.ts
 * Desktop navigation capability admission
 * =====================
 * Validate native capability reports against explicit doctor doubles without creating desktop input.
 */
import { ChildProcess } from 'node:child_process';

import { BrowserError } from '@abr/contracts';
import { GuiEngine } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

/** CapabilityHarness supplies read-only doctor state to the public GUI capability boundary. */
class CapabilityHarness extends GuiEngine {
  readonly calls: string[] = [];

  /**
   * Seed an isolated session and a read-only desktop doctor channel.
   * Args:
   *   doctor (Record<string, unknown>): Explicit native capability metadata.
   * Returns:
   *   CapabilityHarness: Adapter with no launched process or native desktop effects.
   */
  constructor(doctor: Record<string, unknown>) {
    super({
      agentExecutable: 'unused-agent',
      runtimeDirectory: 'owned-runtime',
      profileRoot: 'owned-profiles',
      /**
       * Reject unexpected browser creation in the capability-only harness.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Unexpected-start failure.
       */
      async resolveBrowser() {
        throw new Error('Capability verification uses a read-only doctor double.');
      },
      /**
       * Reject unexpected capture storage in the capability-only harness.
       * Args:
       *   None.
       * Returns:
       *   Promise<never>: Unexpected-capture failure.
       */
      async putScreenshot() {
        throw new Error('Capability verification has no screenshot output.');
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
    Reflect.set(
      this,
      'agent',
      Promise.resolve({
        /**
         * Expose the doctor double and reject every mutation method.
         * Args:
         *   method (string): Requested desktop operation.
         * Returns:
         *   Promise<Record<string, unknown>>: Deep-copied read-only doctor metadata.
         */
        call: async (method: string): Promise<Record<string, unknown>> => {
          this.calls.push(method);
          if (method !== 'desktop.doctor') throw new Error('Unexpected desktop mutation.');
          return structuredClone(doctor);
        },
      }),
    );
  }
}

/**
 * Verify pointer availability alone cannot advertise an unsupported atomic navigation sequence.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of truthful native capability assertions.
 */
async function gateNavigation(): Promise<void> {
  // Cover Unix explicit false, older metadata omission, and unavailable native input independently.
  for (const doctor of [
    { input: true, atomicNavigate: false, accessibility: true, reason: 'AVAILABLE' },
    { input: true, accessibility: true, reason: 'AVAILABLE' },
    { input: false, atomicNavigate: true, accessibility: true, reason: 'MONITOR_UNAVAILABLE' },
  ]) {
    const engine = new CapabilityHarness(doctor);
    const report = await engine.capabilities('owned');
    expect(report.supported).not.toContain('browser.navigate');
    expect(report.unsupported['browser.navigate']).not.toBe('AVAILABLE');
    expect(report.unsupported['browser.navigate']).toBeDefined();
    expect(report.supported.includes('input.pointer')).toBe(doctor.input);
    expect(report.supported.includes('input.keyboard')).toBe(doctor.input);
    expect(engine.calls).toEqual(['desktop.doctor']);
  }
  const available = new CapabilityHarness({
    input: true,
    atomicNavigate: true,
    accessibility: true,
  });
  const report = await available.capabilities('owned');
  expect(report.supported).toContain('browser.navigate');
  expect(report.unsupported['browser.navigate']).toBeUndefined();
  expect(available.calls).toEqual(['desktop.doctor']);
}

test(
  'GUI browser navigation requires an explicit atomic native operation and available input',
  gateNavigation,
);

/**
 * Verify a failed agent startup releases shared input ownership for subsequent requests.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of startup-failure and retry admission assertions.
 */
async function releaseFailedStartup(): Promise<void> {
  const engine = new CapabilityHarness({ input: true, atomicNavigate: true });
  const failure = new BrowserError('INPUT_BACKEND_UNAVAILABLE', 'Unit agent startup failed.');
  Reflect.set(engine, 'agent', Promise.reject(failure));
  // Every rejected startup must leave the input seat available to a later request.
  for (const requestId of ['failed-startup', 'subsequent-startup']) {
    await expect(
      engine.execute({ requestId, sessionId: 'owned', action: 'focus' }),
    ).rejects.toMatchObject({ code: 'INPUT_BACKEND_UNAVAILABLE' });
  }
}

test(
  'GUI releases shared input ownership after supervised agent startup rejection',
  releaseFailedStartup,
);
