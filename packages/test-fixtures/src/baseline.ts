// -*- coding: utf-8 -*-
/**
 * baseline.ts
 * Explicit human baseline review
 * =====================
 * Create candidate artifacts and require an independent interactive terminal review for approval.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import { compareEventTraces, parseEventTrace, stableJson } from './comparator.js';
import type { ComparisonOptions } from './comparator.js';
import type { EventTrace, ParityReport } from './trace.js';

/** BaselineCandidate records unapproved provenance and the immutable trace digest. */
export interface BaselineCandidate {
  schemaVersion: 1;
  status: 'candidate';
  traceSha256: string;
  trace: EventTrace;
}

/** ApprovedBaseline contains an explicit independent operator review receipt. */
export interface ApprovedBaseline {
  schemaVersion: 1;
  status: 'approved';
  traceSha256: string;
  trace: EventTrace;
  review: {
    surface: 'local-tty';
    reviewer: string;
    reviewedAt: string;
    decision: 'approve';
    reviewedTraceSha256: string;
  };
}

/**
 * Calculate an immutable digest of the complete fixed-environment event trace.
 * Args:
 *   trace (EventTrace): Bounded validated fixture recording.
 * Returns:
 *   string: SHA-256 digest covering every trace field.
 */
export function eventTraceDigest(trace: EventTrace): string {
  return createHash('sha256')
    .update(stableJson(parseEventTrace(trace)))
    .digest('hex');
}

/**
 * Create an unapproved candidate from a fixture observation.
 * Args:
 *   trace (EventTrace): Manual or engine event recording.
 * Returns:
 *   BaselineCandidate: Copied trace with candidate status and immutable digest.
 */
export function createBaselineCandidate(trace: EventTrace): BaselineCandidate {
  const parsed = parseEventTrace(trace);
  return {
    schemaVersion: 1,
    status: 'candidate',
    traceSha256: eventTraceDigest(parsed),
    trace: structuredClone(parsed),
  };
}

/**
 * Save a new candidate without overwriting existing baseline evidence.
 * Args:
 *   filename (string): Caller-selected candidate artifact path.
 *   trace (EventTrace): Fixture observation to review independently.
 * Returns:
 *   Promise<BaselineCandidate>: Saved unapproved candidate.
 */
export async function writeBaselineCandidate(
  filename: string,
  trace: EventTrace,
): Promise<BaselineCandidate> {
  const candidate = createBaselineCandidate(trace);
  await writeFile(filename, JSON.stringify(candidate, null, 2), { encoding: 'utf8', flag: 'wx' });
  return candidate;
}

/**
 * Load an approved manual baseline and validate its trace-bound review receipt.
 * Args:
 *   filename (string): Previously reviewed local baseline artifact.
 * Returns:
 *   Promise<ApprovedBaseline>: Integrity checked manual baseline receipt.
 */
export async function readApprovedBaseline(filename: string): Promise<ApprovedBaseline> {
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
  const baseline = value as ApprovedBaseline;
  // Approval applies only to the exact manual recording named in the independent receipt.
  if (
    !baseline ||
    baseline.schemaVersion !== 1 ||
    baseline.status !== 'approved' ||
    baseline.trace?.environment.engine !== 'manual' ||
    baseline.review?.surface !== 'local-tty' ||
    baseline.review.decision !== 'approve' ||
    !baseline.review.reviewer.trim() ||
    !Number.isFinite(Date.parse(baseline.review.reviewedAt)) ||
    baseline.traceSha256 !== baseline.review.reviewedTraceSha256 ||
    baseline.traceSha256 !== eventTraceDigest(baseline.trace)
  )
    throw new Error('Approved baseline receipt is invalid.');
  return baseline;
}

/**
 * Review a manual candidate through an independent local terminal session.
 * Args:
 *   candidateFilename (string): Immutable candidate file to review.
 *   approvedFilename (string): New approved artifact path.
 * Returns:
 *   Promise<void>: Approved artifact creation after explicit operator confirmation.
 */
export async function reviewBaselineCandidate(
  candidateFilename: string,
  approvedFilename: string,
): Promise<void> {
  // Redirected streams cannot provide independent interactive operator approval.
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error('Baseline review requires an interactive local terminal.');
  const value: unknown = JSON.parse(await readFile(candidateFilename, 'utf8'));
  const candidate = value as BaselineCandidate;
  // Automated engine recordings remain candidates; only a manual GUI trace is reviewable.
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    candidate.status !== 'candidate' ||
    candidate.trace?.environment.engine !== 'manual' ||
    candidate.traceSha256 !== eventTraceDigest(candidate.trace)
  )
    throw new Error('A valid manual GUI candidate is required.');
  const validation = compareEventTraces(candidate.trace, candidate.trace);
  // Fixed-environment gaps and truncated artifacts require a new recording before approval.
  if (validation.status !== 'identical' || candidate.trace.samples.length === 0)
    throw new Error('Manual candidate metadata is incomplete.');
  process.stderr.write(
    `Manual baseline review\nFixture: ${candidate.trace.fixture}\nSHA-256: ${candidate.traceSha256}\nEvents: ${candidate.trace.samples.length}\nEnvironment: ${JSON.stringify(candidate.trace.environment)}\n`,
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  // Dispose the trusted terminal interface even when the operator declines approval.
  try {
    const reviewer = (await terminal.question('Reviewer name: ')).trim();
    const answer = await terminal.question(
      `After reviewing the trace and replay, type APPROVE ${candidate.traceSha256}: `,
    );
    if (!reviewer || answer !== `APPROVE ${candidate.traceSha256}`)
      throw new Error('Baseline approval was declined.');
    const approved: ApprovedBaseline = {
      schemaVersion: 1,
      status: 'approved',
      traceSha256: candidate.traceSha256,
      trace: candidate.trace,
      review: {
        surface: 'local-tty',
        reviewer,
        reviewedAt: new Date().toISOString(),
        decision: 'approve',
        reviewedTraceSha256: candidate.traceSha256,
      },
    };
    await writeFile(approvedFilename, JSON.stringify(approved, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } finally {
    terminal.close();
  }
}

/**
 * Compare an actual trace against a receipt-validated approved manual baseline.
 * Args:
 *   baselineFilename (string): Explicit independently reviewed baseline artifact.
 *   actual (EventTrace): Engine fixture recording.
 *   options (ComparisonOptions): Declared numerical tolerances and replay steps.
 * Returns:
 *   Promise<ParityReport>: Comparison with verified local review provenance.
 */
export async function compareApprovedBaseline(
  baselineFilename: string,
  actual: EventTrace,
  options: ComparisonOptions = {},
): Promise<ParityReport> {
  const baseline = await readApprovedBaseline(baselineFilename);
  const report = compareEventTraces(baseline.trace, actual, options);
  report.manualBaselineApproved = true;
  return report;
}
