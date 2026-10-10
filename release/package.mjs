// -*- coding: utf-8 -*-
/**
 * package.mjs
 * Unsigned development release packaging
 * =====================
 * Deploy production dependencies and package pinned runtimes with source manifests and SBOM.
 */
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  ReleaseError,
  canonicalJson,
  cleanTemporary,
  command,
  corepackScript,
  fail,
  fileSha256,
  inside,
  isMain,
  linkMember,
  regularFiles,
  report,
  sha256,
  temporaryRoot,
} from './common.mjs';
import { inventory, validateManifest } from './manifest.mjs';
import { createSbom } from './sbom.mjs';
import { writeZip } from './zip.mjs';

const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read actual workspace package identities without generated deployment paths.
 * Args:
 *   workspace (string): Source repository root.
 * Returns:
 *   Promise<Map>: Workspace names, source folders, and exact declared manifests.
 */
async function workspacePackages(workspace) {
  const output = new Map();
  const folders = [
    'contracts',
    ...(await readdir(path.join(workspace, 'packages'))).map((name) => `packages/${name}`),
  ];
  for (const folder of folders) {
    const manifest = JSON.parse(
      await readFile(path.join(workspace, folder, 'package.json'), 'utf8'),
    );
    output.set(manifest.name, { folder, manifest });
  }
  return output;
}

/**
 * Rewrite owned workspace dependency metadata into portable exact versions.
 * Args:
 *   manifest (object): Authored workspace manifest.
 *   packages (Map): Exact workspace package identities.
 * Returns:
 *   object: Portable runtime-only manifest.
 */
function portableManifest(manifest, packages) {
  const result = { ...manifest, scripts: {}, devDependencies: {} };
  result.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, version]) => [
      name,
      version.startsWith('workspace:') ? packages.get(name).manifest.version : version,
    ]),
  );
  return result;
}

/**
 * Remove only exclusively staged development metadata from one deployment subtree.
 * Args:
 *   root (string): Exclusive temporary deployment root.
 *   member (string): Controlled relative subtree selected by the packager.
 * Returns:
 *   Promise<void>: Completion of scoped staging cleanup.
 */
async function removeStaged(root, member) {
  const filename = inside(root, member);
  const metadata = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return;
  if (metadata.isSymbolicLink())
    throw new ReleaseError('UNSAFE_PACKAGE', 'Staging metadata contains a redirected path.');
  const resolved = await realpath(filename);
  const relative = path.relative(await realpath(root), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new ReleaseError('UNSAFE_CLEANUP', 'Staging cleanup target is outside its allocation.');
  await rm(resolved, { recursive: metadata.isDirectory() });
}

/**
 * Copy a trusted runtime asset tree while resolving internal links within its root.
 * Args:
 *   source (string): Trusted existing browser/runtime directory.
 *   destination (string): Exclusive payload directory.
 *   boundary (string): Original real source root.
 *   ancestors (Set): Current real-directory traversal identities.
 * Returns:
 *   Promise<void>: Portable regular-file asset copy.
 */
async function copyAssets(source, destination, boundary = undefined, ancestors = new Set()) {
  const resolved = await realpath(source);
  boundary ??= resolved;
  const relative = path.relative(boundary, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || ancestors.has(resolved))
    throw new ReleaseError(
      'UNSAFE_PACKAGE',
      'Asset links escape their source root or contain a cycle.',
    );
  const original = await lstat(source);
  // Preserve framework alias identities so the original signed application seal remains intact.
  if (original.isSymbolicLink()) {
    const target = await readlink(source);
    linkMember(path.relative(boundary, source).split(path.sep).join('/'), target);
    await symlink(target, destination, (await lstat(resolved)).isDirectory() ? 'dir' : 'file');
    return;
  }
  const metadata = await lstat(resolved);
  if (metadata.isFile()) {
    await copyFile(resolved, destination);
    return;
  }
  if (!metadata.isDirectory())
    throw new ReleaseError('UNSAFE_PACKAGE', 'Runtime asset type is unsupported.');
  await mkdir(destination, { mode: metadata.mode & 0o777 });
  const seen = new Set([...ancestors, resolved]);
  for (const name of await readdir(resolved))
    await copyAssets(path.join(resolved, name), path.join(destination, name), boundary, seen);
}

/**
 * Fetch the pinned public Node license with bounded retries and validated status.
 * Args:
 *   version (string): Exact installed Node version.
 * Returns:
 *   Promise<Buffer>: Node distribution license text.
 */
async function nodeLicense(version) {
  const url = `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      report('release-license-request', {
        host: 'raw.githubusercontent.com',
        attempt: attempt + 1,
      });
      const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok) throw new Error('License request failed.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 2 * 1024 * 1024)
        throw new Error('License size is invalid.');
      report('release-license-response', { status: response.status, bytes: bytes.length });
      return bytes;
    } catch {
      report('release-license-request-failed', { attempt: attempt + 1 });
    }
  }
  throw new ReleaseError('LICENSE_UNAVAILABLE', 'Pinned Node distribution license is unavailable.');
}

/**
 * Locate the installed official Playwright headed Chromium revision without launch.
 * Args:
 *   workspace (string): Source dependency installation root.
 * Returns:
 *   Promise<object>: Verified existing cache folder and declared browser metadata.
 */
async function bundledBrowser(workspace) {
  const require = createRequire(
    path.join(workspace, 'packages', 'playwright-worker', 'package.json'),
  );
  const { chromium } = require('playwright');
  const metadataRequire = createRequire(require.resolve('playwright/package.json'));
  const metadata = JSON.parse(
    await readFile(
      path.join(
        path.dirname(metadataRequire.resolve('playwright-core/package.json')),
        'browsers.json',
      ),
      'utf8',
    ),
  );
  const browser = metadata.browsers.find((entry) => entry.name === 'chromium');
  let folder = path.dirname(chromium.executablePath());
  while (path.dirname(folder) !== folder && !path.basename(folder).startsWith('chromium-'))
    folder = path.dirname(folder);
  if (path.basename(folder) !== `chromium-${browser.revision}`)
    throw new ReleaseError(
      'BROWSER_ASSET_INVALID',
      'Installed Playwright browser revision is unsupported.',
    );
  const cache = path.dirname(folder);
  const auxiliary = [];
  for (const item of metadata.browsers.filter((entry) =>
    ['ffmpeg', 'winldd', 'chromium-headless-shell'].includes(entry.name),
  )) {
    const directory = `${item.name.replaceAll('-', '_')}-${item.revision}`;
    const source = path.join(cache, directory);
    if (
      await lstat(source)
        .then((value) => value.isDirectory())
        .catch(() => false)
    )
      auxiliary.push({ name: item.name, revision: item.revision, directory, source });
  }
  if (process.platform === 'win32' && !auxiliary.some((item) => item.name === 'winldd'))
    throw new ReleaseError(
      'BROWSER_ASSET_INVALID',
      'Official Windows browser dependency verifier is missing.',
    );
  return { folder, version: browser.browserVersion, revision: browser.revision, auxiliary };
}

/**
 * Hash production source and build control files without executing build commands.
 * Args:
 *   workspace (string): Repository root.
 *   packages (Map | undefined): Optional already-read workspace package descriptors.
 * Returns:
 *   Promise<string>: Deterministic source and build-control SHA256.
 */
export async function sourceFingerprint(workspace, packages = undefined) {
  packages ??= await workspacePackages(workspace);
  const inputs = [];
  // Bind dependency resolution, compiler settings, toolchain pins, and runtime defaults to review.
  const controls = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'Cargo.toml',
    'Cargo.lock',
    '.node-version',
    'rust-toolchain.toml',
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.tests.json',
    'vitest.config.ts',
    'eslint.config.js',
    'native/desktop-agent/Cargo.toml',
    'native/desktop-agent/build.rs',
    '.cargo/config',
    '.cargo/config.toml',
    'native/desktop-agent/.cargo/config',
    'native/desktop-agent/.cargo/config.toml',
    '.npmrc',
    '.pnpmfile.cjs',
    'pnpmfile.cjs',
    'scripts/check-boundaries.mjs',
    'config/abr.config.example.yaml',
    '.github/workflows/check.yml',
    '.github/workflows/release.yml',
  ];
  for (const member of controls) {
    const filename = inside(workspace, member);
    const metadata = await lstat(filename).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    // Optional build hooks enter the fingerprint when present and reject redirected source paths.
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new ReleaseError('UNSAFE_PACKAGE', 'Build control file type is invalid.');
    inputs.push({ path: member, sha256: await fileSha256(filename) });
  }
  // Fingerprint production source and native code separately from ignored downloads and user data.
  for (const item of packages.values()) {
    const sourceRoot = path.join(workspace, item.folder);
    for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /(?:\.ts$|\.schema\.json$|^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$|^mcp-tools\.json$|^package\.json$)/.test(
          entry.name,
        )
      )
        inputs.push({
          path: `${item.folder}/${entry.name}`,
          sha256: await fileSha256(path.join(sourceRoot, entry.name)),
        });
      else if (entry.isDirectory() && entry.name === 'src')
        for (const file of await regularFiles(path.join(sourceRoot, 'src')))
          inputs.push({
            path: `${item.folder}/src/${file.path}`,
            sha256: await fileSha256(path.join(sourceRoot, 'src', ...file.path.split('/'))),
          });
    }
  }
  for (const file of await regularFiles(path.join(workspace, 'native', 'desktop-agent', 'src')))
    inputs.push({
      path: `native/desktop-agent/src/${file.path}`,
      sha256: await fileSha256(
        path.join(workspace, 'native', 'desktop-agent', 'src', ...file.path.split('/')),
      ),
    });
  for (const name of ['bridge', 'patches', 'build']) {
    const directory = path.join(workspace, 'chromium', name);
    for (const file of await regularFiles(directory))
      inputs.push({
        path: `chromium/${name}/${file.path}`,
        sha256: await fileSha256(path.join(directory, ...file.path.split('/'))),
      });
  }
  inputs.push({
    path: 'chromium/VERSION.lock',
    sha256: await fileSha256(path.join(workspace, 'chromium', 'VERSION.lock')),
  });
  for (const file of await regularFiles(TOOL_ROOT))
    inputs.push({
      path: `release/${file.path}`,
      sha256: await fileSha256(path.join(TOOL_ROOT, ...file.path.split('/'))),
    });
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  return sha256(canonicalJson(inputs));
}

/**
 * Collect source fingerprints and committed toolchain identities for packaging.
 * Args:
 *   workspace (string): Repository root.
 *   packages (Map): Workspace package descriptors.
 * Returns:
 *   Promise<object>: Code/build fingerprint, git state, and actual toolchain metadata.
 */
async function sourceMetadata(workspace, packages) {
  const codeSha256 = await sourceFingerprint(workspace, packages);
  let gitCommit = null;
  let gitDirty = true;
  try {
    gitCommit = (
      await command('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
        label: 'release-source-commit',
      })
    ).trim();
    gitDirty = Boolean(
      (
        await command('git', ['status', '--porcelain'], {
          cwd: workspace,
          label: 'release-source-status',
        })
      ).trim(),
    );
  } catch {
    report('release-git-unavailable');
  }
  const rootPackage = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  const nodeVersion = (await readFile(path.join(workspace, '.node-version'), 'utf8')).trim();
  const rustVersion = /^channel = "([^"]+)"$/m.exec(
    await readFile(path.join(workspace, 'rust-toolchain.toml'), 'utf8'),
  )?.[1];
  if (
    nodeVersion !== process.versions.node ||
    !rustVersion ||
    rootPackage.packageManager !== 'pnpm@12.10.1'
  )
    throw new ReleaseError(
      'TOOLCHAIN_MISMATCH',
      'Release toolchain differs from committed exact versions.',
    );
  return {
    codeSha256,
    gitCommit,
    gitDirty,
    nodeVersion,
    rustVersion,
    pnpmVersion: rootPackage.packageManager.slice(5),
    typescriptVersion: rootPackage.devDependencies.typescript,
    version: rootPackage.version,
  };
}

/**
 * Build an unsigned development archive from actual host-platform artifacts.
 * Args:
 *   options (object): Workspace, output directory, native artifact, and browser choice.
 * Returns:
 *   Promise<object>: Produced archive basename, digest, and component counts.
 */
export async function packageDevelopment(options = {}) {
  const started = performance.now();
  const workspace = path.resolve(options.workspace ?? path.join(TOOL_ROOT, '..'));
  const packages = await workspacePackages(workspace);
  const source = await sourceMetadata(workspace, packages);
  const temporary = await temporaryRoot('package');
  const payload = path.join(temporary, 'payload');
  await mkdir(payload, { mode: 0o700 });
  try {
    await command(process.execPath, [corepackScript(), 'pnpm', 'build'], {
      cwd: workspace,
      label: 'release-typescript-build',
    });
    const app = path.join(payload, 'app');
    await command(
      process.execPath,
      [
        corepackScript(),
        'pnpm',
        '--filter',
        '@abr/cli',
        'deploy',
        '--prod',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--node-linker',
        'hoisted',
        app,
      ],
      { cwd: workspace, label: 'release-production-deploy' },
    );
    const owned = path.join(app, 'node_modules', '@abr');
    // Retain compiled runtime files and canonical JSON contracts in owned workspace packages.
    for (const name of await readdir(owned)) {
      const folder = path.join(owned, name);
      const item = packages.get(`@abr/${name}`);
      if (!item)
        throw new ReleaseError(
          'UNSAFE_PACKAGE',
          'Deployment contains an unknown workspace package.',
        );
      for (const entry of await readdir(folder))
        if (
          entry !== 'dist' &&
          entry !== 'package.json' &&
          !(name === 'contracts' && (entry.endsWith('.schema.json') || entry === 'mcp-tools.json'))
        )
          await removeStaged(payload, `app/node_modules/@abr/${name}/${entry}`);
      await writeFile(
        path.join(folder, 'package.json'),
        `${canonicalJson(portableManifest(item.manifest, packages))}\n`,
      );
    }
    await mkdir(path.join(app, 'packages', 'cli'), { recursive: true });
    await cp(
      path.join(workspace, 'packages', 'cli', 'dist'),
      path.join(app, 'packages', 'cli', 'dist'),
      { recursive: true },
    );
    await writeFile(
      path.join(app, 'packages', 'cli', 'package.json'),
      `${canonicalJson(portableManifest(packages.get('@abr/cli').manifest, packages))}\n`,
    );
    for (const entry of await readdir(app))
      if (!['node_modules', 'packages', 'package.json'].includes(entry))
        await removeStaged(payload, `app/${entry}`);
    for (const entry of ['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.pnpm'])
      await removeStaged(payload, `app/node_modules/${entry}`);
    const appManifest = portableManifest(packages.get('@abr/cli').manifest, packages);
    appManifest.bin = { abr: './packages/cli/dist/main.js' };
    appManifest.exports = { '.': './packages/cli/dist/index.js' };
    await writeFile(path.join(app, 'package.json'), `${canonicalJson(appManifest)}\n`);
    // Preserve the Native upstream identity at the same portable root used by the CLI assembly.
    const versionLockMember = 'app/chromium/VERSION.lock';
    await mkdir(path.join(app, 'chromium'));
    await copyFile(
      path.join(workspace, 'chromium', 'VERSION.lock'),
      inside(payload, versionLockMember),
    );
    await mkdir(path.join(payload, 'runtime'));
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    await copyFile(process.execPath, path.join(payload, 'runtime', nodeName));
    await mkdir(path.join(payload, 'licenses'));
    await writeFile(
      path.join(payload, 'licenses', 'node-LICENSE'),
      await nodeLicense(source.nodeVersion),
    );
    let browser;
    if (!options.excludeBrowser) {
      browser = await bundledBrowser(workspace);
      await mkdir(path.join(payload, 'browsers'));
      await copyAssets(
        browser.folder,
        path.join(payload, 'browsers', path.basename(browser.folder)),
      );
      await removeStaged(
        payload,
        `browsers/${path.basename(browser.folder)}/DEPENDENCIES_VALIDATED`,
      );
      for (const item of browser.auxiliary) {
        await copyAssets(item.source, path.join(payload, 'browsers', item.directory));
        await removeStaged(payload, `browsers/${item.directory}/DEPENDENCIES_VALIDATED`);
      }
    }
    let nativeAgentIncluded = false;
    let nativeAgentMember = null;
    let nativeAgentSha256 = null;
    if (options.nativeAgent) {
      const expectedName =
        process.platform === 'win32' ? 'abr-desktop-agent.exe' : 'abr-desktop-agent';
      const nativeFile = path.resolve(options.nativeAgent);
      if (!(await lstat(nativeFile)).isFile() || path.basename(nativeFile) !== expectedName)
        throw new ReleaseError('NATIVE_ASSET_INVALID', 'Desktop agent artifact is invalid.');
      const doctor = JSON.parse(
        await command(nativeFile, ['--doctor'], {
          cwd: workspace,
          label: 'release-native-doctor',
          timeoutMs: 15000,
        }),
      );
      if (
        doctor.platform !==
          { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ||
        doctor.schemaVersion !== 1
      )
        throw new ReleaseError(
          'NATIVE_ASSET_INVALID',
          'Desktop agent platform or protocol differs from the bundle.',
        );
      await mkdir(path.join(app, 'bin'));
      await copyFile(nativeFile, path.join(app, 'bin', expectedName));
      nativeAgentIncluded = true;
      nativeAgentMember = `app/bin/${expectedName}`;
      nativeAgentSha256 = await fileSha256(inside(payload, nativeAgentMember));
    }
    await mkdir(path.join(payload, 'maintenance'));
    for (const name of ['common.mjs', 'manifest.mjs', 'update.mjs', 'zip.mjs'])
      await copyFile(path.join(TOOL_ROOT, name), path.join(payload, 'maintenance', name));
    await copyFile(path.join(TOOL_ROOT, 'launch-template.mjs'), path.join(payload, 'launch.mjs'));
    await writeFile(
      path.join(payload, 'abr.cmd'),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0launch.mjs" %*\r\n',
    );
    await writeFile(
      path.join(payload, 'abr'),
      '#!/bin/sh\nabr_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$abr_root/runtime/node" "$abr_root/launch.mjs" "$@"\n',
      { mode: 0o755 },
    );
    const createdAt = new Date().toISOString();
    const sbom = await createSbom(workspace, app, {
      payloadRoot: payload,
      version: source.version,
      nodeVersion: source.nodeVersion,
      nodeSha256: await fileSha256(process.execPath),
      nativeAgentIncluded,
      browser,
      createdAt,
    });
    await writeFile(path.join(payload, 'sbom.cdx.json'), `${canonicalJson(sbom.sbom)}\n`);
    await writeFile(path.join(payload, 'THIRD-PARTY-NOTICE.txt'), sbom.notice);
    await copyFile(path.join(TOOL_ROOT, 'SUPPORT.md'), path.join(payload, 'SUPPORT.md'));
    const chromium = JSON.parse(
      await readFile(path.join(workspace, 'chromium', 'VERSION.lock'), 'utf8'),
    );
    const manifest = validateManifest({
      schemaVersion: 1,
      format: 'abr-portable-release-v1',
      version: source.version,
      protocolMajor: 1,
      platform: process.platform,
      architecture: process.arch,
      channel: 'development',
      artifactType: 'portable-zip',
      createdAt,
      components: {
        node: { version: source.nodeVersion, binarySha256: await fileSha256(process.execPath) },
        rust: { version: source.rustVersion, inventory: 'all-targets-source-lock' },
        pnpm: { version: source.pnpmVersion },
        typescript: { version: source.typescriptVersion },
        playwright: {
          version: packages.get('@abr/playwright-worker').manifest.dependencies.playwright,
          browser: browser
            ? {
                version: browser.version,
                revision: browser.revision,
                auxiliary: browser.auxiliary.map(({ name, revision, directory }) => ({
                  name,
                  revision,
                  directory,
                })),
              }
            : null,
          mutableMarkers: browser
            ? [
                path.basename(browser.folder),
                ...browser.auxiliary.map((item) => item.directory),
              ].map((directory) => `browsers/${directory}/DEPENDENCIES_VALIDATED`)
            : [],
        },
        mcp: {
          core: packages.get('@abr/mcp-server').manifest.dependencies['@modelcontextprotocol/core'],
          server:
            packages.get('@abr/mcp-server').manifest.dependencies['@modelcontextprotocol/server'],
        },
        desktopAgent: {
          included: nativeAgentIncluded,
          declaredSourceVersion: source.version,
          executable: nativeAgentMember,
          binarySha256: nativeAgentSha256,
          buildAttestation: null,
        },
        nativeChromium: {
          compiled: false,
          versionLockPath: versionLockMember,
          versionLockSha256: await fileSha256(inside(payload, versionLockMember)),
          upstreamTag: chromium.upstreamTag,
          upstreamCommit: chromium.upstreamCommit,
          depsSha256: chromium.depsSha256 ?? null,
          depotToolsCommit: chromium.depotToolsCommit ?? null,
          patchsetVersion: chromium.patchsetVersion,
          patches: chromium.patches ?? [],
        },
      },
      source: {
        codeSha256: source.codeSha256,
        gitCommit: source.gitCommit,
        gitDirty: source.gitDirty,
        pnpmLockSha256: sbom.pnpmSha256,
        cargoLockSha256: sbom.cargoSha256,
      },
      features: {
        compatible: {
          browserBundled: Boolean(browser),
          bundledHeadlessShell:
            browser?.auxiliary.some((item) => item.name === 'chromium-headless-shell') ?? false,
          windowsOwnedFixtureValidation: 'passed',
          otherPlatformPhysicalValidation: 'pending',
        },
        gui: {
          agentIncluded: nativeAgentIncluded,
          physicalBaselineApproval: 'pending',
          runtimePermissionChecks: true,
        },
        native: { available: false, reason: 'CUSTOM_CHROMIUM_BUILD_AND_PARITY_REQUIRED' },
        productionRelease: {
          approved: false,
          signing: 'unavailable',
          notarization: 'unavailable',
          threePlatformManualBaselines: 'pending',
        },
      },
      files: await inventory(payload),
    });
    const after = await sourceMetadata(workspace, packages);
    if (
      after.codeSha256 !== source.codeSha256 ||
      (await fileSha256(path.join(workspace, 'pnpm-lock.yaml'))) !== sbom.pnpmSha256 ||
      (await fileSha256(path.join(workspace, 'Cargo.lock'))) !== sbom.cargoSha256
    )
      throw new ReleaseError(
        'SOURCE_CHANGED',
        'Production source or locks changed during packaging.',
      );
    await writeFile(path.join(payload, 'version-manifest.json'), `${canonicalJson(manifest)}\n`);
    const archive = path.join(temporary, 'release.zip');
    report('release-archive-started', { fileCount: manifest.files.length });
    const archiveInfo = await writeZip(payload, archive);
    const digest = await fileSha256(archive);
    const output = path.resolve(options.output ?? path.join(workspace, '.cache', 'release'));
    await mkdir(output, { recursive: true });
    const basename = `abr-${source.version}-${process.platform}-${process.arch}-development-${digest.slice(0, 12)}.zip`;
    await copyFile(archive, path.join(output, basename));
    await writeFile(path.join(output, `${basename}.sha256`), `${digest}  ${basename}\n`, {
      flag: 'wx',
    });
    await writeFile(
      path.join(output, `${basename}.manifest.json`),
      `${canonicalJson(manifest)}\n`,
      { flag: 'wx' },
    );
    report('release-package-finished', {
      ...archiveInfo,
      ...sbom.counts,
      durationMs: Math.round(performance.now() - started),
    });
    return {
      archive: basename,
      sha256: digest,
      channel: 'development',
      platform: process.platform,
      architecture: process.arch,
      ...archiveInfo,
      ...sbom.counts,
    };
  } finally {
    await cleanTemporary(temporary);
  }
}

/**
 * Dispatch unsigned development packaging with explicit host assets.
 * Args:
 *   argv (string[]): Local packaging arguments.
 * Returns:
 *   Promise<void>: Completion of the archive creation command.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      workspace: { type: 'string' },
      output: { type: 'string' },
      'native-agent': { type: 'string' },
      'exclude-browser': { type: 'boolean' },
    },
  });
  console.log(
    JSON.stringify(
      await packageDevelopment({
        workspace: parsed.values.workspace,
        output: parsed.values.output,
        nativeAgent: parsed.values['native-agent'],
        excludeBrowser: parsed.values['exclude-browser'] ?? false,
      }),
    ),
  );
}

// Direct invocation executes the total packaging entry point.
if (isMain(import.meta.url)) void main().catch(fail);
