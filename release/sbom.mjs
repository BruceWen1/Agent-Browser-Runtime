// -*- coding: utf-8 -*-
/**
 * sbom.mjs
 * Locked software inventory
 * =====================
 * Derive distributed npm and all-target Rust component metadata from actual packages and locks.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ReleaseError, command, fileSha256, rustCommand } from './common.mjs';

/**
 * Encode a package URL with its registry namespace and exact version.
 * Args:
 *   ecosystem (string): npm, cargo, or generic package ecosystem.
 *   name (string): Actual component name.
 *   version (string): Exact component version.
 * Returns:
 *   string: Stable package URL.
 */
function purl(ecosystem, name, version) {
  return `pkg:${ecosystem}/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`;
}

/**
 * Read the actual production dependency manifests in a deployed Node graph.
 * Args:
 *   directory (string): Deployed node_modules directory.
 *   output (Map): Deduplicated component map.
 * Returns:
 *   Promise<Map>: Exact installed package manifests with license metadata.
 */
async function installedPackages(directory, output = new Map()) {
  // Scoped registry namespaces contain packages rather than runtime dependency roots.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await installedPackages(folder, output);
      continue;
    }
    const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
    output.set(`${manifest.name}@${manifest.version}`, manifest);
    const children = await readdir(folder);
    if (children.includes('node_modules'))
      await installedPackages(path.join(folder, 'node_modules'), output);
  }
  return output;
}

/**
 * Parse checksum fields from the committed Cargo lock format.
 * Args:
 *   text (string): Actual Cargo.lock text.
 * Returns:
 *   Map: Exact crate-version to checksum mapping.
 */
function cargoChecksums(text) {
  const output = new Map();
  // Cargo lock package blocks contain scalar identity and registry integrity fields.
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    const checksum = /^checksum = "([a-f0-9]{64})"$/m.exec(block)?.[1];
    if (name && version && checksum) output.set(`${name}@${version}`, checksum);
  }
  return output;
}

/**
 * Create CycloneDX metadata and notices from the actual deployment and source locks.
 * Args:
 *   workspace (string): Repository containing committed locks.
 *   deployed (string): Production deployment root.
 *   metadata (object): Actual runtime, browser, and release source metadata.
 * Returns:
 *   Promise<object>: SBOM, third-party notice, and lock hashes.
 */
export async function createSbom(workspace, deployed, metadata) {
  const { parseAllDocuments } = createRequire(
    path.join(workspace, 'packages', 'cli', 'package.json'),
  )('yaml');
  const lockfile = path.join(workspace, 'pnpm-lock.yaml');
  const cargoLockfile = path.join(workspace, 'Cargo.lock');
  const lockText = await readFile(lockfile, 'utf8');
  const documents = parseAllDocuments(lockText, { uniqueKeys: true, maxAliasCount: 0 });
  if (documents.some((document) => document.errors.length))
    throw new ReleaseError('LOCK_INVALID', 'Committed pnpm lock is invalid.');
  const packages = Object.assign(
    {},
    ...documents.map((document) => document.toJSON()?.packages ?? {}),
  );
  const installed = await installedPackages(path.join(deployed, 'node_modules'));
  const cargo = JSON.parse(
    await command(rustCommand('cargo'), ['metadata', '--locked', '--format-version', '1'], {
      cwd: workspace,
      label: 'release-cargo-metadata',
      timeoutMs: 120000,
    }),
  );
  const cargoHashes = cargoChecksums(await readFile(cargoLockfile, 'utf8'));
  const components = [];
  const notices = [];
  // Runtime npm entries describe only packages actually included in the archive graph.
  for (const item of [...installed.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = purl('npm', item.name, item.version);
    const license = typeof item.license === 'string' ? item.license : item.license?.type;
    const integrity = packages[`${item.name}@${item.version}`]?.resolution?.integrity;
    const hashes = [];
    if (typeof integrity === 'string' && integrity.startsWith('sha512-'))
      hashes.push({
        alg: 'SHA-512',
        content: Buffer.from(integrity.slice(7), 'base64').toString('hex'),
      });
    components.push({
      type: item.name.startsWith('@abr/') ? 'application' : 'library',
      name: item.name,
      version: item.version,
      'bom-ref': id,
      purl: id,
      scope: 'required',
      ...(license ? { licenses: [{ license: { name: license } }] } : {}),
      ...(hashes.length ? { hashes } : {}),
      properties: [{ name: 'abr:inventoryScope', value: 'distributed-production-node-graph' }],
    });
    notices.push(
      `${item.name}@${item.version}: ${license ?? 'license declaration unavailable'}; distributed package license files retain their original text.`,
    );
  }
  // Cargo metadata defaults to all targets; platform-specific source dependencies remain explicitly optional.
  for (const item of cargo.packages.sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )) {
    const id = purl('cargo', item.name, item.version);
    const checksum = cargoHashes.get(`${item.name}@${item.version}`);
    components.push({
      type: item.name === 'abr-desktop-agent' ? 'application' : 'library',
      name: item.name,
      version: item.version,
      'bom-ref': id,
      purl: id,
      scope:
        item.name === 'abr-desktop-agent' && metadata.nativeAgentIncluded ? 'required' : 'optional',
      ...(item.license ? { licenses: [{ expression: item.license }] } : {}),
      ...(checksum ? { hashes: [{ alg: 'SHA-256', content: checksum }] } : {}),
      properties: [{ name: 'abr:inventoryScope', value: 'all-targets-committed-rust-source-lock' }],
    });
    notices.push(
      `${item.name}@${item.version}: ${item.license ?? 'license declaration unavailable'}; Rust source inventory includes target-conditional dependencies.`,
    );
  }
  components.push({
    type: 'application',
    name: 'Node.js',
    version: metadata.nodeVersion,
    'bom-ref': purl('generic', 'node', metadata.nodeVersion),
    hashes: [{ alg: 'SHA-256', content: metadata.nodeSha256 }],
  });
  if (metadata.browser)
    components.push({
      type: 'application',
      name: 'Chrome for Testing',
      version: metadata.browser.version,
      'bom-ref': purl('generic', 'chrome-for-testing', metadata.browser.version),
      properties: [{ name: 'abr:playwrightRevision', value: metadata.browser.revision }],
    });
  const pnpmSha256 = await fileSha256(lockfile);
  const cargoSha256 = await fileSha256(cargoLockfile);
  return {
    sbom: {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      metadata: {
        timestamp: metadata.createdAt,
        component: {
          type: 'application',
          name: 'Agent Browser Runtime',
          version: metadata.version,
          'bom-ref': purl('generic', 'agent-browser-runtime', metadata.version),
        },
        properties: [
          { name: 'abr:pnpmLockSha256', value: pnpmSha256 },
          { name: 'abr:cargoLockSha256', value: cargoSha256 },
          {
            name: 'abr:rustInventoryScope',
            value:
              'all-targets-source-lock; native linkage and platform testing reported separately',
          },
        ],
      },
      components,
    },
    notice: `Agent Browser Runtime third-party inventory\n\nNode.js ${metadata.nodeVersion}: complete license text is distributed in licenses/node-LICENSE.\n${metadata.browser ? `Chrome for Testing ${metadata.browser.version}: browser license resources remain in the bundled browser tree.\n` : ''}\n${notices.join('\n')}\n`,
    pnpmSha256,
    cargoSha256,
    counts: { npm: installed.size, cargo: cargo.packages.length },
  };
}
