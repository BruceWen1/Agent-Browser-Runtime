// -*- coding: utf-8 -*-
/**
 * browser.test.ts
 * Official Compatible event recorder verification
 * =====================
 * Verify native page event collection and privacy inside an actual headed official browser.
 */
import { parseEventTrace, startEventFixture } from '@abr/test-fixtures';
import type { FixtureControl } from '@abr/test-fixtures';
import { launchFixtureBrowser } from '@abr/test-fixtures/testing';
import { expect, test } from 'vitest';

/**
 * Verify owned DOM event and privacy sampling through unchanged official Playwright.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Actual headed Compatible recorder verification.
 */
async function verifyNativeEvents(): Promise<void> {
  const fixture = await startEventFixture({ engine: 'compatible' });
  const browser = await launchFixtureBrowser();
  // Close the owned browser and loopback fixture on every test outcome.
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(fixture.url('click-button'));
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    const clicked = parseEventTrace(
      await page.evaluate(() =>
        (window as unknown as { abrFixture: FixtureControl }).abrFixture.exportTrace(),
      ),
    );
    expect(clicked.environment.engine).toBe('compatible');
    expect(clicked.outcome.counter).toBe(1);
    const nativeClick = clicked.samples.find(
      (sample) => sample.type === 'click' && sample.phase === 'capture',
    );
    expect(nativeClick?.trusted).toBe(true);
    expect(nativeClick?.activation).toBe(true);
    expect(clicked.samples.some((sample) => sample.type === 'pointerdown')).toBe(true);
    expect(
      clicked.samples.some((sample) => sample.type === 'click' && sample.phase === 'bubble'),
    ).toBe(true);
    await page.goto(fixture.url('privacy-sensitive'));
    await page.locator('#password').click();
    await page.keyboard.type('private-fixture-secret');
    await page.locator('#query').click();
    await page.keyboard.type('controlled-public-text');
    const privateTrace = parseEventTrace(
      await page.evaluate(() =>
        (window as unknown as { abrFixture: FixtureControl }).abrFixture.exportTrace(),
      ),
    );
    const artifact = JSON.stringify(privateTrace);
    expect(artifact).not.toContain('private-fixture-secret');
    expect(artifact).not.toContain('controlled-public-text');
    expect(artifact).not.toContain('4111111111111111');
    expect(privateTrace.outcome.controls.password).toBeUndefined();
    expect(privateTrace.outcome.controls.card).toBeUndefined();
    expect(privateTrace.outcome.controls.query?.valueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      privateTrace.samples.some(
        (sample) =>
          sample.type === 'keydown' &&
          sample.target === 'password' &&
          sample.key === '<redacted>' &&
          sample.code === '<redacted>',
      ),
    ).toBe(true);
    expect(
      privateTrace.samples.some(
        (sample) => sample.type === 'beforeinput' && sample.target === 'query',
      ),
    ).toBe(true);
    await page.goto(fixture.url('shadow-dom'));
    await page.getByRole('button', { name: 'Shadow activate' }).click();
    await page.getByRole('textbox', { name: 'Shadow query' }).click();
    await page.keyboard.type('shadow public fixture');
    const shadow = parseEventTrace(
      await page.evaluate(() =>
        (window as unknown as { abrFixture: FixtureControl }).abrFixture.exportTrace(),
      ),
    );
    expect(
      shadow.samples.some(
        (sample) => sample.type === 'click' && sample.target === 'shadow-activate',
      ),
    ).toBe(true);
    expect(shadow.outcome.controls['shadow-query']?.valueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(shadow.outcome.focus).toBe('shadow-query');
    await page.goto(fixture.url('iframe'));
    await page.frameLocator('#frame').getByRole('button', { name: 'Frame activate' }).click();
    await page.frameLocator('#frame').getByRole('textbox', { name: 'Frame query' }).click();
    await page.keyboard.type('frame public fixture');
    const framed = parseEventTrace(
      await page.evaluate(() =>
        (window as unknown as { abrFixture: FixtureControl }).abrFixture.exportTrace(),
      ),
    );
    expect(
      framed.samples.some(
        (sample) => sample.type === 'click' && sample.target === 'frame-activate',
      ),
    ).toBe(true);
    expect(framed.outcome.counter).toBe(1);
    expect(framed.outcome.controls['frame-query']?.valueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(framed.outcome.focus).toBe('frame-query');
    expect(framed.outcome.selection?.anchor).toBe('frame-query');
    expect(
      framed.samples.some(
        (sample) =>
          sample.type === 'keydown' &&
          sample.target === 'frame-query' &&
          sample.code?.startsWith('Key'),
      ),
    ).toBe(true);
  } finally {
    await browser.close();
    await fixture.close();
  }
}

test(
  'official headed browser records native fixture events without private text',
  verifyNativeEvents,
  60000,
);
