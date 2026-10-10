// -*- coding: utf-8 -*-
/**
 * package.test.mjs
 * Build-control fingerprint verification
 * =====================
 * Verify compiler and runtime control changes alter code-bound release identities.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { cleanTemporary, fileSha256, inside, temporaryRoot } from './common.mjs';
import { sourceFingerprint } from './package.mjs';

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
