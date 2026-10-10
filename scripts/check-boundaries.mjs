// -*- coding: utf-8 -*-
/**
 * check-boundaries.mjs
 * Workspace dependency boundary validation
 * =====================
 * Reject browser and platform dependencies in the shared application core.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Inspect source imports in one package.
 *
 * Args:
 *   directory (string): Directory containing package source files.
 *   forbidden (RegExp): Pattern identifying prohibited imports.
 * Returns:
 *   Promise<void>: Completion of recursive validation.
 */
async function inspect(directory, forbidden) {
  // Inspect every source file and recurse through source subdirectories.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    // Apply the same import policy throughout the package source tree.
    if (entry.isDirectory()) await inspect(filename, forbidden);
    // Check TypeScript import declarations against the package boundary.
    else if (entry.name.endsWith('.ts')) {
      const source = await readFile(filename, 'utf8');
      // Reject an import that crosses the application or platform boundary.
      if (forbidden.test(source)) throw new Error(`Dependency boundary violation: ${filename}`);
    }
  }
}

/**
 * Validate the shared package dependency boundaries.
 *
 * Args:
 *   None.
 * Returns:
 *   Promise<void>: Successful completion of source inspection.
 */
async function main() {
  const started = performance.now();
  // Keep the application core independent of browser and OS implementations.
  await inspect('packages/core/src', /from\s+['"](?:playwright|@abr\/playwright-worker|@oai\/sky)/);
  // Keep the MCP adapter independent of direct operating system bindings.
  await inspect('packages/mcp-server/src', /from\s+['"](?:koffi|ffi-napi|@oai\/sky)/);
  console.error(`Dependency boundaries verified in ${(performance.now() - started).toFixed(1)} ms`);
}

// Execute validation when this script is invoked as an entry point.
await main();
