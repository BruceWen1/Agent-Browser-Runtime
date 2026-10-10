// -*- coding: utf-8 -*-
/**
 * common.mjs
 * Audited Chromium build primitives
 * =====================
 * Validate external paths, immutable pins, subprocess boundaries, and safe build diagnostics.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism, arch, platform, release, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CHROMIUM_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const GIB = 1024 ** 3;
export const SOURCE_ORIGINS = {
  upstream: 'https://chromium.googlesource.com/chromium/src.git',
  mirror: 'https://github.com/chromium/chromium.git',
};

/**
 * Create an error with a stable gate identifier and non-secret explanatory message.
 * Args:
 *   code (string): Stable preflight or build failure category.
 *   message (string): Fixed technical explanation.
 * Returns:
 *   Error: Categorized error for safe CLI reporting.
 */
export function gateError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Hash an artifact using SHA-256.
 * Args:
 *   bytes (string | Uint8Array): Complete artifact contents.
 * Returns:
 *   string: Lowercase content digest.
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Classify bounded tool diagnostics into fixed actionable categories without raw text.
 * Args:
 *   text (string): Bounded transient official tool output retained in memory only.
 * Returns:
 *   object: Safe fixed category and an optional known missing executable name.
 */
export function classifyToolFailure(text) {
  const knownBinaries = [
    'git.bat',
    'python3.exe',
    'vpython3.exe',
    'gn.exe',
    'ninja.exe',
    'siso.exe',
    'rc.exe',
    'dbghelp.dll',
  ];
  // Missing-file categories preserve known executable names while excluding paths and message bodies.
  if (/FileNotFoundError|WinError 2\b|ENOENT|No such file or directory/i.test(text)) {
    const binary = knownBinaries.find((name) => text.includes(name));
    return {
      code: binary === 'git.bat' ? 'OFFICIAL_GIT_WRAPPER_MISSING' : 'TOOL_DEPENDENCY_MISSING',
      ...(binary ? { binary } : {}),
    };
  }
  // Network and resource failures use fixed source-independent diagnostic identifiers.
  if (
    /certificate verify failed|CERT_HAS_EXPIRED|CERTIFICATE_VERIFY_FAILED|SSL certificate problem/i.test(
      text,
    )
  )
    return { code: 'TLS_CERTIFICATE_VALIDATION_FAILED' };
  if (/curl 28\b|operation timed out|connection timed out|ETIMEDOUT/i.test(text))
    return { code: 'NETWORK_TIMEOUT' };
  if (/not enough disk space|no space left on device|ENOSPC/i.test(text))
    return { code: 'SOURCE_DISK_FULL' };
  if (/permission denied|access is denied|EACCES/i.test(text))
    return { code: 'TOOL_PERMISSION_DENIED' };
  if (/checksum mismatch|hash mismatch/i.test(text)) return { code: 'TOOL_CONTENT_HASH_MISMATCH' };
  if (/unknown build argument|unknown GN argument/i.test(text))
    return { code: 'GN_ARGUMENT_UNSUPPORTED' };
  // Native build tools emit failed action details on either output stream.
  if (/build failure|build failed|FAILED:|fatal error:|error C\d{4}/i.test(text))
    return { code: 'NATIVE_BUILD_FAILED' };
  return { code: 'TOOL_FAILED' };
}

/**
 * Compare dotted numeric toolchain versions.
 * Args:
 *   actual (string): Installed version.
 *   minimum (string): Required version from the verified build requirements.
 * Returns:
 *   boolean: Whether the installed version satisfies the minimum.
 */
export function versionAtLeast(actual, minimum) {
  // Missing or malformed native version strings cannot satisfy a prerequisite gate.
  if (!/^\d+(?:\.\d+)*$/.test(actual) || !/^\d+(?:\.\d+)*$/.test(minimum)) return false;
  const first = actual.split('.').map(Number);
  const second = minimum.split('.').map(Number);
  // Compare every numeric component without lexicographic version ordering.
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

/**
 * Read the committed Chromium version and patch lock.
 * Args:
 *   filename (string): Explicit lock path, defaulting to the repository lock.
 * Returns:
 *   Promise<object>: Structurally validated exact version configuration.
 */
export async function readVersionLock(filename = path.join(CHROMIUM_ROOT, 'VERSION.lock')) {
  const lock = JSON.parse(await readFile(filename, 'utf8'));
  // Exact tags and complete source hashes form the immutable upstream identity.
  if (
    lock.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(lock.upstreamTag) ||
    !/^[a-f0-9]{40}$/.test(lock.upstreamCommit) ||
    lock.upstreamRepository !== SOURCE_ORIGINS.upstream ||
    lock.upstreamMirror !== SOURCE_ORIGINS.mirror ||
    lock.depotToolsRepository !==
      'https://chromium.googlesource.com/chromium/tools/depot_tools.git' ||
    !Array.isArray(lock.patches) ||
    !/^\d+\.\d+\.\d+$/.test(lock.playwrightVersion) ||
    !Array.isArray(lock.buildArguments) ||
    !Array.isArray(lock.targets)
  )
    throw gateError('INVALID_VERSION_LOCK', 'Version lock is incomplete or malformed.');
  // Optional preparation hashes become mandatory at their corresponding execution gate.
  if (lock.depsSha256 !== null && !/^[a-f0-9]{64}$/.test(lock.depsSha256))
    throw gateError('INVALID_VERSION_LOCK', 'DEPS digest is malformed.');
  if (lock.depotToolsCommit !== null && !/^[a-f0-9]{40}$/.test(lock.depotToolsCommit))
    throw gateError('INVALID_VERSION_LOCK', 'depot_tools commit is malformed.');
  return lock;
}

/**
 * Test whether a filesystem path exists without swallowing unrelated failures.
 * Args:
 *   filename (string): Explicit filesystem path.
 * Returns:
 *   Promise<boolean>: Whether the path currently exists.
 */
export async function exists(filename) {
  // Only absence is interpreted as a missing preparation artifact.
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Resolve a configurable source root outside the application repository.
 * Args:
 *   value (string): Absolute checkout root with shell-safe path components.
 *   repositoryRoot (string): Application repository root used for containment checks.
 * Returns:
 *   Promise<string>: Validated absolute external checkout root.
 */
export async function validateCheckoutRoot(value, repositoryRoot = REPOSITORY_ROOT) {
  // Source and depot_tools paths are restricted before they reach official batch wrappers.
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    /[\s% !^&|<>"'`$;]/.test(value) ||
    value.startsWith('\\\\')
  )
    throw gateError(
      'INVALID_CHECKOUT_PATH',
      'Use an absolute local source directory without spaces or shell metacharacters.',
    );
  const resolved = path.resolve(value);
  // Reject logical drive roots before filesystem aliases resolve to another directory.
  if (resolved === path.parse(resolved).root)
    throw gateError('INVALID_CHECKOUT_PATH', 'Use a dedicated external source directory.');
  let existing = resolved;
  const suffix = [];
  // Resolve the closest existing ancestor while preserving the requested child path.
  while (!(await exists(existing))) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing)
      throw gateError('INVALID_CHECKOUT_PATH', 'Source volume is unavailable.');
    existing = parent;
  }
  let inspected = existing;
  // Reject path redirection through every existing directory component.
  while (true) {
    if ((await lstat(inspected)).isSymbolicLink())
      throw gateError(
        'INVALID_CHECKOUT_PATH',
        'Source ancestors must be ordinary local directories.',
      );
    const parent = path.dirname(inspected);
    if (parent === inspected) break;
    inspected = parent;
  }
  const canonical = path.join(await realpath(existing), ...suffix);
  const repository = await realpath(repositoryRoot);
  const relative = path.relative(repository, canonical);
  const outsideRepository =
    relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  // The source tree remains outside the application workspace and outside the volume root.
  if (!relative || !outsideRepository || canonical === path.parse(canonical).root)
    throw gateError(
      'INVALID_CHECKOUT_PATH',
      'Chromium checkout must remain outside the application repository and volume root.',
    );
  return canonical;
}

/**
 * Write a structured safe phase audit record.
 * Args:
 *   directory (string): Owned audit directory.
 *   record (object): Non-secret phase metadata.
 * Returns:
 *   Promise<void>: Durable audit append and stderr progress output.
 */
export async function audit(directory, record) {
  const entry = { timestamp: new Date().toISOString(), ...record };
  await mkdir(directory, { recursive: true });
  await appendFile(path.join(directory, 'pipeline.jsonl'), JSON.stringify(entry) + '\n', {
    mode: 0o600,
  });
  process.stderr.write(JSON.stringify(entry) + '\n');
}

/**
 * Build a process-local official toolchain environment without changing the user PATH.
 * Args:
 *   depotTools (string): Configurable official depot_tools directory.
 * Returns:
 *   NodeJS.ProcessEnv: Restricted inherited environment with the official isolated Python route.
 */
export function toolchainEnvironment(depotTools) {
  const names = [
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'vs2026_install',
    'GIT_SSL_CAINFO',
    'SSL_CERT_FILE',
  ];
  const environment = {};
  // Preserve only variables needed by the official build tools and OS session.
  for (const name of names) if (process.env[name]) environment[name] = process.env[name];
  const inheritedPath = process.env.Path ?? process.env.PATH ?? '';
  environment.PATH = depotTools + path.delimiter + inheritedPath;
  environment.DEPOT_TOOLS_WIN_TOOLCHAIN = '0';
  environment.DEPOT_TOOLS_UPDATE = '0';
  environment.PYTHONUTF8 = '1';
  return environment;
}

/**
 * Stop the explicitly owned tool tree when its configured deadline expires.
 * Args:
 *   child (ChildProcess): Process created by this pipeline invocation.
 * Returns:
 *   void: Requested termination of its owned native process group.
 */
function stopOwnedTool(child) {
  // A process without a concrete owned PID has no safe termination target.
  if (!Number.isInteger(child.pid) || child.pid < 1) return;
  // Windows tree termination targets only the process created for this phase.
  if (process.platform === 'win32') {
    const taskkill = path.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? '',
      'System32',
      'taskkill.exe',
    );
    const terminator = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    terminator.once('error', () => child.kill());
  } else {
    // Detached native tools have an exclusive process group for cancellation.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Execute an audited native tool with bounded time and captured diagnostic digests.
 * Args:
 *   executable (string): Native executable or validated official batch wrapper.
 *   args (string[]): Explicit argument array.
 *   options (object): Owned working directory, environment, phase, audit path, and timeout.
 * Returns:
 *   Promise<object>: Exit metadata and bounded output for readonly parsers.
 */
export async function runTool(executable, args, options) {
  const started = performance.now();
  let launchExecutable = executable;
  let launchArguments = args;
  // Official Windows batch wrappers execute only closed, shell-safe argument strings.
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(executable)) {
    if ([executable, ...args].some((argument) => /[\s% !^&|<>"'`$;]/.test(argument)))
      throw gateError(
        'INVALID_TOOL_ARGUMENT',
        'Batch tool arguments contain unsupported shell characters.',
      );
    launchExecutable = path.join(
      process.env.SystemRoot ?? process.env.WINDIR ?? '',
      'System32',
      'cmd.exe',
    );
    launchArguments = ['/d', '/s', '/c', 'call ' + [executable, ...args].join(' ')];
  }
  await audit(options.auditDirectory, {
    phase: options.phase,
    state: 'started',
    tool: path.basename(executable),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(launchExecutable, launchArguments, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let diagnosticTail = '';
    const stdoutDigest = createHash('sha256');
    const stderrDigest = createHash('sha256');
    let finished = false;
    let timedOut = false;
    let resourceFailure;
    let diskQueryActive = false;
    // Long source/build phases retain a measured free-space reserve throughout execution.
    const diskMonitor = options.diskReserveRoot
      ? setInterval(() => {
          if (finished || resourceFailure || diskQueryActive) return;
          diskQueryActive = true;
          statfs(options.diskReserveRoot, { bigint: true })
            .then((volume) => {
              if (finished || timedOut) return;
              const freeGiB = Number(volume.bavail * volume.bsize) / GIB;
              if (freeGiB < (options.minimumFreeDiskGiB ?? 20)) {
                resourceFailure = 'SOURCE_DISK_RESERVE_EXHAUSTED';
                stopOwnedTool(child);
              }
            })
            .catch(() => {
              if (!finished && !timedOut) {
                resourceFailure = 'DISK_MONITOR_FAILED';
                stopOwnedTool(child);
              }
            })
            .finally(() => {
              diskQueryActive = false;
            });
        }, options.diskCheckIntervalMs ?? 5000)
      : undefined;
    const heartbeat = setInterval(() => {
      process.stderr.write(
        JSON.stringify({
          phase: options.phase,
          state: 'running',
          durationMs: performance.now() - started,
        }) + '\n',
      );
    }, 30000);
    const timer = setTimeout(
      () => {
        // Stop this owned subprocess on a deadline and retain the failed phase audit.
        if (finished) return;
        timedOut = true;
        clearInterval(heartbeat);
        stopOwnedTool(child);
      },
      options.timeoutMs ?? 30 * 60 * 1000,
    );
    child.stdout.on('data', (bytes) => {
      stdoutBytes += bytes.length;
      stdoutDigest.update(bytes);
      // Keep a bounded transient diagnostic tail for tools that report failures on stdout.
      diagnosticTail = (diagnosticTail + bytes.toString('utf8')).slice(-8192);
      // Readonly git and version parsers consume bounded output; build output remains hashed.
      if (Buffer.byteLength(stdout) + bytes.length <= (options.captureBytes ?? 65536))
        stdout += bytes.toString('utf8');
    });
    child.stderr.on('data', (bytes) => {
      stderrBytes += bytes.length;
      stderrDigest.update(bytes);
      diagnosticTail = (diagnosticTail + bytes.toString('utf8')).slice(-8192);
    });
    child.once('error', async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (diskMonitor) clearInterval(diskMonitor);
      // Audit failures reject the phase rather than escaping an asynchronous event callback.
      try {
        await audit(options.auditDirectory, {
          phase: options.phase,
          state: 'failed',
          code: 'TOOL_START_FAILED',
          durationMs: performance.now() - started,
        });
        reject(
          gateError('TOOL_START_FAILED', 'Required official executable could not be started.'),
        );
      } catch {
        reject(gateError('AUDIT_WRITE_FAILED', 'The phase audit could not be persisted.'));
      }
    });
    child.once('close', async (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (diskMonitor) clearInterval(diskMonitor);
      const metadata = {
        phase: options.phase,
        state: code === 0 && !timedOut && !resourceFailure ? 'completed' : 'failed',
        ...(timedOut ? { code: 'TOOL_TIMEOUT' } : {}),
        ...(resourceFailure ? { code: resourceFailure } : {}),
        ...(code !== 0 && !timedOut ? { diagnostic: classifyToolFailure(diagnosticTail) } : {}),
        exitCode: code,
        durationMs: performance.now() - started,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdoutDigest.digest('hex'),
        stderrSha256: stderrDigest.digest('hex'),
      };
      // Persist terminal state before reporting command completion or failure.
      try {
        await audit(options.auditDirectory, metadata);
        // Resolve deadlines after the owned tree closes and releases its directory handles.
        if (timedOut)
          reject(gateError('TOOL_TIMEOUT', 'Official tool exceeded its configured deadline.'));
        else if (resourceFailure)
          reject(
            gateError(
              resourceFailure,
              'The measured source-volume reserve requires explicit resource review.',
            ),
          );
        else if (code !== 0) {
          const diagnostic = classifyToolFailure(diagnosticTail);
          reject(
            gateError(
              diagnostic.code,
              diagnostic.binary
                ? 'Required official tool dependency is unavailable: ' + diagnostic.binary + '.'
                : 'Official tool reported a failed phase; inspect the fixed diagnostic category.',
            ),
          );
        } else resolve({ ...metadata, stdout });
      } catch {
        reject(gateError('AUDIT_WRITE_FAILED', 'The phase audit could not be persisted.'));
      }
    });
  });
}

/**
 * Read small official HTTPS metadata with bounded retries and redirect enforcement.
 * Args:
 *   url (string): Allowlisted official source metadata URL.
 *   auditDirectory (string): Owned non-secret network audit directory.
 * Returns:
 *   Promise<Uint8Array>: Bounded response bytes with TLS verification preserved.
 */
export async function officialMetadata(url, auditDirectory) {
  // Global Node TLS overrides cannot weaken official metadata verification.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw gateError('TLS_VERIFICATION_REQUIRED', 'Official metadata requires verified TLS.');
  const parsed = new URL(url);
  // Metadata requests use only known official source repositories and transport.
  if (
    parsed.protocol !== 'https:' ||
    ![
      'chromium.googlesource.com',
      'raw.githubusercontent.com',
      'chromiumdash.appspot.com',
    ].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    throw gateError('UNAUTHORIZED_METADATA_ORIGIN', 'Metadata origin is unavailable.');
  // Retry readonly metadata requests without altering TLS or replaying browser input.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await audit(auditDirectory, {
        phase: 'metadata-request',
        host: parsed.hostname,
        attempt: attempt + 1,
      });
      const response = await fetch(parsed, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw gateError('METADATA_HTTP_FAILED', 'Official metadata response is unavailable.');
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      // Bound streamed metadata before storing the complete body in memory.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 4 * 1024 * 1024) {
          await reader.cancel();
          throw gateError('METADATA_TOO_LARGE', 'Official metadata exceeds its quota.');
        }
        chunks.push(value);
      }
      await audit(auditDirectory, {
        phase: 'metadata-response',
        host: parsed.hostname,
        status: response.status,
        bytes: total,
      });
      return Buffer.concat(chunks);
    } catch {
      await audit(auditDirectory, {
        phase: 'metadata-response',
        host: parsed.hostname,
        attempt: attempt + 1,
        code: 'METADATA_FETCH_FAILED',
      });
    }
  }
  throw gateError('METADATA_FETCH_FAILED', 'Official metadata retries were exhausted.');
}

/**
 * Report native host resources and declared target architecture.
 * Args:
 *   checkoutRoot (string): Existing or planned external source location.
 * Returns:
 *   Promise<object>: Actual OS, CPU, RAM, and source-volume free space.
 */
export async function hostResources(checkoutRoot) {
  let existing = checkoutRoot;
  // Locate an existing parent for the actual target-volume free-space query.
  while (!(await exists(existing))) existing = path.dirname(existing);
  const volume = await statfs(existing, { bigint: true });
  return {
    platform: platform(),
    osVersion: release(),
    arch: arch(),
    cpus: availableParallelism(),
    memoryGiB: totalmem() / GIB,
    freeDiskGiB: Number(volume.bavail * volume.bsize) / GIB,
  };
}

/**
 * Save a new phase artifact without replacing prior evidence.
 * Args:
 *   filename (string): Explicit owned output path.
 *   value (unknown): Versioned phase metadata.
 * Returns:
 *   Promise<void>: Exclusive artifact creation.
 */
export async function writeArtifact(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
}
