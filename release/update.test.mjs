// -*- coding: utf-8 -*-
/**
 * update.test.mjs
 * Release integrity and transaction verification
 * =====================
 * Exercise owned update/rollback transactions and malicious archive/signature rejection.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  cleanTemporary,
  fileSha256,
  sha256,
  temporaryRoot,
  validateLinks,
} from './common.mjs';
import { verifyReleaseEvidence } from './gates.mjs';
import { inventory, validateManifest, verifyPublisher } from './manifest.mjs';
import { activeRelease, install, rollback } from './update.mjs';
import { writeZip, zipEntries } from './zip.mjs';

/**
 * Create a small isolated content-addressed development release fixture.
 * Args:
 *   root (string): Marked task-owned temporary directory.
 *   version (string): Independent test release version.
 *   content (string): Distinct test payload.
 *   override (object): Explicit malformed or platform test metadata.
 * Returns:
 *   Promise<object>: Owned archive, checksum, and staging directory.
 */
async function fixture(root, version, content, override = {}) {
  const directory = path.join(root, `source-${version}-${sha256(content).slice(0, 8)}`);
  await mkdir(directory);
  await mkdir(path.join(directory, 'app'));
  await writeFile(path.join(directory, 'app', 'entry.mjs'), content);
  const manifest = {
    schemaVersion: 1,
    format: 'abr-portable-release-v1',
    version,
    protocolMajor: 1,
    platform: process.platform,
    architecture: process.arch,
    channel: 'development',
    artifactType: 'portable-zip',
    createdAt: '2026-10-10T00:00:00.000Z',
    components: { node: { version: process.versions.node }, nativeChromium: { compiled: false } },
    source: { gitDirty: true },
    features: { native: { available: false } },
    files: await inventory(directory),
    ...override,
  };
  await writeFile(path.join(directory, 'version-manifest.json'), `${canonicalJson(manifest)}\n`);
  const archive = path.join(root, `archive-${version}-${sha256(content).slice(0, 8)}.zip`);
  await writeZip(directory, archive);
  return { archive, sha256: await fileSha256(archive), directory, manifest };
}

/**
 * Verify two-version installation, exact replay, and atomic verified rollback.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful transaction assertions.
 */
async function updateAndRollback() {
  const root = await temporaryRoot('test');
  try {
    const first = await fixture(root, '0.1.0', 'export const release = "first";\n');
    const second = await fixture(root, '0.2.0', 'export const release = "second";\n');
    const directory = path.join(root, 'installation');
    const options = { allowUnsignedDevelopment: true };
    const installed = await install(first.archive, first.sha256, directory, options);
    const pointerBefore = await readFile(path.join(directory, 'active-release.json'), 'utf8');
    const replay = await install(first.archive, first.sha256, directory, options);
    assert.equal(replay.changed, false);
    assert.equal(
      await readFile(path.join(directory, 'active-release.json'), 'utf8'),
      pointerBefore,
    );
    const updated = await install(second.archive, second.sha256, directory, options);
    assert.equal(updated.previous, installed.active);
    const active = await activeRelease(directory, options);
    assert.match(await readFile(path.join(active.directory, 'app', 'entry.mjs'), 'utf8'), /second/);
    const restored = await rollback(directory, options);
    assert.equal(restored.active, installed.active);
    const rolledBack = await activeRelease(directory, options);
    assert.match(
      await readFile(path.join(rolledBack.directory, 'app', 'entry.mjs'), 'utf8'),
      /first/,
    );
    await assert.rejects(lstat(path.join(directory, '.update.lock')), { code: 'ENOENT' });
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Verify archive checksum, platform, protocol, and development gates precede pointer mutation.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful fail-closed preflight assertions.
 */
async function preflightFailureIsolation() {
  const root = await temporaryRoot('test');
  try {
    const first = await fixture(root, '0.1.0', 'release one');
    const wrongPlatform = await fixture(root, '0.3.0', 'wrong platform', {
      platform: process.platform === 'win32' ? 'linux' : 'win32',
    });
    const wrongProtocol = await fixture(root, '0.4.0', 'wrong protocol', { protocolMajor: 2 });
    const directory = path.join(root, 'installation');
    const options = { allowUnsignedDevelopment: true };
    await assert.rejects(install(first.archive, first.sha256, directory), {
      code: 'SIGNATURE_REQUIRED',
    });
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    await install(first.archive, first.sha256, directory, options);
    const pointer = await readFile(path.join(directory, 'active-release.json'), 'utf8');
    await assert.rejects(install(first.archive, '0'.repeat(64), directory, options), {
      code: 'ARCHIVE_CHECKSUM',
    });
    await assert.rejects(install(wrongPlatform.archive, wrongPlatform.sha256, directory, options), {
      code: 'PLATFORM_MISMATCH',
    });
    await assert.rejects(install(wrongProtocol.archive, wrongProtocol.sha256, directory, options), {
      code: 'INVALID_MANIFEST',
    });
    assert.equal(await readFile(path.join(directory, 'active-release.json'), 'utf8'), pointer);
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Verify publisher trust anchoring and signature tamper rejection.
 * Args:
 *   None.
 * Returns:
 *   void: Successful cryptographic verification assertions.
 */
function publisherTrust() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest = { channel: 'signed', version: '0.1.0', fingerprint: 'owned-test-only' };
  const envelope = {
    algorithm: 'Ed25519',
    keyId: 'test-only-key',
    signature: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64'),
  };
  const options = {
    trustedKeys: [
      { keyId: 'test-only-key', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) },
    ],
  };
  assert.equal(verifyPublisher(manifest, envelope, options).keyId, 'test-only-key');
  assert.throws(() => verifyPublisher({ ...manifest, version: '0.2.0' }, envelope, options), {
    code: 'SIGNATURE_INVALID',
  });
  assert.throws(() => verifyPublisher(manifest, envelope), { code: 'UNTRUSTED_PUBLISHER' });
}

/**
 * Verify prior payload tampering prevents rollback and preserves the live pointer.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful rollback integrity assertions.
 */
async function tamperedRollback() {
  const root = await temporaryRoot('test');
  try {
    const first = await fixture(root, '0.1.0', 'first payload');
    const second = await fixture(root, '0.2.0', 'second payload');
    const directory = path.join(root, 'installation');
    const options = { allowUnsignedDevelopment: true };
    const initial = await install(first.archive, first.sha256, directory, options);
    await install(second.archive, second.sha256, directory, options);
    await writeFile(
      path.join(directory, 'versions', initial.active, 'app', 'entry.mjs'),
      'tampered',
    );
    const pointer = await readFile(path.join(directory, 'active-release.json'), 'utf8');
    await assert.rejects(rollback(directory, options), { code: 'PACKAGE_INTEGRITY' });
    assert.equal(await readFile(path.join(directory, 'active-release.json'), 'utf8'), pointer);
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Reject symlink member metadata before extraction even with a fresh archive checksum.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful malicious archive rejection.
 */
async function hostileArchive() {
  const root = await temporaryRoot('test');
  try {
    const created = await fixture(root, '0.1.0', 'test payload');
    const bytes = await readFile(created.archive);
    const end = bytes.length - 22;
    const central = bytes.readUInt32LE(end + 16);
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    assert.throws(() => zipEntries(bytes), { code: 'INVALID_ARCHIVE' });
    const invalid = structuredClone(created.manifest);
    invalid.files[0].path = '../outside.mjs';
    assert.throws(() => validateManifest(invalid), { code: 'INVALID_ARCHIVE' });
    const collision = structuredClone(created.manifest);
    collision.files.push({ ...collision.files[0], path: collision.files[0].path.toUpperCase() });
    assert.throws(() => validateManifest(collision), { code: 'INVALID_MANIFEST' });
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Verify production signing rejects development source and unavailable Native builds.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful missing-evidence gate assertions.
 */
async function productionFailClosed() {
  const root = await temporaryRoot('test');
  try {
    const created = await fixture(root, '0.1.0', 'development payload');
    await assert.rejects(verifyReleaseEvidence(created.manifest, undefined, root, []), {
      code: 'SOURCE_NOT_RELEASED',
    });
    const clean = {
      ...created.manifest,
      source: { ...created.manifest.source, gitDirty: false, gitCommit: '1'.repeat(40) },
    };
    await assert.rejects(verifyReleaseEvidence(clean, undefined, root, []), {
      code: 'NATIVE_BUILD_REQUIRED',
    });
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Verify official host validation markers retain a bounded mutable metadata surface.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful zero-byte marker and extra-file rejection assertions.
 */
async function browserMarkerBounds() {
  const root = await temporaryRoot('test');
  try {
    const marker = 'browsers/chromium-1248/DEPENDENCIES_VALIDATED';
    const created = await fixture(root, '0.1.0', 'browser marker fixture', {
      components: {
        node: { version: process.versions.node },
        nativeChromium: { compiled: false },
        playwright: { mutableMarkers: [marker] },
      },
    });
    const directory = path.join(root, 'installation');
    const options = { allowUnsignedDevelopment: true };
    await install(created.archive, created.sha256, directory, options);
    const active = await activeRelease(directory, options);
    await mkdir(path.dirname(path.join(active.directory, ...marker.split('/'))), {
      recursive: true,
    });
    await writeFile(path.join(active.directory, ...marker.split('/')), '');
    await activeRelease(directory, options);
    await writeFile(path.join(active.directory, ...marker.split('/')), 'unexpected content');
    await assert.rejects(activeRelease(directory, options), { code: 'PACKAGE_INTEGRITY' });
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Verify preserved relative framework links and hostile link graph rejection.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful package seal identity and containment assertions.
 */
async function sealedLinkMetadata() {
  const root = await temporaryRoot('test');
  try {
    const directory = path.join(root, 'framework');
    await mkdir(path.join(directory, 'Versions', 'A'), { recursive: true });
    await writeFile(path.join(directory, 'Versions', 'A', 'Library'), 'real signed bytes');
    await writeFile(path.join(directory, 'Library'), 'Versions/Current/Library');
    await writeFile(path.join(directory, 'Versions', 'Current'), 'A');
    const archive = path.join(root, 'framework.zip');
    await writeZip(directory, archive);
    const bytes = await readFile(archive);
    let central = bytes.readUInt32LE(bytes.length - 22 + 16);
    // Encode native framework aliases in a real archive without Windows link privileges.
    while (bytes.readUInt32LE(central) === 0x02014b50) {
      const nameLength = bytes.readUInt16LE(central + 28);
      const name = bytes.subarray(central + 46, central + 46 + nameLength).toString('utf8');
      if (['Library', 'Versions/Current'].includes(name))
        bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
      central +=
        46 + nameLength + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
    }
    const entries = zipEntries(bytes);
    assert.equal(entries[0].type, 'symlink');
    assert.equal(entries[0].symlinkTarget, 'Versions/Current/Library');
    assert.equal(validateLinks(entries).get('Library').target, 'Versions/A/Library');
    const framework = validateLinks([
      { path: 'Framework/Versions/A/Library' },
      { path: 'Framework/Versions/Current', type: 'symlink', symlinkTarget: 'A' },
      {
        path: 'Framework/Library',
        type: 'symlink',
        symlinkTarget: 'Versions/Current/Library',
      },
    ]);
    assert.equal(framework.get('Framework/Library').target, 'Framework/Versions/A/Library');
    assert.equal(framework.get('Framework/Versions/Current').type, 'dir');
    assert.throws(
      () =>
        validateLinks([
          { path: 'dir/file' },
          { path: 'other/file' },
          { path: 'outside' },
          { path: 'dir/up', type: 'symlink', symlinkTarget: '../other' },
          { path: 'escape', type: 'symlink', symlinkTarget: 'dir/up/../../outside' },
        ]),
      { code: 'INVALID_ARCHIVE' },
    );
    assert.throws(
      () =>
        validateLinks([
          { path: 'A', type: 'symlink', symlinkTarget: 'B' },
          { path: 'B', type: 'symlink', symlinkTarget: 'A' },
        ]),
      { code: 'INVALID_ARCHIVE' },
    );
    assert.throws(
      () => validateLinks([{ path: 'A', type: 'symlink', symlinkTarget: '../outside' }]),
      { code: 'INVALID_ARCHIVE' },
    );
    assert.throws(() => validateLinks([{ path: 'A', type: 'symlink', symlinkTarget: 'absent' }]), {
      code: 'INVALID_ARCHIVE',
    });
    assert.throws(
      () =>
        validateLinks([
          { path: 'a/file' },
          { path: 'b/file' },
          { path: 'a/link', type: 'symlink', symlinkTarget: '../b' },
          { path: 'b/link', type: 'symlink', symlinkTarget: '../a' },
        ]),
      { code: 'INVALID_ARCHIVE' },
    );
  } finally {
    await cleanTemporary(root);
  }
}

/**
 * Bound implicit directory allocation and nested archive paths before extraction.
 * Args:
 *   None.
 * Returns:
 *   void: Successful metadata resource limit assertions.
 */
function linkMetadataBounds() {
  const nested = Array.from({ length: 65 }, () => 'segment').join('/');
  assert.throws(() => validateLinks([{ path: nested }]), {
    code: 'INVALID_ARCHIVE',
  });
  const directories = Array.from({ length: 12501 }, (_, index) => ({
    path: `root${index}/level/child/leaf/file`,
  }));
  directories.push({ path: 'link', type: 'symlink', symlinkTarget: directories[0].path });
  assert.throws(() => validateLinks(directories), { code: 'ARCHIVE_LIMIT' });
}

test(
  'symbolic metadata respects path depth and implicit directory allocation limits',
  linkMetadataBounds,
);
test(
  'relative framework aliases retain identities and reject escaping or cyclic graphs',
  sealedLinkMetadata,
);
test('mutable official browser markers remain empty and explicitly bounded', browserMarkerBounds);
test('local releases install, replay, update, and rollback atomically', updateAndRollback);
test('preflight failures preserve the live pointer', preflightFailureIsolation);
test('publisher signatures require configured trust and reject tampering', publisherTrust);
test('tampered rollback target preserves the current installation', tamperedRollback);
test('hostile member types, traversal, and case aliases are rejected', hostileArchive);
test(
  'production release remains closed without actual source/build evidence',
  productionFailClosed,
);
