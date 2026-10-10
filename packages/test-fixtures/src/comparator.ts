// -*- coding: utf-8 -*-
/**
 * comparator.ts
 * Event parity comparison
 * =====================
 * Compare fixed environments, deterministic event semantics, and bounded numerical differences.
 */
import { validate } from '@abr/contracts';

import type { EventSample, EventTrace, ParityReport, TraceDifference } from './trace.js';

/** ComparisonOptions contains declared tolerances and explicit capability evidence. */
export interface ComparisonOptions {
  timestampToleranceMs?: number;
  coordinateToleranceCssPx?: number;
  collapsePointerMotion?: boolean;
  unsupportedReason?: string;
  replaySteps?: string[];
}

/**
 * Produce a deterministic JSON representation for safe object comparison.
 * Args:
 *   value (unknown): JSON-compatible trace field.
 * Returns:
 *   string: Sorted, stable representation.
 */
export function stableJson(value: unknown): string {
  // Arrays preserve observable sequence order.
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  // Objects compare independently of serialization property insertion order.
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([first], [second]) => first.localeCompare(second));
    return (
      '{' +
      entries.map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item)).join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Validate a bounded trace against the shared event contract and local field shape.
 * Args:
 *   value (unknown): Parsed fixture artifact.
 * Returns:
 *   EventTrace: Validated trace for comparison or baseline storage.
 */
export function parseEventTrace(value: unknown): EventTrace {
  validate('browser-event', value);
  const trace = value as EventTrace;
  // Bound artifact size and event count before any comparison or report expansion.
  if (trace.samples.length > 20000 || Buffer.byteLength(JSON.stringify(trace)) > 4 * 1024 * 1024)
    throw new Error('Trace exceeds the fixture quota.');
  // Require the structural fields used by the deterministic event comparator.
  for (const sample of trace.samples) {
    if (
      !Number.isFinite(sample.timestampMs) ||
      typeof sample.target !== 'string' ||
      typeof sample.focus !== 'string' ||
      typeof sample.activation !== 'boolean' ||
      typeof sample.hasBeenActive !== 'boolean' ||
      typeof sample.visibility !== 'string' ||
      !['capture', 'bubble', 'observer'].includes(sample.phase) ||
      !Number.isInteger(sample.historyLength)
    )
      throw new Error('Invalid event sample structure.');
  }
  // Ensure exported outcome has all privacy filtered final-state surfaces.
  const outcome = trace.outcome;
  if (
    !outcome ||
    typeof outcome.controls !== 'object' ||
    typeof outcome.counter !== 'number' ||
    typeof outcome.focus !== 'string' ||
    typeof outcome.truncated !== 'boolean' ||
    !outcome.scroll ||
    !Number.isFinite(outcome.scroll.x) ||
    !Number.isFinite(outcome.scroll.y)
  )
    throw new Error('Invalid fixture outcome structure.');
  return trace;
}

/**
 * Collapse motion samples only while deterministic event semantics remain unchanged.
 * Args:
 *   samples (EventSample[]): Ordered native event observations.
 * Returns:
 *   EventSample[]: Preserved non-motion events and final sample per unchanged motion phase.
 */
function collapseMotion(samples: EventSample[]): EventSample[] {
  const output: EventSample[] = [];
  let signature = '';
  let pending = new Map<string, EventSample>();
  // Flush trajectories at every semantic change or non-motion event boundary.
  for (const sample of samples) {
    const semantics: Partial<EventSample> = { ...sample };
    // Exclude only declared motion geometry and sampling phase from collapse grouping.
    delete semantics.timestampMs;
    delete semantics.clientX;
    delete semantics.clientY;
    delete semantics.phase;
    const next = sample.type === 'pointermove' ? stableJson(semantics) : '';
    // Motion changes in trusted, activation, focus, or target remain separate records.
    if (!next || next !== signature) {
      output.push(...pending.values());
      pending = new Map();
      signature = next;
    }
    // Preserve each propagation phase at its latest sampled coordinate.
    if (next) pending.set(sample.phase, sample);
    else output.push(sample);
  }
  output.push(...pending.values());
  return output;
}

/**
 * Compare same-platform fixture traces without normalizing security semantics.
 * Args:
 *   baselineValue (EventTrace): Explicit baseline or candidate observation.
 *   actualValue (EventTrace): Engine observation from the same fixture configuration.
 *   options (ComparisonOptions): Numerical tolerances and review provenance.
 * Returns:
 *   ParityReport: Deterministic comparison and explicit approval status.
 */
export function compareEventTraces(
  baselineValue: EventTrace,
  actualValue: EventTrace,
  options: ComparisonOptions = {},
): ParityReport {
  const baseline = parseEventTrace(baselineValue);
  const actual = parseEventTrace(actualValue);
  const timeTolerance = options.timestampToleranceMs ?? 1000;
  const coordinateTolerance = options.coordinateToleranceCssPx ?? 2;
  // Numerical tolerances must remain finite and positive or zero.
  if (![timeTolerance, coordinateTolerance].every((value) => Number.isFinite(value) && value >= 0))
    throw new Error('Invalid parity tolerance.');
  const differences: TraceDifference[] = [];
  const report: ParityReport = {
    schemaVersion: 1,
    fixture: baseline.fixture,
    status: 'identical',
    manualBaselineApproved: false,
    differences,
    baselineEnvironment: structuredClone(baseline.environment),
    actualEnvironment: structuredClone(actual.environment),
    replaySteps: options.replaySteps ?? [
      'Open the named owned fixture using an isolated profile.',
      'Perform the recorded action sequence with the declared input path.',
      'Export the read-only fixture trace and compare the resulting artifacts.',
    ],
    normalization: {
      timestampToleranceMs: timeTolerance,
      coordinateToleranceCssPx: coordinateTolerance,
      collapsePointerMotion: options.collapsePointerMotion ?? false,
    },
  };

  /**
   * Append a single comparison difference without executing any fixture action.
   * Args:
   *   path (string): Trace field location.
   *   reason (string): Precise comparison explanation.
   *   first (unknown): Baseline field value.
   *   second (unknown): Actual field value.
   *   severity ('unexpected' | 'accepted'): Declared difference classification.
   * Returns:
   *   void: Completion of report evidence append.
   */
  function difference(
    path: string,
    reason: string,
    first: unknown,
    second: unknown,
    severity: TraceDifference['severity'] = 'unexpected',
  ): void {
    differences.push({ path, reason, baseline: first, actual: second, severity });
  }
  // Explicit unavailable capabilities remain separate from event parity failures.
  if (options.unsupportedReason) {
    report.status = 'unsupported';
    difference('capability', options.unsupportedReason, null, null);
    return report;
  }
  // Fixed environment and initial state differences invalidate the comparison group.
  const fixed = [
    'os',
    'osVersion',
    'arch',
    'windowSystem',
    'keyboardLayout',
    'ime',
    'monitorDpi',
    'browserCommit',
    'fixtureVersion',
    'abrVersion',
  ] as const;
  for (const field of fixed) {
    const first = baseline.environment[field];
    const second = actual.environment[field];
    // Missing or unknown environment metadata provides no reproducible comparison evidence.
    if (
      first === undefined ||
      second === undefined ||
      first === 'unknown' ||
      second === 'unknown' ||
      (field === 'monitorDpi' && (!first || !second))
    )
      difference(
        'environment.' + field,
        'Fixed environment metadata is unavailable.',
        first,
        second,
      );
    else if (first !== second)
      difference('environment.' + field, 'Fixed environment differs.', first, second);
  }
  // A concrete Chromium source commit is required for a same-build parity conclusion.
  for (const trace of [baseline, actual]) {
    if (!/^[a-f0-9]{40}$/i.test(trace.environment.browserCommit))
      difference(
        'environment.browserCommit',
        'Browser commit is unverified.',
        trace.environment.browserCommit,
        null,
      );
  }
  if (baseline.fixture !== actual.fixture)
    difference('fixture', 'Fixture surfaces differ.', baseline.fixture, actual.fixture);
  if (stableJson(baseline.environment.initialState) !== stableJson(actual.environment.initialState))
    difference(
      'environment.initialState',
      'Initial storage, viewport, permissions, focus, or tab count differs.',
      baseline.environment.initialState,
      actual.environment.initialState,
    );
  const initial = baseline.environment.initialState;
  if (
    !initial ||
    !/^[a-f0-9]{64}$/i.test(initial.cookieStorageHash) ||
    initial.permissions === 'unknown' ||
    initial.tabCount < 1 ||
    initial.viewportWidth < 1 ||
    initial.viewportHeight < 1
  )
    difference('environment.initialState', 'Initial-state evidence is incomplete.', initial, null);
  // Profile identifiers identify separate isolated sessions rather than equal storage contents.
  for (const trace of [baseline, actual]) {
    if (!trace.environment.profileId || trace.environment.profileId === 'unknown')
      difference(
        'environment.profileId',
        'Profile provenance is unavailable.',
        trace.environment.profileId,
        null,
      );
  }
  // Like-engine comparisons also fix the driver version; manual recordings have no driver.
  if (
    baseline.environment.engine === actual.environment.engine &&
    baseline.environment.playwrightVersion !== actual.environment.playwrightVersion
  )
    difference(
      'environment.playwrightVersion',
      'Driver versions differ.',
      baseline.environment.playwrightVersion,
      actual.environment.playwrightVersion,
    );
  if (baseline.outcome.truncated || actual.outcome.truncated)
    difference(
      'outcome.truncated',
      'Recording exceeded its declared sample quota.',
      baseline.outcome.truncated,
      actual.outcome.truncated,
    );
  if (differences.length) {
    report.status = 'invalid-fixture';
    return report;
  }

  const firstSamples = options.collapsePointerMotion
    ? collapseMotion(baseline.samples)
    : baseline.samples;
  const secondSamples = options.collapsePointerMotion
    ? collapseMotion(actual.samples)
    : actual.samples;
  const firstStart = firstSamples[0]?.timestampMs ?? 0;
  const secondStart = secondSamples[0]?.timestampMs ?? 0;
  // Compare every event position; inserted and missing events retain explicit sequence differences.
  for (let index = 0; index < Math.max(firstSamples.length, secondSamples.length); index += 1) {
    const first = firstSamples[index];
    const second = secondSamples[index];
    const prefix = `samples[${index}]`;
    if (!first || !second) {
      difference(prefix, 'Event is missing from one sequence.', first ?? null, second ?? null);
      continue;
    }
    const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
    // Strict fields include trusted, activation, composition, focus, selection, and event order.
    for (const key of keys) {
      const firstField = first[key as keyof EventSample];
      const secondField = second[key as keyof EventSample];
      if (stableJson(firstField) === stableJson(secondField)) continue;
      // Normalize only elapsed timestamp offsets and declared CSS geometry tolerances.
      if (key === 'timestampMs') {
        const delta = Math.abs(first.timestampMs - firstStart - (second.timestampMs - secondStart));
        difference(
          prefix + '.' + key,
          'Elapsed event timing differs.',
          firstField,
          secondField,
          delta <= timeTolerance ? 'accepted' : 'unexpected',
        );
      } else if (
        ['clientX', 'clientY', 'deltaX', 'deltaY'].includes(key) &&
        typeof firstField === 'number' &&
        typeof secondField === 'number'
      ) {
        difference(
          prefix + '.' + key,
          'Event geometry differs.',
          firstField,
          secondField,
          Math.abs(firstField - secondField) <= coordinateTolerance ? 'accepted' : 'unexpected',
        );
      } else
        difference(
          prefix + '.' + key,
          'Deterministic event semantics differ.',
          firstField,
          secondField,
        );
    }
  }
  // Final public input hashes and selection compare exactly; private fields remain omitted.
  if (stableJson(baseline.outcome) !== stableJson(actual.outcome))
    difference(
      'outcome',
      'Final controlled DOM or selection differs.',
      baseline.outcome,
      actual.outcome,
    );
  report.status = differences.some((item) => item.severity === 'unexpected')
    ? 'unexpected-diff'
    : differences.length
      ? 'accepted-diff'
      : 'identical';
  return report;
}
