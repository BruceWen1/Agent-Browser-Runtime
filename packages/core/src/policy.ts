// -*- coding: utf-8 -*-
/**
 * policy.ts
 * Origin, profile, and approval enforcement
 * =====================
 * Restrict actions to authorized origins, owned profiles, and reviewed file operations.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserError } from '@abr/contracts';
import type { ActionRequest, AxNode, BrowserSession, CreateSessionRequest } from '@abr/contracts';

import { applicationDataDirectory, expandPath } from './config.js';
import type { RuntimeConfig } from './config.js';
import type { RuntimeGuard } from './runtime.js';
import { requestDigest } from './identity.js';

interface OriginPattern {
  protocol: string;
  hostname: string;
  port: string;
  anyPort: boolean;
}
interface SessionPolicy {
  name: string;
  origins: string[];
  mode: 'ephemeral' | 'persistent';
}
export interface ApprovalRecord {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  sessionId: string;
  requestId: string;
  action: string;
  origin: string;
  createdAt: string;
  expiresAt: string;
}

/** ApprovalRequiredError identifies a pending trusted user decision. */
class ApprovalRequiredError extends BrowserError {
  /**
   * Initialize a typed approval challenge.
   * Args:
   *   approvalId (string): Identifier of the pending local decision.
   * Returns:
   *   ApprovalRequiredError: Initialized challenge without confidential arguments.
   */
  constructor(readonly approvalId: string) {
    super('APPROVAL_REQUIRED', 'This operation requires a local user decision.');
  }
}

/**
 * Parse an exact origin or exact host with a wildcard port.
 * Args:
 *   pattern (string): Trusted allowlist or denylist entry.
 * Returns:
 *   OriginPattern: Canonical host, protocol, and port constraints.
 */
function originPattern(pattern: string): OriginPattern {
  // Permit wildcard ports while requiring an exact hostname and HTTP scheme.
  if (!/^https?:\/\/(?:\[[a-fA-F0-9:]+\]|[^\/?#:@]+)(?::(?:\*|\d+))?$/.test(pattern))
    throw new BrowserError('INVALID_ARGUMENT', 'Origin pattern is invalid.');
  const anyPort = pattern.endsWith(':*');
  const url = new URL(anyPort ? pattern.slice(0, -1) + '65535' : pattern);
  return { protocol: url.protocol, hostname: url.hostname, port: url.port, anyPort };
}

/**
 * Compare a canonical URL with an exact origin policy entry.
 * Args:
 *   url (URL): Parsed browser destination.
 *   pattern (string): Trusted policy entry.
 * Returns:
 *   boolean: Whether protocol, hostname, and port are authorized.
 */
function matches(url: URL, pattern: string): boolean {
  const rule = originPattern(pattern);
  return (
    url.protocol === rule.protocol &&
    url.hostname === rule.hostname &&
    (rule.anyPort || url.port === rule.port)
  );
}

/**
 * Check that a resolved candidate remains below an authorized directory.
 * Args:
 *   root (string): Canonical authorized directory.
 *   candidate (string): Canonical target path.
 * Returns:
 *   boolean: Whether the candidate is a descendant of the directory.
 */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

/** PolicyEngine enforces trusted local origin and filesystem policies for each session. */
export class PolicyEngine implements RuntimeGuard {
  readonly profileRoot: string;
  private readonly sessions = new Map<string, SessionPolicy>();
  private readonly claims = new Set<string>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly approvalKeys = new Map<string, string>();
  private readonly approvalUrls = new Map<string, string>();

  /**
   * Initialize origin and path policy from validated local configuration.
   * Args:
   *   config (RuntimeConfig): Trusted runtime configuration.
   *   dataDirectory (string): Application data root for registered variables.
   * Returns:
   *   PolicyEngine: Initialized per-user authorization service.
   */
  constructor(
    readonly config: RuntimeConfig,
    readonly dataDirectory = applicationDataDirectory(),
  ) {
    this.profileRoot = expandPath(config.browser.profileRoot, dataDirectory);
    // Validate configured origin entries before creating any browser process.
    for (const pattern of [...config.policy.allowedOrigins, ...config.policy.deniedOrigins])
      originPattern(pattern);
  }

  /**
   * Allocate a profile name and validate narrowed session authorization.
   * Args:
   *   input (CreateSessionRequest): Proposed browser session.
   * Returns:
   *   Promise<CreateSessionRequest>: Authorized request with an owned profile name.
   */
  async prepareSession(input: CreateSessionRequest): Promise<CreateSessionRequest> {
    const origins = input.allowedOrigins ?? this.config.policy.allowedOrigins;
    // Session requests can narrow existing authorization but cannot extend it.
    for (const requested of origins) {
      const child = originPattern(requested);
      const permitted = this.config.policy.allowedOrigins.some((entry) => {
        const parent = originPattern(entry);
        return (
          parent.protocol === child.protocol &&
          parent.hostname === child.hostname &&
          (parent.anyPort || (!child.anyPort && parent.port === child.port))
        );
      });
      if (!permitted)
        throw new BrowserError(
          'POLICY_DENIED',
          'Session origin scope exceeds local authorization.',
        );
    }
    const name = input.profile.mode === 'ephemeral' ? randomUUID() : input.profile.name!;
    // Use a portable single filename segment and reject reserved Windows device names.
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) ||
      /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Profile name is invalid.');
    if (this.claims.has(name.toLowerCase()))
      throw new BrowserError('DESKTOP_BUSY', 'Profile is already in use.');
    this.claims.add(name.toLowerCase());
    // Verify existing directories before admitting a profile to the runtime.
    try {
      await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
      const directory = path.join(this.profileRoot, name);
      const information = await lstat(directory).catch(() => undefined);
      // Existing profiles must be ABR-owned directories rather than redirected paths.
      if (information) {
        if (!information.isDirectory() || information.isSymbolicLink())
          throw new BrowserError('POLICY_DENIED', 'Profile directory is redirected or invalid.');
        const marker = JSON.parse(
          await readFile(path.join(directory, '.abr-profile.json'), 'utf8'),
        ) as { schemaVersion?: number; name?: string };
        if (marker.schemaVersion !== 1 || marker.name !== name)
          throw new BrowserError('POLICY_DENIED', 'Profile directory is not owned by ABR.');
      } else {
        await mkdir(directory, { mode: 0o700 });
        await writeFile(
          path.join(directory, '.abr-profile.json'),
          JSON.stringify({ schemaVersion: 1, name }),
          { flag: 'wx', mode: 0o600 },
        );
      }
      const resolved = await realpath(directory);
      if (!isWithin(await realpath(this.profileRoot), resolved))
        throw new BrowserError('POLICY_DENIED', 'Profile path exceeds its authorized root.');
      return { ...input, profile: { ...input.profile, name }, allowedOrigins: [...origins] };
    } catch (error) {
      this.claims.delete(name.toLowerCase());
      // Expose policy errors while masking filesystem paths and original payloads.
      if (error instanceof BrowserError) throw error;
      throw new BrowserError(
        'POLICY_DENIED',
        'Profile directory is unavailable or not owned by ABR.',
      );
    }
  }

  /**
   * Bind an allocated profile and origin scope to the actual session.
   * Args:
   *   session (BrowserSession): Validated adapter session.
   *   input (CreateSessionRequest): Authorized startup request.
   * Returns:
   *   Promise<void>: Completion of session policy registration.
   */
  async created(session: BrowserSession, input: CreateSessionRequest): Promise<void> {
    this.sessions.set(session.id, {
      name: input.profile.name!,
      origins: input.allowedOrigins!,
      mode: input.profile.mode,
    });
  }

  /**
   * Release profile ownership after session cleanup.
   * Args:
   *   session (BrowserSession): Closed adapter session.
   * Returns:
   *   Promise<void>: Completion of authorization resource release.
   */
  async closed(session: BrowserSession): Promise<void> {
    const record = this.sessions.get(session.id);
    // Release only the profile claim owned by this session.
    if (record) {
      if (record.mode === 'ephemeral') await this.cleanProfile(record.name);
      this.claims.delete(record.name.toLowerCase());
    }
    this.sessions.delete(session.id);
  }

  /**
   * Release a profile reservation after failed startup.
   * Args:
   *   input (CreateSessionRequest): Authorized startup request.
   * Returns:
   *   Promise<void>: Completion of reservation cleanup.
   */
  async failed(input: CreateSessionRequest): Promise<void> {
    if (input.profile.name) {
      if (input.profile.mode === 'ephemeral') await this.cleanProfile(input.profile.name);
      this.claims.delete(input.profile.name.toLowerCase());
    }
  }

  /**
   * Remove an owned temporary profile after validating its absolute target.
   * Args:
   *   name (string): Profile segment allocated by this policy.
   * Returns:
   *   Promise<void>: Completion of bounded profile cleanup.
   */
  private async cleanProfile(name: string): Promise<void> {
    const candidate = path.resolve(this.profileRoot, name);
    // Restrict recursive cleanup to an owned descendant of the configured root.
    if (!isWithin(path.resolve(this.profileRoot), candidate))
      throw new BrowserError('POLICY_DENIED', 'Profile cleanup target is invalid.');
    const information = await lstat(candidate).catch(() => undefined);
    if (!information) return;
    if (information.isSymbolicLink())
      throw new BrowserError('POLICY_DENIED', 'Profile cleanup target is redirected.');
    const marker = JSON.parse(
      await readFile(path.join(candidate, '.abr-profile.json'), 'utf8'),
    ) as { name?: string };
    if (
      marker.name !== name ||
      !isWithin(await realpath(this.profileRoot), await realpath(candidate))
    )
      throw new BrowserError('POLICY_DENIED', 'Profile cleanup ownership is invalid.');
    await rm(candidate, { recursive: true, force: true });
  }

  /**
   * Verify a URL against effective session authorization.
   * Args:
   *   sessionId (string): Session owning the requested operation.
   *   value (string): Current or requested browser URL.
   * Returns:
   *   URL: Authorized parsed destination.
   */
  checkUrl(sessionId: string, value: string): URL {
    const record = this.sessions.get(sessionId);
    // Reject actions before a session has an effective authorization scope.
    if (!record) throw new BrowserError('POLICY_DENIED', 'Session authorization is unavailable.');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BrowserError('INVALID_ARGUMENT', 'Browser URL is invalid.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new BrowserError('POLICY_DENIED', 'Browser destination is not authorized.');
    if (
      this.config.policy.deniedOrigins.some((entry) => matches(url, entry)) ||
      !record.origins.some((entry) => matches(url, entry))
    )
      throw new BrowserError('POLICY_DENIED', 'Browser origin is not authorized.');
    return url;
  }

  /**
   * Authorize observation of current browser state.
   * Args:
   *   sessionId (string): Session owning the observed browser.
   *   url (string): Current trusted browser URL.
   * Returns:
   *   void: Completion of read authorization.
   */
  authorizeRead(sessionId: string, url: string): void {
    // Blank startup pages contain only the runtime-owned initial browser surface.
    if (url !== 'about:blank') this.checkUrl(sessionId, url);
  }

  /**
   * Validate upload paths after resolving filesystem redirects.
   * Args:
   *   filename (string): File path explicitly requested for upload.
   * Returns:
   *   Promise<string>: Canonical authorized regular file path.
   */
  async checkUpload(filename: string): Promise<string> {
    // Reject network paths and lexical escapes before filesystem operations.
    if (/^(?:\\\\|\/\/)/.test(filename))
      throw new BrowserError('POLICY_DENIED', 'Network upload paths are unavailable.');
    const absolute = path.resolve(filename);
    const roots = this.config.policy.allowedUploadRoots.map((root) =>
      expandPath(root, this.dataDirectory),
    );
    const lexicalRoot = roots.find((root) => isWithin(root, absolute));
    if (!lexicalRoot)
      throw new BrowserError('POLICY_DENIED', 'Upload path is outside authorized roots.');
    // Resolve the file and allowed roots before comparing directory boundaries.
    try {
      let ancestor = lexicalRoot;
      // Inspect descendants in order and reject redirects before following them.
      for (const segment of path.relative(lexicalRoot, absolute).split(path.sep)) {
        ancestor = path.join(ancestor, segment);
        if ((await lstat(ancestor)).isSymbolicLink())
          throw new BrowserError('POLICY_DENIED', 'Upload path is redirected.');
      }
      const candidate = await realpath(filename);
      const information = await stat(candidate);
      if (!information.isFile())
        throw new BrowserError('POLICY_DENIED', 'Upload target must be a regular file.');
      for (const configured of this.config.policy.allowedUploadRoots) {
        const root = await realpath(expandPath(configured, this.dataDirectory));
        if (isWithin(root, candidate)) return candidate;
      }
    } catch (error) {
      if (error instanceof BrowserError) throw error;
    }
    throw new BrowserError(
      'POLICY_DENIED',
      'Upload path is unavailable or outside authorized roots.',
    );
  }

  /**
   * Compute a decision key without storing action arguments in UI metadata.
   * Args:
   *   input (ActionRequest): Exact requested operation.
   * Returns:
   *   string: Digest bound to the session and operation payload.
   */
  private key(input: ActionRequest): string {
    return requestDigest(input);
  }

  /**
   * Authorize an operation against current origin and sensitive action policy.
   * Args:
   *   input (ActionRequest): Strict runtime operation.
   *   currentUrl (string): Current trusted browser URL.
   *   target (AxNode | undefined): Selected semantic target when available.
   * Returns:
   *   Promise<void>: Completion of authorization or an approval challenge.
   */
  async authorize(input: ActionRequest, currentUrl: string, target?: AxNode): Promise<void> {
    // Initial blank pages accept only navigation to an authorized destination.
    if (input.action === 'navigate') {
      this.checkUrl(input.sessionId, String(input.args?.url));
      if (currentUrl !== 'about:blank') this.checkUrl(input.sessionId, currentUrl);
    } else this.checkUrl(input.sessionId, currentUrl);
    // File transfers additionally require canonical file path authorization.
    if (input.action === 'choose-file') await this.checkUpload(String(input.args?.filePath));
    const sensitiveName =
      /(?:pay|payment|purchase|delete|send message|upload|付款|支付|删除|发送|上传)/i.test(
        target?.name ?? '',
      );
    const customSensitive = this.config.policy.sensitiveTargetPatterns.some((pattern) =>
      (target?.name ?? '').includes(pattern),
    );
    // Require a local user decision for explicit transfers and configured sensitive controls.
    if (input.action !== 'choose-file' && !sensitiveName && !customSensitive) return;
    const key = this.key(input);
    let id = this.approvalKeys.get(key);
    const existing = id ? this.approvals.get(id) : undefined;
    if (
      existing?.status === 'approved' &&
      this.approvalUrls.get(existing.id) === currentUrl &&
      Date.parse(existing.expiresAt) > Date.now()
    )
      return;
    if (existing?.status === 'denied')
      throw new BrowserError('POLICY_DENIED', 'The local user denied this operation.');
    // Create a bounded review record containing identifiers and origin only.
    if (
      !existing ||
      Date.parse(existing.expiresAt) <= Date.now() ||
      this.approvalUrls.get(existing.id) !== currentUrl
    ) {
      id = randomUUID();
      this.approvalKeys.set(key, id);
      this.approvalUrls.set(id, currentUrl);
      this.approvals.set(id, {
        id,
        status: 'pending',
        sessionId: input.sessionId,
        requestId: input.requestId,
        action: input.action,
        origin: new URL(currentUrl).origin,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
    }
    throw new ApprovalRequiredError(id!);
  }

  /**
   * Read the current decision state for an exact operation.
   * Args:
   *   input (ActionRequest): Operation whose approval state is requested.
   * Returns:
   *   ApprovalRecord.status | undefined: Decision state when a review exists.
   */
  approvalState(input: ActionRequest): ApprovalRecord['status'] | undefined {
    const id = this.approvalKeys.get(this.key(input));
    return id ? this.approvalStatus(id).status : undefined;
  }

  /**
   * Query review metadata for the read-only MCP approval tool.
   * Args:
   *   id (string): Review identifier.
   * Returns:
   *   ApprovalRecord: Copy of bounded review metadata.
   */
  approvalStatus(id: string): ApprovalRecord {
    const record = this.approvals.get(id);
    if (!record) throw new BrowserError('INVALID_ARGUMENT', 'Approval does not exist.');
    if (
      (record.status === 'pending' || record.status === 'approved') &&
      Date.parse(record.expiresAt) <= Date.now()
    )
      record.status = 'expired';
    return structuredClone(record);
  }

  /**
   * Record a decision received exclusively from the trusted local UI.
   * Args:
   *   id (string): Pending review identifier.
   *   approved (boolean): Explicit local user decision.
   * Returns:
   *   void: Completion of the decision update.
   */
  reviewFromTrustedUi(id: string, approved: boolean): void {
    const state = this.approvalStatus(id);
    if (state.status !== 'pending')
      throw new BrowserError('INVALID_ARGUMENT', 'Approval is not pending.');
    this.approvals.get(id)!.status = approved ? 'approved' : 'denied';
  }
}
