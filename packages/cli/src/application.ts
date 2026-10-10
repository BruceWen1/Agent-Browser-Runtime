// -*- coding: utf-8 -*-
/**
 * application.ts
 * Production runtime assembly
 * =====================
 * Assemble shared policy, artifacts, diagnostics, and explicitly available adapters.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactStore } from '@abr/artifacts';
import {
  EngineRegistry,
  PolicyEngine,
  Runtime,
  applicationDataDirectory,
  createLogger,
} from '@abr/core';
import type { RuntimeConfig, RuntimeLogger } from '@abr/core';
import { GuiEngine, LocalControlUi, NativeEngine, ReviewUi } from '@abr/native-ipc-client';
import { CompatibleEngine, resolveBrowserBinary } from '@abr/playwright-worker';

export interface Application {
  runtime: Runtime;
  policy: PolicyEngine;
  artifacts: ArtifactStore;
  logger: RuntimeLogger;
  dataDirectory: string;
  closeReviewUi: () => void;
}

/**
 * Assemble a production runtime from validated local configuration.
 * Args:
 *   config (RuntimeConfig): Local user configuration.
 * Returns:
 *   object: Runtime and its owned application services.
 */
export function createApplication(config: RuntimeConfig): Application {
  const dataDirectory = applicationDataDirectory();
  const logger = createLogger(config.runtime.logLevel);
  const artifacts = new ArtifactStore({
    root: path.join(dataDirectory, 'artifacts'),
    ttlMs: Math.max(60000, config.runtime.artifactRetentionDays * 86400000),
    persistScreenshots: config.privacy.persistScreenshots,
  });
  const policy = new PolicyEngine(config, dataDirectory);
  const registry = new EngineRegistry();
  // Register the official compatible adapter without starting a browser for read-only commands.
  registry.register(
    new CompatibleEngine({
      profileRoot: policy.profileRoot,
      artifactRoot: path.join(dataDirectory, 'worker-artifacts'),
      ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
      /**
       * Store a privacy-filtered compatible screenshot.
       * Args:
       *   sessionId (string): Owned compatible session.
       *   bytes (Buffer): Masked PNG capture bytes.
       * Returns:
       *   Promise<string>: Controlled artifact identifier.
       */
      putScreenshot(sessionId, bytes) {
        return artifacts.putPng(sessionId, bytes);
      },
    }),
  );
  const workspace = fileURLToPath(new URL('../../../', import.meta.url));
  const agentName = process.platform === 'win32' ? 'abr-desktop-agent.exe' : 'abr-desktop-agent';
  const agentExecutable =
    config.gui.agentExecutable ??
    ['bin', 'target/release', 'target/debug']
      .map((directory) => path.join(workspace, directory, agentName))
      .find(existsSync);
  const reviewUi = agentExecutable ? new ReviewUi(agentExecutable) : undefined;
  const controls = new Map<string, LocalControlUi>();
  if (reviewUi)
    policy.setApprovalListener((record, digest) => {
      // Accept a decision exclusively from the separately supervised native user surface.
      void reviewUi
        .decide({ ...record, digest })
        .then((approved) => {
          if (
            typeof approved === 'boolean' &&
            policy.approvalStatus(record.id).status === 'pending'
          )
            policy.reviewFromTrustedUi(record.id, approved);
        })
        .catch(() => logger.warn({ event: 'approval-ui-failed', code: 'PERMISSION_REQUIRED' }));
    });
  // Register native input only when its local executable is actually present.
  if (agentExecutable)
    registry.register(
      new GuiEngine({
        agentExecutable,
        runtimeDirectory: path.join(dataDirectory, 'runtime'),
        profileRoot: policy.profileRoot,
        sensitivePatterns: config.privacy.sensitivePatterns,
        /**
         * Resolve the selected ordinary browser through official binary metadata.
         * Args:
         *   input (CreateSessionRequest): Validated browser selection.
         * Returns:
         *   Promise<object>: Existing executable and declared binary version.
         */
        async resolveBrowser(input) {
          return resolveBrowserBinary(input, config.browser.executablePath);
        },
        /**
         * Store an already masked native screenshot.
         * Args:
         *   sessionId (string): Owned browser session.
         *   bytes (Buffer): Masked PNG capture bytes.
         * Returns:
         *   Promise<string>: Controlled artifact identifier.
         */
        putScreenshot(sessionId, bytes) {
          return artifacts.putPng(sessionId, bytes);
        },
      }),
    );
  const versionLock = path.join(workspace, 'chromium', 'VERSION.lock');
  // Native registration requires explicit configuration and a committed upstream identity.
  if (
    agentExecutable &&
    config.native.enabled &&
    config.browser.executablePath &&
    existsSync(config.browser.executablePath) &&
    existsSync(versionLock)
  ) {
    const pin = JSON.parse(readFileSync(versionLock, 'utf8')) as {
      schemaVersion: number;
      upstreamCommit: string;
      upstreamTag: string;
    };
    if (
      pin.schemaVersion !== 1 ||
      !/^[a-f0-9]{40}$/.test(pin.upstreamCommit) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(pin.upstreamTag)
    )
      throw new Error('Native version lock is invalid.');
    registry.register(
      new NativeEngine({
        agentExecutable,
        runtimeDirectory: path.join(dataDirectory, 'runtime'),
        profileRoot: policy.profileRoot,
        upstreamCommit: pin.upstreamCommit,
        upstreamVersion: pin.upstreamTag,
        sensitivePatterns: config.privacy.sensitivePatterns,
        /**
         * Resolve a configured native Chromium executable.
         * Args:
         *   input (CreateSessionRequest): Explicit custom browser selection.
         * Returns:
         *   Promise<object>: Existing custom browser executable metadata.
         */
        async resolveBrowser(input) {
          return resolveBrowserBinary(input, config.browser.executablePath);
        },
        /**
         * Store an OS capture from the native browser session.
         * Args:
         *   sessionId (string): Owned native browser session.
         *   bytes (Buffer): Privacy-filtered PNG capture.
         * Returns:
         *   Promise<string>: Controlled artifact identifier.
         */
        putScreenshot(sessionId, bytes) {
          return artifacts.putPng(sessionId, bytes);
        },
      }),
    );
  }
  const runtime = new Runtime(registry, policy, {
    maxSessions: config.runtime.maxSessions,
    actionTimeoutMs: config.runtime.actionTimeoutMs,
    /**
     * Prepare an independent trusted control surface before exposing a GUI session.
     * Args:
     *   session (BrowserSession): Newly created owned browser session.
     * Returns:
     *   Promise<void>: Completion of native handover control initialization.
     */
    async onCreated(session) {
      if (session.engine === 'compatible' || process.platform !== 'win32' || !agentExecutable)
        return;
      const control = await LocalControlUi.start({
        executable: agentExecutable,
        sessionId: session.id,
        inputProcessId: await (registry.get(session.engine) as GuiEngine).inputProcessId(
          session.id,
        ),
        /**
         * Apply a session-scoped lifecycle request received from physical local UI controls.
         * Args:
         *   event (LocalControlEvent): Explicit local pause, resume, or stop decision.
         *   sessionId (string): Exact session inherited by the owned UI process.
         * Returns:
         *   Promise<void>: Completion of the authorized local lifecycle operation.
         */
        async onEvent(event, sessionId) {
          const session = runtime.list().find((candidate) => candidate.id === sessionId);
          if (!session || ['closing', 'closed'].includes(session.status)) return;
          if (event === 'pause' && session.status !== 'paused') await runtime.pause(sessionId);
          else if (event === 'resume' && session.status === 'paused')
            await runtime.resume(sessionId);
          else if (event === 'stop') await runtime.close(sessionId);
        },
        /**
         * Pause owned automation if its trusted control surface disconnects unexpectedly.
         * Args:
         *   error (BrowserError): Safe classified control failure.
         *   sessionId (string): Owned session whose control became unavailable.
         * Returns:
         *   void: Completion of asynchronous fail-safe pause scheduling.
         */
        onFailure(error, sessionId) {
          logger.warn({ event: 'control-ui-failed', sessionId, code: error.code });
          void runtime.pause(sessionId).catch(() => undefined);
        },
      });
      controls.set(session.id, control);
      // Release a ready control if a physical stop completed during initialization.
      const current = runtime.list().find((candidate) => candidate.id === session.id);
      if (!current || ['closing', 'closed'].includes(current.status)) {
        control.close();
        controls.delete(session.id);
      }
    },
    /**
     * Record safe operation metadata in diagnostics and session history.
     * Args:
     *   event (AuditEvent): Bounded runtime operation metadata.
     * Returns:
     *   void: Completion of diagnostic recording.
     */
    audit(event) {
      if (event.event === 'session-closed' && event.sessionId) {
        controls.get(event.sessionId)?.close();
        controls.delete(event.sessionId);
      }
      logger.info(event);
      artifacts.record(event);
    },
  });
  return {
    runtime,
    policy,
    artifacts,
    logger,
    dataDirectory,
    /**
     * Release every independently owned approval and handover surface.
     * Args:
     *   None.
     * Returns:
     *   void: Completion of local UI shutdown scheduling.
     */
    closeReviewUi() {
      reviewUi?.close();
      for (const control of controls.values()) control.close();
      controls.clear();
    },
  };
}
