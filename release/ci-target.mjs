// -*- coding: utf-8 -*-
/**
 * ci-target.mjs
 * Native release target verification
 * =====================
 * Verify actual runner architecture before using a target label on packaged artifacts.
 */
import { ReleaseError, fail, isMain, report } from './common.mjs';

/**
 * Validate the actual operating system and architecture against the requested target.
 * Args:
 *   argv (string[]): Explicit expected target identifier.
 * Returns:
 *   void: Completion of native runner identity verification.
 */
export function main(argv = process.argv.slice(2)) {
  const started = performance.now();
  const actual = `${process.platform}-${process.arch}`;
  // Target labels describe measured native execution rather than cross-platform assumptions.
  if (argv.length !== 1 || argv[0] !== actual)
    throw new ReleaseError(
      'PLATFORM_MISMATCH',
      'Native runner architecture differs from its release target.',
    );
  report('release-runner-verified', {
    target: actual,
    durationMs: Math.round(performance.now() - started),
  });
}

// Direct invocation validates metadata before the release job proceeds.
if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error);
  }
}
