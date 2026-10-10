// -*- coding: utf-8 -*-
/**
 * package-smoke.mjs
 * Portable package execution verification
 * =====================
 * Install an actual archive into a marked test root and run metadata commands with isolated data.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  ReleaseError,
  cleanTemporary,
  command,
  fail,
  fileSha256,
  inside,
  isMain,
  report,
  temporaryRoot,
} from './common.mjs';
import { activeRelease, install } from './update.mjs';

/**
 * Verify actual packaged dependency resolution and CLI metadata in isolated storage.
 * Args:
 *   options (object): Actual archive path and independently computed SHA256.
 * Returns:
 *   Promise<object>: Successful packaged command results.
 */
export async function smokePackage(options) {
  const started = performance.now();
  const temporary = await temporaryRoot('smoke');
  try {
    const root = path.join(temporary, 'installation');
    await install(options.archive, options.sha256, root, { allowUnsignedDevelopment: true });
    const active = await activeRelease(root, { allowUnsignedDevelopment: true });
    const pointer = await readFile(path.join(root, 'active-release.json'), 'utf8');
    const native = active.manifest.components.nativeChromium;
    const versionLock = inside(active.directory, native.versionLockPath);
    const pin = JSON.parse(await readFile(versionLock, 'utf8'));
    // Assert real identity files and binary checksums rather than inferred build attestation.
    if (
      native.versionLockPath !== 'app/chromium/VERSION.lock' ||
      (await fileSha256(versionLock)) !== native.versionLockSha256 ||
      pin.upstreamCommit !== native.upstreamCommit ||
      pin.upstreamTag !== native.upstreamTag ||
      native.compiled !== false ||
      active.manifest.features.native.available !== false ||
      active.manifest.components.desktopAgent.buildAttestation !== null
    )
      throw new ReleaseError('PACKAGE_SMOKE_FAILED', 'Native identity inventory is inconsistent.');
    const agent = active.manifest.components.desktopAgent;
    if (
      agent.included &&
      (agent.executable !==
        `app/bin/abr-desktop-agent${process.platform === 'win32' ? '.exe' : ''}` ||
        (await fileSha256(inside(active.directory, agent.executable))) !== agent.binarySha256)
    )
      throw new ReleaseError('PACKAGE_SMOKE_FAILED', 'DesktopAgent portable identity is invalid.');
    const executable = path.join(
      active.directory,
      'runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const launcher = path.join(active.directory, 'launch.mjs');
    const environment = { ...process.env, ABR_DATA_DIR: path.join(temporary, 'data') };
    const version = JSON.parse(
      await command(executable, [launcher, 'version'], {
        cwd: temporary,
        env: environment,
        label: 'release-packaged-version',
      }),
    );
    const contract = JSON.parse(
      await command(executable, [launcher, 'test', 'contract'], {
        cwd: temporary,
        env: environment,
        label: 'release-packaged-contract',
      }),
    );
    const doctor = JSON.parse(
      await command(executable, [launcher, 'doctor', '--json'], {
        cwd: temporary,
        env: environment,
        label: 'release-packaged-doctor',
      }),
    );
    const repeatedVersion = JSON.parse(
      await command(executable, [launcher, 'version'], {
        cwd: temporary,
        env: environment,
        label: 'release-packaged-repeat-version',
      }),
    );
    const replay = await install(options.archive, options.sha256, root, {
      allowUnsignedDevelopment: true,
    });
    await activeRelease(root, { allowUnsignedDevelopment: true });
    // Repeated launches and exact archive replay retain one verified active generation.
    if (
      version.abr !== active.manifest.version ||
      version.node !== `v${active.manifest.components.node.version}` ||
      doctor.platform !== process.platform ||
      doctor.architecture !== process.arch ||
      doctor.engines.compatible.status !== 'available' ||
      doctor.engines.native.status !== 'unavailable' ||
      (agent.included && doctor.engines.gui.status !== 'available') ||
      contract.status !== 'succeeded' ||
      contract.toolCount !== 21 ||
      contract.schemaVersion !== active.manifest.protocolMajor ||
      JSON.stringify(repeatedVersion) !== JSON.stringify(version) ||
      replay.changed !== false ||
      (await readFile(path.join(root, 'active-release.json'), 'utf8')) !== pointer
    )
      throw new ReleaseError(
        'PACKAGE_SMOKE_FAILED',
        'Packaged runtime metadata differs from its manifest.',
      );
    report('release-package-smoke-finished', {
      version: version.abr,
      durationMs: Math.round(performance.now() - started),
    });
    return {
      version,
      contract,
      doctor: { platform: doctor.platform, architecture: process.arch },
      inventory: {
        members: active.manifest.files.length,
        nativeVersionLock: native.versionLockPath,
        nativeCommit: native.upstreamCommit,
        desktopAgentSha256: agent.binarySha256,
        browser: active.manifest.components.playwright.browser,
        sourceSha256: active.manifest.source.codeSha256,
      },
      repeatedLaunchStable: true,
      exactReplayStable: true,
      browsersLaunched: false,
    };
  } finally {
    await cleanTemporary(temporary);
  }
}

/**
 * Dispatch execution verification for a selected local development archive.
 * Args:
 *   argv (string[]): Archive path and checksum arguments.
 * Returns:
 *   Promise<void>: Completion of isolated package verification.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: { archive: { type: 'string' }, sha256: { type: 'string' } },
  });
  if (!parsed.values.archive || !parsed.values.sha256)
    throw new ReleaseError(
      'INVALID_ARGUMENT',
      'Package smoke requires a local archive and checksum.',
    );
  console.log(JSON.stringify(await smokePackage(parsed.values)));
}

// Direct invocation runs metadata-only package verification with isolated state.
if (isMain(import.meta.url)) void main().catch(fail);
