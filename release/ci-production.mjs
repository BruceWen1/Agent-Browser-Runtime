// -*- coding: utf-8 -*-
/**
 * ci-production.mjs
 * Protected production runner entry point
 * =====================
 * Require approved evidence and protected signing material before production packaging.
 */
import { ReleaseError, fail, isMain } from './common.mjs';
import { readJson } from './manifest.mjs';
import { signRelease } from './sign.mjs';

/**
 * Run production signing from explicit protected-runner input files.
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Completion after all evidence and operating-system signing gates.
 */
export async function main() {
  // Runners without independent approved inputs retain a closed production gate.
  if (!process.env.ABR_PRODUCTION_INPUTS || !process.env.ABR_RELEASE_SIGNING_KEY_FILE)
    throw new ReleaseError(
      'RELEASE_GATES_REQUIRED',
      'Production requires protected signing inputs, exact-source P0 evidence, and three-platform approved manual baselines.',
    );
  const inputs = await readJson(process.env.ABR_PRODUCTION_INPUTS, 65536);
  console.log(
    JSON.stringify(
      await signRelease({ ...inputs, privateKey: process.env.ABR_RELEASE_SIGNING_KEY_FILE }),
    ),
  );
}

// Direct invocation separates production verification from development packaging.
if (isMain(import.meta.url)) void main().catch(fail);
