// -*- coding: utf-8 -*-
/**
 * authentication.ts
 * Owned local process authentication
 * =====================
 * Bind mutual HMAC proofs to the inherited key, supervised PID, namespace, and fresh nonces.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { BrowserError } from '@abr/contracts';

export type AuthenticationNamespace = 'agent' | 'observer';
export interface AuthenticationChallenge {
  authVersion: 2;
  serverPid: number;
  clientNonce: string;
  serverNonce: string;
  serverProof: string;
}

/**
 * Calculate one domain-separated proof for a supervised local connection.
 * Args:
 *   secret (string): Lowercase inherited bootstrap key in hexadecimal form.
 *   namespace (AuthenticationNamespace): Fixed desktop or observer authority.
 *   direction ('server' | 'client'): Distinct participant proof domain.
 *   serverPid (number): Exact original supervised process identity.
 *   clientNonce (string): Fresh controller challenge.
 *   serverNonce (string): Fresh server challenge.
 * Returns:
 *   string: Lowercase HMAC-SHA256 proof without the bootstrap key.
 */
export function authenticationProof(
  secret: string,
  namespace: AuthenticationNamespace,
  direction: 'server' | 'client',
  serverPid: number,
  clientNonce: string,
  serverNonce: string,
): string {
  // Reject malformed transcripts before creating a cryptographic key.
  if (
    !/^[a-f0-9]{64}$/.test(secret) ||
    !/^[a-f0-9]{64}$/.test(clientNonce) ||
    !/^[a-f0-9]{64}$/.test(serverNonce) ||
    !Number.isSafeInteger(serverPid) ||
    serverPid <= 0 ||
    !['agent', 'observer'].includes(namespace) ||
    !['server', 'client'].includes(direction)
  )
    throw new BrowserError('INVALID_ARGUMENT', 'Local authentication transcript is invalid.');
  const transcript = [
    'abr-local-ipc-auth-v2',
    namespace,
    direction,
    String(serverPid),
    clientNonce,
    serverNonce,
  ].join('\n');
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(transcript, 'utf8').digest('hex');
}

/**
 * Verify a closed challenge response before sending a client authentication proof.
 * Args:
 *   value (unknown): Untrusted response from the connected local endpoint.
 *   secret (string): Key delivered solely to the original child through inherited input.
 *   namespace (AuthenticationNamespace): Selected private protocol namespace.
 *   serverPid (number): PID recorded by the owned process supervisor.
 *   clientNonce (string): Fresh challenge generated for this connection.
 * Returns:
 *   AuthenticationChallenge: Authenticated server metadata and its fresh nonce.
 */
export function verifyAuthenticationChallenge(
  value: unknown,
  secret: string,
  namespace: AuthenticationNamespace,
  serverPid: number,
  clientNonce: string,
): AuthenticationChallenge {
  const response = value as Partial<AuthenticationChallenge> | null;
  // Endpoint metadata must match the exact supervised process and closed challenge shape.
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(response).sort().join(',') !==
      'authVersion,clientNonce,serverNonce,serverPid,serverProof' ||
    response.authVersion !== 2 ||
    response.serverPid !== serverPid ||
    response.clientNonce !== clientNonce ||
    typeof response.serverNonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(response.serverNonce) ||
    typeof response.serverProof !== 'string' ||
    !/^[a-f0-9]{64}$/.test(response.serverProof)
  )
    throw new BrowserError('POLICY_DENIED', 'Local server authentication identity is invalid.');
  const expected = authenticationProof(
    secret,
    namespace,
    'server',
    serverPid,
    clientNonce,
    response.serverNonce,
  );
  // Compare equal-length proof bytes without revealing a matching prefix.
  if (!timingSafeEqual(Buffer.from(response.serverProof, 'hex'), Buffer.from(expected, 'hex')))
    throw new BrowserError('POLICY_DENIED', 'Local server authentication proof is invalid.');
  return response as AuthenticationChallenge;
}
