// -*- coding: utf-8 -*-
/**
 * authentication.test.ts
 * Local process challenge authentication verification
 * =====================
 * Verify independent cryptographic vectors, identity binding, and replacement endpoint rejection.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentClient, FrameDecoder, encodeFrame } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

import {
  authenticationProof,
  verifyAuthenticationChallenge,
} from '../../packages/native-ipc-client/src/authentication.js';

// The expected digests were independently calculated by the platform HMAC-SHA256 implementation.
const secret = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join(
  '',
);
const clientNonce = '11'.repeat(32);
const serverNonce = '22'.repeat(32);

/**
 * Verify independent vectors bind both participant domains and the supervised process.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of key, namespace, PID, nonce, and closed response assertions.
 */
function vectors(): void {
  const serverProof = authenticationProof(
    secret,
    'agent',
    'server',
    4242,
    clientNonce,
    serverNonce,
  );
  expect(serverProof).toBe('688abbe6c1122ce1c75cf360ae31e0d225911bb4f60fe988592d5b0542034847');
  expect(authenticationProof(secret, 'agent', 'client', 4242, clientNonce, serverNonce)).toBe(
    'b59ba579af489654a76f865a64585f63eb74fadb266a828687ec59aae9e02aa0',
  );
  const challenge = { authVersion: 2, serverPid: 4242, clientNonce, serverNonce, serverProof };
  expect(verifyAuthenticationChallenge(challenge, secret, 'agent', 4242, clientNonce)).toEqual(
    challenge,
  );
  // Every changed authority or malformed challenge must fail before application authentication.
  for (const changed of [
    { ...challenge, serverPid: 4243 },
    { ...challenge, clientNonce: '33'.repeat(32) },
    { ...challenge, serverNonce: '' },
    { ...challenge, serverProof: serverProof.toUpperCase() },
    { ...challenge, serverProof: '00'.repeat(32) },
    { ...challenge, secret },
    { ...challenge, authVersion: 1 },
  ])
    expect(() =>
      verifyAuthenticationChallenge(changed, secret, 'agent', 4242, clientNonce),
    ).toThrow();
  expect(() =>
    verifyAuthenticationChallenge(challenge, secret, 'observer', 4242, clientNonce),
  ).toThrow();
  expect(() =>
    verifyAuthenticationChallenge(challenge, 'ff'.repeat(32), 'agent', 4242, clientNonce),
  ).toThrow();
}

/**
 * Reject a local replacement endpoint before the controller sends any secret or client proof.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of actual socket interception and owned-process cleanup assertions.
 */
async function replacementEndpoint(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'abr-auth-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\abr-auth-${randomUUID()}`
      : path.join(root, 'replacement.sock');
  const received: { method: string; params: Record<string, unknown> }[] = [];
  let childPid = 0;
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    // The replacement peer receives a public challenge and returns an unauthenticated forged proof.
    socket.on('data', (bytes) => {
      for (const message of decoder.feed(bytes)) {
        const request = message as {
          requestId: string;
          method: string;
          params: Record<string, unknown>;
        };
        received.push({ method: request.method, params: request.params });
        socket.write(
          encodeFrame({
            schemaVersion: 1,
            requestId: request.requestId,
            ok: true,
            result: {
              authVersion: 2,
              serverPid: childPid,
              clientNonce: request.params.clientNonce,
              serverNonce: '44'.repeat(32),
              serverProof: '00'.repeat(32),
            },
          }),
        );
      }
    });
  });
  // Allocate the replacement listener before creating the separately supervised process.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'pipe',
    windowsHide: true,
  });
  childPid = child.pid!;
  let channel: AgentClient | undefined;
  try {
    channel = await AgentClient.connectOwnedProcess(child, endpoint);
    await expect(channel.authenticate('observer', secret)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('observer.challenge');
    expect(Object.keys(received[0]!.params).sort()).toEqual(['authVersion', 'clientNonce']);
    expect(JSON.stringify(received)).not.toContain(secret);
  } finally {
    channel?.closeChannel();
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Remove only the test root allocated directly under the temporary directory.
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith('abr-auth-')
    )
      throw new Error('Invalid authentication test cleanup root.');
    await rm(root, { recursive: true, force: true });
  }
}

test('local authentication matches independent vectors and binds closed process identity', vectors);
test(
  'replacement local endpoint receives no bootstrap secret or client proof',
  replacementEndpoint,
);
