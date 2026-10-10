// -*- coding: utf-8 -*-
/**
 * config.ts
 * Runtime configuration parsing
 * =====================
 * Validate trusted local configuration and resolve registered application paths.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { BrowserError } from '@abr/contracts';
import { parse } from 'yaml';
import * as z from 'zod/v4';

// Configuration objects have closed fields and enforce GUI execution invariants.
export const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runtime: z.strictObject({
    defaultEngine: z.enum(['compatible', 'gui', 'native']),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    artifactRetentionDays: z.number().int().min(0).max(365),
    maxSessions: z.number().int().min(1).max(32),
    actionTimeoutMs: z.number().int().min(1).max(120000).default(10000),
  }),
  mcp: z.strictObject({ transport: z.literal('stdio') }),
  browser: z.strictObject({
    binary: z.enum(['bundled-chromium', 'installed-chrome', 'custom-chromium']),
    headless: z.boolean(),
    profileRoot: z.string().min(1),
    executablePath: z.string().optional(),
  }),
  gui: z.strictObject({
    requireForeground: z.literal(true),
    desktopInputConcurrency: z.literal(1),
    allowScriptFallback: z.literal(false),
    agentExecutable: z.string().optional(),
  }),
  policy: z.strictObject({
    allowedOrigins: z.array(z.string()),
    deniedOrigins: z.array(z.string()),
    requireHumanApproval: z.array(z.enum(['file-upload', 'payment', 'send-message', 'delete'])),
    allowedUploadRoots: z.array(z.string()),
    sensitiveTargetPatterns: z.array(z.string()).default([]),
  }),
  privacy: z.strictObject({
    sensitivePatterns: z.array(z.string().min(1).max(256)).max(64).default([]),
    redactSensitiveText: z.literal(true),
    persistScreenshots: z.boolean(),
    logUrlQuery: z.literal(false),
  }),
  native: z.strictObject({ enabled: z.boolean(), bridgePath: z.string().optional() }),
});
export type RuntimeConfig = z.infer<typeof configurationSchema>;

/**
 * Construct the local runtime's conservative initial configuration.
 * Args:
 *   None.
 * Returns:
 *   RuntimeConfig: Validated defaults with isolated profiles and explicit policies.
 */
export function defaultConfiguration(): RuntimeConfig {
  return configurationSchema.parse({
    schemaVersion: 1,
    runtime: {
      defaultEngine: 'compatible',
      logLevel: 'info',
      artifactRetentionDays: 7,
      maxSessions: 4,
    },
    mcp: { transport: 'stdio' },
    browser: {
      binary: 'bundled-chromium',
      headless: false,
      profileRoot: '${ABR_DATA_DIR}/profiles',
    },
    gui: { requireForeground: true, desktopInputConcurrency: 1, allowScriptFallback: false },
    policy: {
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      deniedOrigins: [],
      requireHumanApproval: ['file-upload', 'payment', 'send-message', 'delete'],
      allowedUploadRoots: ['${ABR_DATA_DIR}/uploads'],
    },
    privacy: { redactSensitiveText: true, persistScreenshots: false, logUrlQuery: false },
    native: { enabled: false },
  });
}

/**
 * Resolve the current user's application data directory.
 * Args:
 *   None.
 * Returns:
 *   string: Platform-appropriate ABR data root.
 */
export function applicationDataDirectory(): string {
  // Honor an explicitly configured application root without shell expansion.
  if (process.env.ABR_DATA_DIR) return path.resolve(process.env.ABR_DATA_DIR);
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ABR');
  if (process.platform === 'darwin')
    return path.join(homedir(), 'Library', 'Application Support', 'ABR');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'abr');
}

/**
 * Expand registered application variables in a trusted local path.
 * Args:
 *   value (string): Configured path containing registered placeholders.
 *   dataDirectory (string): Current application data root.
 * Returns:
 *   string: Absolute platform-native path.
 */
export function expandPath(value: string, dataDirectory: string): string {
  const expanded = value.replaceAll('${ABR_DATA_DIR}', dataDirectory);
  // Reject unknown variable names instead of invoking shell substitution.
  if (expanded.includes('${'))
    throw new BrowserError('INVALID_ARGUMENT', 'Unknown configuration path variable.');
  return path.resolve(expanded);
}

/**
 * Read and validate local runtime configuration.
 * Args:
 *   filename (string): Configuration file selected by the local user.
 * Returns:
 *   Promise<RuntimeConfig>: Validated configuration with required defaults.
 */
export async function readConfiguration(filename: string): Promise<RuntimeConfig> {
  // Parse YAML as data and reject duplicate keys and expansion aliases.
  try {
    const content = await readFile(filename, 'utf8');
    return configurationSchema.parse(parse(content, { uniqueKeys: true, maxAliasCount: 0 }));
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', 'Runtime configuration is invalid or unavailable.');
  }
}
