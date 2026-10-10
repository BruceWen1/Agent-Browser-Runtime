// -*- coding: utf-8 -*-
/**
 * update.mjs
 * Verified local release installation and rollback
 * =====================
 * Stage checksum-verified archives and atomically switch same-protocol release pointers.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  ReleaseError,
  atomicJson,
  boundedFile,
  canonicalJson,
  fail,
  inside,
  isMain,
  report,
  sha256,
  syncDirectory,
} from './common.mjs';
import { readJson, validateManifest, verifyDirectory, verifyPublisher } from './manifest.mjs';
import { entryBytes, extractZip, zipEntries } from './zip.mjs';

/**
 * Create or verify an explicitly owned installation root and private version store.
 * Args:
 *   directory (string): User-selected ABR installation directory.
 * Returns:
 *   Promise<string>: Resolved owned installation root.
 */
async function installationRoot(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new ReleaseError('UNSAFE_INSTALL_ROOT', 'Installation root is redirected or invalid.');
  const root = await realpath(directory);
  const marker = path.join(root, '.abr-install-root.json');
  const children = await readdir(root);
  // Initialize ownership only in an empty directory selected for this installation.
  if (!children.length)
    await writeFile(marker, `${canonicalJson({ schemaVersion: 1, kind: 'abr-install-root' })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  const owner = await readJson(marker, 4096).catch(() => {
    throw new ReleaseError('UNSAFE_INSTALL_ROOT', 'Installation ownership marker is unavailable.');
  });
  if (
    owner.schemaVersion !== 1 ||
    owner.kind !== 'abr-install-root' ||
    (await lstat(marker)).isSymbolicLink()
  )
    throw new ReleaseError('UNSAFE_INSTALL_ROOT', 'Installation ownership marker is invalid.');
  const versions = path.join(root, 'versions');
  await mkdir(versions, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(versions)).isDirectory() || (await lstat(versions)).isSymbolicLink())
    throw new ReleaseError('UNSAFE_INSTALL_ROOT', 'Installation version store is invalid.');
  return root;
}

/**
 * Acquire an exclusive updater lock scoped to an owned installation root.
 * Args:
 *   root (string): Verified installation root.
 * Returns:
 *   Promise<object>: Lock handle and exclusive lock path.
 */
async function acquireLock(root) {
  const filename = path.join(root, '.update.lock');
  let handle;
  try {
    handle = await open(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new ReleaseError(
        'UPDATE_BUSY',
        'Another update owns this installation; retained crash locks require local recovery.',
      );
    throw new ReleaseError('UPDATE_LOCK_FAILED', 'Installation update lock cannot be opened.');
  }
  try {
    await handle.writeFile(
      `${canonicalJson({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(filename);
    throw error;
  }
  return { handle, filename };
}

/**
 * Read and validate the active and previous release pointer records.
 * Args:
 *   root (string): Verified installation root.
 * Returns:
 *   Promise<object | undefined>: Validated pointer or initial empty state.
 */
async function state(root) {
  const filename = path.join(root, 'active-release.json');
  let value;
  try {
    if ((await lstat(filename)).isSymbolicLink())
      throw new ReleaseError('POINTER_INVALID', 'Release pointer is redirected.');
    value = await readJson(filename, 8192);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    value.schemaVersion !== 1 ||
    value.protocolMajor !== 1 ||
    value.platform !== process.platform ||
    value.architecture !== process.arch ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    throw new ReleaseError('POINTER_INVALID', 'Release pointer platform or protocol is invalid.');
  // Pointer identifiers remain data and never become unchecked filesystem paths.
  for (const reference of [value.active, value.previous].filter(Boolean)) {
    if (
      !/^abr-[A-Za-z0-9.-]+-[a-f0-9]{12}$/.test(reference.id) ||
      !/^[a-f0-9]{64}$/.test(reference.archiveSha256) ||
      !/^[a-f0-9]{64}$/.test(reference.manifestSha256) ||
      !['signed', 'development'].includes(reference.channel)
    )
      throw new ReleaseError('POINTER_INVALID', 'Release pointer identity is invalid.');
  }
  if (!value.active)
    throw new ReleaseError('POINTER_INVALID', 'Release pointer has no active version.');
  return value;
}

/**
 * Verify the manifest and full inventory of an installed pointer target.
 * Args:
 *   root (string): Owned installation root.
 *   reference (object): Validated active or previous pointer.
 *   options (object): Explicit development and publisher trust settings.
 * Returns:
 *   Promise<object>: Verified installed directory and manifest.
 */
async function verifyReference(root, reference, options) {
  const directory = inside(root, `versions/${reference.id}`);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new ReleaseError('PACKAGE_INTEGRITY', 'Installed release directory is redirected.');
  const manifestBytes = await boundedFile(
    path.join(directory, 'version-manifest.json'),
    16 * 1024 * 1024,
  );
  if (sha256(manifestBytes) !== reference.manifestSha256)
    throw new ReleaseError('PACKAGE_INTEGRITY', 'Installed release manifest checksum failed.');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
  } catch (error) {
    throw error instanceof ReleaseError
      ? error
      : new ReleaseError('INVALID_MANIFEST', 'Installed manifest JSON is invalid.');
  }
  let envelope;
  if (manifest.channel === 'signed')
    envelope = await readJson(path.join(directory, 'release-signature.json'), 4096);
  verifyPublisher(manifest, envelope, options);
  if (
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch ||
    manifest.channel !== reference.channel
  )
    throw new ReleaseError('PLATFORM_MISMATCH', 'Installed release platform identity changed.');
  await verifyDirectory(directory, manifest);
  return { directory, manifest };
}

/**
 * Install a checksum-anchored local archive and switch its live pointer atomically.
 * Args:
 *   archive (string): Local release ZIP selected by the user.
 *   expectedSha256 (string): Independently supplied archive SHA256.
 *   directory (string): Owned installation root.
 *   options (object): Explicit development opt-in and publisher trust anchors.
 * Returns:
 *   Promise<object>: Activated release identifier and previous identifier.
 */
export async function install(archive, expectedSha256, directory, options = {}) {
  const started = performance.now();
  const bytes = await boundedFile(archive, 2 * 1024 * 1024 * 1024);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256)
    throw new ReleaseError(
      'ARCHIVE_CHECKSUM',
      'Release archive checksum does not match its supplied anchor.',
    );
  const entries = zipEntries(bytes);
  // Windows installers accept regular members while Darwin/Linux retain sealed relative links.
  if (process.platform === 'win32' && entries.some((entry) => entry.type === 'symlink'))
    throw new ReleaseError(
      'PLATFORM_MISMATCH',
      'This Windows package contains unsupported symbolic members.',
    );
  const manifestEntry = entries.find((entry) => entry.path === 'version-manifest.json');
  if (!manifestEntry || manifestEntry.size > 16 * 1024 * 1024)
    throw new ReleaseError('INVALID_MANIFEST', 'Release manifest is absent or exceeds limits.');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(entryBytes(manifestEntry).toString('utf8')));
  } catch (error) {
    throw error instanceof ReleaseError
      ? error
      : new ReleaseError('INVALID_MANIFEST', 'Release manifest JSON is invalid.');
  }
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch)
    throw new ReleaseError(
      'PLATFORM_MISMATCH',
      'Release archive platform differs from this runtime.',
    );
  const signatureEntry = entries.find((entry) => entry.path === 'release-signature.json');
  if (signatureEntry?.size > 4096)
    throw new ReleaseError('SIGNATURE_INVALID', 'Publisher envelope exceeds limits.');
  let envelope;
  try {
    envelope = signatureEntry ? JSON.parse(entryBytes(signatureEntry).toString('utf8')) : undefined;
  } catch {
    throw new ReleaseError('SIGNATURE_INVALID', 'Publisher envelope JSON is invalid.');
  }
  verifyPublisher(manifest, envelope, options);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (entries.length !== expected.size + 1 + (signatureEntry ? 1 : 0))
    throw new ReleaseError('PACKAGE_INTEGRITY', 'Release archive has unmanifested members.');
  // Match every archive member before creating an installation transaction.
  for (const entry of entries) {
    if (['version-manifest.json', 'release-signature.json'].includes(entry.path)) continue;
    const file = expected.get(entry.path);
    if (
      !file ||
      entry.size !== file.size ||
      entry.mode !== file.mode ||
      entry.type !== file.type ||
      entry.symlinkTarget !== file.symlinkTarget ||
      sha256(entryBytes(entry)) !== file.sha256
    )
      throw new ReleaseError('PACKAGE_INTEGRITY', 'Release archive member integrity failed.');
  }
  report('release-archive-verified', {
    fileCount: expected.size,
    durationMs: Math.round(performance.now() - started),
  });
  const root = await installationRoot(directory);
  const lock = await acquireLock(root);
  const token = randomUUID();
  const pending = inside(root, `versions/.pending-${token}`);
  let extracted = false;
  try {
    const previous = await state(root);
    if (previous) await verifyReference(root, previous.active, options);
    const id = `abr-${manifest.version}-${expectedSha256.slice(0, 12)}`;
    const final = inside(root, `versions/${id}`);
    const current = previous?.active;
    // Exact repeated installation retains the existing generation and verified payload.
    if (current?.id === id)
      return { active: id, previous: previous.previous?.id ?? null, changed: false };
    await mkdir(pending, { mode: 0o700 });
    extracted = true;
    await extractZip(entries, pending, true);
    await verifyDirectory(pending, manifest);
    const reference = {
      id,
      archiveSha256: expectedSha256,
      manifestSha256: sha256(entryBytes(manifestEntry)),
      channel: manifest.channel,
    };
    try {
      await rename(pending, final);
      extracted = false;
      await syncDirectory(path.dirname(final));
    } catch (error) {
      // A previous installed content-addressed version is reused only after full integrity verification.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      await verifyReference(root, reference, options);
    }
    await atomicJson(path.join(root, 'active-release.json'), {
      schemaVersion: 1,
      protocolMajor: 1,
      platform: process.platform,
      architecture: process.arch,
      generation: (previous?.generation ?? 0) + 1,
      active: reference,
      previous: current ?? null,
    });
    report('release-install-finished', {
      active: id,
      durationMs: Math.round(performance.now() - started),
    });
    return { active: id, previous: current?.id ?? null, changed: true };
  } finally {
    try {
      // Cleanup targets derive only from this allocated transaction and verified absolute root.
      if (extracted) {
        const resolved = await realpath(pending);
        if (
          path.dirname(resolved) !== (await realpath(path.join(root, 'versions'))) ||
          path.basename(resolved) !== `.pending-${token}` ||
          (await lstat(pending)).isSymbolicLink()
        )
          throw new ReleaseError('UNSAFE_CLEANUP', 'Update staging cleanup ownership is invalid.');
        await rm(resolved, { recursive: true });
      }
    } finally {
      await lock.handle.close();
      await rm(lock.filename);
    }
  }
}

/**
 * Verify the previous release and atomically restore its live pointer.
 * Args:
 *   directory (string): Owned installation root.
 *   options (object): Explicit development and publisher trust settings.
 * Returns:
 *   Promise<object>: Restored release and displaced release identifiers.
 */
export async function rollback(directory, options = {}) {
  const started = performance.now();
  const root = await installationRoot(directory);
  const lock = await acquireLock(root);
  try {
    const previous = await state(root);
    if (!previous?.previous)
      throw new ReleaseError('NO_ROLLBACK', 'No verified previous release is available.');
    await verifyReference(root, previous.previous, options);
    await atomicJson(path.join(root, 'active-release.json'), {
      ...previous,
      generation: previous.generation + 1,
      active: previous.previous,
      previous: previous.active,
    });
    report('release-rollback-finished', {
      active: previous.previous.id,
      durationMs: Math.round(performance.now() - started),
    });
    return { active: previous.previous.id, previous: previous.active.id };
  } finally {
    await lock.handle.close();
    await rm(lock.filename);
  }
}

/**
 * Resolve an active installation only after validating its complete inventory.
 * Args:
 *   directory (string): Owned installation root.
 *   options (object): Explicit development and publisher trust settings.
 * Returns:
 *   Promise<object>: Verified active directory and release metadata.
 */
export async function activeRelease(directory, options = {}) {
  const root = await installationRoot(directory);
  const current = await state(root);
  if (!current) throw new ReleaseError('NO_INSTALLATION', 'Installation has no active release.');
  return verifyReference(root, current.active, options);
}

/**
 * Dispatch the local update or rollback command without network publishing.
 * Args:
 *   argv (string[]): Command arguments.
 * Returns:
 *   Promise<void>: Completion of the verified local operation.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: 'string' },
      archive: { type: 'string' },
      sha256: { type: 'string' },
      'allow-unsigned-development': { type: 'boolean' },
      'trusted-keys': { type: 'string' },
    },
  });
  if (!parsed.values.root)
    throw new ReleaseError('INVALID_ARGUMENT', 'An installation root is required.');
  const options = {
    allowUnsignedDevelopment: parsed.values['allow-unsigned-development'] ?? false,
    ...(parsed.values['trusted-keys']
      ? { trustedKeys: await readJson(parsed.values['trusted-keys'], 65536) }
      : {}),
  };
  let result;
  if (parsed.positionals.join(' ') === 'install' && parsed.values.archive && parsed.values.sha256)
    result = await install(
      parsed.values.archive,
      parsed.values.sha256,
      parsed.values.root,
      options,
    );
  else if (parsed.positionals.join(' ') === 'rollback')
    result = await rollback(parsed.values.root, options);
  else
    throw new ReleaseError('INVALID_ARGUMENT', 'Select install with archive/checksum or rollback.');
  console.log(JSON.stringify(result));
}

// Direct invocation runs the bounded total-dispatch entry point.
if (isMain(import.meta.url)) void main().catch(fail);
