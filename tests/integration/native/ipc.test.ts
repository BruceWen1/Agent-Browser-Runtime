// -*- coding: utf-8 -*-
/**
 * ipc.test.ts
 * Native transport integration verification
 * =====================
 * Exercise the compiled Rust agent through authenticated current-user local IPC.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentClient } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

const executable = path.resolve(
  'target',
  'debug',
  process.platform === 'win32' ? 'abr-desktop-agent.exe' : 'abr-desktop-agent',
);

/**
 * Verify authenticated Rust transport, correlated concurrent calls, and shutdown.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of real cross-language IPC assertions.
 */
async function integration(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'abr-ipc-test-'));
  const agent = await AgentClient.start(executable, directory);
  // Release only the test-owned process and its verified temporary directory.
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => agent.call('desktop.doctor', {})),
    );
    expect(results).toHaveLength(8);
    expect(results[0]).toMatchObject({ schemaVersion: 1 });
    await expect(agent.call('desktop.unknown', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  } finally {
    await agent.close();
    if (
      path.dirname(directory) === path.resolve(tmpdir()) &&
      path.basename(directory).startsWith('abr-ipc-test-')
    )
      await rm(directory, { recursive: true, force: true });
  }
}

test.skipIf(!existsSync(executable))(
  'authenticated native IPC correlates concurrent Rust responses',
  integration,
);
