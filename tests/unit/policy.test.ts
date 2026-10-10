// -*- coding: utf-8 -*-
/**
 * policy.test.ts
 * Origin and filesystem authorization tests
 * =====================
 * Verify scope narrowing, profile ownership, upload redirects, and explicit consent.
 */
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CreateSessionRequest } from '@abr/contracts';
import { EngineRegistry, PolicyEngine, Runtime, readConfiguration } from '@abr/core';
import { expect, test } from 'vitest';

import { StubEngine } from '../helpers/stub-engine.js';

const input: CreateSessionRequest = {
  engine: 'compatible',
  browser: 'bundled-chromium',
  profile: { mode: 'ephemeral' },
};

/**
 * Construct an isolated policy and coordinator using owned test directories.
 * Args:
 *   None.
 * Returns:
 *   Promise<object>: Temporary root, policy, adapter, and coordinator.
 */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-policy-'));
  const config = await readConfiguration('config/abr.config.example.yaml');
  const policy = new PolicyEngine(config, root);
  const registry = new EngineRegistry();
  const engine = new StubEngine();
  registry.register(engine);
  return { root, policy, config, engine, runtime: new Runtime(registry, policy) };
}

/**
 * Remove a test directory after checking its absolute ownership boundary.
 * Args:
 *   root (string): Directory returned by the isolated setup helper.
 * Returns:
 *   Promise<void>: Completion of bounded test cleanup.
 */
async function cleanup(root: string): Promise<void> {
  // Only this suite's directly allocated temporary roots may be removed recursively.
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('abr-policy-')
  )
    throw new Error('Invalid temporary cleanup root.');
  await rm(root, { recursive: true, force: true });
}

/**
 * Verify exact host matching, deny precedence, and narrowed session origins.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of origin authorization assertions.
 */
async function verifyOrigins(): Promise<void> {
  const { root, runtime, policy, config } = await setup();
  // Release all browser and filesystem state even when an assertion fails.
  try {
    const session = await runtime.create(input);
    expect(policy.checkUrl(session.id, 'http://127.0.0.1:8080/path').hostname).toBe('127.0.0.1');
    expect(() => policy.checkUrl(session.id, 'http://localhost.evil.test/')).toThrow();
    expect(() => policy.checkUrl(session.id, 'http://user:password@localhost/')).toThrow();
    expect(() => policy.checkUrl(session.id, 'javascript:alert(1)')).toThrow();
    config.policy.deniedOrigins.push('http://localhost:*');
    expect(() => policy.checkUrl(session.id, 'http://localhost:8080/')).toThrow();
    await expect(
      runtime.create({ ...input, allowedOrigins: ['https://example.com'] }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const narrow = await runtime.create({ ...input, allowedOrigins: ['http://127.0.0.1:1234'] });
    expect(() => policy.checkUrl(narrow.id, 'http://127.0.0.1:5678/')).toThrow();
  } finally {
    await runtime.closeAll();
    await cleanup(root);
  }
}

/**
 * Verify reserved names, unmanaged directories, and redirected profiles.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of profile ownership assertions.
 */
async function verifyProfiles(): Promise<void> {
  const { root, policy } = await setup();
  const persistent = { ...input, profile: { mode: 'persistent' as const, name: 'owned' } };
  // Preserve test cleanup across rejected profile allocation cases.
  try {
    await expect(
      policy.prepareSession({ ...persistent, profile: { mode: 'persistent', name: '../escape' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      policy.prepareSession({ ...persistent, profile: { mode: 'persistent', name: 'CON' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const prepared = await policy.prepareSession(persistent);
    await expect(policy.prepareSession(persistent)).rejects.toMatchObject({ code: 'DESKTOP_BUSY' });
    await policy.failed(prepared);
    await mkdir(path.join(policy.profileRoot, 'unmanaged'));
    await expect(
      policy.prepareSession({ ...persistent, profile: { mode: 'persistent', name: 'unmanaged' } }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const external = path.join(root, 'external');
    await mkdir(external);
    await symlink(external, path.join(policy.profileRoot, 'redirect'), 'junction');
    await expect(
      policy.prepareSession({ ...persistent, profile: { mode: 'persistent', name: 'redirect' } }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await cleanup(root);
  }
}

/**
 * Verify uploads reject lexical escapes, network paths, and junction redirects.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of upload boundary assertions.
 */
async function verifyUploads(): Promise<void> {
  const { root, policy } = await setup();
  // Restrict all fixture files and redirects to this suite's temporary root.
  try {
    const uploads = path.join(root, 'uploads');
    const external = path.join(root, 'external');
    await mkdir(uploads);
    await mkdir(external);
    const file = path.join(uploads, 'fixture.txt');
    await writeFile(file, 'fixture');
    await writeFile(path.join(external, 'outside.txt'), 'fixture');
    expect(await policy.checkUpload(file)).toBe(
      await import('node:fs/promises').then((fs) => fs.realpath(file)),
    );
    await expect(policy.checkUpload(path.join(external, 'outside.txt'))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(
      policy.checkUpload('\\\\untrusted.invalid\\share\\file.txt'),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await symlink(external, path.join(uploads, 'redirect'), 'junction');
    await expect(
      policy.checkUpload(path.join(uploads, 'redirect', 'outside.txt')),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  } finally {
    await cleanup(root);
  }
}

/**
 * Verify consent can resume the original action once and cleanup removes its profile.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of approval binding and cleanup assertions.
 */
async function verifyConsent(): Promise<void> {
  const { root, runtime, policy, engine } = await setup();
  // Complete cleanup after approved and duplicate request paths have been exercised.
  try {
    await mkdir(path.join(root, 'uploads'));
    const file = path.join(root, 'uploads', 'fixture.txt');
    await writeFile(file, 'fixture');
    const session = await runtime.create(input);
    const request = {
      requestId: 'upload',
      sessionId: session.id,
      action: 'choose-file',
      args: { filePath: file },
    };
    const pending = await runtime.execute(request);
    expect(pending.status).toBe('approval-required');
    expect(engine.executed).toBe(0);
    expect(JSON.stringify(policy.approvalStatus(pending.approvalId!))).not.toContain(file);
    policy.reviewFromTrustedUi(pending.approvalId!, true);
    const reordered = {
      action: 'choose-file',
      args: { filePath: file },
      sessionId: session.id,
      requestId: 'upload',
    };
    const results = await Promise.all([runtime.execute(reordered), runtime.execute(request)]);
    expect(results.every((result) => result.status === 'succeeded')).toBe(true);
    expect(engine.executed).toBe(1);
    const directories = await import('node:fs/promises').then((fs) =>
      fs.readdir(policy.profileRoot),
    );
    const profile = directories[0]!;
    await runtime.closeAll();
    await expect(lstat(path.join(policy.profileRoot, profile))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await runtime.closeAll();
    await cleanup(root);
  }
}

/**
 * Verify a denied approval produces a terminal cancelled operation.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of denied consent assertions.
 */
async function verifyDeniedConsent(): Promise<void> {
  const { root, runtime, policy, engine } = await setup();
  // Keep denied transfer fixtures and profile state isolated from the host environment.
  try {
    await mkdir(path.join(root, 'uploads'));
    const file = path.join(root, 'uploads', 'fixture.txt');
    await writeFile(file, 'fixture');
    const session = await runtime.create(input);
    const request = {
      requestId: 'denied',
      sessionId: session.id,
      action: 'choose-file',
      args: { filePath: file },
    };
    const pending = await runtime.execute(request);
    policy.reviewFromTrustedUi(pending.approvalId!, false);
    expect((await runtime.execute(request)).status).toBe('cancelled');
    expect(engine.executed).toBe(0);
  } finally {
    await runtime.closeAll();
    await cleanup(root);
  }
}

test('origin scopes narrow and denied hosts take precedence', verifyOrigins);
test('profile allocation requires ownership and exclusive access', verifyProfiles);
test('upload authorization rejects escaped and redirected files', verifyUploads);
test('approved operations resume once under their original identity', verifyConsent);
test('denied operations remain cancelled and never reach the adapter', verifyDeniedConsent);
