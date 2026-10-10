// -*- coding: utf-8 -*-
/**
 * coordinate-policy.test.ts
 * Coordinate semantic consent and caller-reference preservation
 * =====================
 * Verify actual Core and policy decisions against explicit browser-free semantic inspection doubles.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BrowserError, validateCoordinateInspection } from '@abr/contracts';
import type { ActionRequest, ActionResult, AxNode, BrowserSnapshot } from '@abr/contracts';
import { defaultConfiguration, EngineRegistry, PolicyEngine, Runtime } from '@abr/core';
import { expect, test } from 'vitest';

import { StubEngine } from '../helpers/stub-engine.js';

/** PolicyInspectionDouble maintains caller snapshots independently from fresh inspection metadata. */
class PolicyInspectionDouble extends StubEngine {
  sensitiveName = 'Delete message';
  sensitiveValue = 'private-fixture-value';
  transientStates: string[] = [];
  ambiguous = false;
  publicSnapshotId: string | undefined;
  inspections = 0;
  inspectedBeforeInput: BrowserSnapshot | undefined;
  changeAtDispatch: string | undefined;
  onExecute: (() => void) | undefined;

  /**
   * Build controlled physical semantic metadata without changing any stored caller reference.
   * Args:
   *   sessionId (string): Owned test browser identity.
   *   snapshotId (string): Explicit public or independent observation identity.
   * Returns:
   *   BrowserSnapshot: Browser-free current semantic fixture.
   */
  private snapshot(sessionId: string, snapshotId: string): BrowserSnapshot {
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
        value: this.sensitiveValue,
        states: [...this.transientStates],
        bounds: { x: 200, y: 20, width: 100, height: 40, space: 'screen-physical' },
      },
    ];
    if (this.ambiguous)
      controls.push({ ...controls[1]!, nodeId: 'overlapping', name: 'Other control' });
    return {
      sessionId,
      snapshotId,
      timestamp: new Date().toISOString(),
      windowId: 'owned-window',
      tabId: 'owned-tab',
      root: { nodeId: 'document', role: 'document', states: [], children: controls },
      scale: { dpr: 1, zoom: 1 },
      source: 'playwright-accessibility',
      url: 'http://127.0.0.1/',
    };
  }

  /**
   * Publish caller references for the explicit test selection workflow.
   * Args:
   *   sessionId (string): Owned test browser identity.
   * Returns:
   *   Promise<BrowserSnapshot>: Public fixture snapshot whose ID remains cached.
   */
  override async observe(sessionId: string): Promise<BrowserSnapshot> {
    this.publicSnapshotId = randomUUID();
    return this.snapshot(sessionId, this.publicSnapshotId);
  }

  /**
   * Read current fixture semantics without overwriting the public target cache.
   * Args:
   *   sessionId (string): Owned test browser identity.
   * Returns:
   *   Promise<BrowserSnapshot>: Independently identified semantic inspection.
   */
  override async inspectionSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    this.inspections++;
    return this.snapshot(sessionId, randomUUID());
  }

  /**
   * Revalidate private coordinate evidence and count simulated dispatch only after admission.
   * Args:
   *   input (ActionRequest): Authorized fake operation.
   *   inspection (BrowserSnapshot | undefined): Private coordinate authorization witness.
   * Returns:
   *   Promise<ActionResult>: Explicit unexecuted physical path with a fake operation count.
   */
  override async execute(
    input: ActionRequest,
    inspection?: BrowserSnapshot,
  ): Promise<ActionResult> {
    this.onExecute?.();
    if (this.block) await this.block;
    const references = [
      input.target,
      input.args?.source,
      input.args?.destination,
    ] as ActionRequest['target'][];
    // Original mixed-drag AX references must survive the private semantic read.
    for (const target of references)
      if (target?.kind === 'ax-node' && target.snapshotId !== this.publicSnapshotId)
        throw new BrowserError('TARGET_STALE', 'Caller reference cache was overwritten.');
    if (this.changeAtDispatch) this.sensitiveName = this.changeAtDispatch;
    if (inspection) {
      this.inspectedBeforeInput = inspection;
      validateCoordinateInspection(
        input,
        inspection,
        await this.inspectionSnapshot(input.sessionId),
      );
    }
    this.executed++;
    return {
      requestId: input.requestId,
      sessionId: input.sessionId,
      actionId: randomUUID(),
      status: 'succeeded',
      executionPath: 'not-executed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Assemble real Core and policy with a browser-free semantic fixture.
 * Args:
 *   patterns (string[]): Optional trusted sensitive-control names.
 * Returns:
 *   Promise<object>: Owned runtime, policy, double, and cleanup handle.
 */
async function setup(patterns: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-coordinate-policy-'));
  const config = defaultConfiguration();
  config.policy.sensitiveTargetPatterns = patterns;
  const policy = new PolicyEngine(config, root);
  const registry = new EngineRegistry();
  const engine = new PolicyInspectionDouble();
  registry.register(engine);
  const runtime = new Runtime(registry, policy);
  const session = await runtime.create({
    engine: 'compatible',
    browser: 'bundled-chromium',
    profile: { mode: 'ephemeral' },
  });
  return { root, engine, policy, runtime, session };
}

/**
 * Release simulated browser state and its exact allocated policy directory.
 * Args:
 *   fixture (Awaited<ReturnType<typeof setup>>): Owned test runtime and directory.
 * Returns:
 *   Promise<void>: Completion of bounded test resource cleanup.
 */
async function close(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await fixture.runtime.closeAll();
  if (
    path.dirname(fixture.root) !== path.resolve(tmpdir()) ||
    !path.basename(fixture.root).startsWith('abr-coordinate-policy-')
  )
    throw new Error('Invalid coordinate policy cleanup root.');
  await rm(fixture.root, { recursive: true, force: true });
}

/**
 * Create an exact coordinate button action for the owned fixture.
 * Args:
 *   sessionId (string): Owned fake browser identity.
 *   requestId (string): Exactly-once action identity.
 * Returns:
 *   ActionRequest: Point within the named sensitive control.
 */
function coordinateClick(sessionId: string, requestId: string): ActionRequest {
  return {
    requestId,
    sessionId,
    action: 'click',
    target: {
      kind: 'coordinate',
      x: 250,
      y: 40,
      space: 'screen-physical',
      windowId: 'owned-window',
    },
  };
}

/**
 * Verify coordinate input reaches real sensitive-control policy before any adapter dispatch.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of deletion and unsupported inspection assertions.
 */
async function gateCoordinateDeletion(): Promise<void> {
  const fixture = await setup();
  try {
    const result = await fixture.runtime.execute(coordinateClick(fixture.session.id, 'delete'));
    expect(result).toMatchObject({ status: 'approval-required', executionPath: 'not-executed' });
    expect(fixture.engine.executed).toBe(0);
    expect(fixture.engine.publicSnapshotId).toBeUndefined();
    expect(JSON.stringify(fixture.policy.approvalStatus(result.approvalId!))).not.toContain(
      'private-fixture-value',
    );
    Reflect.set(fixture.engine, 'inspectionSnapshot', undefined);
    expect(
      await fixture.runtime.execute(coordinateClick(fixture.session.id, 'missing-inspection')),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_CAPABILITY' },
    });
    expect(fixture.engine.executed).toBe(0);
  } finally {
    await close(fixture);
  }
}

/**
 * Verify approved deletion cannot authorize a changed payment control at the same point.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of semantic approval renewal and exactly-once assertions.
 */
async function bindChangedSemanticApproval(): Promise<void> {
  const fixture = await setup();
  try {
    const request = coordinateClick(fixture.session.id, 'semantic-change');
    const deletion = await fixture.runtime.execute(request);
    fixture.policy.reviewFromTrustedUi(deletion.approvalId!, true);
    fixture.engine.sensitiveName = 'Payment';
    const payment = await fixture.runtime.execute(request);
    expect(payment.status).toBe('approval-required');
    expect(payment.approvalId).not.toBe(deletion.approvalId);
    expect(fixture.policy.approvalState(request)).toBe('pending');
    expect(fixture.engine.executed).toBe(0);
    fixture.policy.reviewFromTrustedUi(payment.approvalId!, true);
    fixture.engine.transientStates = ['focused', 'hovered'];
    fixture.engine.sensitiveValue = 'different-private-value';
    const [first, duplicate] = await Promise.all([
      fixture.runtime.execute(request),
      fixture.runtime.execute(request),
    ]);
    expect(first.status).toBe('succeeded');
    expect(duplicate.actionId).toBe(first.actionId);
    expect(fixture.engine.executed).toBe(1);
  } finally {
    await close(fixture);
  }
}

/**
 * Verify both mixed drag endpoints share configured consent while caller references remain valid.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of configured risk, private snapshot, and cache preservation assertions.
 */
async function gateMixedDragAndPreserveCaller(): Promise<void> {
  const fixture = await setup(['Publish']);
  try {
    fixture.engine.sensitiveName = 'Publish update';
    const caller = await fixture.runtime.observe(fixture.session.id);
    const request: ActionRequest = {
      requestId: 'mixed-drag',
      sessionId: fixture.session.id,
      action: 'drag',
      args: {
        source: { kind: 'ax-node', snapshotId: caller.snapshotId, nodeId: 'safe' },
        destination: {
          kind: 'coordinate',
          x: 250,
          y: 40,
          space: 'screen-physical',
          windowId: caller.windowId,
        },
      },
    };
    const pending = await fixture.runtime.execute(request);
    expect(pending.status).toBe('approval-required');
    expect(fixture.engine.publicSnapshotId).toBe(caller.snapshotId);
    fixture.policy.reviewFromTrustedUi(pending.approvalId!, true);
    const result = await fixture.runtime.execute(request);
    expect(result.status).toBe('succeeded');
    expect(fixture.engine.executed).toBe(1);
    expect(fixture.engine.publicSnapshotId).toBe(caller.snapshotId);
    expect(fixture.engine.inspectedBeforeInput?.snapshotId).not.toBe(caller.snapshotId);
  } finally {
    await close(fixture);
  }
}

/**
 * Verify unknown, ambiguous, or dispatch-time changed semantics stop coordinate input.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of explicit inspection rejection assertions.
 */
async function rejectUnverifiedCoordinates(): Promise<void> {
  const fixture = await setup();
  try {
    const request = coordinateClick(fixture.session.id, 'unknown');
    const background = {
      ...request,
      target: {
        ...request.target!,
        kind: 'coordinate' as const,
        x: 450,
        y: 200,
        space: 'screen-physical' as const,
        windowId: 'owned-window',
      },
    };
    expect(await fixture.runtime.execute(background)).toMatchObject({
      status: 'failed',
      error: { code: 'TARGET_NOT_FOUND' },
    });
    fixture.engine.ambiguous = true;
    expect(
      await fixture.runtime.execute(coordinateClick(fixture.session.id, 'ambiguous')),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'UNSUPPORTED_CAPABILITY' },
    });
    fixture.engine.ambiguous = false;
    const pending = await fixture.runtime.execute(
      coordinateClick(fixture.session.id, 'dispatch-change'),
    );
    fixture.policy.reviewFromTrustedUi(pending.approvalId!, true);
    fixture.engine.changeAtDispatch = 'Payment';
    expect(
      await fixture.runtime.execute(coordinateClick(fixture.session.id, 'dispatch-change')),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'TARGET_STALE' },
    });
    expect(fixture.engine.executed).toBe(0);
  } finally {
    await close(fixture);
  }
}

test(
  'coordinate sensitive controls require real policy consent before adapter dispatch',
  gateCoordinateDeletion,
);
test(
  'approved deletion coordinates require renewed payment consent and preserve exactly-once execution',
  bindChangedSemanticApproval,
);
test(
  'mixed coordinate and AX drag endpoints share configured consent without replacing caller references',
  gateMixedDragAndPreserveCaller,
);
test(
  'unknown, ambiguous, and dispatch-time changed coordinate targets stop before input',
  rejectUnverifiedCoordinates,
);

/**
 * Verify concurrent busy observations preserve the adapter and Core AX caller references.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of isolated busy-read and mixed-drag cache assertions.
 */
async function preserveBusyCallerReferences(): Promise<void> {
  const fixture = await setup();
  let release: (() => void) | undefined;
  try {
    const caller = await fixture.runtime.observe(fixture.session.id);
    const entered = new Promise<void>((resolve) => {
      fixture.engine.onExecute = resolve;
    });
    fixture.engine.block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = fixture.runtime.execute({
      requestId: 'busy-mixed',
      sessionId: fixture.session.id,
      action: 'drag',
      args: {
        source: { kind: 'ax-node', snapshotId: caller.snapshotId, nodeId: 'safe' },
        destination: {
          kind: 'coordinate',
          x: 70,
          y: 40,
          space: 'screen-physical',
          windowId: caller.windowId,
        },
      },
    });
    await entered;
    const observedWhileBusy = await fixture.runtime.observe(fixture.session.id);
    expect(observedWhileBusy.snapshotId).not.toBe(caller.snapshotId);
    expect(fixture.engine.publicSnapshotId).toBe(caller.snapshotId);
    release!();
    expect((await operation).status).toBe('succeeded');
    expect(fixture.engine.executed).toBe(1);
  } finally {
    release?.();
    await close(fixture);
  }
}

test(
  'busy read-only observations preserve pending mixed-drag caller references',
  preserveBusyCallerReferences,
);
