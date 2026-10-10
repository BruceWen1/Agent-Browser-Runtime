// -*- coding: utf-8 -*-
/**
 * cli.test.ts
 * Command entry point verification
 * =====================
 * Verify machine-readable diagnostics and exclusive configuration initialization.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const execute = promisify(execFile);

/**
 * Verify local diagnostic and contract command output is parseable JSON.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of CLI output assertions.
 */
async function verifyDiagnostics(): Promise<void> {
  const result = await execute(process.execPath, ['packages/cli/dist/main.js', 'doctor', '--json']);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(output.schemaVersion).toBe(1);
  expect(Object.keys(output.engines as object)).toEqual(['compatible', 'gui', 'native']);
  expect(result.stdout).not.toContain('configuration-ready');
  const contract = await execute(process.execPath, [
    'packages/cli/dist/main.js',
    'test',
    'contract',
  ]);
  expect(JSON.parse(contract.stdout)).toMatchObject({ status: 'succeeded', toolCount: 21 });
}

/**
 * Verify initialization creates a portable configuration and preserves existing files.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of initialization and overwrite rejection assertions.
 */
async function verifyInitialization(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-cli-'));
  const filename = path.join(root, 'config.yaml');
  // Keep every initialization and cleanup operation within the allocated test root.
  try {
    const result = await execute(process.execPath, [
      'packages/cli/dist/main.js',
      'init',
      '--config',
      filename,
    ]);
    expect(JSON.parse(result.stdout).status).toBe('initialized');
    const original = await readFile(filename, 'utf8');
    expect(original).toContain('${ABR_DATA_DIR}/profiles');
    await expect(
      execute(process.execPath, ['packages/cli/dist/main.js', 'init', '--config', filename]),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(filename, 'utf8')).toBe(original);
  } finally {
    // Verify the absolute target before recursively removing the disposable configuration.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-cli-')
    )
      throw new Error('Invalid CLI cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('CLI diagnostics use machine-readable standard output', verifyDiagnostics);
test('configuration initialization preserves an existing file', verifyInitialization);
