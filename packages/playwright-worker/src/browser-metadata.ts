// -*- coding: utf-8 -*-
/**
 * browser-metadata.ts
 * Official browser binary metadata
 * =====================
 * Resolve installed binaries without starting browser automation sessions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { BrowserError } from '@abr/contracts';
import type { CreateSessionRequest } from '@abr/contracts';
import { chromium } from 'playwright';

/**
 * Resolve a selected browser and its available binary metadata.
 * Args:
 *   input (CreateSessionRequest): Browser selection.
 *   customPath (string | undefined): Trusted local executable configuration.
 * Returns:
 *   object: Verified existing executable and declared version metadata.
 */
export function resolveBrowserBinary(
  input: CreateSessionRequest,
  customPath?: string,
): { executable: string; version: string } {
  if (input.browser === 'bundled-chromium') {
    const executable = chromium.executablePath();
    if (!existsSync(executable))
      throw new BrowserError(
        'INPUT_BACKEND_UNAVAILABLE',
        'Official bundled browser is not installed.',
      );
    const require = createRequire(
      createRequire(import.meta.url).resolve('playwright/package.json'),
    );
    const manifest = JSON.parse(
      readFileSync(
        path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json'),
        'utf8',
      ),
    ) as { browsers: { name: string; browserVersion?: string }[] };
    return {
      executable,
      version:
        manifest.browsers.find((browser) => browser.name === 'chromium')?.browserVersion ??
        'unverified',
    };
  }
  if (input.browser === 'custom-chromium') {
    if (!customPath || !existsSync(customPath))
      throw new BrowserError(
        'INPUT_BACKEND_UNAVAILABLE',
        'Custom browser executable is unavailable.',
      );
    return { executable: path.resolve(customPath), version: 'unverified' };
  }
  const candidates =
    process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
          .filter((root): root is string => Boolean(root))
          .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? [
            path.join(
              path.parse(process.execPath).root,
              'Applications',
              'Google Chrome.app',
              'Contents',
              'MacOS',
              'Google Chrome',
            ),
          ]
        : (process.env.PATH ?? '')
            .split(path.delimiter)
            .flatMap((root) =>
              ['google-chrome', 'chromium', 'chromium-browser'].map((name) =>
                path.join(root, name),
              ),
            );
  const executable = candidates.find(existsSync);
  if (!executable)
    throw new BrowserError(
      'INPUT_BACKEND_UNAVAILABLE',
      'Installed browser executable is unavailable.',
    );
  return { executable, version: 'unverified' };
}
