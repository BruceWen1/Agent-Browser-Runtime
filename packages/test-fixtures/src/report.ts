// -*- coding: utf-8 -*-
/**
 * report.ts
 * Standalone event parity reports
 * =====================
 * Render escaped HTML and save complete JSON, trace, and environment evidence.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EventTrace, ParityReport } from './trace.js';

/**
 * Escape every untrusted trace string before including it in HTML.
 * Args:
 *   value (unknown): JSON-compatible trace field.
 * Returns:
 *   string: HTML-safe text.
 */
function escape(value: unknown): string {
  return (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? ''))
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render an offline parity report with explicit baseline approval provenance.
 * Args:
 *   report (ParityReport): Comparison evidence from the strict comparator.
 * Returns:
 *   string: Standalone HTML without executable trace content.
 */
export function renderParityHtml(report: ParityReport): string {
  const rows = report.differences
    .map(
      (item) =>
        `<tr><td>${escape(item.path)}</td><td>${escape(item.severity)}</td><td>${escape(item.reason)}</td><td><pre>${escape(item.baseline)}</pre></td><td><pre>${escape(item.actual)}</pre></td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>ABR event parity report</title><style>body{font:16px system-ui;margin:32px;color:#172b4d}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd;padding:8px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#445}</style></head><body>
<h1>${escape(report.fixture)}</h1><p>Comparison status: <strong>${escape(report.status)}</strong></p><p>Approved manual baseline: <strong>${report.manualBaselineApproved ? 'yes' : 'no; candidate comparison only'}</strong></p>
<h2>Replay</h2><ol>${report.replaySteps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>
<h2>Fixed environment</h2><table><tr><th>Baseline</th><th>Actual</th></tr><tr><td><pre>${escape(report.baselineEnvironment)}</pre></td><td><pre>${escape(report.actualEnvironment)}</pre></td></tr></table>
<h2>Declared normalization</h2><pre>${escape(report.normalization)}</pre><h2>Differences (${report.differences.length})</h2><table><tr><th>Field</th><th>Classification</th><th>Reason</th><th>Baseline</th><th>Actual</th></tr>${rows}</table>
<p><small>Event comparison evidence records the declared platform, browser commit, and input path. Manual baseline approval requires independent local operator review.</small></p></body></html>`;
}

/**
 * Save a complete immutable parity run in an explicitly supplied output directory.
 * Args:
 *   directory (string): Caller-selected report output directory.
 *   report (ParityReport): Comparison evidence and provenance.
 *   baseline (EventTrace): Baseline or candidate source trace.
 *   actual (EventTrace): Engine source trace.
 * Returns:
 *   Promise<void>: Creation of JSON, HTML, trace, and version artifacts.
 */
export async function writeParityReport(
  directory: string,
  report: ParityReport,
  baseline: EventTrace,
  actual: EventTrace,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const documents = {
    'parity-report.json': JSON.stringify(report, null, 2),
    'parity-report.html': renderParityHtml(report),
    'baseline-trace.json': JSON.stringify(baseline, null, 2),
    'actual-trace.json': JSON.stringify(actual, null, 2),
    'version-manifest.json': JSON.stringify(
      { schemaVersion: 1, baseline: report.baselineEnvironment, actual: report.actualEnvironment },
      null,
      2,
    ),
  };
  // Exclusive writes preserve prior runs and require a new output directory for every report.
  for (const [filename, content] of Object.entries(documents))
    await writeFile(path.join(directory, filename), content, { encoding: 'utf8', flag: 'wx' });
}
