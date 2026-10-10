// -*- coding: utf-8 -*-
/**
 * testing.ts
 * Explicit official browser fixture verification
 * =====================
 * Launch the unchanged official Playwright browser for Compatible recorder validation only.
 */
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

/**
 * Launch the official headed browser for owned Compatible fixture tests.
 * Args:
 *   None.
 * Returns:
 *   Promise<Browser>: Official browser requiring caller-controlled cleanup.
 */
export async function launchFixtureBrowser(): Promise<Browser> {
  return chromium.launch({ headless: false });
}
