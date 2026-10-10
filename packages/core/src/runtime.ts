// -*- coding: utf-8 -*-
/**
 * runtime.ts
 * Browser session and action coordination
 * =====================
 * Maintain session state, input ownership, idempotency, and adapter boundaries.
 */
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  ACTION_TO_TOOL,
  BrowserError,
  MCP_TOOLS,
  actionResultSchema,
  capabilityReportSchema,
  coordinateReferences,
  coordinateTargets,
  normalizeError,
  parseAction,
  parseBrowserSession,
  parseSession,
  snapshotSchema,
  validateOutput,
} from '@abr/contracts';
import type {
  ActionRequest,
  ActionResult,
  AxNode,
  BrowserEngine,
  BrowserSession,
  BrowserSnapshot,
  CapabilityReport,
  CreateSessionRequest,
  ExecutionPath,
  Target,
} from '@abr/contracts';

import type { EngineRegistry } from './registry.js';
import { filterSnapshot } from './privacy.js';

export interface RuntimeGuard {
  prepareSession(input: CreateSessionRequest): Promise<CreateSessionRequest>;
  authorize(input: ActionRequest, url: string, target?: AxNode): Promise<void>;
  authorizeTargets?(
    input: ActionRequest,
    url: string,
    context: SemanticAuthorizationContext,
  ): Promise<void>;
  created?(session: BrowserSession, input: CreateSessionRequest): Promise<void>;
  closed?(session: BrowserSession): Promise<void>;
  failed?(input: CreateSessionRequest): Promise<void>;
  approvalState?(input: ActionRequest): 'pending' | 'approved' | 'denied' | 'expired' | undefined;
  authorizeRead?(sessionId: string, url: string): void;
}
export interface SemanticAuthorizationContext {
  source: BrowserSnapshot['source'];
  windowId: string;
  tabId?: string;
  targets: AxNode[];
}
export interface AuditEvent {
  event: string;
  sessionId?: string;
  requestId?: string;
  engine?: string;
  durationMs?: number;
  code?: string;
}
export interface RuntimeOptions {
  maxSessions?: number;
  actionTimeoutMs?: number;
  maxRequestsPerSession?: number;
  audit?: (event: AuditEvent) => void;
  onCreated?: (session: BrowserSession) => Promise<void>;
}
interface RequestRecord {
  digest: string;
  result: Promise<ActionResult>;
}
interface SessionRecord {
  session: BrowserSession;
  engine: BrowserEngine;
  snapshot?: BrowserSnapshot;
  requests: Map<string, RequestRecord>;
  active?: Promise<ActionResult>;
  closing?: Promise<void>;
  initializing: boolean;
}

/**
 * Serialize a JSON value with deterministic object key ordering.
 *
 * Args:
 *   value (unknown): JSON-compatible value used for a request digest.
 * Returns:
 *   string: Stable serialization retaining array ordering.
 */
function canonical(value: unknown): string {
  // Arrays preserve order while objects sort their property names.
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Locate a node within a stored accessibility snapshot.
 *
 * Args:
 *   root (AxNode): Snapshot subtree to inspect.
 *   nodeId (string): Node identifier belonging to the snapshot.
 * Returns:
 *   AxNode | undefined: Matched node when present.
 */
function findNode(root: AxNode, nodeId: string): AxNode | undefined {
  // Return a direct match before inspecting descendants.
  if (root.nodeId === nodeId) return root;
  // Recursively inspect children within the same snapshot.
  for (const child of root.children ?? []) {
    const result = findNode(child, nodeId);
    // Stop when a unique node identifier has been located.
    if (result) return result;
  }
  return undefined;
}

/**
 * Find the deepest focused interaction control for semantic keyboard authorization.
 * Args:
 *   root (AxNode): Privacy-filtered observed subtree.
 * Returns:
 *   AxNode | undefined: Focused control when a semantic target is available.
 */
function focusedControl(root: AxNode): AxNode | undefined {
  // Prefer focused descendants over container-level focus metadata.
  for (const child of root.children ?? []) {
    const focused = focusedControl(child);
    if (focused) return focused;
  }
  if (root.states.includes('focused') && !['window', 'document', 'group'].includes(root.role))
    return root;
  return undefined;
}

/** Runtime coordinates browser adapters under an explicitly supplied authorization guard. */
export class Runtime {
  private readonly sessions = new Map<string, SessionRecord>();
  private creating = 0;
  private readonly maxSessions: number;
  private readonly timeoutMs: number;
  private readonly maxRequests: number;
  private readonly audit: (event: AuditEvent) => void;
  private readonly onCreated: RuntimeOptions['onCreated'];

  /**
   * Initialize session coordination with mandatory authorization.
   *
   * Args:
   *   registry (EngineRegistry): Explicitly registered browser adapters.
   *   guard (RuntimeGuard): Session and action authorization service.
   *   options (RuntimeOptions): Resource limits and diagnostic sink.
   * Returns:
   *   Runtime: Initialized session coordinator.
   */
  constructor(
    readonly registry: EngineRegistry,
    readonly guard: RuntimeGuard,
    options: RuntimeOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 4;
    this.timeoutMs = options.actionTimeoutMs ?? 10_000;
    this.maxRequests = options.maxRequestsPerSession ?? 4096;
    this.audit = options.audit ?? (() => undefined);
    this.onCreated = options.onCreated;
  }

  /**
   * Create a session without exceeding concurrent creation limits.
   *
   * Args:
   *   value (unknown): Session configuration received at the public boundary.
   * Returns:
   *   Promise<BrowserSession>: Validated isolated session metadata.
   */
  async create(value: unknown): Promise<BrowserSession> {
    const input = structuredClone(parseSession(value));
    const engine = this.registry.get(input.engine);
    const live = [...this.sessions.values()].filter(
      (record) => !record.initializing && record.session.status !== 'closed',
    ).length;
    // Reserve capacity before performing asynchronous authorization or startup.
    if (live + this.creating >= this.maxSessions)
      throw new BrowserError('DESKTOP_BUSY', 'Session capacity is exhausted.');
    this.creating++;
    const started = performance.now();
    let created: BrowserSession | undefined;
    let prepared: CreateSessionRequest | undefined;
    // Release capacity and partially created adapter state on startup failure.
    try {
      prepared = await this.guard.prepareSession(input);
      created = await engine.create(prepared);
      const session = parseBrowserSession(created);
      // Keep engine identity and session ownership immutable at the boundary.
      if (
        session.engine !== input.engine ||
        session.status !== 'ready' ||
        this.sessions.has(session.id)
      ) {
        throw new BrowserError('INTERNAL_ERROR', 'Adapter returned inconsistent session metadata.');
      }
      await this.guard.created?.(session, prepared);
      this.sessions.set(session.id, {
        session: { ...structuredClone(session), status: 'creating' },
        engine,
        requests: new Map(),
        initializing: true,
      });
      await this.onCreated?.(structuredClone(session));
      const ready = this.sessions.get(session.id)!;
      ready.initializing = false;
      // Expose input readiness after trusted local controls complete initialization.
      if (ready.session.status === 'creating') ready.session.status = 'ready';
      this.audit({
        event: 'session-created',
        sessionId: session.id,
        engine: session.engine,
        durationMs: performance.now() - started,
      });
      return structuredClone(ready.session);
    } catch (error) {
      // Close newly allocated adapter state when its identifier is available.
      if (created?.id && this.sessions.has(created.id))
        await this.close(created.id).catch(() => undefined);
      else {
        if (created?.id) await engine.close(created.id).catch(() => undefined);
        if (prepared) await this.guard.failed?.(prepared);
      }
      throw normalizeError(error);
    } finally {
      if (created?.id) {
        const record = this.sessions.get(created.id);
        if (record) record.initializing = false;
      }
      this.creating--;
    }
  }

  /**
   * List session metadata without exposing mutable application state.
   *
   * Args:
   *   None.
   * Returns:
   *   BrowserSession[]: Copies of current user session metadata.
   */
  list(): BrowserSession[] {
    return [...this.sessions.values()].map((record) => structuredClone(record.session));
  }

  /**
   * Retrieve a session record with lifecycle validation.
   *
   * Args:
   *   id (string): Runtime session identifier.
   *   allowClosed (boolean): Whether cleanup can inspect closed sessions.
   * Returns:
   *   SessionRecord: Privately owned session record.
   */
  private record(id: string, allowClosed = false): SessionRecord {
    const record = this.sessions.get(id);
    // Distinguish absent sessions from known sessions that have been closed.
    if (!record) throw new BrowserError('SESSION_NOT_FOUND', 'Session does not exist.');
    if (!allowClosed && ['closed', 'closing'].includes(record.session.status))
      throw new BrowserError('SESSION_CLOSED', 'Session is closed.');
    return record;
  }

  /**
   * Retrieve a complete capability report from the selected adapter.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<CapabilityReport>: Supported capabilities and unavailable reasons.
   */
  async capabilities(id: string): Promise<CapabilityReport> {
    const record = this.record(id);
    const report = await record.engine.capabilities(id);
    // Validate adapter output before returning it through MCP or CLI.
    validateOutput(capabilityReportSchema, report);
    return structuredClone(report);
  }

  /**
   * Capture a validated accessibility snapshot for a session.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<BrowserSnapshot>: Snapshot suitable for display and target selection.
   */
  async observe(id: string): Promise<BrowserSnapshot> {
    const record = this.record(id);
    this.guard.authorizeRead?.(id, await record.engine.currentUrl(id));
    const referenceObservation =
      record.session.status === 'ready' || record.session.status === 'paused';
    // Busy reads preserve adapter caller caches as well as the Core reference cache.
    if (!referenceObservation && !record.engine.inspectionSnapshot)
      throw new BrowserError(
        'UNSUPPORTED_CAPABILITY',
        'Independent busy-session observation is unavailable.',
      );
    const observed = referenceObservation
      ? await record.engine.observe(id)
      : await record.engine.inspectionSnapshot!(id);
    validateOutput(snapshotSchema, observed);
    const snapshot = filterSnapshot(observed);
    // Enforce session ownership and schema invariants on observed data.
    validateOutput(snapshotSchema, snapshot);
    if (snapshot.sessionId !== id)
      throw new BrowserError('INTERNAL_ERROR', 'Snapshot belongs to a different session.');
    // Only idle snapshots become input references; busy observations remain read-only.
    if (
      referenceObservation &&
      (record.session.status === 'ready' || record.session.status === 'paused')
    )
      record.snapshot = structuredClone(snapshot);
    return structuredClone(snapshot);
  }

  /**
   * Capture a session screenshot using its selected execution engine.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<object>: MIME type and controlled artifact identifier.
   */
  async screenshot(id: string): Promise<{ mimeType: 'image/png'; blobId: string }> {
    const record = this.record(id);
    this.guard.authorizeRead?.(id, await record.engine.currentUrl(id));
    return record.engine.screenshot(id);
  }

  /**
   * Submit an action with exactly-once request identity within the session.
   *
   * Args:
   *   value (unknown): Action envelope and strict action arguments.
   * Returns:
   *   Promise<ActionResult>: Cached or newly executed action result.
   */
  async execute(value: unknown): Promise<ActionResult> {
    const input = structuredClone(parseAction(value));
    const record = this.record(input.sessionId);
    const digest = createHash('sha256').update(canonical(input)).digest('hex');
    const existing = record.requests.get(input.requestId);
    // Return duplicate requests without repeating input or changing authorization.
    if (existing) {
      if (existing.digest !== digest)
        throw new BrowserError('INVALID_ARGUMENT', 'Request identifier has a different payload.');
      const cached = await existing.result;
      const state = this.guard.approvalState?.(input);
      // Denied and expired decisions terminate the original pending request.
      if (cached.status === 'approval-required' && (state === 'denied' || state === 'expired')) {
        const result: ActionResult = {
          ...cached,
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          error: {
            code: 'POLICY_DENIED',
            message: 'Approval was denied or expired.',
            retryable: false,
          },
        };
        record.requests.set(input.requestId, { digest, result: Promise.resolve(result) });
        return structuredClone(result);
      }
      // An approved pending operation can resume once under the original request identity.
      if (
        cached.status === 'approval-required' &&
        state === 'approved' &&
        record.requests.get(input.requestId) === existing
      ) {
        const result = this.run(record, input);
        record.requests.set(input.requestId, { digest, result });
        return structuredClone(await result);
      }
      // Reuse a resumed operation rather than retaining its earlier approval challenge.
      if (record.requests.get(input.requestId) !== existing)
        return structuredClone(await record.requests.get(input.requestId)!.result);
      return structuredClone(cached);
    }
    // Keep every request identity for the session lifetime instead of evicting it.
    if (record.requests.size >= this.maxRequests)
      throw new BrowserError('DESKTOP_BUSY', 'Request history capacity is exhausted.');
    const result = this.run(record, input);
    record.requests.set(input.requestId, { digest, result });
    return structuredClone(await result);
  }

  /**
   * Authorize and run one operation under the session input owner.
   *
   * Args:
   *   record (SessionRecord): Privately owned session and adapter state.
   *   input (ActionRequest): Fully validated action.
   * Returns:
   *   Promise<ActionResult>: Classified execution result.
   */
  private async run(record: SessionRecord, input: ActionRequest): Promise<ActionResult> {
    const startedAt = new Date().toISOString();
    const actionId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ownsBusy = false;
    let executionPath: ExecutionPath = 'not-executed';
    // Convert expected failures to typed results while retaining request identity.
    try {
      if (record.session.status !== 'ready')
        throw new BrowserError('DESKTOP_BUSY', 'Session is not ready for input.');
      record.session.status = 'busy';
      ownsBusy = true;
      const report = await this.capabilities(input.sessionId);
      const tool = MCP_TOOLS.find((candidate) => candidate.name === ACTION_TO_TOOL[input.action]);
      // Reject unavailable semantics before consulting or invoking an input adapter.
      if (tool?.requiredCapability && !report.supported.includes(tool.requiredCapability))
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'Action capability is unavailable.');
      if (input.args?.strategy === 'ime' && !report.supported.includes('input.ime'))
        throw new BrowserError('UNSUPPORTED_CAPABILITY', 'IME composition is unavailable.');
      const targets: AxNode[] = [];
      const references = [
        input.target,
        ...(input.action === 'drag'
          ? [input.args?.source as Target, input.args?.destination as Target]
          : []),
      ];
      // Validate every drag endpoint and direct target against the caller's snapshot.
      for (const reference of references) {
        if (reference?.kind !== 'ax-node') continue;
        if (record.snapshot?.snapshotId !== reference.snapshotId)
          throw new BrowserError(
            'TARGET_STALE',
            'A new observation is required.',
            true,
            'browser_observe',
          );
        const target = findNode(record.snapshot.root, reference.nodeId);
        if (!target)
          throw new BrowserError('TARGET_NOT_FOUND', 'Target does not exist in the snapshot.');
        targets.push(target);
      }
      if (input.expectedSnapshotId && input.expectedSnapshotId !== record.snapshot?.snapshotId)
        throw new BrowserError(
          'TARGET_STALE',
          'Expected snapshot has expired.',
          true,
          'browser_observe',
        );
      const url = await record.engine.currentUrl(input.sessionId);
      // Confirm origin authorization before reading private current semantic context.
      this.guard.authorizeRead?.(input.sessionId, url);
      let inspection: BrowserSnapshot | undefined;
      let semanticSnapshot = record.snapshot;
      const coordinates = coordinateReferences(input);
      // Inspect coordinates independently so mixed drag AX endpoints retain the caller's original cache.
      if (coordinates.length > 0) {
        if (!record.engine.inspectionSnapshot)
          throw new BrowserError(
            'UNSUPPORTED_CAPABILITY',
            'Coordinate semantic inspection is unavailable.',
          );
        const observed = await record.engine.inspectionSnapshot(input.sessionId);
        validateOutput(snapshotSchema, observed);
        inspection = filterSnapshot(observed);
        if (inspection.sessionId !== input.sessionId || inspection.url !== url)
          throw new BrowserError('TARGET_STALE', 'Coordinate inspection page identity changed.');
        semanticSnapshot = inspection;
        for (const coordinate of coordinates)
          targets.push(...coordinateTargets(inspection, coordinate));
      }
      // Bind text submission and activation keys to the current focused semantic control.
      if (
        input.action === 'type-text' ||
        (input.action === 'key-press' &&
          ['Enter', 'Return', 'Space', ' '].includes(String(input.args?.key)))
      ) {
        const observed = record.engine.inspectionSnapshot
          ? await record.engine.inspectionSnapshot(input.sessionId)
          : await record.engine.observe(input.sessionId);
        validateOutput(snapshotSchema, observed);
        if (observed.sessionId !== input.sessionId)
          throw new BrowserError(
            'INTERNAL_ERROR',
            'Focused observation belongs to another session.',
          );
        semanticSnapshot = filterSnapshot(observed);
        const focused = focusedControl(semanticSnapshot.root);
        if (focused) targets.push(focused);
      }
      // Apply authorization to current browser state immediately before execution.
      if (semanticSnapshot && this.guard.authorizeTargets) {
        await this.guard.authorizeTargets(input, url, {
          source: semanticSnapshot.source,
          windowId: semanticSnapshot.windowId,
          ...(semanticSnapshot.tabId ? { tabId: semanticSnapshot.tabId } : {}),
          targets,
        });
      } else {
        if (targets.length === 0) await this.guard.authorize(input, url);
        for (const target of targets) await this.guard.authorize(input, url, target);
      }
      if ((await record.engine.currentUrl(input.sessionId)) !== url)
        throw new BrowserError(
          'TARGET_STALE',
          'Browser location changed during authorization.',
          true,
          'browser_observe',
        );
      executionPath = record.engine.kind === 'compatible' ? 'playwright-cdp' : 'os-input';
      const operation = record.engine.execute(input, inspection);
      record.active = operation;
      // Retain ownership until the real adapter operation settles after a timeout.
      void operation
        .finally(() => {
          delete record.active;
          delete record.snapshot;
          if (record.session.status === 'busy') record.session.status = 'ready';
        })
        .catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void record.engine.cancel?.(input.sessionId).catch(() => undefined);
          reject(new BrowserError('TIMEOUT', 'Action deadline exceeded.'));
        }, input.timeoutMs ?? this.timeoutMs);
      });
      const result = await Promise.race([operation, deadline]);
      // Reject inconsistent adapter result identifiers and malformed output.
      validateOutput(actionResultSchema, result);
      if (result.sessionId !== input.sessionId || result.requestId !== input.requestId)
        throw new BrowserError('INTERNAL_ERROR', 'Adapter result has inconsistent ownership.');
      // Recheck completed browser state after navigation or page-triggered transitions.
      if (result.status === 'succeeded')
        this.guard.authorizeRead?.(
          input.sessionId,
          await record.engine.currentUrl(input.sessionId),
        );
      this.audit({
        event: 'action-finished',
        sessionId: input.sessionId,
        requestId: input.requestId,
        engine: record.session.engine,
      });
      return result;
    } catch (error) {
      const failure = normalizeError(error);
      this.audit({
        event: 'action-failed',
        sessionId: input.sessionId,
        requestId: input.requestId,
        code: failure.code,
      });
      return {
        requestId: input.requestId,
        actionId,
        sessionId: input.sessionId,
        status: failure.code === 'APPROVAL_REQUIRED' ? 'approval-required' : 'failed',
        executionPath,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: failure.toJSON(),
        ...('approvalId' in failure && typeof failure.approvalId === 'string'
          ? { approvalId: failure.approvalId }
          : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (ownsBusy && !record.active && record.session.status === 'busy')
        record.session.status = 'ready';
    }
  }

  /**
   * Pause a session and release adapter input ownership.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<void>: Completion of input pause.
   */
  async pause(id: string): Promise<void> {
    const record = this.record(id);
    // Change state before awaiting the adapter to reject racing input requests.
    record.session.status = 'paused';
    await record.engine.cancel?.(id);
    await record.engine.pause(id);
    this.audit({ event: 'session-paused', sessionId: id });
  }

  /**
   * Resume a paused session after its adapter is ready for input.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<void>: Completion of session resumption.
   */
  async resume(id: string): Promise<void> {
    const record = this.record(id);
    // Resume only an idle paused session with no outstanding physical input.
    if (record.session.status !== 'paused' || record.active)
      throw new BrowserError('DESKTOP_BUSY', 'Session cannot resume in its current state.');
    await record.engine.resume(id);
    record.session.status = 'ready';
    delete record.snapshot;
  }

  /**
   * Close a session idempotently and retain terminal metadata.
   *
   * Args:
   *   id (string): Runtime session identifier.
   * Returns:
   *   Promise<void>: Completion of adapter resource release.
   */
  async close(id: string): Promise<void> {
    const record = this.record(id, true);
    // Duplicate close requests share the original cleanup operation.
    if (record.session.status === 'closed') return;
    if (record.closing) return record.closing;
    record.session.status = 'closing';
    record.closing = (async () => {
      // Classify cleanup failure while retaining metadata for a retry.
      try {
        await record.engine.cancel?.(id).catch((error: unknown) => {
          // Continue resource release after a disconnected cancellation backend.
          this.audit({
            event: 'session-cancel-failed',
            sessionId: id,
            code: normalizeError(error).code,
          });
        });
        await record.engine.close(id);
        await this.guard.closed?.(record.session);
        record.session.status = 'closed';
        record.requests.clear();
        delete record.snapshot;
        this.audit({ event: 'session-closed', sessionId: id });
      } catch (error) {
        record.session.status = 'failed';
        this.audit({
          event: 'session-close-failed',
          sessionId: id,
          code: normalizeError(error).code,
        });
        throw normalizeError(error);
      } finally {
        delete record.closing;
      }
    })();
    return record.closing;
  }

  /**
   * Close every session while allowing independent cleanup to complete.
   *
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of all session cleanup attempts.
   */
  async closeAll(): Promise<void> {
    const outcomes = await Promise.allSettled(this.list().map((session) => this.close(session.id)));
    // Report an aggregate failure after all independent resources have been visited.
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new BrowserError('INTERNAL_ERROR', 'One or more sessions failed to close.');
  }
}
