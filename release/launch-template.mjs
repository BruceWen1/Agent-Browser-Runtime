// -*- coding: utf-8 -*-
/**
 * launch-template.mjs
 * Portable runtime launcher
 * =====================
 * Verify packaged contents and launch the CLI with an archive-local browser cache.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, report } from './maintenance/common.mjs';
import { validateManifest, verifyDirectory, verifyPublisher } from './maintenance/manifest.mjs';

/**
 * Verify a portable bundle and supervise its local CLI process.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion of CLI lifetime supervision.
 */
async function main() {
  const started = performance.now();
  const root = path.dirname(fileURLToPath(import.meta.url));
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(root, 'version-manifest.json'), 'utf8')),
  );
  // Run only the matching archive platform and pinned Node runtime.
  if (
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch ||
    process.versions.node !== manifest.components.node.version
  )
    throw new Error('Runtime platform or version differs from the bundle.');
  let envelope;
  let trustedKeys;
  if (manifest.channel === 'signed') {
    envelope = JSON.parse(await readFile(path.join(root, 'release-signature.json'), 'utf8'));
    if (process.env.ABR_RELEASE_TRUSTED_KEYS)
      trustedKeys = JSON.parse(await readFile(process.env.ABR_RELEASE_TRUSTED_KEYS, 'utf8'));
  }
  verifyPublisher(manifest, envelope, {
    allowUnsignedDevelopment: manifest.channel === 'development',
    trustedKeys,
  });
  await verifyDirectory(root, manifest);
  report('packaged-runtime-verified', {
    channel: manifest.channel,
    durationMs: Math.round(performance.now() - started),
  });
  const child = spawn(
    process.execPath,
    [path.join(root, 'app', 'packages', 'cli', 'dist', 'main.js'), ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        ...(manifest.features.compatible.browserBundled
          ? { PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers') }
          : {}),
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  child.once('error', () => {
    process.exitCode = 1;
  });
  // Forward shutdown signals so the CLI releases owned browsers and desktop agents.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  await new Promise((resolve) =>
    child.once('close', (code) => {
      process.exitCode = code ?? 1;
      resolve();
    }),
  );
}

// This template becomes the package's explicit runtime entry point.
void main().catch(fail);
