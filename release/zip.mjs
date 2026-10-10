// -*- coding: utf-8 -*-
/**
 * zip.mjs
 * Bounded portable release archives
 * =====================
 * Preserve regular files and sealed internal link identities with pre-extraction validation.
 */
import { mkdir, open, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { crc32 as nativeCrc32, deflateRawSync, inflateRawSync } from 'node:zlib';

import {
  ReleaseError,
  archiveMembers,
  inside,
  memberPath,
  syncDirectory,
  validateLinks,
} from './common.mjs';

const FILE_LIMIT = 512 * 1024 * 1024;
const TOTAL_LIMIT = 4 * 1024 * 1024 * 1024;
const ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * Compute the standard ZIP CRC32 over a byte value.
 * Args:
 *   bytes (Buffer): Uncompressed member bytes.
 * Returns:
 *   number: Unsigned CRC32 value.
 */
export function crc32(bytes) {
  return nativeCrc32(bytes) >>> 0;
}

/**
 * Write a deterministic ZIP containing regular files and portable executable modes.
 * Args:
 *   directory (string): Verified owned staging directory.
 *   filename (string): Exclusive output archive path.
 * Returns:
 *   Promise<object>: Archive file count and byte size.
 */
export async function writeZip(directory, filename) {
  const files = await archiveMembers(directory);
  validateLinks(files);
  if (files.length > 65534)
    throw new ReleaseError('ARCHIVE_LIMIT', 'Release file count exceeds ZIP limits.');
  const output = await open(filename, 'wx', 0o600);
  const central = [];
  let offset = 0;
  let total = 0;
  try {
    // Compress members independently so browser assets retain bounded peak allocation.
    for (const file of files) {
      total += file.size;
      if (file.size > FILE_LIMIT || total > TOTAL_LIMIT)
        throw new ReleaseError('ARCHIVE_LIMIT', 'Release uncompressed size exceeds limits.');
      const name = Buffer.from(file.path, 'utf8');
      const data =
        file.type === 'symlink'
          ? Buffer.from(file.symlinkTarget, 'utf8')
          : await readFile(inside(directory, file.path));
      const compressed = deflateRawSync(data, { level: 6 });
      const checksum = crc32(data);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12);
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE((3 << 8) | 20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(8, 10);
      record.writeUInt16LE(33, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(
        (((file.type === 'symlink' ? 0o120000 : 0o100000) | file.mode) << 16) >>> 0,
        38,
      );
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      await output.write(header);
      await output.write(name);
      await output.write(compressed);
      offset += header.length + name.length + compressed.length;
      if (offset > ARCHIVE_LIMIT)
        throw new ReleaseError('ARCHIVE_LIMIT', 'Release archive size exceeds limits.');
    }
    const table = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(table.length, 12);
    end.writeUInt32LE(offset, 16);
    await output.write(table);
    await output.write(end);
    await output.sync();
    return { fileCount: files.length, bytes: offset + table.length + end.length };
  } finally {
    await output.close();
  }
}

/**
 * Validate a ZIP central directory and each local member before any extraction.
 * Args:
 *   bytes (Buffer): Checksum-verified archive bytes.
 * Returns:
 *   object[]: Validated bounded member descriptors and compressed byte ranges.
 */
export function zipEntries(bytes) {
  if (bytes.length < 22 || bytes.length > ARCHIVE_LIMIT)
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive length is invalid.');
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive footer is invalid.');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (count !== bytes.readUInt16LE(end + 8) || start + size !== end)
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive directory is invalid.');
  const names = new Set();
  const entries = [];
  let cursor = start;
  let total = 0;
  let previousEnd = 0;
  // Validate all paths, file types, sizes, and overlapping ranges before returning data.
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new ReleaseError('INVALID_ARCHIVE', 'Archive member header is invalid.');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const offset = bytes.readUInt32LE(cursor + 42);
    if (
      flags !== 0x800 ||
      method !== 8 ||
      bytes.readUInt16LE(cursor + 30) ||
      bytes.readUInt16LE(cursor + 32) ||
      bytes.readUInt16LE(cursor + 34) ||
      ![0o100000, 0o120000].includes(mode & 0o170000) ||
      mode & 0o7000 ||
      size > FILE_LIMIT
    )
      throw new ReleaseError(
        'INVALID_ARCHIVE',
        'Archive member encoding or file type is unsupported.',
      );
    if (cursor + 46 + nameSize > end)
      throw new ReleaseError('INVALID_ARCHIVE', 'Archive member name is truncated.');
    const encoded = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = memberPath(encoded.toString('utf8'));
    if (!Buffer.from(name, 'utf8').equals(encoded) || names.has(name.toLowerCase()))
      throw new ReleaseError('INVALID_ARCHIVE', 'Archive member names collide or are invalid.');
    names.add(name.toLowerCase());
    if (
      offset !== previousEnd ||
      offset + 30 + nameSize + compressedSize > start ||
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method ||
      bytes.readUInt32LE(offset + 14) !== checksum ||
      bytes.readUInt32LE(offset + 18) !== compressedSize ||
      bytes.readUInt32LE(offset + 22) !== size ||
      bytes.readUInt16LE(offset + 26) !== nameSize ||
      bytes.readUInt16LE(offset + 28) !== 0 ||
      !bytes.subarray(offset + 30, offset + 30 + nameSize).equals(encoded)
    )
      throw new ReleaseError('INVALID_ARCHIVE', 'Archive local member identity is invalid.');
    total += size;
    if (total > TOTAL_LIMIT)
      throw new ReleaseError('ARCHIVE_LIMIT', 'Archive expansion exceeds limits.');
    const descriptor = {
      path: name,
      size,
      mode: mode & 0o777,
      checksum,
      data: bytes.subarray(offset + 30 + nameSize, offset + 30 + nameSize + compressedSize),
    };
    if ((mode & 0o170000) === 0o120000) {
      if (size > 4096 || descriptor.mode !== 0o777)
        throw new ReleaseError('INVALID_ARCHIVE', 'Archive symbolic link identity exceeds limits.');
      const target = entryBytes(descriptor);
      descriptor.type = 'symlink';
      descriptor.symlinkTarget = target.toString('utf8');
      if (!Buffer.from(descriptor.symlinkTarget, 'utf8').equals(target))
        throw new ReleaseError('INVALID_ARCHIVE', 'Archive symbolic target encoding is invalid.');
    }
    entries.push(descriptor);
    previousEnd = offset + 30 + nameSize + compressedSize;
    cursor += 46 + nameSize;
  }
  if (cursor !== end || previousEnd !== start)
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive contains unindexed bytes.');
  // Reject file/directory aliases before extraction allocates any transaction data.
  for (const name of names) {
    const pieces = name.split('/');
    for (let index = 1; index < pieces.length; index++)
      if (names.has(pieces.slice(0, index).join('/')))
        throw new ReleaseError('INVALID_ARCHIVE', 'Archive file and directory identities collide.');
  }
  validateLinks(entries);
  return entries;
}

/**
 * Decode one member with exact size and CRC validation.
 * Args:
 *   entry (object): Previously validated archive descriptor.
 * Returns:
 *   Buffer: Verified uncompressed member bytes.
 */
export function entryBytes(entry) {
  let result;
  try {
    result = inflateRawSync(entry.data, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive compressed member is invalid.');
  }
  if (result.length !== entry.size || crc32(result) !== entry.checksum)
    throw new ReleaseError('INVALID_ARCHIVE', 'Archive member checksum is invalid.');
  return result;
}

/**
 * Extract regular files before creating validated internal relative aliases.
 * Args:
 *   entries (object[]): Fully validated central directory.
 *   directory (string): New exclusive staging directory.
 *   allocated (boolean): Whether the caller already exclusively allocated this root.
 * Returns:
 *   Promise<void>: Completion of bounded extraction.
 */
export async function extractZip(entries, directory, allocated = false) {
  if (!allocated) await mkdir(directory, { mode: 0o700 });
  // Exclusive creation prevents replacing preexisting application data or profile files.
  const directories = new Set([directory]);
  const links = validateLinks(entries);
  if (process.platform === 'win32' && links.size)
    throw new ReleaseError('PLATFORM_MISMATCH', 'Windows extraction requires regular members.');
  for (const entry of entries.filter((value) => value.type !== 'symlink')) {
    const filename = inside(directory, entry.path);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    let parent = path.dirname(filename);
    while (parent !== directory) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
    const handle = await open(filename, 'wx', entry.mode);
    try {
      await handle.writeFile(entryBytes(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  // Create aliases only after all regular members exist inside the exclusive owned root.
  for (const entry of entries.filter((value) => value.type === 'symlink')) {
    const filename = inside(directory, entry.path);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    let parent = path.dirname(filename);
    while (parent !== directory) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
    await symlink(entry.symlinkTarget, filename, links.get(entry.path).type);
  }
  // Persist child directory entries before installing the version directory's final name.
  for (const current of [...directories].sort((a, b) => b.length - a.length))
    await syncDirectory(current);
}
