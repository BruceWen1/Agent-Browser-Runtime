// -*- coding: utf-8 -*-
/**
 * stub-engine.ts
 * Session coordinator test doubles
 * =====================
 * Provide controllable adapters for concurrency and lifecycle boundary tests.
 */
import { randomUUID } from 'node:crypto';

import { CAPABILITIES, validateCoordinateInspection } from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  BrowserEngine,
  BrowserSession,
  BrowserSnapshot,
  CapabilityReport,
  CreateSessionRequest,
  Engine,
} from '@abr/contracts';
import type { RuntimeGuard } from '@abr/core';

/** StubEngine implements a controllable adapter used exclusively by unit tests. */
export class StubEngine implements BrowserEngine {
  readonly kind: Engine = 'compatible';
  executed = 0;
  closed = 0;
  block: Promise<void> | undefined;

  /**
   * Return valid session metadata for coordinator tests.
   * Args:
   *   input (CreateSessionRequest): Requested session mode.
   * Returns:
   *   Promise<BrowserSession>: Isolated test session.
   */
  async create(input: CreateSessionRequest): Promise<BrowserSession> {
    return {
      id: randomUUID(),
      engine: input.engine,
      status: 'ready',
      browserVersion: 'unit-test',
      platform: 'test',
      capabilities: [...CAPABILITIES],
      createdAt: new Date().toISOString(),
      profileId: randomUUID(),
    };
  }

  /**
   * Return the complete capability set for state tests.
   * Args:
   *   None.
   * Returns:
   *   Promise<CapabilityReport>: Complete test capabilities.
   */
  async capabilities(): Promise<CapabilityReport> {
    return { supported: [...CAPABILITIES], unsupported: {} };
  }

  /**
   * Return a stable target snapshot for coordinator tests.
   * Args:
   *   sessionId (string): Test session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Snapshot with a single named button.
   */
  async observe(sessionId: string): Promise<BrowserSnapshot> {
    return {
      sessionId,
      snapshotId: 'snapshot-test',
      timestamp: new Date().toISOString(),
      windowId: 'window-test',
      root: { nodeId: 'button-test', role: 'button', name: 'Activate', states: [] },
      scale: { dpr: 1, zoom: 1 },
      source: 'playwright-accessibility',
      url: 'http://127.0.0.1/',
    };
  }

  /**
   * Read independent stub inspection while preserving caller reference IDs.
   * Args:
   *   sessionId (string): Owned test session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Fresh test metadata with no adapter cache mutation.
   */
  async inspectionSnapshot(sessionId: string): Promise<BrowserSnapshot> {
    return this.observe(sessionId);
  }

  /**
   * Return the current trusted browser URL for authorization tests.
   * Args:
   *   None.
   * Returns:
   *   Promise<string>: Local fixture origin.
   */
  async currentUrl(): Promise<string> {
    return 'http://127.0.0.1/';
  }

  /**
   * Return a controlled artifact reference.
   * Args:
   *   None.
   * Returns:
   *   Promise<object>: Test screenshot metadata.
   */
  async screenshot(): Promise<{ mimeType: 'image/png'; blobId: string }> {
    return { mimeType: 'image/png', blobId: 'blob-test' };
  }

  /**
   * Count executions and optionally hold an operation open.
   * Args:
   *   input (ActionRequest): Validated coordinator input.
   *   inspection (BrowserSnapshot | undefined): Independent coordinate authorization witness.
   * Returns:
   *   Promise<ActionResult>: Successful adapter response after the gate opens.
   */
  async execute(input: ActionRequest, inspection?: BrowserSnapshot): Promise<ActionResult> {
    if (inspection)
      validateCoordinateInspection(
        input,
        inspection,
        await this.inspectionSnapshot(input.sessionId),
      );
    this.executed++;
    // Keep the operation active when a test supplies a controllable gate.
    if (this.block) await this.block;
    return {
      requestId: input.requestId,
      sessionId: input.sessionId,
      actionId: randomUUID(),
      status: 'succeeded',
      executionPath: 'playwright-cdp',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * Complete the test adapter's pause operation.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of the pause acknowledgement.
   */
  async pause(): Promise<void> {}

  /**
   * Complete the test adapter's resume operation.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of the resume acknowledgement.
   */
  async resume(): Promise<void> {}

  /**
   * Count adapter cleanup calls.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of test resource cleanup.
   */
  async close(): Promise<void> {
    this.closed++;
  }
}

/** UnitGuard is an explicit authorization double for coordinator isolation tests. */
export class UnitGuard implements RuntimeGuard {
  block: Promise<void> | undefined;

  /**
   * Preserve the requested session for lifecycle tests.
   * Args:
   *   input (CreateSessionRequest): Test session request.
   * Returns:
   *   Promise<CreateSessionRequest>: Original test configuration.
   */
  async prepareSession(input: CreateSessionRequest): Promise<CreateSessionRequest> {
    return input;
  }

  /**
   * Hold authorization open for concurrency tests when requested.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of the test authorization gate.
   */
  async authorize(): Promise<void> {
    if (this.block) await this.block;
  }
}
