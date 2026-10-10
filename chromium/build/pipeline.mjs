// -*- coding: utf-8 -*-
/**
 * pipeline.mjs
 * Official Chromium preparation and build pipeline
 * =====================
 * Pin official sources, verify native prerequisites, audit controlled phases, and retain original and patched builds.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CHROMIUM_ROOT,
  GIB,
  REPOSITORY_ROOT,
  SOURCE_ORIGINS,
  audit,
  exists,
  gateError,
  hostResources,
  officialMetadata,
  readVersionLock,
  runTool,
  sha256,
  toolchainEnvironment,
  validateCheckoutRoot,
  versionAtLeast,
  writeArtifact,
} from './common.mjs';

/**
 * Measure allocated file storage within one owned directory and optional source scope.
 * Args:
 *   state (object): Validated external workspace context.
 *   directory (string): Exact owned directory to measure.
 *   options (object): Whether the source root out directory is excluded from traversal.
 * Returns:
 *   Promise<number>: Actual allocation measured through native filesystem tools.
 */
export async function allocatedOutputBytes(state, directory, options = {}) {
  const root = await validateCheckoutRoot(state.root);
  const measured = await validateCheckoutRoot(directory);
  const relative = path.relative(root, measured);
  // Every measured scope remains inside the explicit ordinary external workspace.
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw gateError(
      'INVALID_ALLOCATION_SCOPE',
      'Allocation scope must remain within the owned root.',
    );
  // Missing output directories have no existing allocation to deduct from a remaining budget.
  if (!(await exists(measured))) return 0;
  // Allocation and monitored free space refer to the same owned filesystem.
  const rootDevice = (await lstat(root)).dev;
  if ((await lstat(measured)).dev !== rootDevice)
    throw gateError(
      'INVALID_ALLOCATION_SCOPE',
      'Allocation scope requires the owned source filesystem.',
    );
  const excludeRootOut = options.excludeRootOut === true;
  const timeoutMs = 120000;
  if (process.platform === 'win32') {
    const powershell = path.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? '',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const declaration = await readFile(new URL('./windows-allocation.cs', import.meta.url));
    const excluded = excludeRootOut ? path.join(measured, 'out') : '';
    // Native traversal includes hidden Git storage and prunes the exact root output scope.
    const script = `$ErrorActionPreference='Stop';$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${declaration.toString('base64')}'));Add-Type -TypeDefinition $source;[AbrAllocation]::Measure('${measured}','${excluded}',$true).ToString()`;
    const result = await runTool(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { ...state, phase: 'measure-directory-allocation', cwd: REPOSITORY_ROOT, timeoutMs },
    );
    const bytes = Number(result.stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw gateError(
        'DISK_MEASUREMENT_FAILED',
        'Native directory allocation measurement is invalid.',
      );
    return bytes;
  }
  // Native du includes hidden entries and retains its no-follow allocation semantics on Unix.
  const scopes = excludeRootOut
    ? (await readdir(measured))
        .filter((name) => name !== 'out')
        .map((name) => path.join(measured, name))
    : [measured];
  for (const scope of scopes)
    if ((await lstat(scope)).dev !== rootDevice)
      throw gateError(
        'INVALID_ALLOCATION_SCOPE',
        'Allocation entries require the owned source filesystem.',
      );
  const result = scopes.length
    ? await runTool('du', ['-skx', ...scopes], {
        ...state,
        phase: 'measure-directory-allocation',
        cwd: REPOSITORY_ROOT,
        timeoutMs,
      })
    : { stdout: '' };
  let bytes = 0;
  // Sum each selected root entry while preserving deduplication inside one native du invocation.
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const count = line.match(/^\s*(\d+)\s/);
    if (!count) throw gateError('DISK_MEASUREMENT_FAILED', 'Native allocation output is invalid.');
    bytes += Number(count[1]) * 1024;
  }
  // The selected child scopes omit only the source root directory's own native allocation.
  if (excludeRootOut) bytes += Number((await lstat(measured)).blocks) * 512;
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw gateError(
      'DISK_MEASUREMENT_FAILED',
      'Native directory allocation measurement is invalid.',
    );
  return bytes;
}

/**
 * Match a compiled original output to the exact active build identity.
 * Args:
 *   state (object): Locked source, dependency, toolchain, and GN configuration.
 *   manifest (object): Completed original build measurement candidate.
 * Returns:
 *   boolean: Whether the candidate supplies a valid same-pin output measurement.
 */
export function matchesOriginalBuild(state, manifest) {
  const expectedArguments =
    [
      ...state.lock.buildArguments,
      'target_cpu="' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '"',
    ].join('\n') + '\n';
  const target =
    (process.platform === 'win32'
      ? 'windows-'
      : process.platform === 'darwin'
        ? 'macos-'
        : 'linux-') + process.arch;
  return (
    manifest?.schemaVersion === 1 &&
    manifest.variant === 'original' &&
    manifest.state === 'compiled' &&
    manifest.upstreamCommit === state.lock.upstreamCommit &&
    manifest.depsSha256 === state.lock.depsSha256 &&
    manifest.depotToolsCommit === state.lock.depotToolsCommit &&
    manifest.gnArguments === expectedArguments &&
    manifest.prerequisites?.target === target &&
    Number.isSafeInteger(manifest.outputAllocatedBytes) &&
    manifest.outputAllocatedBytes > 0
  );
}

/**
 * Calculate a stage-specific planning estimate from measured source and output storage.
 * Args:
 *   variant (string): Original or patched native output identity.
 *   workspacePlanningGiB (number): Locked initial workspace planning base.
 *   sourceBytes (number): Active source storage with the root out directory excluded.
 *   outputBytes (number): Storage already allocated to the selected output.
 *   originalBytes (number | undefined): Verified same-pin completed original output storage.
 * Returns:
 *   object: Estimated or unresolved remaining space with explicit capacity limitations.
 */
export function estimateBuildDiskBudget(
  variant,
  workspacePlanningGiB,
  sourceBytes,
  outputBytes,
  originalBytes,
) {
  // Reject malformed measurements before their values participate in remaining-space arithmetic.
  if (
    !['original', 'patched'].includes(variant) ||
    !Number.isFinite(workspacePlanningGiB) ||
    workspacePlanningGiB <= 0 ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0 ||
    !Number.isSafeInteger(outputBytes) ||
    outputBytes < 0 ||
    (originalBytes !== undefined && (!Number.isSafeInteger(originalBytes) || originalBytes <= 0))
  )
    throw gateError('DISK_MEASUREMENT_FAILED', 'Build storage measurements are invalid.');
  const sourceGiB = sourceBytes / GIB;
  const reserveGiB = 20;
  const result = {
    workspacePlanningGiB,
    activeSourceAllocatedGiB: variant === 'original' ? sourceGiB : null,
    existingAllocatedGiB: outputBytes / GIB,
    reserveGiB,
    capacityVerified: false,
    estimateStatus: 'estimate-unverified',
    budgetStatus: 'unresolved',
    estimatedTotalGiB: null,
    requiredRemainingFreeGiB: null,
  };
  // A source tree consuming the planning base provides no remaining first-output size estimate.
  if (variant === 'original' && sourceGiB >= workspacePlanningGiB)
    return { ...result, basis: 'active-source-exceeds-workspace-planning-base' };
  // Patched capacity uses only a completed exact-match original output measurement.
  if (variant === 'patched' && originalBytes === undefined)
    return { ...result, basis: 'verified-same-pin-original-output-required' };
  const estimatedTotalGiB =
    variant === 'patched'
      ? (originalBytes / GIB) * 1.25 + reserveGiB
      : workspacePlanningGiB - sourceGiB + reserveGiB;
  return {
    ...result,
    budgetStatus: 'estimated',
    estimatedTotalGiB,
    basis:
      variant === 'patched'
        ? 'measured-same-pin-original-output-plus-25-percent-and-reserve'
        : 'workspace-planning-base-minus-active-source-plus-reserve',
    requiredRemainingFreeGiB: Math.max(reserveGiB, estimatedTotalGiB - outputBytes / GIB),
  };
}

/**
 * Estimate remaining build space from measured same-pin output with an explicit contingency.
 * Args:
 *   state (object): Exact source, dependency, toolchain, and output configuration.
 *   variant (string): Original or patched output directory.
 * Returns:
 *   Promise<object>: Conservative remaining-space estimate and measured evidence basis.
 */
export async function buildDiskBudget(state, variant) {
  let originalBytes;
  // A completed same-pin original output provides measured evidence for the small readonly patch build.
  if (variant === 'patched') {
    const candidates = (await readdir(state.auditDirectory))
      .filter((name) => /^build-original-\d+\.json$/.test(name))
      .sort()
      .reverse();
    for (const name of candidates) {
      const manifest = JSON.parse(await readFile(path.join(state.auditDirectory, name), 'utf8'));
      if (matchesOriginalBuild(state, manifest)) {
        originalBytes = manifest.outputAllocatedBytes;
        break;
      }
    }
  }
  const output = path.join(
    state.source,
    'out',
    variant === 'patched' ? 'ABRPatched' : 'ABROriginal',
  );
  // Existing outputs are excluded from source storage and deducted exactly once for this variant.
  const sourceBytes =
    variant === 'original'
      ? await allocatedOutputBytes(state, state.source, { excludeRootOut: true })
      : 0;
  const outputBytes = await allocatedOutputBytes(state, output);
  return estimateBuildDiskBudget(
    variant,
    state.lock.requirements.minimumFreeDiskGiB,
    sourceBytes,
    outputBytes,
    originalBytes,
  );
}

/**
 * Create owned phase context without mutating the source checkout.
 * Args:
 *   values (object): Parsed explicit command options.
 * Returns:
 *   Promise<object>: Validated source, tool, audit, and lock configuration.
 */
export async function context(values) {
  const root = await validateCheckoutRoot(values['checkout-root']);
  const source = await validateCheckoutRoot(values['source-dir'] ?? path.join(root, 'src'));
  const sourceName = path.relative(root, source).split(path.sep).join('/');
  // Source and tool paths remain descendants of the explicitly named external root.
  if (
    !sourceName ||
    path.relative(root, source) === '..' ||
    path.relative(root, source).startsWith('..' + path.sep) ||
    path.isAbsolute(path.relative(root, source))
  )
    throw gateError(
      'INVALID_CHECKOUT_PATH',
      'Source must remain inside the external checkout root.',
    );
  const sourceOrigin = SOURCE_ORIGINS[values['source-origin'] ?? 'upstream'];
  if (!sourceOrigin)
    throw gateError(
      'INVALID_SOURCE_ORIGIN',
      'Use the declared upstream or official mirror source origin.',
    );
  const lock = await readVersionLock(values.lock);
  const depotTools = await validateCheckoutRoot(path.join(root, 'depot_tools'));
  return {
    root,
    source,
    sourceName,
    sourceOrigin,
    lock,
    depotTools,
    auditDirectory: path.join(root, 'audit'),
    env: toolchainEnvironment(depotTools),
    timeoutMs: values['timeout-seconds']
      ? Number(values['timeout-seconds']) * 1000
      : 30 * 60 * 1000,
  };
}

/**
 * Run one readonly or owned git command through the safe subprocess boundary.
 * Args:
 *   state (object): Validated pipeline context.
 *   args (string[]): Explicit git arguments.
 *   phase (string): Non-secret audit phase identifier.
 *   cwd (string): Owned working directory for git.
 *   timeoutMs (number): Explicit bounded command deadline.
 * Returns:
 *   Promise<string>: Bounded git output for hash and state verification.
 */
async function git(state, args, phase, cwd = state.root, timeoutMs = 60000) {
  const result = await runTool(
    'git',
    [
      '-c',
      'protocol.version=2',
      '-c',
      'http.lowSpeedLimit=1024',
      '-c',
      'http.lowSpeedTime=30',
      '-c',
      'http.sslVerify=true',
      ...args,
    ],
    { ...state, phase, cwd, timeoutMs },
  );
  return result.stdout.trim();
}

/**
 * Verify the release tag against the selected official source repository.
 * Args:
 *   state (object): Exact upstream tag and commit context.
 * Returns:
 *   Promise<object>: Tag and DEPS evidence from official metadata.
 */
export async function verifyUpstream(state) {
  let tagOutput;
  // Retry readonly Git requests and preserve the exact selected origin in the receipt.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      tagOutput = await git(
        state,
        [
          'ls-remote',
          state.sourceOrigin,
          'refs/tags/' + state.lock.upstreamTag,
          'refs/tags/' + state.lock.upstreamTag + '^{}',
        ],
        'verify-release-tag',
        REPOSITORY_ROOT,
        45000,
      );
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  const lines = tagOutput.split('\n').map((line) => line.trim().split(/\s+/));
  const peeled = lines.find(([, ref]) => ref?.endsWith('^{}'))?.[0];
  const direct = lines.find(([, ref]) => ref === 'refs/tags/' + state.lock.upstreamTag)?.[0];
  // Annotated tags resolve through their peeled commit; ordinary tags resolve directly.
  if ((peeled ?? direct) !== state.lock.upstreamCommit)
    throw gateError('UPSTREAM_PIN_MISMATCH', 'Release tag resolves to a different source commit.');
  const mirrored = state.sourceOrigin === SOURCE_ORIGINS.mirror;
  const depsUrl = mirrored
    ? `https://raw.githubusercontent.com/chromium/chromium/${state.lock.upstreamCommit}/DEPS`
    : `https://chromium.googlesource.com/chromium/src/+/${state.lock.upstreamCommit}/DEPS?format=TEXT`;
  const depsResponse = await officialMetadata(depsUrl, state.auditDirectory);
  const depsBytes = mirrored
    ? depsResponse
    : Buffer.from(depsResponse.toString('ascii').trim(), 'base64');
  // A source-level DEPS lock controls dependency synchronization and subsequent hooks.
  if (!depsBytes.length || !depsBytes.includes(Buffer.from('vars')))
    throw gateError('INVALID_DEPS', 'Official DEPS metadata is incomplete.');
  const digest = sha256(depsBytes);
  if (state.lock.depsSha256 && digest !== state.lock.depsSha256)
    throw gateError('DEPS_PIN_MISMATCH', 'DEPS metadata differs from the committed digest.');
  const receipt = {
    schemaVersion: 1,
    upstreamTag: state.lock.upstreamTag,
    upstreamCommit: state.lock.upstreamCommit,
    sourceOrigin: state.sourceOrigin,
    depsSha256: digest,
    verifiedAt: new Date().toISOString(),
  };
  await writeArtifact(
    path.join(state.auditDirectory, 'pin-' + digest + '-' + Date.now() + '.json'),
    receipt,
  );
  return receipt;
}

/**
 * Read an exact official depot_tools HEAD identity for independent lock preparation.
 * Args:
 *   state (object): Owned audit context with the official repository identity.
 * Returns:
 *   Promise<object>: Official commit metadata receipt without installing toolchain files.
 */
export async function verifyDepotToolsMetadata(state) {
  const url = state.lock.depotToolsRepository.replace(/\.git$/, '') + '/+/HEAD?format=JSON';
  const bytes = await officialMetadata(url, state.auditDirectory);
  const metadata = JSON.parse(bytes.toString('utf8').replace(/^\)\]\}'\r?\n/, ''));
  // Metadata must identify a complete immutable Git commit before it enters the lock.
  if (!/^[a-f0-9]{40}$/.test(metadata.commit))
    throw gateError(
      'INVALID_DEPOT_TOOLS_METADATA',
      'Official tool metadata lacks a complete commit.',
    );
  const receipt = {
    schemaVersion: 1,
    repository: state.lock.depotToolsRepository,
    depotToolsCommit: metadata.commit,
    metadataSha256: sha256(bytes),
    verifiedAt: new Date().toISOString(),
  };
  await writeArtifact(
    path.join(state.auditDirectory, 'depot-tools-pin-' + Date.now() + '.json'),
    receipt,
  );
  return receipt;
}

/**
 * Probe the native Windows toolchain through installed registry and executable metadata.
 * Args:
 *   state (object): Current Windows pipeline context.
 * Returns:
 *   Promise<object>: Actual Visual Studio, SDK, debugger, and volume gate evidence.
 */
async function windowsToolchain(state) {
  const programRoot = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  const vswhere = path.join(
    programRoot ?? '',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  const probe = await runTool(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      state.lock.requirements.windows.requiredComponent,
      '-format',
      'json',
    ],
    { ...state, phase: 'visual-studio-probe', cwd: REPOSITORY_ROOT, timeoutMs: 30000 },
  );
  const installations = JSON.parse(probe.stdout);
  const visualStudio = installations[0];
  const drive = path.parse(state.root).root.replace(/[:\\/]/g, '');
  // Query conventional OS registry locations and real SDK file versions without installation actions.
  const script = `$ErrorActionPreference='Stop'; $kits=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots').KitsRoot10; $sdk=@(Get-ChildItem -LiteralPath (Join-Path $kits 'bin') -Directory | ForEach-Object { $rc=Join-Path $_.FullName 'x64\\rc.exe'; if(Test-Path -LiteralPath $rc){ (Get-Item -LiteralPath $rc).VersionInfo.FileVersion } }); $debug=Join-Path $kits 'Debuggers\\x64\\dbghelp.dll'; $debugVersion=if(Test-Path -LiteralPath $debug){(Get-Item -LiteralPath $debug).VersionInfo.FileVersion}else{''}; $volume=(Get-Volume -DriveLetter '${drive}').FileSystem; @{sdkVersions=$sdk; debugToolsVersion=$debugVersion; fileSystem=$volume}|ConvertTo-Json -Compress`;
  const powershell = path.join(
    process.env.SystemRoot ?? process.env.WINDIR ?? '',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = await runTool(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { ...state, phase: 'windows-sdk-probe', cwd: REPOSITORY_ROOT, timeoutMs: 30000 },
  );
  const metadata = JSON.parse(result.stdout);
  const versions = (
    Array.isArray(metadata.sdkVersions) ? metadata.sdkVersions : [metadata.sdkVersions]
  ).map((value) => value.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? '0');
  const sdk = versions.find((value) =>
    versionAtLeast(value, state.lock.requirements.windows.minimumWindowsSdk),
  );
  const debuggerVersion = metadata.debugToolsVersion.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? '0';
  const gates = {
    visualStudio: Boolean(
      visualStudio &&
      versionAtLeast(
        visualStudio.installationVersion,
        state.lock.requirements.windows.minimumVisualStudio,
      ),
    ),
    atlMfc: Boolean(visualStudio),
    windowsSdk: Boolean(sdk),
    debugTools: versionAtLeast(debuggerVersion, state.lock.requirements.windows.minimumDebugTools),
    sourceFileSystem: metadata.fileSystem === 'NTFS',
  };
  // The selected installed Visual Studio remains process-local to the official toolchain.
  if (visualStudio?.installationPath) state.env.vs2026_install = visualStudio.installationPath;
  return {
    gates,
    visualStudioVersion: visualStudio?.installationVersion ?? 'unavailable',
    sdkVersion: sdk ?? 'unavailable',
    debugToolsVersion: debuggerVersion,
    fileSystem: metadata.fileSystem,
  };
}

/**
 * Probe the actual native macOS Xcode, SDK, and source-volume filesystem.
 * Args:
 *   state (object): Native macOS source context and exact upstream pin.
 * Returns:
 *   Promise<object>: Actual Xcode/SDK/APFS requirement gates.
 */
async function macosToolchain(state) {
  const options = { ...state, cwd: REPOSITORY_ROOT, timeoutMs: 30000 };
  const xcode = await runTool('xcodebuild', ['-version'], {
    ...options,
    phase: 'macos-xcode-probe',
  });
  const sdk = await runTool('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], {
    ...options,
    phase: 'macos-sdk-probe',
  });
  let volume = state.root;
  // Query an existing source-volume ancestor before any checkout is created.
  while (!(await exists(volume))) volume = path.dirname(volume);
  const disk = await runTool('diskutil', ['info', '-plist', volume], {
    ...options,
    phase: 'macos-volume-probe',
  });
  const mirror = state.sourceOrigin === SOURCE_ORIGINS.mirror;
  const metadataPath = 'build/config/mac/mac_sdk.gni';
  const url = mirror
    ? `https://raw.githubusercontent.com/chromium/chromium/${state.lock.upstreamCommit}/${metadataPath}`
    : `https://chromium.googlesource.com/chromium/src/+/${state.lock.upstreamCommit}/${metadataPath}?format=TEXT`;
  const bytes = await officialMetadata(url, state.auditDirectory);
  const content = mirror
    ? bytes.toString('utf8')
    : Buffer.from(bytes.toString('ascii').trim(), 'base64').toString('utf8');
  const requiredSdk = content.match(/mac_sdk_official_version\s*=\s*"(\d+(?:\.\d+)+)"/)?.[1];
  const sdkVersion = sdk.stdout.trim();
  const xcodeVersion = xcode.stdout.match(/Xcode (\d+(?:\.\d+)+)/)?.[1];
  const apfs = /<key>FilesystemType<\/key>\s*<string>apfs<\/string>/i.test(disk.stdout);
  return {
    gates: {
      xcode: Boolean(xcodeVersion),
      macosSdk: Boolean(requiredSdk && versionAtLeast(sdkVersion, requiredSdk)),
      sourceFileSystem: apfs,
    },
    xcodeVersion: xcodeVersion ?? 'unavailable',
    sdkVersion,
    requiredSdk: requiredSdk ?? 'unverified',
    requirementSha256: sha256(bytes),
    fileSystem: apfs ? 'apfs' : 'unsupported',
  };
}

/**
 * Probe native Linux package dependencies through the pinned official quick-check path.
 * Args:
 *   state (object): Native Linux source context and exact upstream pin.
 * Returns:
 *   Promise<object>: Actual source and package prerequisite gates without package installation.
 */
async function linuxToolchain(state) {
  const gates = { pinnedDependencyScript: false, systemDependencies: false };
  // Official Linux package checks require the exact source checkout they belong to.
  if (!(await exists(path.join(state.source, 'DEPS'))))
    return { gates, state: 'pending-pinned-source-dependency-check' };
  const head = await git(
    state,
    ['rev-parse', 'HEAD'],
    'linux-verify-dependency-source',
    state.source,
  );
  await verifySource(state, head === state.lock.upstreamCommit ? 'original' : 'patched', false);
  const script = path.join(state.source, 'build', 'install-build-deps.sh');
  let content = await readFile(script, 'utf8');
  const python = path.join(state.source, 'build', 'install-build-deps.py');
  // Modern official wrappers delegate their closed quick-check flags to the companion module.
  if (await exists(python)) content += await readFile(python, 'utf8');
  if (!content.includes('--quick-check'))
    return { gates, state: 'unsupported-upstream-quick-check' };
  gates.pinnedDependencyScript = true;
  const args = [script, '--quick-check'];
  // Append the noninteractive flag only when the actual pinned script declares it.
  if (content.includes('--no-prompt')) args.push('--no-prompt');
  // A failed readonly check retains a blocked package gate for explicit native preparation.
  try {
    await runTool('bash', args, {
      ...state,
      phase: 'linux-build-dependency-check',
      cwd: state.source,
      timeoutMs: 120000,
    });
    gates.systemDependencies = true;
  } catch {
    return { gates, state: 'pending-native-system-dependencies' };
  }
  return {
    gates,
    state: 'verified-pinned-source-system-dependencies',
    dependencyScriptSha256: sha256(content),
  };
}

/**
 * Report native prerequisites with actual resource and platform evidence.
 * Args:
 *   state (object): Validated source context.
 * Returns:
 *   Promise<object>: Explicit ready/blocked preparation gates.
 */
export async function preflight(state) {
  const resources = await hostResources(state.root);
  const target =
    resources.platform === 'win32'
      ? 'windows-' + resources.arch
      : resources.platform === 'darwin'
        ? 'macos-' + resources.arch
        : 'linux-' + resources.arch;
  const gates = {
    nativeTarget: state.lock.targets.includes(target),
    memory: resources.memoryGiB >= state.lock.requirements.minimumMemoryGiB,
    freeDisk: resources.freeDiskGiB >= state.lock.requirements.minimumFreeDiskGiB,
  };
  let toolchain;
  // Windows uses the exact verified SDK and ATL/MFC requirement matrix.
  if (resources.platform === 'win32') {
    toolchain = await windowsToolchain(state);
    Object.assign(gates, toolchain.gates);
  } else if (resources.platform === 'darwin') {
    toolchain = await macosToolchain(state);
    Object.assign(gates, toolchain.gates);
  } else if (resources.platform === 'linux') {
    toolchain = await linuxToolchain(state);
    Object.assign(gates, toolchain.gates);
  } else {
    gates.platformRequirementsVerified = false;
    toolchain = { state: 'unsupported-native-platform' };
  }
  return {
    schemaVersion: 1,
    target,
    resources,
    gates,
    toolchain,
    status: Object.values(gates).every(Boolean) ? 'ready' : 'blocked',
    checkoutReady:
      resources.platform === 'linux'
        ? gates.nativeTarget && gates.memory && gates.freeDisk
        : Object.values(gates).every(Boolean),
  };
}

/**
 * Require complete native prerequisite evidence before hooks or source preparation.
 * Args:
 *   state (object): Current native pipeline context.
 *   stage (string): Source checkout or complete build prerequisite phase.
 *   variant (string): Exact output directory for remaining-space accounting.
 * Returns:
 *   Promise<object>: Verified preparation report.
 */
async function requirePreflight(state, stage = 'build', variant = 'original') {
  const report = await preflight(state);
  const budget = stage === 'build-output' ? await buildDiskBudget(state, variant) : undefined;
  const result = applyStageResourceBudget(report, stage, budget);
  await writeArtifact(path.join(state.auditDirectory, 'preflight-' + Date.now() + '.json'), result);
  if (stage === 'checkout' ? !result.checkoutReady : result.status !== 'ready')
    throw gateError(
      'PREREQUISITE_GATE_BLOCKED',
      'Native build prerequisites are incomplete; inspect the preflight artifact.',
    );
  return result;
}

/**
 * Apply the explicit resource policy for one verified native preparation stage.
 * Args:
 *   report (object): Fresh hardware and native toolchain preflight results.
 *   stage (string): Preparation, synchronized tools, or output build phase.
 *   budget (object | undefined): Measured output planning estimate for build-output.
 * Returns:
 *   object: Stage-specific admission with unchanged native toolchain gates.
 */
export function applyStageResourceBudget(report, stage, budget) {
  const result = structuredClone(report);
  result.resourceStage = stage;
  // Initial preparation preserves the locked free-space floor.
  if (stage === 'build-output') {
    result.buildDiskBudget = budget;
    result.gates.freeDisk =
      budget?.budgetStatus === 'estimated' &&
      Number.isFinite(budget.requiredRemainingFreeGiB) &&
      result.resources.freeDiskGiB >= budget.requiredRemainingFreeGiB;
  }
  // Verified existing source synchronization and exact hooks retain a hard live reserve.
  if (stage === 'source-sync' || stage === 'hooks') {
    result.toolDiskBudget = {
      reserveGiB: 20,
      capacityVerified: false,
      estimateStatus: 'bounded-tool-phase-requires-live-disk-reserve-monitoring',
    };
    result.gates.freeDisk = result.resources.freeDiskGiB >= 20;
  }
  result.status = Object.values(result.gates).every(Boolean) ? 'ready' : 'blocked';
  return result;
}

/**
 * Require an owned external workspace marker for every mutation stage.
 * Args:
 *   state (object): Configurable external source workspace.
 * Returns:
 *   Promise<void>: Successful marker ownership check.
 */
async function requireOwnership(state) {
  const marker = JSON.parse(
    await readFile(path.join(state.root, '.abr-chromium-workspace.json'), 'utf8'),
  );
  if (
    marker.schemaVersion !== 1 ||
    marker.purpose !== 'abr-chromium' ||
    marker.upstreamCommit !== state.lock.upstreamCommit ||
    marker.sourceOrigin !== state.sourceOrigin ||
    marker.sourceName !== state.sourceName
  )
    throw gateError(
      'WORKSPACE_OWNERSHIP_MISMATCH',
      'External workspace marker differs from the selected pin or origin.',
    );
}

/**
 * Adopt an already prepared pinned source checkout without changing its files.
 * Args:
 *   state (object): External root containing the selected official source checkout.
 * Returns:
 *   Promise<object>: Verified source identity and newly created ownership marker.
 */
export async function adopt(state) {
  await requirePreflight(state);
  const source = await verifySource(state, 'original', false);
  const marker = {
    schemaVersion: 1,
    purpose: 'abr-chromium',
    upstreamCommit: state.lock.upstreamCommit,
    sourceOrigin: state.sourceOrigin,
    sourceName: state.sourceName,
  };
  await writeArtifact(path.join(state.root, '.abr-chromium-workspace.json'), marker);
  return { ...source, state: 'adopted' };
}

/**
 * Prepare a fresh owned workspace using the unchanged official fetch command.
 * Args:
 *   state (object): New external checkout root and pinned source configuration.
 * Returns:
 *   Promise<object>: Pinned upstream checkout after official fetch and source verification.
 */
export async function checkout(state) {
  await requirePreflight(state, 'checkout');
  const entries = (await readdir(state.root)).filter((name) => name !== 'audit');
  // Fresh preparation cannot replace a pre-existing source or tool directory.
  if (entries.length)
    throw gateError('WORKSPACE_NOT_EMPTY', 'Use adopt for a separately prepared source workspace.');
  // The unchanged upstream fetch recipe creates its canonical src solution name.
  if (state.sourceOrigin === SOURCE_ORIGINS.upstream && state.sourceName !== 'src')
    throw gateError(
      'UNSUPPORTED_FETCH_LAYOUT',
      'The upstream fetch recipe requires the canonical src directory.',
    );
  const pin = await verifyUpstream(state);
  if (!state.lock.depotToolsCommit)
    throw gateError(
      'DEPOT_TOOLS_PIN_REQUIRED',
      'Record a verified official depot_tools commit before tool installation.',
    );
  await git(
    state,
    ['clone', '--no-checkout', state.lock.depotToolsRepository, state.depotTools],
    'clone-depot-tools',
    state.root,
    state.timeoutMs,
  );
  await git(
    state,
    ['checkout', '--detach', state.lock.depotToolsCommit],
    'pin-depot-tools',
    state.depotTools,
  );
  await writeArtifact(path.join(state.root, '.abr-chromium-workspace.json'), {
    schemaVersion: 1,
    purpose: 'abr-chromium',
    upstreamCommit: state.lock.upstreamCommit,
    sourceOrigin: state.sourceOrigin,
    sourceName: state.sourceName,
  });
  await ensureWindowsBootstrap(state);
  // Bootstrap official Windows isolated Python through the supported command shell.
  await runTool(toolPath(state, 'gclient'), ['--version'], {
    ...state,
    phase: 'bootstrap-official-toolchain',
    cwd: state.root,
  });
  // Mirror preparation keeps the explicitly selected source origin in the gclient solution.
  if (state.sourceOrigin === SOURCE_ORIGINS.mirror) {
    await runTool(
      toolPath(state, 'gclient'),
      ['config', '--name=' + state.sourceName, '--unmanaged', state.sourceOrigin],
      { ...state, phase: 'gclient-mirror-config', cwd: state.root },
    );
    await git(
      state,
      [
        'clone',
        '--depth=1',
        '--branch',
        state.lock.upstreamTag,
        '--filter=blob:none',
        state.sourceOrigin,
        state.source,
      ],
      'clone-pinned-mirror',
      state.root,
      state.timeoutMs,
    );
  } else {
    // The official fetch command prepares the upstream gclient solution and dependency layout.
    await runTool(toolPath(state, 'fetch'), ['--nohooks', '--no-history', 'chromium'], {
      ...state,
      phase: 'official-fetch',
      cwd: state.root,
    });
  }
  await git(
    state,
    ['fetch', '--depth=1', state.sourceOrigin, 'refs/tags/' + state.lock.upstreamTag],
    'fetch-pinned-release',
    state.source,
    state.timeoutMs,
  );
  await git(
    state,
    ['checkout', '--detach', state.lock.upstreamCommit],
    'checkout-pinned-release',
    state.source,
  );
  const source = await verifySource(state, 'original', false);
  if (source.depsSha256 !== pin.depsSha256)
    throw gateError('DEPS_PIN_MISMATCH', 'Fetched DEPS differs from verified release metadata.');
  return source;
}

/**
 * Resolve an official depot_tools wrapper for the native host platform.
 * Args:
 *   state (object): Owned official toolchain context.
 *   tool (string): Closed official command identifier.
 * Returns:
 *   string: Portable native tool path.
 */
function toolPath(state, tool) {
  if (!['fetch', 'gclient', 'gn', 'autoninja'].includes(tool))
    throw gateError('INVALID_TOOL', 'Build tool is unregistered.');
  return path.join(state.depotTools, tool + (process.platform === 'win32' ? '.bat' : ''));
}

/**
 * Verify source origin, immutable base commit, clean state, DEPS, and optional patch receipt.
 * Args:
 *   state (object): Selected owned source context.
 *   variant (string): Original or patched build identity.
 *   requireLockedDeps (boolean): Whether synchronization/build requires a committed DEPS hash.
 *   cleanMode (string): Strict clean checkout or validated interrupted dependency resume.
 * Returns:
 *   Promise<object>: Concrete source and dependency evidence.
 */
export async function verifySource(
  state,
  variant = 'original',
  requireLockedDeps = true,
  cleanMode = 'strict',
) {
  const origin = await git(
    state,
    ['remote', 'get-url', 'origin'],
    'verify-source-origin',
    state.source,
  );
  const head = await git(state, ['rev-parse', 'HEAD'], 'verify-source-head', state.source);
  const dirty = await git(
    state,
    ['status', '--porcelain', '--untracked-files=normal'],
    'verify-source-clean',
    state.source,
  );
  if (![state.sourceOrigin, state.sourceOrigin.replace(/\.git$/, '')].includes(origin))
    throw gateError(
      'SOURCE_ORIGIN_MISMATCH',
      'Source origin differs from the explicitly selected official repository.',
    );
  if (dirty && cleanMode !== 'sync-resume')
    throw gateError(
      'SOURCE_DIRTY',
      'Source has uncommitted changes or unresolved patch application.',
    );
  if (variant === 'original' && head !== state.lock.upstreamCommit)
    throw gateError(
      'SOURCE_PIN_MISMATCH',
      'Original source HEAD differs from the exact upstream commit.',
    );
  if (variant === 'patched') {
    const receipt = JSON.parse(
      await readFile(path.join(state.auditDirectory, 'applied-patches.json'), 'utf8'),
    );
    if (
      receipt.upstreamCommit !== state.lock.upstreamCommit ||
      receipt.head !== head ||
      receipt.patchsetSha256 !== sha256(JSON.stringify(state.lock.patches))
    )
      throw gateError(
        'PATCH_RECEIPT_MISMATCH',
        'Patched source differs from its verified application receipt.',
      );
    await git(
      state,
      ['merge-base', '--is-ancestor', state.lock.upstreamCommit, head],
      'verify-patch-ancestry',
      state.source,
    );
  }
  const depsSha256 = sha256(await readFile(path.join(state.source, 'DEPS')));
  // Hooks and builds require the DEPS digest to be explicitly committed after source verification.
  if (requireLockedDeps && !state.lock.depsSha256)
    throw gateError(
      'DEPS_PIN_REQUIRED',
      'Record the verified release DEPS digest before dependency synchronization.',
    );
  if (state.lock.depsSha256 && depsSha256 !== state.lock.depsSha256)
    throw gateError('DEPS_PIN_MISMATCH', 'Source DEPS differs from the committed digest.');
  // Interrupted dependency work is the only narrowly permitted pre-sync dirty state.
  if (cleanMode === 'sync-resume') await verifySyncResumeState(state, dirty);
  return { upstreamCommit: state.lock.upstreamCommit, head, sourceOrigin: origin, depsSha256 };
}

/**
 * Resolve pinned Git dependency URLs using the exact official DEPS parser and isolated interpreter.
 * Args:
 *   state (object): Verified source/DEPS and exact official toolchain context.
 * Returns:
 *   Promise<object>: Repository and revision declarations keyed by source-relative scope.
 */
async function pinnedGitDependencies(state) {
  await verifyDepotTools(state);
  const relativePython = (
    await readFile(path.join(state.depotTools, 'python3_bin_reldir.txt'), 'utf8')
  ).trim();
  const python = path.resolve(
    state.depotTools,
    relativePython,
    process.platform === 'win32' ? 'python3.exe' : 'python3',
  );
  const relative = path.relative(state.depotTools, python);
  // The metadata helper uses only the already bootstrapped official isolated toolchain.
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw gateError(
      'TOOLCHAIN_PATH_REJECTED',
      'The official isolated interpreter must remain within pinned depot_tools.',
    );
  const program =
    "import collections.abc,json,pathlib,sys;sys.path.insert(0,sys.argv[1]);import gclient_eval;d=gclient_eval.Parse(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'),sys.argv[2]);print(json.dumps({p:v['url'] for p,v in d['deps'].items() if isinstance(v,collections.abc.Mapping) and v.get('dep_type')=='git' and isinstance(v.get('url'),str)}))";
  const result = await runTool(
    python,
    ['-I', '-c', program, state.depotTools, path.join(state.source, 'DEPS')],
    {
      ...state,
      phase: 'parse-pinned-git-dependencies',
      cwd: state.source,
      timeoutMs: 30000,
      captureBytes: 1024 * 1024,
    },
  );
  const values = JSON.parse(result.stdout);
  const output = {};
  // Dependency scopes stay within the exact root solution and use immutable Git revisions.
  for (const [name, value] of Object.entries(values)) {
    if (!name.startsWith(state.sourceName + '/') || typeof value !== 'string') continue;
    const separator = value.lastIndexOf('@');
    const origin = value.slice(0, separator);
    const revision = value.slice(separator + 1);
    if (separator < 1 || !/^[a-f0-9]{40}$/.test(revision) || !origin.startsWith('https://'))
      continue;
    output[name.slice(state.sourceName.length + 1)] = { origin, revision };
  }
  return output;
}

/**
 * Classify root changes that belong to narrowly scoped interrupted gclient work.
 * Args:
 *   status (string): Bounded root Git porcelain output.
 *   tracked (string): Root HEAD-to-working-tree raw diff.
 *   dependencies (object): Repository/revision map expanded from pinned DEPS.
 *   preserved (Set<string>): Missing gitlink scopes with independently verified intact recovery records.
 * Returns:
 *   object[]: Dependency entries requiring concrete root and origin validation.
 */
export function classifySyncResumeEntries(status, tracked, dependencies, preserved = new Set()) {
  const entries = [];
  // Root tracked content remains byte-identical; only dependency gitlink transitions are permitted.
  for (const line of tracked.split('\n').filter(Boolean)) {
    const missing = line.match(/^:160000 000000 ([a-f0-9]{40}) 0{40} D\t(.+)$/);
    // A missing gitlink is accepted only after its complete old checkout has a verified preservation receipt.
    if (missing) {
      if (
        !dependencies[missing[2]] ||
        dependencies[missing[2]].revision !== missing[1] ||
        !preserved.has(missing[2])
      )
        throw gateError(
          'SOURCE_USER_MODIFICATIONS',
          'Missing dependency lacks verified complete preservation evidence.',
        );
      continue;
    }
    const parsed = line.match(/^:160000 160000 ([a-f0-9]{40}) ([a-f0-9]{40}) M\t(.+)$/);
    if (!parsed || !dependencies[parsed[3]])
      throw gateError(
        'SOURCE_USER_MODIFICATIONS',
        'Source synchronization cannot overwrite root tracked changes.',
      );
    const expected = dependencies[parsed[3]];
    if (parsed[1] !== expected.revision)
      throw gateError(
        'DEPENDENCY_PIN_MISMATCH',
        'Root gitlink differs from its pinned DEPS revision.',
      );
    entries.push({ path: parsed[3], origin: expected.origin, kind: 'gitlink' });
  }
  // Unknown untracked files remain outside the allowed recovery surface.
  for (const line of status.split('\n').filter((item) => item.startsWith('?? '))) {
    const name = line.slice(3).replace(/\/$/, '');
    const match = name.match(/^(?:(.+)\/)?_gclient_([a-zA-Z0-9_.-]+)_([a-zA-Z0-9]{8})$/);
    if (!match)
      throw gateError(
        'SOURCE_USER_MODIFICATIONS',
        'Unknown untracked source data requires explicit review.',
      );
    const destination = (match[1] ? match[1] + '/' : '') + match[2];
    const expected = dependencies[destination];
    if (!expected)
      throw gateError(
        'UNKNOWN_GCLIENT_CLONE',
        'Temporary clone does not match a pinned DEPS destination.',
      );
    entries.push({ path: name, origin: expected.origin, kind: 'temporary-clone' });
  }
  return entries;
}

/**
 * Verify classified interrupted Git dependency state against actual owned directories.
 * Args:
 *   state (object): Verified source identity and pinned official dependency parser.
 *   status (string): Bounded root porcelain status.
 * Returns:
 *   Promise<void>: Origin and ordinary Git-root validation for every permitted entry.
 */
async function verifySyncResumeState(state, status) {
  const dependencies = await pinnedGitDependencies(state);
  const tracked = await git(
    state,
    ['diff', '--raw', '--no-abbrev', 'HEAD', '--', '.'],
    'verify-root-tracked-sync-state',
    state.source,
  );
  const preserved = await verifiedPreservedDependencies(state, dependencies);
  const entries = classifySyncResumeEntries(status, tracked, dependencies, preserved);
  // Every classified entry is independently validated against its concrete pinned origin.
  for (const entry of entries) await verifyDependencyOrigin(state, entry.path, entry.origin);
  await audit(state.auditDirectory, {
    phase: 'verify-sync-resume',
    state: 'completed',
    allowedState: 'pinned-gitlinks-and-verified-gclient-temporary-clones',
  });
}

/**
 * Verify source-scoped complete dependency preservation receipts before reinitialization.
 * Args:
 *   state (object): Owned exact source context.
 *   dependencies (object): Pinned official dependency declarations.
 * Returns:
 *   Promise<Set<string>>: Missing destinations with independently verified intact recovery repositories.
 */
async function verifiedPreservedDependencies(state, dependencies) {
  const recovery = path.join(state.root, 'recovery');
  const filename = path.join(recovery, 'preservation.jsonl');
  const preserved = new Set();
  // Workspaces with no preservation operation keep the ordinary dependency resume checks.
  if (!(await exists(filename))) return preserved;
  const text = (await readFile(filename, 'utf8')).replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const receipt = JSON.parse(line);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.purpose !== 'preserved-interrupted-gclient-dependency' ||
      receipt.upstreamCommit !== state.lock.upstreamCommit ||
      receipt.depsSha256 !== state.lock.depsSha256
    )
      throw gateError(
        'RECOVERY_RECEIPT_INVALID',
        'Dependency preservation evidence differs from the selected source pin.',
      );
    const relative = path
      .relative(state.source, path.resolve(receipt.source))
      .split(path.sep)
      .join('/');
    const expected = dependencies[relative];
    if (!expected || receipt.origin.replace(/\.git$/, '') !== expected.origin.replace(/\.git$/, ''))
      throw gateError(
        'RECOVERY_RECEIPT_INVALID',
        'Preserved dependency origin or source scope differs from pinned DEPS.',
      );
    const destination = await validateCheckoutRoot(receipt.destination);
    const scope = path.relative(recovery, destination);
    if (!scope || scope === '..' || scope.startsWith('..' + path.sep) || path.isAbsolute(scope))
      throw gateError(
        'RECOVERY_RECEIPT_INVALID',
        'Preserved dependency must remain in the owned recovery directory.',
      );
    const top = await git(
      state,
      ['rev-parse', '--show-toplevel'],
      'verify-preserved-dependency-root',
      destination,
    );
    const origin = await git(
      state,
      ['remote', 'get-url', 'origin'],
      'verify-preserved-dependency-origin',
      destination,
    );
    if (
      path.resolve(top) !== destination ||
      origin.replace(/\.git$/, '') !== expected.origin.replace(/\.git$/, '')
    )
      throw gateError(
        'RECOVERY_RECEIPT_INVALID',
        'Preserved checkout no longer matches its repository identity.',
      );
    preserved.add(relative);
  }
  return preserved;
}

/**
 * Verify a dependency or temporary clone's concrete root and expected official origin.
 * Args:
 *   state (object): Owned source workspace.
 *   relative (string): Strict source-relative dependency or temporary clone directory.
 *   expected (string): Repository URL expanded from pinned DEPS.
 * Returns:
 *   Promise<void>: Successful ordinary directory, Git root, and origin checks.
 */
async function verifyDependencyOrigin(state, relative, expected) {
  const directory = path.resolve(state.source, relative);
  await validateCheckoutRoot(directory);
  const scope = path.relative(state.source, directory);
  if (!scope || scope === '..' || scope.startsWith('..' + path.sep) || path.isAbsolute(scope))
    throw gateError(
      'DEPENDENCY_SCOPE_REJECTED',
      'Dependency checkout must remain under its owned source root.',
    );
  const top = await git(
    state,
    ['rev-parse', '--show-toplevel'],
    'verify-dependency-git-root',
    directory,
  );
  if (path.resolve(top) !== directory)
    throw gateError(
      'DEPENDENCY_SCOPE_REJECTED',
      'Dependency directory is not its own Git checkout.',
    );
  const origin = await git(
    state,
    ['remote', 'get-url', 'origin'],
    'verify-dependency-origin',
    directory,
  );
  if (origin.replace(/\.git$/, '') !== expected.replace(/\.git$/, ''))
    throw gateError('DEPENDENCY_ORIGIN_MISMATCH', 'Dependency origin differs from pinned DEPS.');
}

/**
 * Verify every initialized dependency checkout after successful official synchronization.
 * Args:
 *   state (object): Clean exact parent source and pinned official DEPS context.
 * Returns:
 *   Promise<object>: Verified dependency count and pinned clean-state evidence.
 */
export async function verifySynchronizedDependencies(state) {
  const dependencies = await pinnedGitDependencies(state);
  let initialized = 0;
  // Platform-disabled dependencies have no initialized Git directory and remain outside this host run.
  for (const [name, expected] of Object.entries(dependencies)) {
    const directory = path.join(state.source, name);
    if (!(await exists(path.join(directory, '.git')))) continue;
    await verifyDependencyOrigin(state, name, expected.origin);
    const head = await git(
      state,
      ['rev-parse', 'HEAD'],
      'verify-synchronized-dependency-head',
      directory,
    );
    if (head !== expected.revision)
      throw gateError(
        'DEPENDENCY_PIN_MISMATCH',
        'Synchronized dependency HEAD differs from pinned DEPS.',
      );
    const dirty = await git(
      state,
      ['status', '--porcelain', '--untracked-files=normal'],
      'verify-synchronized-dependency-clean',
      directory,
    );
    if (dirty) {
      await audit(state.auditDirectory, {
        phase: 'verify-synchronized-dependency-clean',
        state: 'failed',
        code: 'DEPENDENCY_DIRTY',
        dependency: name,
      });
      throw gateError(
        'DEPENDENCY_DIRTY',
        'Synchronized dependency has unfinished or local changes.',
      );
    }
    initialized += 1;
  }
  await audit(state.auditDirectory, {
    phase: 'verify-synchronized-dependencies',
    state: 'completed',
    initialized,
  });
  return { initialized, state: 'verified-pinned-clean-git-dependencies' };
}

/**
 * Resolve every selected immutable Git scope from official completed-sync markers.
 * Args:
 *   state (object): Exact owned source identity.
 *   entries (object): Official selected gclient entries parsed as literal data.
 *   revisions (object): Official selected Git commits recorded after successful sync.
 * Returns:
 *   object[]: Complete selected Git scopes with expected HTTPS origins and revisions.
 */
export function selectedSyncGitGraph(state, entries, revisions) {
  if (
    !entries ||
    !revisions ||
    Array.isArray(entries) ||
    Array.isArray(revisions) ||
    typeof entries !== 'object' ||
    typeof revisions !== 'object'
  )
    throw gateError('SOURCE_SYNC_MARKER_INVALID', 'Official sync markers are invalid.');
  const graph = [];
  // Selected Git entries require concrete immutable revisions within the bound source solution.
  for (const [scope, value] of Object.entries(entries)) {
    if (typeof value !== 'string' || !value.startsWith('https://')) continue;
    // Official CIPD entries use directory:package identities and a separate package service URL.
    if (scope.includes(':')) {
      const separator = scope.indexOf(':');
      const directory = scope.slice(0, separator);
      const packageName = scope.slice(separator + 1);
      const relativeDirectory = directory.slice(state.sourceName.length + 1);
      const packageUrl = new URL(value);
      if (
        !directory.startsWith(state.sourceName + '/') ||
        !/^[A-Za-z0-9_.+/-]+$/.test(relativeDirectory) ||
        relativeDirectory.split('/').some((part) => !part || part === '.' || part === '..') ||
        !packageName ||
        packageUrl.origin !== 'https://chrome-infra-packages.appspot.com' ||
        packageUrl.username ||
        packageUrl.password ||
        packageUrl.search ||
        packageUrl.hash ||
        Object.hasOwn(revisions, scope)
      )
        throw gateError(
          'SOURCE_SYNC_MARKER_INVALID',
          'CIPD entry requires a separate bounded official package scope.',
        );
      continue;
    }
    const root = scope === state.sourceName;
    const match = value.match(/^(https:\/\/[^\s?#]+)@([a-f0-9]{40})$/);
    if (!root && !match)
      throw gateError(
        'SOURCE_SYNC_MARKER_INVALID',
        'Selected Git entry requires an immutable revision.',
      );
    const origin = root ? value : match[1];
    const url = new URL(origin);
    const relative = root ? '' : scope.slice(state.sourceName.length + 1);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (!root &&
        (!scope.startsWith(state.sourceName + '/') ||
          !/^[A-Za-z0-9_.+/-]+$/.test(relative) ||
          relative.split('/').some((part) => !part || part === '.' || part === '..')))
    )
      throw gateError(
        'DEPENDENCY_SCOPE_REJECTED',
        'Selected Git scope requires a bounded source path.',
      );
    const revision = revisions[scope];
    if (
      typeof revision !== 'string' ||
      !/^[a-f0-9]{40}$/.test(revision) ||
      (root
        ? revision !== state.lock.upstreamCommit ||
          origin.replace(/\.git$/, '') !== state.sourceOrigin.replace(/\.git$/, '')
        : revision !== match[2])
    )
      throw gateError(
        'SOURCE_SYNC_MARKER_INVALID',
        'Selected Git scope differs from official completion metadata.',
      );
    graph.push({ scope, relative, origin, revision });
  }
  // Exact set equality prevents skipped or missing selected Git checkouts from passing hooks admission.
  if (
    !graph.some((entry) => entry.relative === '') ||
    graph.length !== Object.keys(revisions).length ||
    Object.keys(revisions).some((scope) => !graph.some((entry) => entry.scope === scope))
  )
    throw gateError(
      'SOURCE_SYNC_MARKER_INVALID',
      'Selected Git scope sets differ across completion markers.',
    );
  return graph;
}

/**
 * Parse and hash the official source configuration and completed dependency markers.
 * Args:
 *   state (object): Owned source with verified official isolated toolchain.
 * Returns:
 *   Promise<object>: Marker digests and complete selected immutable Git graph.
 */
async function syncMarkers(state) {
  const filenames = ['.gclient', '.gclient_entries', '.gclient_previous_sync_commits'];
  const contents = await Promise.all(
    filenames.map((name) => readFile(path.join(state.root, name))),
  );
  const relativePython = (
    await readFile(path.join(state.depotTools, 'python3_bin_reldir.txt'), 'utf8')
  ).trim();
  const python = path.resolve(
    state.depotTools,
    relativePython,
    process.platform === 'win32' ? 'python3.exe' : 'python3',
  );
  const relative = path.relative(state.depotTools, python);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw gateError(
      'TOOLCHAIN_PATH_REJECTED',
      'Official marker parser requires the pinned isolated interpreter.',
    );
  const program =
    "import json,pathlib,sys;sys.path.insert(0,sys.argv[1]);import gclient_eval;p=pathlib.Path(sys.argv[2]);d=gclient_eval.ParseLocalConfig(p.read_text(encoding='utf-8'),str(p));print(json.dumps(dict(d.get('entries',{}))))";
  const parsed = await runTool(
    python,
    ['-I', '-c', program, state.depotTools, path.join(state.root, '.gclient_entries')],
    {
      ...state,
      phase: 'parse-selected-sync-entries',
      cwd: state.root,
      timeoutMs: 30000,
      captureBytes: 1024 * 1024,
    },
  );
  const graph = selectedSyncGitGraph(
    state,
    JSON.parse(parsed.stdout),
    JSON.parse(contents[2].toString('utf8')),
  );
  // Detect marker edits across the isolated parser invocation before producing bound evidence.
  const current = await Promise.all(filenames.map((name) => readFile(path.join(state.root, name))));
  if (current.some((bytes, index) => sha256(bytes) !== sha256(contents[index])))
    throw gateError(
      'SOURCE_SYNC_MARKER_CHANGED',
      'Official sync markers changed during validation.',
    );
  return {
    graph,
    previousSyncCommits: contents[2].toString('utf8'),
    hashes: Object.fromEntries(filenames.map((name, index) => [name, sha256(contents[index])])),
  };
}

/**
 * Match append-only official successful-sync evidence against current source markers.
 * Args:
 *   state (object): Locked owned source and toolchain identity.
 *   receipt (object): Successful official synchronization receipt.
 *   hashes (object): Current source configuration and marker digests.
 * Returns:
 *   boolean: Whether hooks may use this exact completed-sync evidence.
 */
export function matchesSyncCompletion(state, receipt, hashes) {
  return (
    receipt?.schemaVersion === 1 &&
    receipt.purpose === 'completed-official-source-sync' &&
    receipt.upstreamCommit === state.lock.upstreamCommit &&
    receipt.depsSha256 === state.lock.depsSha256 &&
    receipt.depotToolsCommit === state.lock.depotToolsCommit &&
    receipt.sourceOrigin === state.sourceOrigin &&
    receipt.sourceName === state.sourceName &&
    receipt.host === process.platform + '-' + process.arch &&
    receipt.syncRevision === state.sourceName + '@' + state.lock.upstreamCommit &&
    receipt.noHooks === true &&
    receipt.toolEvidence?.state === 'completed' &&
    receipt.toolEvidence.phase === 'gclient-sync' &&
    receipt.toolEvidence.exitCode === 0 &&
    ['.gclient', '.gclient_entries', '.gclient_previous_sync_commits'].every(
      (name) =>
        typeof hashes[name] === 'string' &&
        /^[a-f0-9]{64}$/.test(hashes[name]) &&
        receipt.markerHashes?.[name] === hashes[name],
    )
  );
}

/**
 * Verify every selected Git checkout and require matching official exit-zero sync evidence.
 * Args:
 *   state (object): Exact owned source and pinned toolchain context.
 * Returns:
 *   Promise<object>: Completed synchronization receipt and verified selected checkout count.
 */
async function verifySyncCompletion(state) {
  const markers = await syncMarkers(state);
  const candidates = (await readdir(state.auditDirectory))
    .filter((name) => /^sync-complete-\d+\.json$/.test(name))
    .sort()
    .reverse();
  let receipt;
  // Historical receipts remain intact; only a current exact marker and host match is admitted.
  for (const name of candidates) {
    const candidate = JSON.parse(await readFile(path.join(state.auditDirectory, name), 'utf8'));
    if (matchesSyncCompletion(state, candidate, markers.hashes)) {
      receipt = candidate;
      break;
    }
  }
  if (!receipt)
    throw gateError(
      'SOURCE_SYNC_COMPLETION_REQUIRED',
      'Exact official successful-sync evidence is required.',
    );
  for (const entry of markers.graph) {
    const directory = path.join(state.source, entry.relative);
    if (!(await exists(path.join(directory, '.git'))))
      throw gateError(
        'SELECTED_DEPENDENCY_MISSING',
        'An official selected Git checkout is absent.',
      );
    // The parent source is independently checked for original or verified patched identity.
    if (!entry.relative) continue;
    await verifyDependencyOrigin(state, entry.relative, entry.origin);
    const head = await git(
      state,
      ['rev-parse', 'HEAD'],
      'verify-selected-dependency-head',
      directory,
    );
    const dirty = await git(
      state,
      ['status', '--porcelain', '--untracked-files=normal'],
      'verify-selected-dependency-clean',
      directory,
    );
    if (head !== entry.revision || dirty)
      throw gateError(
        'SELECTED_DEPENDENCY_MISMATCH',
        'Selected Git checkout differs from completed synchronization.',
      );
  }
  const current = await syncMarkers(state);
  if (!matchesSyncCompletion(state, receipt, current.hashes))
    throw gateError(
      'SOURCE_SYNC_MARKER_CHANGED',
      'Official sync markers changed during checkout validation.',
    );
  return {
    receipt,
    selectedGitCheckouts: markers.graph.length,
    previousSyncCommits: markers.previousSyncCommits,
    cipdEvidence: 'official-exit-zero-and-bound-selected-markers',
  };
}

/**
 * Run official hooks after exact successful-sync, selected graph, and native toolchain admission.
 * Args:
 *   state (object): Verified owned source with completed official synchronization evidence.
 * Returns:
 *   Promise<object>: Concrete official hooks completion receipt.
 */
export async function hooks(state) {
  await requireOwnership(state);
  await verifyDepotTools(state);
  const source = await verifySource(state);
  const completion = await verifySyncCompletion(state);
  // Initialized checkout counts supplement the complete selected graph and immutable marker evidence.
  const dependencies = await verifySynchronizedDependencies(state);
  const prerequisites = await requirePreflight(state, 'hooks');
  // The pinned gclient writes its inherited previous-sync metadata after runhooks as well as sync.
  const hookEnvironment = {
    ...state.env,
    GCLIENT_PREVIOUS_SYNC_COMMITS: completion.previousSyncCommits,
  };
  const toolResult = await runTool(toolPath(state, 'gclient'), ['runhooks'], {
    ...state,
    env: hookEnvironment,
    phase: 'gclient-hooks',
    diskReserveRoot: state.root,
    minimumFreeDiskGiB: 20,
    cwd: state.root,
  });
  await verifySource(state);
  const afterMarkers = await syncMarkers(state);
  if (!matchesSyncCompletion(state, completion.receipt, afterMarkers.hashes))
    throw gateError('SOURCE_SYNC_MARKER_CHANGED', 'Official sync evidence changed during hooks.');
  const receipt = {
    schemaVersion: 1,
    ...source,
    dependencies,
    selectedGitCheckouts: completion.selectedGitCheckouts,
    cipdEvidence: completion.cipdEvidence,
    syncCompletedAt: completion.receipt.completedAt,
    depotToolsCommit: state.lock.depotToolsCommit,
    prerequisites,
    toolEvidence: safeToolEvidence(toolResult),
    hooksCompletedAt: new Date().toISOString(),
  };
  await writeArtifact(path.join(state.auditDirectory, 'hooks-' + Date.now() + '.json'), receipt);
  return receipt;
}

/**
 * Retain official tool completion metadata while excluding captured raw parser output.
 * Args:
 *   result (object): Audited runTool result with optional bounded raw stdout.
 * Returns:
 *   object: Safe phase, return code, duration, byte counts, and diagnostic digests.
 */
function safeToolEvidence(result) {
  const evidence = { ...result };
  delete evidence.stdout;
  return evidence;
}

/**
 * Verify official depot_tools source identity before executing isolated Python wrappers.
 * Args:
 *   state (object): Official pinned toolchain context.
 * Returns:
 *   Promise<void>: Successful origin, commit, and clean-source checks.
 */
async function verifyDepotTools(state) {
  if (!state.lock.depotToolsCommit)
    throw gateError(
      'DEPOT_TOOLS_PIN_REQUIRED',
      'Record a verified official depot_tools commit before tool execution.',
    );
  const origin = await git(
    state,
    ['remote', 'get-url', 'origin'],
    'verify-depot-tools-origin',
    state.depotTools,
  );
  const head = await git(state, ['rev-parse', 'HEAD'], 'verify-depot-tools-head', state.depotTools);
  const dirty = await git(
    state,
    ['status', '--porcelain', '--untracked-files=no'],
    'verify-depot-tools-clean',
    state.depotTools,
  );
  if (origin !== state.lock.depotToolsRepository || head !== state.lock.depotToolsCommit || dirty)
    throw gateError(
      'DEPOT_TOOLS_PIN_MISMATCH',
      'Official depot_tools origin, commit, or tracked state differs from the lock.',
    );
}

/**
 * Bootstrap generated Windows tool wrappers from the exact pinned official source.
 * Args:
 *   state (object): Verified official depot_tools source and private process environment.
 * Returns:
 *   Promise<void>: Available git.bat wrapper without updating the repository commit.
 */
async function ensureWindowsBootstrap(state) {
  // Other native platforms retain their separate official tool bootstrap paths.
  if (process.platform !== 'win32' || (await exists(path.join(state.depotTools, 'git.bat'))))
    return;
  await verifyDepotTools(state);
  await runTool(path.join(state.depotTools, 'bootstrap', 'win_tools.bat'), [], {
    ...state,
    phase: 'bootstrap-windows-wrappers',
    cwd: state.depotTools,
  });
  // The generated wrapper is required by the pinned gclient git_cache implementation.
  if (!(await exists(path.join(state.depotTools, 'git.bat'))))
    throw gateError(
      'OFFICIAL_GIT_WRAPPER_MISSING',
      'Official Windows bootstrap did not create the required git.bat wrapper.',
    );
  await verifyDepotTools(state);
}

/**
 * Synchronize exact DEPS and run official hooks after all ownership and toolchain gates.
 * Args:
 *   state (object): Complete native source preparation context.
 *   jobs (number): Explicit bounded dependency synchronization concurrency.
 * Returns:
 *   Promise<object>: Concrete synchronized dependency receipt.
 */
export async function sync(state, jobs = 8) {
  // Dependency synchronization uses finite declared concurrency for source-volume safety.
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64)
    throw gateError(
      'INVALID_SYNC_ARGUMENT',
      'Use bounded positive dependency synchronization concurrency.',
    );
  await requireOwnership(state);
  await verifyDepotTools(state);
  await ensureWindowsBootstrap(state);
  const source = await verifySource(state, 'original', true, 'sync-resume');
  // Existing exact owned source uses fresh native gates with a live monitored tool-phase reserve.
  await requirePreflight(state, 'source-sync');
  // Existing separately prepared source repositories receive a controlled gclient solution.
  if (!(await exists(path.join(state.root, '.gclient'))))
    await runTool(
      toolPath(state, 'gclient'),
      ['config', '--name=' + state.sourceName, '--unmanaged', state.sourceOrigin],
      {
        ...state,
        phase: 'gclient-config',
        cwd: state.root,
      },
    );
  const toolEvidence = await runTool(
    toolPath(state, 'gclient'),
    [
      'sync',
      '--nohooks',
      '--no-history',
      '--jobs=' + jobs,
      '--revision',
      state.sourceName + '@' + state.lock.upstreamCommit,
    ],
    {
      ...state,
      phase: 'gclient-sync',
      cwd: state.root,
      diskReserveRoot: state.root,
      minimumFreeDiskGiB: 20,
    },
  );
  // Official exit-zero synchronization binds the complete selected graph and actual marker bytes.
  await verifySource(state);
  const markers = await syncMarkers(state);
  const completion = {
    schemaVersion: 1,
    purpose: 'completed-official-source-sync',
    upstreamCommit: state.lock.upstreamCommit,
    depsSha256: state.lock.depsSha256,
    depotToolsCommit: state.lock.depotToolsCommit,
    sourceOrigin: state.sourceOrigin,
    sourceName: state.sourceName,
    host: process.platform + '-' + process.arch,
    syncRevision: state.sourceName + '@' + state.lock.upstreamCommit,
    noHooks: true,
    markerHashes: markers.hashes,
    selectedGitCheckouts: markers.graph.length,
    toolEvidence: safeToolEvidence(toolEvidence),
    completedAt: new Date().toISOString(),
  };
  await writeArtifact(
    path.join(state.auditDirectory, 'sync-complete-' + Date.now() + '.json'),
    completion,
  );
  const completedHooks = await hooks(state);
  const receipt = {
    schemaVersion: 1,
    ...source,
    dependencies: completedHooks.dependencies,
    selectedGitCheckouts: completedHooks.selectedGitCheckouts,
    hooksCompletedAt: completedHooks.hooksCompletedAt,
    depotToolsCommit: state.lock.depotToolsCommit,
    synchronizedAt: new Date().toISOString(),
  };
  await writeArtifact(path.join(state.auditDirectory, 'sync-' + Date.now() + '.json'), receipt);
  return receipt;
}

/**
 * Verify patch file containment, SHA-256, and declared browser-layer modification scope.
 * Args:
 *   lock (object): Exact patch manifest from VERSION.lock.
 * Returns:
 *   Promise<string[]>: Verified mailbox patch paths in application order.
 */
export async function verifyPatches(lock) {
  const files = [];
  // Patch application follows the committed ordered manifest only.
  for (const patch of lock.patches) {
    if (
      !/^patches\/[a-zA-Z0-9_.-]+\.patch$/.test(patch.file) ||
      !/^[a-f0-9]{64}$/.test(patch.sha256) ||
      patch.scope !== 'browser-readonly' ||
      !Array.isArray(patch.allowedPaths) ||
      !patch.allowedPaths.length
    )
      throw gateError(
        'INVALID_PATCH_MANIFEST',
        'Every patch requires a locked hash and explicit readonly browser scope.',
      );
    const filename = path.join(CHROMIUM_ROOT, patch.file);
    const content = await readFile(filename);
    if (sha256(content) !== patch.sha256)
      throw gateError(
        'PATCH_CHECKSUM_MISMATCH',
        'Patch contents differ from the committed digest.',
      );
    const modified = [
      ...content.toString('utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
    ].flatMap((match) => [match[1], match[2]]);
    if (
      !modified.length ||
      modified.some(
        (name) =>
          !name.startsWith('chrome/') ||
          name.startsWith('chrome/renderer/') ||
          !patch.allowedPaths.some(
            (allowed) => name === allowed || (allowed.endsWith('/') && name.startsWith(allowed)),
          ),
      )
    )
      throw gateError(
        'PATCH_SCOPE_REJECTED',
        'Patch changes files outside its declared readonly browser layer.',
      );
    files.push(filename);
  }
  return files;
}

/**
 * Apply verified mailbox patches using git am three-way conflict handling.
 * Args:
 *   state (object): Owned clean exact upstream source checkout.
 * Returns:
 *   Promise<object>: Applied commit and patchset receipt.
 */
export async function applyPatches(state) {
  await requireOwnership(state);
  await verifySource(state);
  const files = await verifyPatches(state.lock);
  if (!files.length)
    throw gateError(
      'PATCHSET_EMPTY',
      'Create and verify a readonly observer patch before patched-source application.',
    );
  // A conflict stops the phase and leaves git state available for explicit review.
  await git(
    state,
    ['am', '--3way', ...files],
    'apply-readonly-patchset',
    state.source,
    state.timeoutMs,
  );
  const head = await git(state, ['rev-parse', 'HEAD'], 'verify-applied-head', state.source);
  const receipt = {
    schemaVersion: 1,
    upstreamCommit: state.lock.upstreamCommit,
    head,
    patchsetSha256: sha256(JSON.stringify(state.lock.patches)),
    appliedAt: new Date().toISOString(),
  };
  await writeArtifact(path.join(state.auditDirectory, 'applied-patches.json'), receipt);
  return receipt;
}

/**
 * Generate and build an original or patched native Chromium output directory.
 * Args:
 *   state (object): Verified owned source and official native toolchain context.
 *   variant (string): Original or patched build identity.
 *   jobs (number): Explicit bounded local build concurrency.
 * Returns:
 *   Promise<object>: Concrete binary hash, source, GN, and toolchain manifest after a completed build.
 */
export async function build(state, variant, jobs) {
  if (
    !['original', 'patched'].includes(variant) ||
    !Number.isInteger(jobs) ||
    jobs < 1 ||
    jobs > 64
  )
    throw gateError(
      'INVALID_BUILD_ARGUMENT',
      'Use a declared variant and bounded local concurrency.',
    );
  await requireOwnership(state);
  await verifyDepotTools(state);
  const source = await verifySource(state, variant);
  await verifySyncCompletion(state);
  const prerequisites = await requirePreflight(state, 'build-output', variant);
  const output = path.join('out', variant === 'original' ? 'ABROriginal' : 'ABRPatched');
  const cpu = process.arch === 'arm64' ? 'arm64' : 'x64';
  const variantArguments = variant === 'patched' ? (state.lock.patchedBuildArguments ?? []) : [];
  const argumentsText =
    [...state.lock.buildArguments, ...variantArguments, 'target_cpu="' + cpu + '"'].join('\n') +
    '\n';
  // GN configuration is a file so batch wrappers never receive quoted shell expressions.
  await writeArtifact(
    path.join(state.auditDirectory, 'gn-' + variant + '-' + Date.now() + '.json'),
    { schemaVersion: 1, variant, arguments: argumentsText },
  );
  const outputDirectory = path.join(state.source, output);
  await mkdir(outputDirectory, { recursive: true });
  const argumentFile = path.join(outputDirectory, 'args.gn');
  // Resumed builds reuse the identical locked configuration and reject altered arguments.
  if (await exists(argumentFile)) {
    if ((await readFile(argumentFile, 'utf8')) !== argumentsText)
      throw gateError('GN_ARGUMENTS_MISMATCH', 'Existing output uses different GN arguments.');
  } else await writeFile(argumentFile, argumentsText, { flag: 'wx' });
  await runTool(toolPath(state, 'gn'), ['gen', output], {
    ...state,
    phase: 'gn-generate-' + variant,
    cwd: state.source,
  });
  await runTool(toolPath(state, 'autoninja'), ['-C', output, '-j', String(jobs), 'chrome'], {
    ...state,
    phase: 'compile-chromium-' + variant,
    diskReserveRoot: state.root,
    minimumFreeDiskGiB: 20,
    cwd: state.source,
    timeoutMs: state.timeoutMs,
  });
  const binary =
    process.platform === 'win32'
      ? 'chrome.exe'
      : process.platform === 'darwin'
        ? path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium')
        : 'chrome';
  const binaryPath = path.join(state.source, output, binary);
  const manifest = {
    schemaVersion: 1,
    state: 'compiled',
    variant,
    ...source,
    upstreamTag: state.lock.upstreamTag,
    depotToolsCommit: state.lock.depotToolsCommit,
    playwrightVersion: state.lock.playwrightVersion,
    playwrightCompatibility: 'pending-same-build-smoke',
    patchsetVersion: state.lock.patchsetVersion,
    patches: state.lock.patches,
    prerequisites,
    gnArguments: argumentsText,
    binarySha256: sha256(await readFile(binaryPath)),
    outputAllocatedBytes: await allocatedOutputBytes(state, outputDirectory),
    binaryRelativePath: path.join(output, binary),
    compiledAt: new Date().toISOString(),
    validation: {
      compatibleSmoke: 'pending',
      manualGuiParity: 'pending',
      nativeObserver: 'pending',
      securityReview: 'pending',
      signedRelease: 'pending',
    },
  };
  await writeArtifact(
    path.join(state.auditDirectory, 'build-' + variant + '-' + Date.now() + '.json'),
    manifest,
  );
  return manifest;
}

/**
 * Dispatch one explicit preparation or build command and report key/total duration.
 * Args:
 *   argv (string[]): Explicit pipeline command arguments.
 * Returns:
 *   Promise<void>: Completed audited phase with machine-readable stdout result.
 */
export async function main(argv = process.argv.slice(2)) {
  const started = performance.now();
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'checkout-root': { type: 'string' },
      'source-dir': { type: 'string' },
      'source-origin': { type: 'string' },
      lock: { type: 'string' },
      variant: { type: 'string' },
      jobs: { type: 'string' },
      'timeout-seconds': { type: 'string' },
    },
  });
  const command = parsed.positionals[0];
  // Every command has a closed action name and exactly one positional command.
  if (
    parsed.positionals.length !== 1 ||
    ![
      'status',
      'preflight',
      'verify-upstream',
      'verify-depot-tools',
      'verify-source',
      'verify-patches',
      'adopt',
      'checkout',
      'sync',
      'hooks',
      'apply-patches',
      'build',
    ].includes(command)
  )
    throw gateError(
      'INVALID_COMMAND',
      'Select an explicit status, verification, source, synchronization, patch, or build command.',
    );
  if (
    parsed.values['timeout-seconds'] &&
    (!/^\d+$/.test(parsed.values['timeout-seconds']) ||
      Number(parsed.values['timeout-seconds']) < 10 ||
      Number(parsed.values['timeout-seconds']) > 86400)
  )
    throw gateError('INVALID_TIMEOUT', 'Tool deadlines must be between 10 and 86400 seconds.');
  const state = await context(parsed.values);
  // Audit only safe operation identifiers, versions, codes, and durations.
  try {
    let result;
    if (command === 'status')
      result = {
        schemaVersion: 1,
        upstreamTag: state.lock.upstreamTag,
        upstreamCommit: state.lock.upstreamCommit,
        sourceOrigin: state.sourceOrigin,
        verification: state.lock.verification,
        sourcePresent: await exists(path.join(state.source, '.git')),
        depotToolsPinned: Boolean(state.lock.depotToolsCommit),
        depsPinned: Boolean(state.lock.depsSha256),
        patches: state.lock.patches.length,
        sourceBuild: 'pending-verified-manifest',
      };
    else if (command === 'preflight') result = await preflight(state);
    else if (command === 'verify-upstream') result = await verifyUpstream(state);
    else if (command === 'verify-depot-tools') result = await verifyDepotToolsMetadata(state);
    else if (command === 'verify-source')
      result = await verifySource(state, parsed.values.variant ?? 'original', false);
    else if (command === 'verify-patches')
      result = { schemaVersion: 1, verifiedPatches: (await verifyPatches(state.lock)).length };
    else if (command === 'adopt') result = await adopt(state);
    else if (command === 'checkout') result = await checkout(state);
    else if (command === 'sync') result = await sync(state, Number(parsed.values.jobs ?? '8'));
    else if (command === 'hooks') result = await hooks(state);
    else if (command === 'apply-patches') result = await applyPatches(state);
    else
      result = await build(
        state,
        parsed.values.variant ?? 'original',
        Number(parsed.values.jobs ?? '8'),
      );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    await audit(state.auditDirectory, {
      phase: command,
      state: 'failed',
      code: error.code ?? 'PIPELINE_FAILED',
    });
    throw error;
  } finally {
    await audit(state.auditDirectory, {
      phase: 'pipeline-total',
      command,
      durationMs: performance.now() - started,
    });
  }
}

// The explicit module entry point keeps imports free of source or toolchain mutations.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        code: error.code ?? 'PIPELINE_FAILED',
        message: error.code ? error.message : 'Inspect the failed pipeline phase metadata.',
      }) + '\n',
    );
    process.exitCode = 1;
  });
}
