// -*- coding: utf-8 -*-
/**
 * application.ts
 * Production runtime assembly
 * =====================
 * Assemble shared policy, artifacts, diagnostics, and explicitly available adapters.
 */
import path from 'node:path';

import { ArtifactStore } from '@abr/artifacts';
import {
  EngineRegistry,
  PolicyEngine,
  Runtime,
  applicationDataDirectory,
  createLogger,
} from '@abr/core';
import type { RuntimeConfig, RuntimeLogger } from '@abr/core';
import { CompatibleEngine } from '@abr/playwright-worker';

export interface Application {
  runtime: Runtime;
  policy: PolicyEngine;
  artifacts: ArtifactStore;
  logger: RuntimeLogger;
  dataDirectory: string;
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
      putScreenshot(sessionId, bytes) {
        return artifacts.putPng(sessionId, bytes);
      },
    }),
  );
  const runtime = new Runtime(registry, policy, {
    maxSessions: config.runtime.maxSessions,
    actionTimeoutMs: config.runtime.actionTimeoutMs,
    /**
     * Record safe operation metadata in diagnostics and session history.
     * Args:
     *   event (AuditEvent): Bounded runtime operation metadata.
     * Returns:
     *   void: Completion of diagnostic recording.
     */
    audit(event) {
      logger.info(event);
      artifacts.record(event);
    },
  });
  return { runtime, policy, artifacts, logger, dataDirectory };
}
