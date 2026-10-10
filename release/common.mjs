// -*- coding: utf-8 -*-
/**
 * common.mjs
 * Release filesystem and process primitives
 * =====================
 * Validate owned paths, run bounded build commands, and write durable local state.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** ReleaseError exposes stable diagnostic-safe release failures. */
export class ReleaseError extends Error {
  /**
   * Construct a classified release failure.
   * Args:
   *   code (string): Stable failure category.
   *   message (string): Fixed description excluding host paths and secrets.
   * Returns:
   *   ReleaseError: Classified operational failure.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Emit bounded release metadata on standard error.
 * Args:
 *   event (string): Operation category.
 *   fields (object): Safe identifiers, counts, hashes, and timings.
 * Returns:
 *   void: Completion of metadata output.
 */
export function report(event, fields = {}) {
  console.error(JSON.stringify({ event, ...fields }));
}

/**
 * Compute SHA256 over an owned byte value.
 * Args:
 *   value (Buffer | string): Bytes to hash.
 * Returns:
 *   string: Lowercase hexadecimal digest.
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Compute a file digest without buffering a large browser binary.
 * Args:
 *   filename (string): Owned regular file.
 * Returns:
 *   Promise<string>: Lowercase SHA256 digest.
 */
export async function fileSha256(filename) {
  const hash = createHash('sha256');
  // Consume bounded stream chunks while preserving binary contents.
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Read the exact bounded bytes from one regular-file handle before digest verification.
 * Args:
 *   filename (string): User-selected local archive or metadata file.
 *   maximum (number): Maximum permitted file length.
 * Returns:
 *   Promise<Buffer>: Exact bytes read from one verified descriptor.
 */
export async function boundedFile(filename, maximum) {
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum)
      throw new ReleaseError('ARCHIVE_LIMIT', 'Selected release file type or size is invalid.');
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    // Bind parsing and checksums to one bounded descriptor rather than separate pathname reads.
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0)
        throw new ReleaseError('ARCHIVE_CHECKSUM', 'Selected release file changed while reading.');
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0)
      throw new ReleaseError('ARCHIVE_LIMIT', 'Selected release file grew while reading.');
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Synchronize directory metadata where the native platform exposes that operation.
 * Args:
 *   directory (string): Owned directory whose child names changed.
 * Returns:
 *   Promise<boolean>: Whether directory synchronization was available and completed.
 */
export async function syncDirectory(directory) {
  // Windows directory flushing requires native handles outside the Node filesystem API.
  if (process.platform === 'win32') return false;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Encode an object with a deterministic recursive key order.
 * Args:
 *   value (unknown): JSON-compatible manifest or signed payload.
 * Returns:
 *   string: Canonical JSON text.
 */
export function canonicalJson(value) {
  // Preserve ordered arrays and sort only object member names.
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Validate a portable release-relative path before filesystem access.
 * Args:
 *   value (string): Forward-slash relative archive member.
 * Returns:
 *   string: Validated member path.
 */
export function memberPath(value) {
  // Reject platform aliases, traversal, control characters, and executable path redirection.
  if (
    typeof value !== 'string' ||
    !value ||
    value.normalize('NFC') !== value ||
    Buffer.byteLength(value) > 4096 ||
    /[\\:\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith('/')
  )
    throw new ReleaseError('INVALID_ARCHIVE', 'Release member path is invalid.');
  const segments = value.split('/');
  if (
    segments.length > 64 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[ .]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  )
    throw new ReleaseError('INVALID_ARCHIVE', 'Release member path is not portable.');
  return value;
}

/**
 * Resolve a validated member strictly beneath a selected root.
 * Args:
 *   root (string): Owned release or installation directory.
 *   member (string): Validated archive member.
 * Returns:
 *   string: Contained absolute filesystem path.
 */
export function inside(root, member) {
  const resolved = path.resolve(root, ...memberPath(member).split('/'));
  const relative = path.relative(path.resolve(root), resolved);
  // Verify final containment before mutating an installation directory.
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new ReleaseError('INVALID_ARCHIVE', 'Release member escapes its root.');
  return resolved;
}

/**
 * Enumerate regular files with deterministic paths and executable modes.
 * Args:
 *   root (string): Owned staging directory.
 *   prefix (string): Current relative subtree.
 * Returns:
 *   Promise<object[]>: Sorted regular member descriptors.
 */
export async function regularFiles(root, prefix = '') {
  const output = [];
  const directory = prefix ? inside(root, prefix) : root;
  // Native links and special files are excluded from distributable archives.
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const member = memberPath(prefix ? `${prefix}/${entry.name}` : entry.name);
    const filename = inside(root, member);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink())
      throw new ReleaseError('UNSAFE_PACKAGE', 'Release staging contains a symbolic link.');
    if (metadata.isDirectory()) output.push(...(await regularFiles(root, member)));
    else if (metadata.isFile())
      output.push({
        path: member,
        size: metadata.size,
        mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      });
    else throw new ReleaseError('UNSAFE_PACKAGE', 'Release staging contains a special file.');
  }
  return output;
}

/**
 * Validate relative link text while preserving native path component order.
 * Args:
 *   member (string): Link member path.
 *   target (string): Native relative link text.
 * Returns:
 *   string: Package-relative expression retaining directory aliases and parent components.
 */
export function linkMember(member, target) {
  if (
    typeof target !== 'string' ||
    !target ||
    target.normalize('NFC') !== target ||
    Buffer.byteLength(target) > 4096 ||
    target.startsWith('/') ||
    /[\\:\u0000-\u001f\u007f]/.test(target)
  )
    throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic link target is not portable.');
  // Preserve parent components until aliases have been expanded in native resolution order.
  for (const component of target.split('/'))
    if (component && component !== '.' && component !== '..') memberPath(component);
  const parent = path.posix.dirname(memberPath(member));
  return parent === '.' ? target : `${parent}/${target}`;
}

/**
 * Validate all relative links against existing package files and implicit directories.
 * Args:
 *   members (object[]): Complete archive or manifest member set.
 * Returns:
 *   Map: Verified link members and their final target type.
 */
export function validateLinks(members) {
  const files = new Map(members.map((member) => [memberPath(member.path), member]));
  const aliases = members.filter((member) => member.type === 'symlink');
  // Regular-only archives require no directory alias graph allocation.
  if (!aliases.length) return new Map();
  const directories = new Set();
  for (const member of members) {
    const pieces = member.path.split('/');
    for (let index = 1; index < pieces.length; index++) {
      directories.add(pieces.slice(0, index).join('/'));
      // Limit implicit directory metadata before constructing the traversal graph.
      if (directories.size > 50000)
        throw new ReleaseError('ARCHIVE_LIMIT', 'Package directory graph exceeds its limit.');
    }
  }
  const links = new Map();
  // Resolve each path component before interpreting subsequent parent traversal.
  for (const member of aliases) {
    const remaining = linkMember(member.path, member.symlinkTarget).split('/');
    const resolved = [];
    let expansions = 0;
    while (remaining.length) {
      const component = remaining.shift();
      if (!component || component === '.') continue;
      if (component === '..') {
        if (!resolved.length)
          throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic link escapes its root.');
        resolved.pop();
        continue;
      }
      resolved.push(component);
      const candidate = resolved.join('/');
      const entry = files.get(candidate);
      if (entry?.type === 'symlink') {
        if (++expansions > 64)
          throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic links contain a cycle.');
        // Retain the suffix after replacing a directory alias with its original relative text.
        linkMember(entry.path, entry.symlinkTarget);
        resolved.pop();
        remaining.unshift(...entry.symlinkTarget.split('/'));
      } else if (!entry && !directories.has(candidate))
        throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic link target is absent.');
      else if (entry && remaining.some((value) => value !== ''))
        throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic link traverses a file.');
    }
    const target = memberPath(resolved.join('/'));
    if (!files.has(target) && !directories.has(target))
      throw new ReleaseError('INVALID_ARCHIVE', 'Package symbolic link target is absent.');
    links.set(member.path, { target, type: directories.has(target) ? 'dir' : 'file' });
  }
  const graph = new Map();
  for (const directory of directories) {
    const parent = path.posix.dirname(directory);
    if (!graph.has(parent)) graph.set(parent, new Set());
    graph.get(parent).add(directory);
  }
  for (const [member, link] of links) {
    if (link.type === 'dir') {
      const parent = path.posix.dirname(member);
      if (!graph.has(parent)) graph.set(parent, new Set());
      graph.get(parent).add(link.target);
    }
  }
  const states = new Map();
  // Include directory traversal edges when rejecting cycles through directory aliases.
  for (const start of graph.keys()) {
    const pending = [{ node: start, exit: false }];
    while (pending.length) {
      const current = pending.pop();
      if (current.exit) {
        states.set(current.node, 2);
        continue;
      }
      if (states.get(current.node) === 2) continue;
      if (states.get(current.node) === 1)
        throw new ReleaseError('INVALID_ARCHIVE', 'Package directory aliases contain a cycle.');
      states.set(current.node, 1);
      pending.push({ node: current.node, exit: true });
      for (const child of graph.get(current.node) ?? []) pending.push({ node: child, exit: false });
    }
  }
  return links;
}

/**
 * Enumerate distributable files and preserved internal relative link identities.
 * Args:
 *   root (string): Owned package staging directory.
 *   prefix (string): Current subtree relative member.
 * Returns:
 *   Promise<object[]>: Deterministic regular and symbolic member descriptors.
 */
export async function archiveMembers(root, prefix = '') {
  const result = [];
  const directory = prefix ? inside(root, prefix) : root;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const member = memberPath(prefix ? `${prefix}/${entry.name}` : entry.name);
    const filename = inside(root, member);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(filename);
      linkMember(member, target);
      result.push({
        path: member,
        size: Buffer.byteLength(target),
        mode: 0o777,
        type: 'symlink',
        symlinkTarget: target,
      });
    } else if (metadata.isDirectory()) result.push(...(await archiveMembers(root, member)));
    else if (metadata.isFile())
      result.push({
        path: member,
        size: metadata.size,
        mode: metadata.mode & 0o111 ? 0o755 : 0o644,
      });
    else
      throw new ReleaseError(
        'UNSAFE_PACKAGE',
        'Package staging contains an unsupported file type.',
      );
  }
  return result;
}

/**
 * Allocate a marked task-owned temporary directory.
 * Args:
 *   label (string): Portable task category.
 * Returns:
 *   Promise<string>: Exclusive marked temporary root.
 */
export async function temporaryRoot(label = 'work') {
  const directory = await mkdtemp(path.join(tmpdir(), `abr-release-${label}-`));
  await writeFile(path.join(directory, '.abr-release-owned'), 'schemaVersion=1\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return directory;
}

/**
 * Remove only an allocated and marked temporary release tree.
 * Args:
 *   directory (string): Previously allocated task root.
 * Returns:
 *   Promise<void>: Completion of bounded temporary cleanup.
 */
export async function cleanTemporary(directory) {
  const resolved = await realpath(directory);
  const temporary = await realpath(tmpdir());
  const metadata = await lstat(directory);
  // Resolve and verify the absolute target before recursive cleanup on Windows.
  if (
    path.dirname(resolved) !== temporary ||
    !path.basename(resolved).startsWith('abr-release-') ||
    metadata.isSymbolicLink() ||
    (await readFile(path.join(resolved, '.abr-release-owned'), 'utf8')) !== 'schemaVersion=1\n'
  )
    throw new ReleaseError('UNSAFE_CLEANUP', 'Temporary cleanup ownership is invalid.');
  await rm(resolved, { recursive: true });
}

/**
 * Flush JSON state and replace its live pointer with an atomic rename.
 * Args:
 *   filename (string): Owned pointer or manifest path.
 *   value (object): Validated state.
 * Returns:
 *   Promise<void>: Completion of atomic replacement and supported directory synchronization.
 */
export async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}-${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  await syncDirectory(path.dirname(filename));
}

/**
 * Run an explicitly selected build process with output and time bounds.
 * Args:
 *   executable (string): Verified executable or operating-system command.
 *   args (string[]): Structured command arguments.
 *   options (object): Working directory, environment, timeout, and safe event label.
 * Returns:
 *   Promise<string>: Captured standard output for metadata parsing.
 */
export function command(executable, args, options = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const chunks = [];
    let total = 0;
    let failed;
    const timer = setTimeout(() => {
      failed = new ReleaseError('BUILD_TIMEOUT', 'Release subprocess deadline expired.');
      child.kill();
    }, options.timeoutMs ?? 120000);
    /**
     * Bound subprocess output without exposing build paths in diagnostics.
     * Args:
     *   chunk (Buffer): Current output bytes.
     *   capture (boolean): Whether bytes contribute to parsed standard output.
     * Returns:
     *   void: Completion of byte accounting.
     */
    function consume(chunk, capture) {
      total += chunk.length;
      if (total > (options.maxBytes ?? 32 * 1024 * 1024)) {
        failed = new ReleaseError(
          'BUILD_OUTPUT_LIMIT',
          'Release subprocess output limit exceeded.',
        );
        child.kill();
      } else if (capture || options.captureStderr) chunks.push(chunk);
    }
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.once('error', () => {
      failed = new ReleaseError('BUILD_UNAVAILABLE', 'Release subprocess is unavailable.');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      report(options.label ?? 'release-command-finished', {
        durationMs: Math.round(performance.now() - started),
        succeeded: code === 0 && !failed,
      });
      if (failed || code !== 0)
        reject(failed ?? new ReleaseError('BUILD_FAILED', 'Release subprocess failed.'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Resolve the configured Rust executable from the user-managed toolchain.
 * Args:
 *   name (string): Rust command basename.
 * Returns:
 *   string: Portable user toolchain path.
 */
export function rustCommand(name) {
  return path.join(
    process.env.CARGO_HOME ?? path.join(homedir(), '.cargo'),
    'bin',
    `${name}${process.platform === 'win32' ? '.exe' : ''}`,
  );
}

/**
 * Resolve the pinned Corepack JavaScript entry point for shell-free invocation.
 * Args:
 *   None.
 * Returns:
 *   string: Node-install-relative Corepack script.
 */
export function corepackScript() {
  const binaryDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(binaryDirectory, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(binaryDirectory, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    ...(process.env.COREPACK_ROOT
      ? [path.join(process.env.COREPACK_ROOT, 'dist', 'corepack.js')]
      : []),
  ];
  const resolved = candidates.find(existsSync);
  if (!resolved)
    throw new ReleaseError('TOOLCHAIN_UNAVAILABLE', 'Pinned Corepack installation is unavailable.');
  return resolved;
}

/**
 * Determine whether a module is the directly selected command entry point.
 * Args:
 *   url (string): Current import metadata URL.
 * Returns:
 *   boolean: Whether the current process selected this module.
 */
export function isMain(url) {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url));
}

/**
 * Report a classified command failure without untrusted exception text.
 * Args:
 *   error (unknown): Operational failure.
 * Returns:
 *   void: Completion of bounded failure reporting.
 */
export function fail(error) {
  report('release-failed', {
    code: error instanceof ReleaseError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof ReleaseError ? error.message : 'Release operation failed.',
  });
  process.exitCode = 1;
}
