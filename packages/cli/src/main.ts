// -*- coding: utf-8 -*-
/**
 * main.ts
 * Browser runtime command entry point
 * =====================
 * Initialize configuration, diagnose local capabilities, and serve browser tools.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { BrowserError, MCP_TOOLS, normalizeError, toolInputSchema } from '@abr/contracts';
import { defaultConfiguration, readConfiguration } from '@abr/core';
import { serveRuntime } from '@abr/mcp-server';
import { stringify } from 'yaml';

import { createApplication } from './application.js';

/**
 * Report installed browser candidates using metadata-only path checks.
 * Args:
 *   None.
 * Returns:
 *   object[]: Availability records with private directory components omitted.
 */
function browserCandidates() {
  const paths =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.ProgramFiles ?? '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
          path.join(
            process.env['ProgramFiles(x86)'] ?? '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
          path.join(
            process.env.LOCALAPPDATA ?? '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return paths.map((filename) => ({
    binary: path.basename(filename),
    available: existsSync(filename),
  }));
}

/**
 * Dispatch a local runtime command and record key step duration.
 * Args:
 *   argv (string[]): Command arguments supplied by the local user.
 * Returns:
 *   Promise<void>: Completion of command dispatch or stdio server startup.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const started = performance.now();
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean' },
      stdio: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = parsed.positionals.join(' ');
  const configFile = path.resolve(parsed.values.config ?? path.join('.abr', 'config.yaml'));
  // Display concise command documentation when no command is requested.
  if (parsed.values.help || !command) {
    console.log(
      'ABR: init [--config path], doctor [--json], version, mcp serve --stdio, test contract',
    );
    return;
  }
  // Initialize configuration using exclusive creation to preserve existing settings.
  if (command === 'init') {
    if (existsSync(configFile))
      throw new BrowserError('INVALID_ARGUMENT', 'Configuration already exists.');
    await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await writeFile(configFile, stringify(defaultConfiguration()), { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({ status: 'initialized', config: path.relative(process.cwd(), configFile) }),
    );
    console.error(
      JSON.stringify({ event: 'init-finished', durationMs: performance.now() - started }),
    );
    return;
  }
  const configStarted = performance.now();
  const config = existsSync(configFile)
    ? await readConfiguration(configFile)
    : defaultConfiguration();
  const application = createApplication(config);
  const { runtime, artifacts, policy, logger } = application;
  logger.info({ event: 'configuration-ready', durationMs: performance.now() - configStarted });
  // Each non-server command releases its owned runtime and artifact resources.
  try {
    if (command === 'version') {
      console.log(
        JSON.stringify({ abr: '0.1.0', node: process.version, mcpSdk: '2.3.1', schemaVersion: 1 }),
      );
    } else if (command === 'doctor') {
      const engines = Object.fromEntries(
        ['compatible', 'gui', 'native'].map((kind) => [
          kind,
          {
            status: runtime.registry.kinds().includes(kind as 'compatible' | 'gui' | 'native')
              ? 'available'
              : 'unavailable',
            reason: 'ADAPTER_NOT_REGISTERED',
          },
        ]),
      );
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            platform: process.platform,
            architecture: process.arch,
            osVersion: release(),
            node: process.version,
            mcpSdk: '2.3.1',
            browsers: browserCandidates(),
            engines,
            profileRoot: 'configured-user-data-root',
            stdout: 'protocol-only-in-mcp-mode',
          },
          null,
          parsed.values.json ? undefined : 2,
        ),
      );
    } else if (command === 'test contract') {
      for (const tool of MCP_TOOLS) toolInputSchema(tool);
      console.log(
        JSON.stringify({ status: 'succeeded', toolCount: MCP_TOOLS.length, schemaVersion: 1 }),
      );
    } else if (command === 'mcp serve' && parsed.values.stdio) {
      const handle = serveRuntime(runtime, {
        policy,
        artifacts,
        audit(event) {
          logger.info(event);
        },
        async dispose() {
          await artifacts.close();
          logger.info({ event: 'mcp-stopped', durationMs: performance.now() - started });
        },
      });
      // Shutdown signals close the protocol and owned browser resources.
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void handle.close();
        });
      logger.info({ event: 'mcp-ready', durationMs: performance.now() - started });
      return;
    } else
      throw new BrowserError(
        'INVALID_ARGUMENT',
        'Command is unavailable or has invalid arguments.',
      );
  } finally {
    if (!(command === 'mcp serve' && parsed.values.stdio)) {
      await runtime.closeAll();
      await artifacts.close();
      logger.info({ event: 'command-finished', durationMs: performance.now() - started });
    }
  }
}

// Dispatch only when the compiled module is invoked as the command entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const failure = normalizeError(error);
    process.stderr.write(
      JSON.stringify({ event: 'command-failed', error: failure.toJSON() }) + '\n',
    );
    process.exitCode = 1;
  });
}
