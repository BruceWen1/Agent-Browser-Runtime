// -*- coding: utf-8 -*-
/**
 * main.ts
 * Owned fixture and event parity command line
 * =====================
 * Serve local fixtures, create candidates, review manual baselines, and export parity evidence.
 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  compareApprovedBaseline,
  reviewBaselineCandidate,
  writeBaselineCandidate,
} from './baseline.js';
import { compareEventTraces, parseEventTrace } from './comparator.js';
import { writeParityReport } from './report.js';
import { startEventFixture } from './server.js';

/**
 * Read one JSON fixture trace and validate its shared event contract.
 * Args:
 *   filename (string): Explicit local trace artifact path.
 * Returns:
 *   Promise<EventTrace>: Validated bounded trace.
 */
async function readTrace(filename: string) {
  return parseEventTrace(JSON.parse(await readFile(filename, 'utf8')) as unknown);
}

/**
 * Dispatch local fixture, candidate, review, and parity report commands.
 * Args:
 *   args (string[]): Explicit command arguments.
 * Returns:
 *   Promise<void>: Command completion or long-running local fixture listener.
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const started = performance.now();
  const [command, first, second, output] = args;
  // Record only fixed command names and durations rather than input text or artifact contents.
  try {
    if (command === 'serve' && args.length <= 2) {
      const environment = first
        ? (JSON.parse(await readFile(first, 'utf8')) as Parameters<typeof startEventFixture>[0])
        : undefined;
      const server = await startEventFixture(environment);
      process.stdout.write(JSON.stringify({ origin: server.origin }) + '\n');
      process.stderr.write(
        JSON.stringify({ step: 'fixture-ready', durationMs: performance.now() - started }) + '\n',
      );
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await server.close();
    } else if (command === 'candidate' && first && second && args.length === 3) {
      await writeBaselineCandidate(second, await readTrace(first));
      process.stdout.write('{"status":"candidate"}\n');
    } else if (command === 'review' && first && second && args.length === 3) {
      await reviewBaselineCandidate(first, second);
      process.stdout.write('{"status":"approved"}\n');
    } else if (
      ['compare', 'compare-approved'].includes(command ?? '') &&
      first &&
      second &&
      output &&
      args.length === 4
    ) {
      const actual = await readTrace(second);
      const baseline =
        command === 'compare-approved'
          ? (JSON.parse(await readFile(first, 'utf8')) as { trace: unknown }).trace
          : await readTrace(first);
      const report =
        command === 'compare-approved'
          ? await compareApprovedBaseline(first, actual)
          : compareEventTraces(parseEventTrace(baseline), actual);
      await writeParityReport(output, report, parseEventTrace(baseline), actual);
      process.stdout.write(
        JSON.stringify({
          status: report.status,
          manualBaselineApproved: report.manualBaselineApproved,
        }) + '\n',
      );
      if (['unexpected-diff', 'invalid-fixture'].includes(report.status)) process.exitCode = 1;
    } else
      throw new Error(
        'Use serve [metadata.json], candidate trace.json candidate.json, review candidate.json approved.json, or compare[-approved] baseline.json actual.json report-directory.',
      );
  } finally {
    process.stderr.write(
      JSON.stringify({
        step: 'fixture-command-finished',
        durationMs: performance.now() - started,
      }) + '\n',
    );
  }
}

// Execute only when this module is the directly selected command-line entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write(
      'Fixture command failed; inspect the local command and artifact metadata.\n',
    );
    process.exitCode = 1;
  });
}
