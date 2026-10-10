// -*- coding: utf-8 -*-
/**
 * manifest.mjs
 * Release inventory and publisher verification
 * =====================
 * Validate platform, protocol, component metadata, member hashes, and trusted signatures.
 */
import { createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import {
  ReleaseError,
  archiveMembers,
  canonicalJson,
  fileSha256,
  inside,
  memberPath,
  sha256,
  validateLinks,
} from './common.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const TOP_FIELDS = [
  'schemaVersion',
  'format',
  'version',
  'protocolMajor',
  'platform',
  'architecture',
  'channel',
  'artifactType',
  'createdAt',
  'components',
  'source',
  'features',
  'files',
];

/**
 * Construct a release inventory from actual regular staging files.
 * Args:
 *   directory (string): Owned release staging root.
 * Returns:
 *   Promise<object[]>: Deterministic path, size, mode, and SHA256 inventory.
 */
export async function inventory(directory) {
  const files = await archiveMembers(directory);
  const result = [];
  // Exclude only the signed manifest and its signature envelope from recursive inventory.
  for (const file of files) {
    if (['version-manifest.json', 'release-signature.json'].includes(file.path)) continue;
    result.push({
      ...file,
      sha256:
        file.type === 'symlink'
          ? sha256(file.symlinkTarget)
          : await fileSha256(inside(directory, file.path)),
    });
  }
  return result;
}

/**
 * Validate closed release metadata before signature checks or filesystem writes.
 * Args:
 *   manifest (object): Parsed version manifest.
 * Returns:
 *   object: Validated release metadata.
 */
export function validateManifest(manifest) {
  // Validate identity fields before interpreting member or component metadata.
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).some((key) => !TOP_FIELDS.includes(key)) ||
    TOP_FIELDS.some((key) => !(key in manifest)) ||
    manifest.schemaVersion !== 1 ||
    manifest.format !== 'abr-portable-release-v1' ||
    manifest.artifactType !== 'portable-zip' ||
    manifest.protocolMajor !== 1 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    !['win32', 'darwin', 'linux'].includes(manifest.platform) ||
    !['x64', 'arm64'].includes(manifest.architecture) ||
    !['development', 'signed'].includes(manifest.channel) ||
    typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 60000
  )
    throw new ReleaseError('INVALID_MANIFEST', 'Release identity or protocol fields are invalid.');
  const names = new Set();
  let total = 0;
  // Close member records and reject aliases across case-insensitive target filesystems.
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      Object.keys(file).sort().join(',') !==
        (file.type === 'symlink'
          ? 'mode,path,sha256,size,symlinkTarget,type'
          : 'mode,path,sha256,size') ||
      !DIGEST.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 512 * 1024 * 1024 ||
      !(file.type === 'symlink'
        ? file.mode === 0o777 &&
          typeof file.symlinkTarget === 'string' &&
          Buffer.byteLength(file.symlinkTarget) === file.size &&
          sha256(file.symlinkTarget) === file.sha256
        : [0o644, 0o755].includes(file.mode))
    )
      throw new ReleaseError('INVALID_MANIFEST', 'Release member metadata is invalid.');
    const name = memberPath(file.path);
    if (
      ['version-manifest.json', 'release-signature.json'].includes(name) ||
      names.has(name.toLowerCase())
    )
      throw new ReleaseError('INVALID_MANIFEST', 'Release inventory member identity is invalid.');
    names.add(name.toLowerCase());
    total += file.size;
  }
  if (total > 4 * 1024 * 1024 * 1024)
    throw new ReleaseError('INVALID_MANIFEST', 'Release inventory exceeds size limits.');
  // A member file cannot also act as another member's parent directory.
  for (const name of names) {
    const pieces = name.split('/');
    for (let index = 1; index < pieces.length; index++)
      if (names.has(pieces.slice(0, index).join('/')))
        throw new ReleaseError(
          'INVALID_MANIFEST',
          'Release member directory identity collides with a file.',
        );
  }
  const markers = manifest.components?.playwright?.mutableMarkers ?? [];
  validateLinks(manifest.files);
  if (
    !Array.isArray(markers) ||
    markers.length > 4 ||
    markers.some(
      (value) =>
        typeof value !== 'string' ||
        !/^browsers\/(?:chromium|chromium_headless_shell|ffmpeg|winldd)-[0-9]+\/DEPENDENCIES_VALIDATED$/.test(
          value,
        ),
    )
  )
    throw new ReleaseError('INVALID_MANIFEST', 'Runtime browser marker declarations are invalid.');
  const queue = [
    { value: manifest.components, depth: 0 },
    { value: manifest.source, depth: 0 },
    { value: manifest.features, depth: 0 },
  ];
  let entries = 0;
  // Bound signed metadata depth before canonical encoding to prevent recursive exhaustion.
  while (queue.length) {
    const { value, depth } = queue.pop();
    if (depth > 16 || ++entries > 100000)
      throw new ReleaseError('INVALID_MANIFEST', 'Release component metadata exceeds limits.');
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
    else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null)
      throw new ReleaseError('INVALID_MANIFEST', 'Release component metadata is invalid.');
  }
  return manifest;
}

/**
 * Verify an Ed25519 publisher signature against explicitly configured trust anchors.
 * Args:
 *   manifest (object): Validated release metadata.
 *   envelope (object | undefined): Detached publisher signature.
 *   options (object): Trusted key records and development opt-in.
 * Returns:
 *   object: Verified channel and publisher identity.
 */
export function verifyPublisher(manifest, envelope, options = {}) {
  // Development assets require an explicit local installation choice.
  if (manifest.channel === 'development') {
    if (!options.allowUnsignedDevelopment || envelope)
      throw new ReleaseError(
        'SIGNATURE_REQUIRED',
        'Unsigned development installation requires explicit opt-in.',
      );
    return { channel: 'development', keyId: null };
  }
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !== 'algorithm,keyId,signature' ||
    envelope.algorithm !== 'Ed25519' ||
    typeof envelope.keyId !== 'string' ||
    typeof envelope.signature !== 'string'
  )
    throw new ReleaseError('SIGNATURE_REQUIRED', 'A trusted publisher signature is required.');
  const trusted = options.trustedKeys?.find((key) => key.keyId === envelope.keyId);
  if (!trusted)
    throw new ReleaseError(
      'UNTRUSTED_PUBLISHER',
      'Publisher key is outside the configured trust anchors.',
    );
  let signature;
  let key;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
    key = createPublicKey(trusted.publicKey);
  } catch {
    throw new ReleaseError('SIGNATURE_INVALID', 'Publisher signature key is invalid.');
  }
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== envelope.signature ||
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, Buffer.from(canonicalJson(manifest)), key, signature)
  )
    throw new ReleaseError('SIGNATURE_INVALID', 'Publisher signature verification failed.');
  return { channel: 'signed', keyId: envelope.keyId };
}

/**
 * Verify every installed member and reject extra files or redirected directories.
 * Args:
 *   directory (string): Owned staged or installed release.
 *   manifest (object): Validated expected inventory.
 * Returns:
 *   Promise<void>: Completion of full installed integrity verification.
 */
export async function verifyDirectory(directory, manifest) {
  const actual = await archiveMembers(directory);
  validateLinks(actual);
  const markers = new Set(manifest.components?.playwright?.mutableMarkers ?? []);
  for (const file of actual)
    if (markers.has(file.path) && file.size !== 0)
      throw new ReleaseError(
        'PACKAGE_INTEGRITY',
        'Browser dependency validation marker is invalid.',
      );
  const files = new Map(
    actual
      .filter(
        (file) =>
          !['version-manifest.json', 'release-signature.json'].includes(file.path) &&
          !markers.has(file.path),
      )
      .map((file) => [file.path, file]),
  );
  if (files.size !== manifest.files.length)
    throw new ReleaseError(
      'PACKAGE_INTEGRITY',
      'Installed release inventory differs from its manifest.',
    );
  // Verify byte lengths, hashes, and portable executable mode declarations.
  for (const expected of manifest.files) {
    const file = files.get(expected.path);
    if (expected.type === 'symlink') {
      if (
        !file ||
        file.type !== 'symlink' ||
        file.symlinkTarget !== expected.symlinkTarget ||
        sha256(file.symlinkTarget) !== expected.sha256
      )
        throw new ReleaseError(
          'PACKAGE_INTEGRITY',
          'Installed package symbolic link identity changed.',
        );
      continue;
    }
    if (
      !file ||
      file.type === 'symlink' ||
      file.size !== expected.size ||
      (process.platform !== 'win32' && file.mode !== expected.mode) ||
      (await fileSha256(inside(directory, expected.path))) !== expected.sha256
    )
      throw new ReleaseError('PACKAGE_INTEGRITY', 'Installed release member integrity failed.');
  }
}

/**
 * Read bounded JSON metadata with classified parsing failures.
 * Args:
 *   filename (string): Owned manifest, pointer, or key file.
 *   maximum (number): Maximum permitted byte length.
 * Returns:
 *   Promise<object>: Parsed JSON metadata.
 */
export async function readJson(filename, maximum = 16 * 1024 * 1024) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum)
    throw new ReleaseError('INVALID_MANIFEST', 'Release metadata file type or size is invalid.');
  const bytes = await readFile(filename);
  if (bytes.length > maximum)
    throw new ReleaseError('INVALID_MANIFEST', 'Release metadata size exceeds limits.');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ReleaseError('INVALID_MANIFEST', 'Release metadata JSON is invalid.');
  }
}
