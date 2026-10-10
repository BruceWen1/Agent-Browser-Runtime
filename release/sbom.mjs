// -*- coding: utf-8 -*-
/**
 * sbom.mjs
 * Locked software inventory
 * =====================
 * Derive deployed package, source-lock, and browser auxiliary metadata with actual integrity evidence.
 */
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseError,
  command,
  fileSha256,
  inside,
  regularFiles,
  rustCommand,
  sha256,
} from './common.mjs';

const LICENSE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'licenses');

/**
 * Inspect the packaged ffmpeg executable's own license declaration without processing media.
 * Args:
 *   executable (string): Actual bundled ffmpeg executable.
 * Returns:
 *   Promise<string>: Bounded license report from the packaged binary.
 */
async function readFfmpegLicense(executable) {
  return command(executable, ['-L'], {
    captureStderr: true,
    label: 'release-ffmpeg-license',
    timeoutMs: 10000,
    maxBytes: 128 * 1024,
  });
}

/**
 * Inventory the actual distributed ffmpeg and Windows dependency-verifier assets.
 * Args:
 *   payload (string): Owned release staging root.
 *   browser (object): Actual Playwright browser metadata and present auxiliary directories.
 *   inspectLicense (Function): Native license inspector or explicit isolated fixture source.
 * Returns:
 *   Promise<object>: Auxiliary CycloneDX components and complete license notice entries.
 */
export async function browserAuxiliarySbom(payload, browser, inspectLicense = readFfmpegLicense) {
  const components = [];
  const notices = [];
  // Include only present auxiliary assets with complete revision-bound directories.
  for (const asset of browser?.auxiliary ?? []) {
    // Select auxiliary component types with explicit license verification paths.
    if (!['ffmpeg', 'winldd'].includes(asset.name)) continue;
    // Require an exact numeric revision and its corresponding cache directory.
    if (
      typeof asset.revision !== 'string' ||
      !/^\d+$/.test(asset.revision) ||
      asset.directory !== `${asset.name}-${asset.revision}`
    )
      throw new ReleaseError('AUXILIARY_ASSET_INVALID', 'Auxiliary asset identity is invalid.');
    const directory = `browsers/${asset.directory}`;
    const files = await regularFiles(payload, directory);
    const binaryNames =
      asset.name === 'ffmpeg'
        ? ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']
        : ['PrintDeps.exe'];
    const binaries = files.filter((file) => binaryNames.includes(path.posix.basename(file.path)));
    // Each component binds to one concrete executable from the deployed inventory.
    if (binaries.length !== 1)
      throw new ReleaseError(
        'AUXILIARY_ASSET_INVALID',
        'Auxiliary executable is absent or ambiguous.',
      );
    const binary = binaries[0].path;
    const binarySha256 = await fileSha256(inside(payload, binary));
    let version;
    let licenses;
    const properties = [
      { name: 'abr:playwrightRevision', value: asset.revision },
      { name: 'abr:inventoryScope', value: 'distributed-browser-auxiliary-assets' },
      { name: 'abr:inventoryDirectory', value: directory },
      { name: 'abr:inventoryPath', value: binary },
    ];
    // Inspect ffmpeg's binary declaration and use pinned source evidence for Winldd.
    if (asset.name === 'ffmpeg') {
      const report = await inspectLicense(inside(payload, binary));
      version = /^ffmpeg version ([^\s]+) /m.exec(report)?.[1];
      // Admit the actual LGPL declaration and its distributed full-text license resource.
      if (
        !version ||
        report.includes('--enable-gpl') ||
        !/GNU Lesser General Public\s+License/.test(report) ||
        !/version 2\.1 of the License[\s\S]*any later version/.test(report)
      )
        throw new ReleaseError(
          'AUXILIARY_LICENSE_UNAVAILABLE',
          'Bundled ffmpeg license declaration requires explicit verification.',
        );
      const licensePath = `${directory}/COPYING.LGPLv2.1`;
      const text = await readFile(inside(payload, licensePath), 'utf8');
      // Require the LGPL resource matching the executable's declared license version.
      if (!text.includes('GNU LESSER GENERAL PUBLIC LICENSE') || !text.includes('Version 2.1'))
        throw new ReleaseError(
          'AUXILIARY_LICENSE_UNAVAILABLE',
          'Bundled ffmpeg license text is incomplete.',
        );
      licenses = [{ license: { id: 'LGPL-2.1-or-later' } }];
      properties.push(
        { name: 'abr:licenseEvidence', value: 'packaged-executable-license-report' },
        { name: 'abr:licenseReportSha256', value: sha256(report) },
        { name: 'abr:licenseInventoryPath', value: licensePath },
        { name: 'abr:licenseSha256', value: await fileSha256(inside(payload, licensePath)) },
      );
      notices.push(
        `ffmpeg ${version}, Playwright revision ${asset.revision}: LGPL-2.1-or-later; complete license text is distributed at ${licensePath}.`,
      );
    } else {
      const provenance = JSON.parse(
        await readFile(path.join(LICENSE_ROOT, 'winldd-1007-provenance.json'), 'utf8'),
      );
      const sourceCode = provenance.sources?.find(
        (source) => source.path === 'browser_patches/winldd/PrintDeps.cpp',
      );
      const buildNumber = provenance.sources?.find(
        (source) => source.path === 'browser_patches/winldd/BUILD_NUMBER',
      );
      // The pinned source evidence applies to its exact official auxiliary build number.
      if (
        provenance.schemaVersion !== 1 ||
        provenance.component !== 'winldd' ||
        asset.revision !== String(provenance.buildNumber) ||
        provenance.licenseExpression !== 'MIT AND Apache-2.0' ||
        !/^[a-f0-9]{40}$/.test(provenance.sourceCommit) ||
        !/^[a-f0-9]{64}$/.test(sourceCode?.sha256) ||
        !/^[a-f0-9]{64}$/.test(buildNumber?.sha256)
      )
        throw new ReleaseError(
          'AUXILIARY_LICENSE_UNAVAILABLE',
          'Winldd revision lacks pinned license evidence.',
        );
      const licensePath = 'licenses/winldd-1007-LICENSE.txt';
      const provenancePath = 'licenses/winldd-1007-provenance.json';
      await mkdir(inside(payload, 'licenses'), { recursive: true });
      await copyFile(
        path.join(LICENSE_ROOT, 'winldd-1007-LICENSE.txt'),
        inside(payload, licensePath),
      );
      await copyFile(
        path.join(LICENSE_ROOT, 'winldd-1007-provenance.json'),
        inside(payload, provenancePath),
      );
      const licenseSha256 = await fileSha256(inside(payload, licensePath));
      // Bind the distributed copyright and license text to its pinned source receipt.
      if (licenseSha256 !== provenance.licenseFile?.sha256)
        throw new ReleaseError(
          'AUXILIARY_LICENSE_UNAVAILABLE',
          'Winldd license evidence checksum differs.',
        );
      licenses = [{ expression: provenance.licenseExpression }];
      properties.push(
        { name: 'abr:licenseEvidence', value: 'pinned-official-build-source' },
        { name: 'abr:licenseSourceCommit', value: provenance.sourceCommit },
        { name: 'abr:licenseSourceSha256', value: sourceCode.sha256 },
        { name: 'abr:licenseBuildNumberSha256', value: buildNumber.sha256 },
        { name: 'abr:licenseInventoryPath', value: licensePath },
        { name: 'abr:licenseSha256', value: licenseSha256 },
        { name: 'abr:licenseProvenanceInventoryPath', value: provenancePath },
        {
          name: 'abr:licenseProvenanceSha256',
          value: await fileSha256(inside(payload, provenancePath)),
        },
      );
      notices.push(
        `Winldd, Playwright revision ${asset.revision}: MIT AND Apache-2.0; complete copyright and license texts are distributed at ${licensePath}.`,
      );
    }
    components.push({
      type: 'application',
      name: asset.name === 'ffmpeg' ? 'FFmpeg' : 'Winldd',
      ...(version ? { version } : {}),
      'bom-ref': `abr:playwright-auxiliary:${asset.name}:${asset.revision}`,
      scope: 'required',
      licenses,
      hashes: [{ alg: 'SHA-256', content: binarySha256 }],
      properties,
    });
  }
  return { components, notices };
}

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
  // Auxiliary entries use the deployed executable bytes and separately verified license evidence.
  const auxiliary = await browserAuxiliarySbom(metadata.payloadRoot, metadata.browser);
  components.push(...auxiliary.components);
  notices.push(...auxiliary.notices);
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
