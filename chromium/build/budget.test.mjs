// -*- coding: utf-8 -*-
/**
 * budget.test.mjs
 * Stage-specific Chromium storage and completion evidence verification
 * =====================
 * Validate owned temporary allocation scopes, planning arithmetic, and immutable sync boundaries.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GIB, readVersionLock, runTool } from './common.mjs';
import {
  allocatedOutputBytes,
  applyStageResourceBudget,
  buildDiskBudget,
  estimateBuildDiskBudget,
  matchesOriginalBuild,
  matchesSyncCompletion,
  selectedSyncGitGraph,
} from './pipeline.mjs';

/**
 * Verify original planning deducts source and existing output exactly once.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of remaining-space and unresolved capacity assertions.
 */
function originalBudget() {
  const budget = estimateBuildDiskBudget('original', 100, 60 * GIB, 5 * GIB);
  assert.equal(budget.requiredRemainingFreeGiB, 55);
  assert.equal(budget.budgetStatus, 'estimated');
  assert.equal(budget.estimateStatus, 'estimate-unverified');
  assert.equal(budget.capacityVerified, false);
  assert.equal(
    estimateBuildDiskBudget('original', 100, 60 * GIB, 60 * GIB).requiredRemainingFreeGiB,
    20,
  );
  // Source storage exhausting the planning base cannot become a reserve-only ready report.
  for (const sourceGiB of [100, 101]) {
    const unresolved = estimateBuildDiskBudget('original', 100, sourceGiB * GIB, 0);
    assert.equal(unresolved.budgetStatus, 'unresolved');
    assert.equal(unresolved.requiredRemainingFreeGiB, null);
  }
  assert.throws(() => estimateBuildDiskBudget('original', 100, -1, 0), {
    code: 'DISK_MEASUREMENT_FAILED',
  });
}

/**
 * Verify patched output requires exact original build identity and one reserve contingency.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of exact-pin, GN, platform, and patched arithmetic assertions.
 */
async function patchedBudget() {
  const lock = await readVersionLock();
  const state = { lock };
  const manifest = {
    schemaVersion: 1,
    variant: 'original',
    state: 'compiled',
    upstreamCommit: lock.upstreamCommit,
    depsSha256: lock.depsSha256,
    depotToolsCommit: lock.depotToolsCommit,
    gnArguments:
      [
        ...lock.buildArguments,
        'target_cpu="' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '"',
      ].join('\n') + '\n',
    prerequisites: {
      target:
        (process.platform === 'win32'
          ? 'windows-'
          : process.platform === 'darwin'
            ? 'macos-'
            : 'linux-') + process.arch,
    },
    outputAllocatedBytes: 10 * GIB,
  };
  assert.equal(matchesOriginalBuild(state, manifest), true);
  // Unit metadata is explicit test data; each changed identity must invalidate its measurement.
  for (const change of [
    { upstreamCommit: '0'.repeat(40) },
    { depsSha256: '0'.repeat(64) },
    { depotToolsCommit: '0'.repeat(40) },
    { gnArguments: manifest.gnArguments + 'is_debug=true\n' },
    { prerequisites: { target: 'foreign-platform' } },
    { state: 'pending' },
    { variant: 'patched' },
    { outputAllocatedBytes: 0 },
    { outputAllocatedBytes: 0.5 },
  ])
    assert.equal(matchesOriginalBuild(state, { ...manifest, ...change }), false);
  const patched = estimateBuildDiskBudget(
    'patched',
    100,
    0,
    3 * GIB,
    manifest.outputAllocatedBytes,
  );
  assert.equal(patched.requiredRemainingFreeGiB, 29.5);
  assert.equal(patched.capacityVerified, false);
  assert.equal(estimateBuildDiskBudget('patched', 100, 0, 0).budgetStatus, 'unresolved');
}

/**
 * Verify preparation and exact-source tool stages retain distinct resource admission.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of unchanged initial floor, live reserve, and SDK gate assertions.
 */
function stageAdmission() {
  const report = {
    resources: { freeDiskGiB: 97 },
    gates: { freeDisk: false, memory: true, sdk: true },
    status: 'blocked',
    checkoutReady: false,
  };
  assert.equal(applyStageResourceBudget(report, 'checkout').status, 'blocked');
  assert.equal(applyStageResourceBudget(report, 'build').status, 'blocked');
  assert.equal(applyStageResourceBudget(report, 'source-sync').status, 'ready');
  assert.equal(applyStageResourceBudget(report, 'hooks').status, 'ready');
  assert.equal(
    applyStageResourceBudget({ ...report, gates: { ...report.gates, sdk: false } }, 'hooks').status,
    'blocked',
  );
  assert.equal(
    applyStageResourceBudget({ ...report, resources: { freeDiskGiB: 19.99 } }, 'hooks').status,
    'blocked',
  );
  const unresolved = estimateBuildDiskBudget('original', 100, 100 * GIB, 0);
  assert.equal(applyStageResourceBudget(report, 'build-output', unresolved).status, 'blocked');
  assert.equal(report.status, 'blocked');
}

/**
 * Verify native allocation includes hidden storage and prunes only the owned root out tree.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of actual temporary filesystem and scope assertions.
 */
async function allocationScopes() {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-budget-'));
  const source = path.join(root, 'src');
  const state = {
    root,
    source,
    auditDirectory: path.join(root, 'audit'),
    env: process.env,
    lock: await readVersionLock(),
  };
  try {
    const hidden = path.join(source, '.git');
    await mkdir(hidden, { recursive: true });
    await writeFile(path.join(hidden, 'owned.pack'), randomBytes(16384));
    // Windows filesystem Hidden is an actual attribute rather than a leading-dot filename convention.
    if (process.platform === 'win32')
      await runTool(path.join(process.env.SystemRoot, 'System32', 'attrib.exe'), ['+H', hidden], {
        ...state,
        cwd: root,
        phase: 'mark-owned-hidden-test-directory',
        timeoutMs: 10000,
      });
    assert.ok((await allocatedOutputBytes(state, source, { excludeRootOut: true })) >= 16384);
    const nestedOut = path.join(source, 'deps', 'generated', 'out');
    const original = path.join(source, 'out', 'ABROriginal');
    await mkdir(nestedOut, { recursive: true });
    await mkdir(original, { recursive: true });
    await writeFile(path.join(nestedOut, 'owned-source.dat'), randomBytes(8192));
    await writeFile(path.join(original, 'owned-output.obj'), randomBytes(32768));
    const all = await allocatedOutputBytes(state, source);
    const excluded = await allocatedOutputBytes(state, source, { excludeRootOut: true });
    const outputTree = await allocatedOutputBytes(state, path.join(source, 'out'));
    assert.ok(excluded >= 24576);
    assert.ok(Math.abs(all - outputTree - excluded) <= 4096);
    const budget = await buildDiskBudget(state, 'original');
    assert.equal(budget.activeSourceAllocatedGiB * GIB, excluded);
    assert.ok(budget.existingAllocatedGiB > 0);
    await assert.rejects(allocatedOutputBytes(state, path.dirname(root)), {
      code: 'INVALID_ALLOCATION_SCOPE',
    });
    assert.equal((await buildDiskBudget(state, 'patched')).budgetStatus, 'unresolved');
    // Windows measurement leaves package and build-log aliases opaque to their targets.
    if (process.platform === 'win32') {
      const target = path.join(root, 'other-owned');
      await mkdir(target);
      await writeFile(path.join(target, 'excluded-target.dat'), randomBytes(65536));
      await symlink(target, path.join(source, 'redirect'), 'junction');
      assert.equal(await allocatedOutputBytes(state, source), all);
      // Source package links remain opaque and their target data cannot enter the deducted estimate.
      assert.equal(await allocatedOutputBytes(state, source, { excludeRootOut: true }), excluded);
    }
  } finally {
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-budget-')
    )
      throw new Error('Invalid storage-budget cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Verify selected official Git markers form a complete immutable source graph.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of missing, foreign, and revision mismatch rejection assertions.
 */
function selectedGraph() {
  const state = {
    sourceName: 'src',
    sourceOrigin: 'https://github.com/chromium/chromium.git',
    lock: { upstreamCommit: 'a'.repeat(40) },
  };
  const entries = {
    src: state.sourceOrigin,
    'src/third_party/owned': 'https://example.invalid/owned.git@' + 'b'.repeat(40),
  };
  const commits = { src: 'a'.repeat(40), 'src/third_party/owned': 'b'.repeat(40) };
  assert.equal(selectedSyncGitGraph(state, entries, commits).length, 2);
  // Actual official CIPD markers use tagged package versions outside the Git checkout graph.
  const packageScope = 'src/buildtools/win:gn/gn/windows-amd64';
  const packageUrl =
    'https://chrome-infra-packages.appspot.com/gn/gn/windows-amd64@git_revision:' + 'c'.repeat(40);
  const packagedEntries = { ...entries, [packageScope]: packageUrl };
  assert.equal(selectedSyncGitGraph(state, packagedEntries, commits).length, 2);
  assert.throws(
    () =>
      selectedSyncGitGraph(state, packagedEntries, { ...commits, [packageScope]: 'c'.repeat(40) }),
    { code: 'SOURCE_SYNC_MARKER_INVALID' },
  );
  assert.throws(
    () =>
      selectedSyncGitGraph(
        state,
        { ...entries, [packageScope]: entries['src/third_party/owned'] },
        commits,
      ),
    { code: 'SOURCE_SYNC_MARKER_INVALID' },
  );
  assert.throws(
    () =>
      selectedSyncGitGraph(
        state,
        { ...entries, 'src/third_party/missing': 'https://example.invalid/missing.git' },
        commits,
      ),
    { code: 'SOURCE_SYNC_MARKER_INVALID' },
  );
  assert.throws(() => selectedSyncGitGraph(state, entries, { src: commits.src }), {
    code: 'SOURCE_SYNC_MARKER_INVALID',
  });
  assert.throws(
    () => selectedSyncGitGraph(state, entries, { ...commits, 'src/missing': 'c'.repeat(40) }),
    { code: 'SOURCE_SYNC_MARKER_INVALID' },
  );
  assert.throws(
    () =>
      selectedSyncGitGraph(state, entries, { ...commits, 'src/third_party/owned': 'c'.repeat(40) }),
    { code: 'SOURCE_SYNC_MARKER_INVALID' },
  );
  assert.throws(
    () =>
      selectedSyncGitGraph(
        state,
        { src: entries.src, 'src/../outside': entries['src/third_party/owned'] },
        { src: commits.src, 'src/../outside': 'b'.repeat(40) },
      ),
    { code: 'DEPENDENCY_SCOPE_REJECTED' },
  );
}

/**
 * Verify successful-sync evidence binds source, toolchain, host, and marker content.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of receipt identity and content-change rejection assertions.
 */
async function completionReceipt() {
  const lock = await readVersionLock();
  const state = { lock, sourceName: 'src', sourceOrigin: lock.upstreamMirror };
  const hashes = {
    '.gclient': '1'.repeat(64),
    '.gclient_entries': '2'.repeat(64),
    '.gclient_previous_sync_commits': '3'.repeat(64),
  };
  const receipt = {
    schemaVersion: 1,
    purpose: 'completed-official-source-sync',
    upstreamCommit: lock.upstreamCommit,
    depsSha256: lock.depsSha256,
    depotToolsCommit: lock.depotToolsCommit,
    sourceOrigin: state.sourceOrigin,
    sourceName: 'src',
    host: process.platform + '-' + process.arch,
    markerHashes: hashes,
    syncRevision: 'src@' + lock.upstreamCommit,
    noHooks: true,
    toolEvidence: { phase: 'gclient-sync', state: 'completed', exitCode: 0 },
  };
  assert.equal(matchesSyncCompletion(state, receipt, hashes), true);
  for (const change of [
    { upstreamCommit: '0'.repeat(40) },
    { depsSha256: '0'.repeat(64) },
    { depotToolsCommit: '0'.repeat(40) },
    { sourceOrigin: lock.upstreamRepository },
    { host: 'foreign-platform' },
    { noHooks: false },
    { syncRevision: 'src@wrong' },
    { toolEvidence: { phase: 'gclient-sync', state: 'failed', exitCode: 1 } },
  ])
    assert.equal(matchesSyncCompletion(state, { ...receipt, ...change }, hashes), false);
  assert.equal(
    matchesSyncCompletion(state, receipt, { ...hashes, '.gclient_entries': '4'.repeat(64) }),
    false,
  );
}

test(
  'original planning accounts for source and output and keeps exhausted estimates unresolved',
  originalBudget,
);
test(
  'patched planning accepts only exact original configuration and one measured contingency',
  patchedBudget,
);
test(
  'native preparation and synchronized tool phases preserve their independent resource gates',
  stageAdmission,
);
test(
  'owned allocation includes hidden Git storage and excludes only root build output',
  allocationScopes,
);
test('official selected Git marker sets require immutable complete source scopes', selectedGraph);
test(
  'official sync completion evidence binds source identity and all marker hashes',
  completionReceipt,
);
