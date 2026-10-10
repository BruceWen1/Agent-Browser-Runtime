// -*- coding: utf-8 -*-
/**
 * pipeline.test.mjs
 * Chromium build boundary verification
 * =====================
 * Verify path, exact-pin, resource, subprocess, and patch gates without a Chromium build claim.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyToolFailure,
  REPOSITORY_ROOT,
  readVersionLock,
  runTool,
  sha256,
  validateCheckoutRoot,
  versionAtLeast,
} from './common.mjs';
import { allocatedOutputBytes, classifySyncResumeEntries, verifyPatches } from './pipeline.mjs';

/**
 * Verify exact source locks and numeric toolchain requirement ordering.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful actual committed-lock assertions.
 */
async function pinnedVersion() {
  const lock = await readVersionLock();
  assert.equal(lock.upstreamCommit, '634b046faf2137b83af71c87baf362b533af9104');
  assert.equal(lock.verification.tag, 'verified-official-mirror');
  assert.equal(versionAtLeast('18.6.11806.211', '18.0.0'), true);
  assert.equal(versionAtLeast('10.0.28000.1839', '10.0.28000.2270'), false);
  assert.equal(versionAtLeast('10.0.26100.8249', '10.0.26100.3323'), true);
  assert.equal(versionAtLeast('10.0.19041.685', '10.0.28000.2270'), false);
  assert.equal(versionAtLeast('unavailable', '18.0.0'), false);
  assert.deepEqual(
    classifyToolFailure('FileNotFoundError [WinError 2] C:/private/?token=secret/git.bat'),
    { code: 'OFFICIAL_GIT_WRAPPER_MISSING', binary: 'git.bat' },
  );
  assert.equal(
    JSON.stringify(classifyToolFailure('No space left on device token=private')).includes(
      'private',
    ),
    false,
  );
}

/**
 * Verify source containment and Windows shell metacharacter boundaries.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful unsafe-path rejection assertions.
 */
async function pathBoundaries() {
  await assert.rejects(validateCheckoutRoot(REPOSITORY_ROOT), { code: 'INVALID_CHECKOUT_PATH' });
  await assert.rejects(validateCheckoutRoot(path.join(tmpdir(), 'abr source')), {
    code: 'INVALID_CHECKOUT_PATH',
  });
  await assert.rejects(validateCheckoutRoot(path.join(tmpdir(), 'abr%TEMP%')), {
    code: 'INVALID_CHECKOUT_PATH',
  });
  await assert.rejects(validateCheckoutRoot(path.join(tmpdir(), 'abr&injected')), {
    code: 'INVALID_CHECKOUT_PATH',
  });
  await assert.rejects(validateCheckoutRoot(path.parse(REPOSITORY_ROOT).root), {
    code: 'INVALID_CHECKOUT_PATH',
  });
  assert.equal((await verifyPatches({ patches: [] })).length, 0);
  await assert.rejects(
    verifyPatches({
      patches: [
        {
          file: '../unowned.patch',
          sha256: 'a'.repeat(64),
          scope: 'browser-readonly',
          allowedPaths: ['chrome/browser/'],
        },
      ],
    }),
    { code: 'INVALID_PATCH_MANIFEST' },
  );
}

/**
 * Verify command failure/timeout audits preserve diagnostic digests and omit raw input.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful real subprocess boundary assertions.
 */
async function processBoundaries() {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-pipeline-'));
  // Remove only this directly allocated owned temporary test directory.
  try {
    const options = {
      cwd: root,
      env: process.env,
      auditDirectory: root,
      phase: 'owned-process-test',
      timeoutMs: 1000,
    };
    const script = path.join(root, 'controlled.mjs');
    await writeFile(
      script,
      "process.stdout.write('fixture-private-value'); process.stderr.write('https://example.invalid/?token=fixture-secret');",
    );
    const result = await runTool(process.execPath, [script], options);
    assert.equal(result.stdoutSha256, sha256('fixture-private-value'));
    // Native filesystem allocation is measured from the actual owned test output directory.
    assert.ok(
      (await allocatedOutputBytes({ root, auditDirectory: root, env: process.env }, root)) > 0,
    );
    const audit = await readFile(path.join(root, 'pipeline.jsonl'), 'utf8');
    assert.equal(audit.includes('fixture-private-value'), false);
    assert.equal(audit.includes('fixture-secret'), false);
    await writeFile(script, 'process.exitCode=7;');
    await assert.rejects(
      runTool(process.execPath, [script], { ...options, phase: 'owned-failure-test' }),
      { code: 'TOOL_FAILED' },
    );
    await assert.rejects(
      runTool(path.join(root, 'missing-owned-tool.exe'), [], {
        ...options,
        phase: 'owned-start-failure-test',
      }),
      { code: 'TOOL_START_FAILED' },
    );
    await writeFile(script, 'setInterval(()=>{},1000);');
    await assert.rejects(
      runTool(process.execPath, [script], {
        ...options,
        phase: 'owned-disk-reserve-test',
        timeoutMs: 5000,
        diskReserveRoot: root,
        minimumFreeDiskGiB: 1_000_000,
        diskCheckIntervalMs: 10,
      }),
      { code: 'SOURCE_DISK_RESERVE_EXHAUSTED' },
    );
    await assert.rejects(
      runTool(process.execPath, [script], {
        ...options,
        phase: 'owned-timeout-test',
        timeoutMs: 50,
      }),
      { code: 'TOOL_TIMEOUT' },
    );
  } finally {
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-pipeline-')
    )
      throw new Error('Invalid build test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('exact pin and numeric native toolchain gates remain reproducible', pinnedVersion);
test('source paths and patch manifests remain within explicit boundaries', pathBoundaries);

/**
 * Verify interrupted source recovery never admits root file edits or unknown temporary scopes.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of Git link, unknown file, and temporary clone boundary assertions.
 */
function syncResumeBoundaries() {
  const revision = 'a'.repeat(40);
  const dependencies = {
    v8: { origin: 'https://chromium.googlesource.com/v8/v8.git', revision },
    'third_party/tflite/src': {
      origin: 'https://chromium.googlesource.com/external/github.com/tensorflow/tensorflow.git',
      revision,
    },
  };
  const raw = ':160000 160000 ' + revision + ' ' + 'b'.repeat(40) + ' M\tv8';
  assert.equal(
    classifySyncResumeEntries(' M v8\n?? _gclient_v8_abcd1234/', raw, dependencies).length,
    2,
  );
  assert.equal(
    classifySyncResumeEntries('?? third_party/tflite/_gclient_src_abcd1234/', '', dependencies)[0]
      .kind,
    'temporary-clone',
  );
  assert.throws(
    () =>
      classifySyncResumeEntries(
        ' M DEPS',
        ':100644 100644 ' + revision + ' ' + 'b'.repeat(40) + ' M\tDEPS',
        dependencies,
      ),
    { code: 'SOURCE_USER_MODIFICATIONS' },
  );
  assert.throws(() => classifySyncResumeEntries('?? personal.txt', '', dependencies), {
    code: 'SOURCE_USER_MODIFICATIONS',
  });
  assert.throws(
    () => classifySyncResumeEntries('?? _gclient_unknown_abcd1234/', '', dependencies),
    { code: 'UNKNOWN_GCLIENT_CLONE' },
  );
  assert.throws(
    () => classifySyncResumeEntries(' M v8', raw.replace(revision, 'c'.repeat(40)), dependencies),
    { code: 'DEPENDENCY_PIN_MISMATCH' },
  );
  const missing = ':160000 000000 ' + revision + ' ' + '0'.repeat(40) + ' D\tv8';
  assert.throws(() => classifySyncResumeEntries(' D v8', missing, dependencies), {
    code: 'SOURCE_USER_MODIFICATIONS',
  });
  assert.equal(
    classifySyncResumeEntries(' D v8', missing, dependencies, new Set(['v8'])).length,
    0,
  );
}

test(
  'interrupted sync admits only exact DEPS links and owned temporary clone scopes',
  syncResumeBoundaries,
);
test('owned subprocess audits exclude raw diagnostics and enforce deadlines', processBoundaries);
