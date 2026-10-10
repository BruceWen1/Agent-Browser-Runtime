// -*- coding: utf-8 -*-
/**
 * profile-preferences.ts
 * Owned GUI profile observation settings
 * =====================
 * Preserve profile settings while enabling full browser address display for origin verification.
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserError } from '@abr/contracts';

/**
 * Enable the ordinary browser full-address display preference before owned startup.
 * Args:
 *   directory (string): Policy-allocated and exclusively claimed profile directory.
 * Returns:
 *   Promise<void>: Completion of profile display configuration.
 */
export async function prepareGuiPreferences(directory: string): Promise<void> {
  const profile = path.join(directory, 'Default');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  if ((await lstat(profile)).isSymbolicLink())
    throw new BrowserError('POLICY_DENIED', 'GUI profile preferences are redirected.');
  const filename = path.join(profile, 'Preferences');
  let preferences: Record<string, unknown> = {};
  // Inspect existing settings as bounded data while preserving unrelated preferences.
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 5 * 1024 * 1024)
      throw new BrowserError('POLICY_DENIED', 'GUI profile preferences are invalid.');
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new BrowserError('POLICY_DENIED', 'GUI profile preference format is invalid.');
    preferences = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const omnibox = preferences.omnibox;
  if (omnibox !== undefined && (!omnibox || typeof omnibox !== 'object' || Array.isArray(omnibox)))
    throw new BrowserError('POLICY_DENIED', 'GUI omnibox preference format is invalid.');
  preferences.omnibox = {
    ...(omnibox as Record<string, unknown> | undefined),
    prevent_url_elisions: true,
  };
  await writeFile(filename, JSON.stringify(preferences), { mode: 0o600 });
}
