// -*- coding: utf-8 -*-
/**
 * research.test.mjs
 * Isolated research gate verification
 * =====================
 * Verify disabled defaults, actual official source evidence, strict command plans, and explicit OS provenance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCompatibleEvidence,
  executeA2Command,
  planA2Command,
  readResearchFlags,
} from './research.mjs';

/**
 * Verify committed disabled research flags and actual official source evidence.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful isolated default and source audit assertions.
 */
async function researchDefaults() {
  const flags = await readResearchFlags();
  assert.equal(flags.a1DiffAnalysis, false);
  assert.equal(flags.a2OsInputPrototype, false);
  assert.throws(() => planA2Command(flags, 'Runtime.evaluate', {}, {}), {
    code: 'EXPERIMENT_DISABLED',
  });
  const evidence = await collectCompatibleEvidence();
  assert.equal(evidence.version, '1.64.0');
  assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok(evidence.observations['Input.dispatchMouseEvent'].length);
  assert.deepEqual(evidence.securityBehaviorChanges, []);
  assert.equal(evidence.validation.a2RealOsInputParity, 'pending');
}

/**
 * Verify command scope, owned origins, button callback limits, and actual execution paths.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful pure prototype boundary assertions without OS validation claims.
 */
async function researchPlans() {
  const flags = { schemaVersion: 1, a1DiffAnalysis: false, a2OsInputPrototype: true };
  const session = {
    engine: 'gui',
    sessionId: 'owned-fixture-session',
    windowId: 'owned-window',
    pageUrl: 'http://127.0.0.1:1234/click-button',
  };
  const plan = planA2Command(
    flags,
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: 20, y: 30 },
    session,
  );
  assert.equal(plan.request.action, 'pointer-move');
  assert.equal(plan.request.target.space, 'viewport-css');
  assert.equal(plan.parity, 'pending-owned-fixture-os-comparison');
  assert.throws(
    () =>
      planA2Command(
        flags,
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: 20, y: 30 },
        session,
      ),
    { code: 'RESEARCH_COMMAND_UNSUPPORTED' },
  );
  assert.throws(
    () => planA2Command(flags, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }, session),
    { code: 'RESEARCH_COMMAND_UNSUPPORTED' },
  );
  assert.throws(
    () =>
      planA2Command(flags, 'Runtime.evaluate', { expression: 'document.body.click()' }, session),
    { code: 'RESEARCH_COMMAND_UNSUPPORTED' },
  );
  assert.throws(
    () =>
      planA2Command(
        flags,
        'Input.insertText',
        { text: 'fixture' },
        { ...session, pageUrl: 'https://example.invalid/' },
      ),
    { code: 'RESEARCH_FIXTURE_REQUIRED' },
  );
  const adapter = {
    /**
     * Return a synthetic owned fixture URL for pure prototype boundary verification.
     * Args:
     *   None.
     * Returns:
     *   Promise<string>: Controlled test page identity.
     */
    async currentUrl() {
      return session.pageUrl;
    },
    /**
     * Return a synthetic fallback result that must be explicitly rejected.
     * Args:
     *   None.
     * Returns:
     *   Promise<object>: Controlled invalid execution provenance.
     */
    async execute() {
      return { status: 'succeeded', executionPath: 'playwright-cdp' };
    },
  };
  await assert.rejects(
    executeA2Command(flags, 'Input.insertText', { text: 'fixture' }, session, adapter),
    { code: 'RESEARCH_EXECUTION_PATH_REJECTED' },
  );
}

test(
  'independent A1/A2 flags remain disabled and official source evidence is exact',
  researchDefaults,
);
test('A2 prototype retains owned GUI boundaries and explicit unsupported callbacks', researchPlans);
