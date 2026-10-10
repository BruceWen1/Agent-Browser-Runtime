// -*- coding: utf-8 -*-
/**
 * package.test.mjs
 * Build-control fingerprint verification
 * =====================
 * Verify code-bound build controls and actual auxiliary asset software inventory.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanTemporary, fileSha256, inside, temporaryRoot } from './common.mjs';
import { sourceFingerprint } from './package.mjs';
import { browserAuxiliarySbom } from './sbom.mjs';

/**
 * Verify real control-file mutations change a deterministic fingerprint with unchanged locks.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of configuration mutation and private-data exclusion assertions.
 */
async function buildControlFingerprint() {
  const root = await temporaryRoot('fingerprint');
  const packages = new Map([['@abr/example', { folder: 'packages/example' }]]);
  const files = {
    'package.json': '{"scripts":{"build":"tsc -b"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9',
    'pnpm-workspace.yaml': 'packages: [packages/*]',
    'Cargo.lock': 'version = 4',
    'Cargo.toml': '[workspace]\nmembers = ["native/desktop-agent"]',
    '.node-version': '24.15.0',
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.99.0"',
    'tsconfig.json': '{"references":[]}',
    'tsconfig.base.json': '{"compilerOptions":{"strict":true}}',
    'native/desktop-agent/Cargo.toml': '[package]\nname = "abr-desktop-agent"',
    'native/desktop-agent/src/main.rs': 'fn main() {}',
    'packages/example/package.json': '{"name":"@abr/example"}',
    'packages/example/tsconfig.json': '{"compilerOptions":{"composite":true}}',
    'packages/example/src/index.ts': 'export const value = 1;',
    'chromium/VERSION.lock': '{"schemaVersion":1}',
    'chromium/bridge/main.cc': 'int main() { return 0; }',
    'chromium/patches/observer.patch': 'readonly patch',
    'chromium/build/pipeline.mjs': 'export const build = "original";',
  };
  try {
    // Build an isolated source tree without executing compilers or modifying repository state.
    for (const [member, value] of Object.entries(files)) {
      const filename = inside(root, member);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, value);
    }
    const baseline = await sourceFingerprint(root, packages);
    const pnpmLock = await fileSha256(inside(root, 'pnpm-lock.yaml'));
    const cargoLock = await fileSha256(inside(root, 'Cargo.lock'));
    // Each changed compiler, resolver, pin, or Native build control must invalidate source identity.
    for (const [member, mutation] of Object.entries({
      'package.json': '{"scripts":{"build":"tsc -b --force"}}',
      'pnpm-workspace.yaml': 'packages: [packages/*, contracts]',
      'Cargo.toml': '[workspace]\nmembers = ["native/desktop-agent"]\n[profile.dev]\ndebug = 0',
      'native/desktop-agent/Cargo.toml': '[package]\nname = "abr-desktop-agent"\nversion = "0.2.0"',
      '.node-version': '24.15.1',
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.99.1"',
      'tsconfig.json': '{"references":[{"path":"./packages/example"}]}',
      'tsconfig.base.json': '{"compilerOptions":{"strict":false}}',
      'packages/example/tsconfig.json': '{"compilerOptions":{"composite":true,"target":"ES2024"}}',
      'chromium/build/pipeline.mjs': 'export const build = "patched";',
    })) {
      const filename = inside(root, member);
      const original = await readFile(filename);
      await writeFile(filename, mutation);
      assert.notEqual(await sourceFingerprint(root, packages), baseline, member);
      assert.equal(await fileSha256(inside(root, 'pnpm-lock.yaml')), pnpmLock);
      assert.equal(await fileSha256(inside(root, 'Cargo.lock')), cargoLock);
      await writeFile(filename, original);
      assert.equal(await sourceFingerprint(root, packages), baseline);
    }
    await mkdir(inside(root, '.cargo'));
    await writeFile(inside(root, '.cargo/config.toml'), '[build]\nrustflags = ["--cfg", "custom"]');
    assert.notEqual(await sourceFingerprint(root, packages), baseline);
    const controlled = await sourceFingerprint(root, packages);
    // Documentation and local user configuration remain outside production/build input inventory.
    await mkdir(inside(root, 'docs'));
    await writeFile(inside(root, 'docs/status.md'), 'local status');
    await mkdir(inside(root, '.abr'));
    await writeFile(inside(root, '.abr/config.yaml'), 'private runtime settings');
    assert.equal(await sourceFingerprint(root, packages), controlled);
  } finally {
    await cleanTemporary(root);
  }
}

test(
  'build and runtime configuration mutations invalidate fingerprint with unchanged locks',
  buildControlFingerprint,
);

/**
 * Verify auxiliary components bind actual files, explicit licenses, and truthful revision identities.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of isolated asset-integrity and license-evidence assertions.
 */
async function auxiliarySoftwareInventory() {
  const root = await temporaryRoot('auxiliary-sbom');
  const browser = {
    auxiliary: [
      { name: 'ffmpeg', revision: '1013', directory: 'ffmpeg-1013' },
      { name: 'winldd', revision: '1007', directory: 'winldd-1007' },
    ],
  };
  const report =
    'ffmpeg version n7.0.1-playwright-build-1013 Copyright\nGNU Lesser General Public\nLicense; either version 2.1 of the License, or any later version.';
  /**
   * Provide an explicit synthetic license report without executing fixture binary bytes.
   * Args:
   *   executable (string): Test-owned staged ffmpeg path.
   * Returns:
   *   Promise<string>: Fixture declaration for inventory policy verification.
   */
  async function inspectLicense(executable) {
    assert.equal(executable, inside(root, 'browsers/ffmpeg-1013/ffmpeg-win64.exe'));
    return report;
  }
  /**
   * Provide a contradictory GPL-enabled fixture report to verify fail-closed license admission.
   * Args:
   *   None.
   * Returns:
   *   Promise<string>: Deliberately inconsistent fixture license declaration.
   */
  async function inconsistentLicense() {
    return `${report}\nconfiguration: --enable-gpl`;
  }
  try {
    // Fixture bytes exercise file hashing and inventory binding independently of native execution.
    for (const [member, bytes] of Object.entries({
      'browsers/ffmpeg-1013/ffmpeg-win64.exe': 'owned synthetic ffmpeg bytes',
      'browsers/ffmpeg-1013/COPYING.LGPLv2.1': 'GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1',
      'browsers/winldd-1007/PrintDeps.exe': 'owned synthetic Winldd bytes',
    })) {
      const filename = inside(root, member);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
    }
    const result = await browserAuxiliarySbom(root, browser, inspectLicense);
    assert.equal(result.components.length, 2);
    assert.equal(result.notices.length, 2);
    const [ffmpeg, winldd] = result.components;
    assert.equal(ffmpeg.version, 'n7.0.1-playwright-build-1013');
    assert.equal(ffmpeg.licenses[0].license.id, 'LGPL-2.1-or-later');
    assert.equal(winldd.licenses[0].expression, 'MIT AND Apache-2.0');
    assert.equal(Object.hasOwn(winldd, 'version'), false);
    // Auxiliary build numbers remain properties, and component hashes identify actual executables.
    for (const component of result.components) {
      const properties = Object.fromEntries(
        component.properties.map((item) => [item.name, item.value]),
      );
      assert.match(properties['abr:playwrightRevision'], /^\d+$/);
      assert.equal(
        component.hashes[0].content,
        await fileSha256(inside(root, properties['abr:inventoryPath'])),
      );
      assert.equal(
        properties['abr:licenseSha256'],
        await fileSha256(inside(root, properties['abr:licenseInventoryPath'])),
      );
    }
    const provenance = JSON.parse(
      await readFile(inside(root, 'licenses/winldd-1007-provenance.json'), 'utf8'),
    );
    assert.equal(provenance.binaryBuildAttestation, null);
    assert.equal(provenance.buildNumber, 1007);
    assert.equal(provenance.sourceCommit, '606ecd8b34bac100db32561b6278ffd76e5eb3cd');
    await writeFile(
      inside(root, 'browsers/ffmpeg-1013/ffmpeg-win64.exe'),
      'mutated fixture executable',
    );
    const changed = await browserAuxiliarySbom(root, browser, inspectLicense);
    assert.notEqual(changed.components[0].hashes[0].content, ffmpeg.hashes[0].content);
    await assert.rejects(browserAuxiliarySbom(root, browser, inconsistentLicense), {
      code: 'AUXILIARY_LICENSE_UNAVAILABLE',
    });
    const wrongRevision = {
      auxiliary: [{ name: 'winldd', revision: '1008', directory: 'winldd-1008' }],
    };
    await mkdir(inside(root, 'browsers/winldd-1008'));
    await writeFile(inside(root, 'browsers/winldd-1008/PrintDeps.exe'), 'wrong-revision fixture');
    await assert.rejects(browserAuxiliarySbom(root, wrongRevision), {
      code: 'AUXILIARY_LICENSE_UNAVAILABLE',
    });
    await assert.rejects(
      browserAuxiliarySbom(root, {
        auxiliary: [{ name: 'winldd', revision: '1007', directory: '../outside' }],
      }),
      { code: 'AUXILIARY_ASSET_INVALID' },
    );
  } finally {
    await cleanTemporary(root);
  }
}

test(
  'auxiliary SBOM binds actual binary bytes and verified license evidence',
  auxiliarySoftwareInventory,
);
