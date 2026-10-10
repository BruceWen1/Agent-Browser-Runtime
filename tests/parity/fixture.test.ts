// -*- coding: utf-8 -*-
/**
 * fixture.test.ts
 * Owned fixture HTTP verification
 * =====================
 * Verify loopback binding, controlled routes, bounded sample quotas, and immutable recorder exports.
 */
import { FIXTURE_NAMES, startEventFixture } from '@abr/test-fixtures';
import { expect, test } from 'vitest';

/**
 * Retry owned local HTTP reads without replaying browser input actions.
 * Args:
 *   url (string): Controlled loopback fixture URL.
 *   method (string): Read or explicitly denied mutation request method.
 * Returns:
 *   Promise<Response>: Owned server response.
 */
async function request(url: string, method = 'GET'): Promise<Response> {
  let failure: unknown;
  // Retry transport failures only; every request remains inside the owned loopback listener.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { method });
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/**
 * Verify every fixture surface is served locally with no arbitrary route or mutation fallback.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of HTTP and quota assertions.
 */
async function verifyFixtureRoutes(): Promise<void> {
  const fixture = await startEventFixture({ engine: 'compatible', maxSamples: 12 });
  // Close only the explicitly allocated local server across all assertion outcomes.
  try {
    expect(new URL(fixture.origin).hostname).toBe('127.0.0.1');
    for (const name of FIXTURE_NAMES) {
      const response = await request(fixture.url(name));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('exportTrace');
      expect(html).toContain('writable: false');
      expect(html).toContain('"maxSamples":12');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    }
    expect((await request(fixture.origin + '/unknown')).status).toBe(404);
    expect((await request(fixture.url('click-button'), 'POST')).status).toBe(405);
  } finally {
    await fixture.close();
  }
  await expect(startEventFixture({ maxSamples: 20001 })).rejects.toThrow();
}

test('owned fixture routes remain loopback-only and explicitly bounded', verifyFixtureRoutes);
