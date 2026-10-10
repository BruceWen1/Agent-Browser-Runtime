// -*- coding: utf-8 -*-
/**
 * comparator.test.ts
 * Strict event parity regression verification
 * =====================
 * Verify trusted semantics, composition ordering, environment validity, and immutable candidate evidence.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  compareEventTraces,
  createBaselineCandidate,
  eventTraceDigest,
  readApprovedBaseline,
  renderParityHtml,
  reviewBaselineCandidate,
  writeBaselineCandidate,
  writeParityReport,
} from '@abr/test-fixtures';
import type { EventSample, EventTrace } from '@abr/test-fixtures';
import { expect, test } from 'vitest';

/**
 * Construct a concrete same-platform trace fixture for comparator regression tests.
 * Args:
 *   None.
 * Returns:
 *   EventTrace: Deterministic sample with fixed complete provenance.
 */
function trace(): EventTrace {
  const common: Omit<EventSample, 'type'> = {
    trusted: true,
    timestampMs: 0,
    phase: 'capture',
    target: 'query',
    focus: 'query',
    activation: true,
    hasBeenActive: true,
    visibility: 'visible',
    historyLength: 1,
  };
  return {
    schemaVersion: 1,
    fixture: 'text-input-cjk-ime',
    environment: {
      os: 'win32',
      browserCommit: 'a'.repeat(40),
      engine: 'manual',
      osVersion: 'fixture-os',
      arch: 'x64',
      windowSystem: 'win32',
      keyboardLayout: 'fixture-layout',
      ime: 'fixture-ime',
      monitorDpi: 120,
      abrVersion: '0.1.0',
      playwrightVersion: 'not-applicable',
      profileId: 'owned-fixture-profile',
      fixtureVersion: '1.0.0',
      pageUrl: 'http://127.0.0.1:1234/text-input-cjk-ime',
      initialState: {
        cookieStorageHash: 'b'.repeat(64),
        viewportWidth: 800,
        viewportHeight: 600,
        permissions: 'default',
        focused: true,
        tabCount: 1,
      },
    },
    samples: [
      { ...common, type: 'keydown', key: 'Process', code: 'KeyA' },
      { ...common, type: 'compositionstart', timestampMs: 5, textLength: 0 },
      {
        ...common,
        type: 'beforeinput',
        timestampMs: 10,
        inputType: 'insertCompositionText',
        composing: true,
      },
      { ...common, type: 'compositionupdate', timestampMs: 15, textLength: 1 },
      { ...common, type: 'compositionend', timestampMs: 20, textLength: 1 },
      { ...common, type: 'input', timestampMs: 25, inputType: 'insertText', composing: false },
      { ...common, type: 'keyup', timestampMs: 30, key: 'Process', code: 'KeyA' },
    ],
    outcome: {
      controls: { query: { valueHash: 'c'.repeat(64) } },
      counter: 0,
      focus: 'query',
      selection: null,
      visibility: 'visible',
      scroll: { x: 0, y: 0 },
      popup: 'not-requested',
      clipboard: 'not-requested',
      uploadConfirmed: false,
      dropped: false,
      truncated: false,
    },
  };
}

/**
 * Verify strict trusted, activation, missing-event, and composition-order differences.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of event semantic regression assertions.
 */
function strictSemantics(): void {
  const baseline = trace();
  expect(compareEventTraces(baseline, structuredClone(baseline)).status).toBe('identical');
  const untrusted = structuredClone(baseline);
  untrusted.samples[2]!.trusted = false;
  expect(
    compareEventTraces(baseline, untrusted).differences.some((difference) =>
      difference.path.endsWith('.trusted'),
    ),
  ).toBe(true);
  const inactive = structuredClone(baseline);
  inactive.samples[2]!.activation = false;
  expect(compareEventTraces(baseline, inactive).status).toBe('unexpected-diff');
  const missing = structuredClone(baseline);
  missing.samples.splice(0, 1);
  expect(compareEventTraces(baseline, missing).status).toBe('unexpected-diff');
  const reordered = structuredClone(baseline);
  [reordered.samples[1], reordered.samples[4]] = [reordered.samples[4]!, reordered.samples[1]!];
  expect(compareEventTraces(baseline, reordered).status).toBe('unexpected-diff');
  const finalState = structuredClone(baseline);
  finalState.outcome.controls.query!.valueHash = 'd'.repeat(64);
  expect(
    compareEventTraces(baseline, finalState).differences.some(
      (difference) => difference.path === 'outcome',
    ),
  ).toBe(true);
}

/**
 * Verify tolerances preserve numerical discrepancies without hiding semantic differences.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of bounded normalization assertions.
 */
function numericalTolerances(): void {
  const baseline = trace();
  baseline.samples[0]!.clientX = 100;
  const actual = structuredClone(baseline);
  actual.samples[0]!.clientX = 101;
  // Change the clock origin independently from elapsed event timing.
  for (const sample of actual.samples) sample.timestampMs += 500;
  expect(compareEventTraces(baseline, actual).status).toBe('accepted-diff');
  actual.samples[0]!.clientX = 105;
  expect(compareEventTraces(baseline, actual).status).toBe('unexpected-diff');
  actual.samples[0]!.clientX = 100;
  actual.samples[2]!.timestampMs += 1200;
  expect(compareEventTraces(baseline, actual).status).toBe('unexpected-diff');
}

/**
 * Verify incomparable environment groups and unavailable capabilities have explicit states.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of fixed-environment validity assertions.
 */
function invalidGroups(): void {
  const baseline = trace();
  const actual = structuredClone(baseline);
  actual.environment.ime = 'different-ime';
  expect(compareEventTraces(baseline, actual).status).toBe('invalid-fixture');
  actual.environment.ime = baseline.environment.ime;
  actual.environment.initialState.focused = false;
  expect(compareEventTraces(baseline, actual).status).toBe('invalid-fixture');
  actual.environment.initialState.focused = true;
  actual.environment.browserCommit = 'unknown';
  expect(compareEventTraces(baseline, actual).status).toBe('invalid-fixture');
  expect(
    compareEventTraces(baseline, actual, { unsupportedReason: 'input.ime unavailable' }).status,
  ).toBe('unsupported');
  const truncated = trace();
  truncated.outcome.truncated = true;
  expect(compareEventTraces(baseline, truncated).status).toBe('invalid-fixture');
}

/**
 * Verify pointer sampling compression retains trusted and activation transitions.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of motion security-semantic assertions.
 */
function motionNormalization(): void {
  const baseline = trace();
  const pointer: EventSample = {
    ...baseline.samples[0]!,
    type: 'pointermove',
    clientX: 100,
    clientY: 100,
  };
  baseline.samples = [pointer, { ...pointer, phase: 'bubble' }];
  const actual = structuredClone(baseline);
  actual.samples.unshift({ ...pointer, clientX: 90 }, { ...pointer, phase: 'bubble', clientX: 90 });
  expect(compareEventTraces(baseline, actual, { collapsePointerMotion: true }).status).toBe(
    'identical',
  );
  actual.samples[0]!.trusted = false;
  expect(compareEventTraces(baseline, actual, { collapsePointerMotion: true }).status).toBe(
    'unexpected-diff',
  );
  actual.samples[0]!.trusted = true;
  actual.samples[0]!.activation = false;
  expect(compareEventTraces(baseline, actual, { collapsePointerMotion: true }).status).toBe(
    'unexpected-diff',
  );
}

/**
 * Verify generated candidates, immutable file writes, tamper detection, and safe report rendering.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of baseline and report artifact assertions.
 */
async function baselineEvidence(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-parity-'));
  // Clean up only the task-owned directory created directly under the system temporary root.
  try {
    const observation = trace();
    observation.environment.engine = 'compatible';
    observation.environment.playwrightVersion = '1.64.0';
    const candidate = createBaselineCandidate(observation);
    expect(candidate.status).toBe('candidate');
    expect(compareEventTraces(observation, observation).manualBaselineApproved).toBe(false);
    const filename = path.join(root, 'candidate.json');
    await writeBaselineCandidate(filename, observation);
    await expect(writeBaselineCandidate(filename, observation)).rejects.toThrow();
    await expect(readApprovedBaseline(filename)).rejects.toThrow();
    await expect(
      reviewBaselineCandidate(filename, path.join(root, 'approved.json')),
    ).rejects.toThrow();
    const manual = trace();
    const digest = eventTraceDigest(manual);
    const approved = {
      schemaVersion: 1,
      status: 'approved',
      traceSha256: digest,
      trace: manual,
      review: {
        surface: 'local-tty',
        reviewer: 'test receipt verifier',
        reviewedAt: '2026-10-10T00:00:00.000Z',
        decision: 'approve',
        reviewedTraceSha256: digest,
      },
    };
    // Synthetic receipts exercise integrity checks and remain isolated test evidence.
    approved.trace.samples[0]!.trusted = false;
    const tampered = path.join(root, 'tampered.json');
    await writeFile(tampered, JSON.stringify(approved));
    await expect(readApprovedBaseline(tampered)).rejects.toThrow();
    const report = compareEventTraces(manual, manual);
    report.fixture = '<script>alert("fixture")</script>';
    report.replaySteps = ['<img src=x onerror=alert(1)>'];
    const html = renderParityHtml(report);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    const directory = path.join(root, 'report');
    await writeParityReport(directory, report, manual, manual);
    expect(
      JSON.parse(await readFile(path.join(directory, 'parity-report.json'), 'utf8'))
        .manualBaselineApproved,
    ).toBe(false);
    await expect(writeParityReport(directory, report, manual, manual)).rejects.toThrow();
  } finally {
    // Resolve the cleanup guard before recursively removing the allocated temporary root.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-parity-')
    )
      throw new Error('Invalid parity cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('trusted activation and composition sequences compare strictly', strictSemantics);
test('elapsed timing and CSS geometry use declared tolerances', numericalTolerances);
test('pointer normalization preserves trusted and activation changes', motionNormalization);
test('environment drift and unavailable capabilities remain explicit', invalidGroups);
test(
  'baseline candidates require independent review and preserve artifact integrity',
  baselineEvidence,
);
