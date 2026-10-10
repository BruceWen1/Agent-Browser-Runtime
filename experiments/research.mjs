// -*- coding: utf-8 -*-
/**
 * research.mjs
 * Isolated Compatible input research
 * =====================
 * Inspect unchanged official source evidence and prototype explicitly gated owned-fixture command plans.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { compareEventTraces, parseEventTrace, renderParityHtml } from '@abr/test-fixtures';

import { REPOSITORY_ROOT, gateError, sha256, writeArtifact } from '../chromium/build/common.mjs';

// Research commands retain their observed upstream semantics and explicit prototype limits.
export const COMMAND_MATRIX = [
  {
    command: 'Input.dispatchMouseEvent(mouseMoved,buttons=0)',
    observedPath: 'CDP pointer input',
    prototype: 'owned-fixture pointer-move',
    parity: 'pending-real-OS-input-comparison',
  },
  {
    command: 'Input.dispatchMouseEvent(mousePressed/mouseReleased)',
    observedPath: 'independent CDP button transitions',
    prototype: 'unsupported-independent-button-callbacks',
    parity: 'not-implemented',
  },
  {
    command: 'Input.dispatchKeyEvent(keyDown/keyUp)',
    observedPath: 'independent CDP keyboard transitions',
    prototype: 'unsupported-independent-key-callbacks',
    parity: 'not-implemented',
  },
  {
    command: 'Input.insertText',
    observedPath: 'CDP text submission',
    prototype: 'owned-fixture type-text with actualStrategy',
    parity: 'pending-text-input-composition-comparison',
  },
  {
    command: 'selectOption',
    observedPath: 'injected DOM option selection',
    prototype: 'not-gui-equivalent',
    parity: 'unsupported',
  },
  {
    command: 'Runtime.evaluate',
    observedPath: 'JavaScript evaluation',
    prototype: 'not-gui-equivalent',
    parity: 'unsupported',
  },
  {
    command: 'DOM.setFileInputFiles',
    observedPath: 'CDP file input assignment',
    prototype: 'not-gui-equivalent',
    parity: 'unsupported',
  },
  {
    command: 'network routing/context permission mutation',
    observedPath: 'protocol or context control',
    prototype: 'not-gui-equivalent',
    parity: 'unsupported',
  },
];

/**
 * Read closed research flags whose committed defaults disable every experiment.
 * Args:
 *   filename (string): Explicit locally reviewed flag configuration.
 * Returns:
 *   Promise<object>: Validated independent A1/A2 opt-in state.
 */
export async function readResearchFlags(
  filename = fileURLToPath(new URL('./flags.json', import.meta.url)),
) {
  const flags = JSON.parse(await readFile(filename, 'utf8'));
  // Closed boolean flags provide no implicit production feature activation.
  if (
    flags.schemaVersion !== 1 ||
    typeof flags.a1DiffAnalysis !== 'boolean' ||
    typeof flags.a2OsInputPrototype !== 'boolean' ||
    Object.keys(flags).some(
      (key) => !['schemaVersion', 'a1DiffAnalysis', 'a2OsInputPrototype'].includes(key),
    )
  )
    throw gateError('INVALID_RESEARCH_FLAGS', 'Research flag configuration is malformed.');
  return flags;
}

/**
 * Require a named independent experiment to be explicitly enabled.
 * Args:
 *   flags (object): Validated independent research configuration.
 *   name (string): Closed A1 or A2 flag name.
 * Returns:
 *   void: Successful explicit experiment gate.
 */
function requireFlag(flags, name) {
  if (!flags[name])
    throw gateError(
      'EXPERIMENT_DISABLED',
      'The isolated experiment is disabled by its local feature flag.',
    );
}

/**
 * Require a controlled local event fixture for every research execution.
 * Args:
 *   value (string): Declared fixture page URL.
 * Returns:
 *   URL: Validated loopback-only page identity.
 */
function ownedFixture(value) {
  const url = new URL(value);
  // Research uses controlled pages on explicit loopback origins only.
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port
  )
    throw gateError(
      'RESEARCH_FIXTURE_REQUIRED',
      'Research execution requires an owned loopback fixture URL.',
    );
  return url;
}

/**
 * Collect exact evidence from the installed unchanged official Playwright package.
 * Args:
 *   None.
 * Returns:
 *   Promise<object>: Version, source digest, protocol call locations, and semantic matrix.
 */
export async function collectCompatibleEvidence() {
  const request = createRequire(
    path.join(REPOSITORY_ROOT, 'packages', 'test-fixtures', 'package.json'),
  );
  const playwright = request.resolve('playwright/package.json');
  const corePackage = createRequire(playwright).resolve('playwright-core/package.json');
  const metadata = JSON.parse(await readFile(corePackage, 'utf8'));
  if (metadata.version !== '1.64.0')
    throw gateError(
      'RESEARCH_VERSION_MISMATCH',
      'Research evidence requires the exact committed Playwright version.',
    );
  const source = await readFile(path.join(path.dirname(corePackage), 'lib', 'coreBundle.js'));
  const text = source.toString('utf8');
  const needles = [
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'DOM.setFileInputFiles',
    'injected.selectOptions',
  ];
  const observations = {};
  // Preserve only published protocol identifiers and source line positions from the local package.
  for (const needle of needles) {
    const lines = text.split('\n');
    observations[needle] = lines.flatMap((line, index) =>
      line.includes(needle) ? [index + 1] : [],
    );
    if (!observations[needle].length)
      throw gateError(
        'RESEARCH_SOURCE_CHANGED',
        'Official source evidence requires renewed command auditing.',
      );
  }
  return {
    schemaVersion: 1,
    source: 'official-playwright-npm-package',
    package: 'playwright-core',
    version: metadata.version,
    license: metadata.license,
    sourceFile: 'lib/coreBundle.js',
    sourceSha256: sha256(source),
    observations,
    matrix: COMMAND_MATRIX,
    securityBehaviorChanges: [],
    validation: {
      staticSourceInspection: 'completed',
      a1SameBuildManualBaseline: 'pending',
      a2RealOsInputParity: 'pending',
      patchedBrowser: 'pending-compiled-observer',
    },
  };
}

/**
 * Compare candidate A1 traces within the independent opt-in research boundary.
 * Args:
 *   flags (object): Explicit independent A1 configuration.
 *   baselineValue (unknown): Owned reference event trace.
 *   actualValue (unknown): Owned Compatible or Native event trace.
 * Returns:
 *   object: Event differences and explicit pending human review evidence.
 */
export function analyzeA1(flags, baselineValue, actualValue) {
  requireFlag(flags, 'a1DiffAnalysis');
  const baseline = parseEventTrace(baselineValue);
  const actual = parseEventTrace(actualValue);
  ownedFixture(baseline.environment.pageUrl);
  ownedFixture(actual.environment.pageUrl);
  const report = compareEventTraces(baseline, actual);
  // Analysis proposes no security-semantic modifications and retains unapproved candidate status.
  return {
    schemaVersion: 1,
    experiment: 'a1-difference-analysis',
    report,
    patchProposals: [],
    securityBehaviorChanges: [],
    conclusion:
      report.status === 'invalid-fixture'
        ? 'incomparable-fixed-environment'
        : 'candidate-event-differences-require-independent-review',
    productionEnabled: false,
  };
}

/**
 * Plan a bounded A2 command for the existing protected GUI runtime adapter.
 * Args:
 *   flags (object): Explicit independent A2 configuration.
 *   method (string): Requested CDP command identifier.
 *   parameters (object): Strict command-specific input values.
 *   session (object): Owned fixture URL, GUI session, and validated window identity.
 * Returns:
 *   object: Core action request and declared experimental semantic limitation.
 */
export function planA2Command(flags, method, parameters, session) {
  requireFlag(flags, 'a2OsInputPrototype');
  ownedFixture(session.pageUrl);
  // Only GUI sessions with concrete runtime and window ownership can reach the adapter.
  if (
    session.engine !== 'gui' ||
    typeof session.sessionId !== 'string' ||
    !session.sessionId ||
    typeof session.windowId !== 'string' ||
    !session.windowId
  )
    throw gateError(
      'RESEARCH_GUI_SESSION_REQUIRED',
      'A2 planning requires an owned GUI session and window.',
    );
  const action = { requestId: randomUUID(), sessionId: session.sessionId };
  if (method === 'Input.dispatchMouseEvent') {
    // Independent button transitions require callback-preserving native primitives and remain unsupported.
    if (
      parameters.type !== 'mouseMoved' ||
      (parameters.buttons !== undefined && parameters.buttons !== 0) ||
      (parameters.modifiers !== undefined && parameters.modifiers !== 0) ||
      (parameters.button !== undefined && parameters.button !== 'none') ||
      !Number.isFinite(parameters.x) ||
      !Number.isFinite(parameters.y) ||
      Object.keys(parameters).some(
        (key) => !['type', 'x', 'y', 'buttons', 'button', 'modifiers'].includes(key),
      )
    )
      throw gateError(
        'RESEARCH_COMMAND_UNSUPPORTED',
        'Only an unmodified button-free pointer move has a bounded experimental plan.',
      );
    return {
      request: {
        ...action,
        action: 'pointer-move',
        target: {
          kind: 'coordinate',
          x: parameters.x,
          y: parameters.y,
          space: 'viewport-css',
          windowId: session.windowId,
        },
      },
      semantics: 'experimental-os-pointer-move',
      parity: 'pending-owned-fixture-os-comparison',
    };
  }
  if (method === 'Input.insertText') {
    // Text submission reports the actual adapter strategy and leaves IME parity as separate evidence.
    if (
      typeof parameters.text !== 'string' ||
      parameters.text.length < 1 ||
      parameters.text.length > 4096 ||
      Object.keys(parameters).some((key) => key !== 'text')
    )
      throw gateError(
        'RESEARCH_COMMAND_UNSUPPORTED',
        'Text submission requires a bounded exact text command.',
      );
    return {
      request: {
        ...action,
        action: 'type-text',
        args: { text: parameters.text, strategy: 'auto' },
      },
      semantics: 'experimental-os-text-submission',
      parity: 'pending-keyboard-input-composition-comparison',
    };
  }
  throw gateError(
    'RESEARCH_COMMAND_UNSUPPORTED',
    'The command retains its existing Compatible semantics.',
  );
}

/**
 * Execute an explicit A2 plan through the already protected GUI runtime only.
 * Args:
 *   flags (object): Explicit independent A2 configuration.
 *   method (string): Closed supported research command.
 *   parameters (object): Strict command parameters.
 *   session (object): Owned GUI fixture identity.
 *   adapter (object): Core currentUrl and execute methods enforcing policy and input leases.
 * Returns:
 *   Promise<object>: Actual execution provenance without a GUI-equivalence assertion.
 */
export async function executeA2Command(flags, method, parameters, session, adapter) {
  const plan = planA2Command(flags, method, parameters, session);
  const current = await adapter.currentUrl(session.sessionId);
  // Recheck the concrete current owned page before the protected runtime validates the action.
  if (ownedFixture(current).href !== ownedFixture(session.pageUrl).href)
    throw gateError(
      'RESEARCH_FIXTURE_CHANGED',
      'The current fixture changed before experimental execution.',
    );
  const result = await adapter.execute(plan.request);
  // A successful prototype records OS provenance and explicitly rejects an adapter fallback.
  if (result.status === 'succeeded' && result.executionPath !== 'os-input')
    throw gateError(
      'RESEARCH_EXECUTION_PATH_REJECTED',
      'A2 success requires the protected native OS input path.',
    );
  return {
    experiment: 'a2-protected-gui-prototype',
    semantics: plan.semantics,
    parity: plan.parity,
    result,
    productionEnabled: false,
  };
}

/**
 * Dispatch static evidence or explicitly gated A1 trace research commands.
 * Args:
 *   argv (string[]): Explicit independent experiment arguments.
 * Returns:
 *   Promise<void>: Saved candidate research evidence with safe duration output.
 */
export async function main(argv = process.argv.slice(2)) {
  const started = performance.now();
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { flags: { type: 'string' }, output: { type: 'string' } },
  });
  // Every artifact is explicitly selected and created exclusively for this research run.
  try {
    if (positionals[0] === 'evidence' && positionals.length === 1 && values.output) {
      await writeArtifact(values.output, await collectCompatibleEvidence());
      process.stdout.write('{"state":"static-source-evidence","productionEnabled":false}\n');
    } else if (positionals[0] === 'a1' && positionals.length === 3 && values.output) {
      const flags = await readResearchFlags(values.flags);
      const baseline = JSON.parse(await readFile(positionals[1], 'utf8'));
      const actual = JSON.parse(await readFile(positionals[2], 'utf8'));
      const evidence = analyzeA1(flags, baseline, actual);
      await writeArtifact(values.output, evidence);
      await writeFile(values.output + '.html', renderParityHtml(evidence.report), { flag: 'wx' });
      process.stdout.write(
        JSON.stringify({ state: evidence.report.status, productionEnabled: false }) + '\n',
      );
    } else
      throw gateError(
        'INVALID_RESEARCH_COMMAND',
        'Use evidence --output artifact.json or a1 baseline.json actual.json --flags reviewed-flags.json --output artifact.json.',
      );
  } finally {
    process.stderr.write(
      JSON.stringify({ phase: 'research-total', durationMs: performance.now() - started }) + '\n',
    );
  }
}

// Research modules remain outside production registration and require explicit direct invocation.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        code: error.code ?? 'RESEARCH_FAILED',
        message: error.code ? error.message : 'Inspect the declared local research inputs.',
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
