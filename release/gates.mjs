// -*- coding: utf-8 -*-
/**
 * gates.mjs
 * Production release evidence gates
 * =====================
 * Require code-bound independent reviews, complete platform parity, and actual OS signatures.
 */
import { createPublicKey, verify } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  ReleaseError,
  archiveMembers,
  canonicalJson,
  command,
  fileSha256,
  inside,
  sha256,
  validateLinks,
} from './common.mjs';
import { readJson } from './manifest.mjs';

// Production targets require the complete GUI and Native physical-input parity matrix.
export const RELEASE_TARGETS = ['win32-x64', 'darwin-arm64', 'linux-x64'];
export const REQUIRED_FIXTURES = [
  'click-button',
  'double-click',
  'text-input-en',
  'scroll-nested',
  'drag-drop-html',
  'popup-user-activation',
  'focus-navigation',
  'privacy-sensitive',
  'file-dialog',
  'upload-confirm',
  'back-forward-bfcache',
];

/**
 * Hash a signed application tree while retaining sealed relative symbolic-link identities.
 * Args:
 *   directory (string): Selected signed application bundle.
 * Returns:
 *   Promise<string>: Deterministic application inventory SHA256.
 */
async function signedApplicationDigest(directory) {
  const members = await archiveMembers(directory);
  // Apply the same component-aware containment and metadata quotas to signed app identities.
  validateLinks(members);
  const files = [];
  // Hash regular bytes while retaining each sealed alias rather than reading through the alias.
  for (const member of members) {
    if (member.type === 'symlink')
      files.push({ path: member.path, type: 'symlink', target: member.symlinkTarget });
    else
      files.push({
        path: member.path,
        type: 'file',
        size: member.size,
        sha256: await fileSha256(inside(directory, member.path)),
      });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return sha256(canonicalJson(files));
}

/**
 * Verify an independent reviewer signature over the exact release evidence payload.
 * Args:
 *   evidence (object): Signed source-bound review evidence.
 *   trustedKeys (object[]): Explicitly trusted reviewer public keys.
 * Returns:
 *   object: Cryptographically verified review payload.
 */
function verifyReview(evidence, trustedKeys) {
  const envelope = evidence?.signature;
  const trusted = trustedKeys?.find((key) => key.keyId === envelope?.keyId);
  if (!evidence?.payload || !trusted || envelope.algorithm !== 'Ed25519')
    throw new ReleaseError('REVIEW_REQUIRED', 'Independent trusted review evidence is required.');
  let key;
  let bytes;
  try {
    key = createPublicKey(trusted.publicKey);
    bytes = Buffer.from(envelope.signature, 'base64');
  } catch {
    throw new ReleaseError('REVIEW_INVALID', 'Independent review signature key is invalid.');
  }
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    bytes.length !== 64 ||
    bytes.toString('base64') !== envelope.signature ||
    !verify(null, Buffer.from(canonicalJson(evidence.payload)), key, bytes)
  )
    throw new ReleaseError('REVIEW_INVALID', 'Independent review signature verification failed.');
  return evidence.payload;
}

/**
 * Require complete source-bound P0 and approved physical desktop evidence.
 * Args:
 *   manifest (object): Candidate release metadata.
 *   evidence (object): Signed independent review bundle.
 *   directory (string): Read-only evidence artifact root.
 *   trustedKeys (object[]): Explicit reviewer trust anchors.
 * Returns:
 *   Promise<object>: Verified gate coverage and reviewer identity.
 */
export async function verifyReleaseEvidence(manifest, evidence, directory, trustedKeys) {
  // Clean exact source and a compiled observer build precede all production approval checks.
  if (manifest.source.gitDirty || !/^[a-f0-9]{40}$/.test(manifest.source.gitCommit))
    throw new ReleaseError('SOURCE_NOT_RELEASED', 'Production requires clean committed source.');
  if (!manifest.components.nativeChromium.compiled || !manifest.features.native.available)
    throw new ReleaseError(
      'NATIVE_BUILD_REQUIRED',
      'Production requires the compiled and validated Native Chromium build.',
    );
  const payload = verifyReview(evidence, trustedKeys);
  if (
    payload.schemaVersion !== 1 ||
    payload.codeSha256 !== manifest.source.codeSha256 ||
    payload.gitCommit !== manifest.source.gitCommit ||
    !Array.isArray(payload.records)
  )
    throw new ReleaseError(
      'EVIDENCE_STALE',
      'Release review evidence differs from the exact source.',
    );
  const coverage = new Set();
  const installerBindings = new Map();
  const requiredChecks = new Set([
    'contracts',
    'unit',
    'mcp-integration',
    'compatible-e2e',
    'security',
    'license-review',
    'native-ordinary-regression',
  ]);
  // Every external artifact is bound by its own checksum and the reviewer's signature.
  for (const record of payload.records) {
    if (
      typeof record.artifact !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      (await fileSha256(inside(directory, record.artifact))) !== record.sha256
    )
      throw new ReleaseError('EVIDENCE_INTEGRITY', 'Release evidence artifact checksum failed.');
    const artifact = await readJson(inside(directory, record.artifact), 8 * 1024 * 1024);
    // Independent installer review binds OS signatures to the exact distributed payload inventory.
    if (record.kind === 'installer-binding') {
      if (
        !RELEASE_TARGETS.includes(record.target) ||
        artifact.schemaVersion !== 1 ||
        artifact.status !== 'approved' ||
        artifact.codeSha256 !== payload.codeSha256 ||
        artifact.gitCommit !== payload.gitCommit ||
        artifact.inventorySha256 !== sha256(canonicalJson(manifest.files)) ||
        !/^[a-f0-9]{64}$/.test(artifact.installerSha256)
      )
        throw new ReleaseError(
          'INSTALLER_BINDING_INVALID',
          'Reviewed installer differs from the exact payload inventory.',
        );
      installerBindings.set(record.target, artifact.installerSha256);
      continue;
    }
    if (record.kind === 'check') {
      if (
        artifact.status !== 'passed' ||
        artifact.codeSha256 !== payload.codeSha256 ||
        artifact.gitCommit !== payload.gitCommit
      )
        throw new ReleaseError('P0_FAILED', 'Required release check did not pass for this source.');
      requiredChecks.delete(record.check);
      continue;
    }
    if (
      record.kind !== 'manual-parity' ||
      !RELEASE_TARGETS.includes(record.target) ||
      !['gui', 'native'].includes(record.engine) ||
      !REQUIRED_FIXTURES.includes(record.fixture)
    )
      throw new ReleaseError('EVIDENCE_INVALID', 'Release parity identity is invalid.');
    const targetPlatform = record.target.split('-')[0];
    const acceptedPlatform = {
      win32: ['windows', 'win32'],
      darwin: ['macos', 'darwin'],
      linux: ['linux'],
    }[targetPlatform];
    if (
      artifact.schemaVersion !== 1 ||
      !['identical', 'accepted-diff'].includes(artifact.status) ||
      artifact.manualBaselineApproved !== true ||
      artifact.fixture !== record.fixture ||
      artifact.baselineEnvironment?.engine !== 'manual' ||
      artifact.actualEnvironment?.engine !== record.engine ||
      !acceptedPlatform.includes(artifact.actualEnvironment.os) ||
      artifact.actualEnvironment.arch !== record.target.split('-')[1] ||
      artifact.baselineEnvironment.browserCommit !== artifact.actualEnvironment.browserCommit ||
      artifact.actualEnvironment.abrVersion !== manifest.version ||
      artifact.normalization?.timestampToleranceMs > 250 ||
      artifact.normalization?.coordinateToleranceCssPx > 2 ||
      artifact.differences?.some((difference) => difference.severity === 'unexpected')
    )
      throw new ReleaseError(
        'PARITY_NOT_APPROVED',
        'Required physical parity artifact is unapproved or contains unexplained differences.',
      );
    coverage.add(`${record.target}:${record.engine}:${record.fixture}`);
  }
  if (requiredChecks.size)
    throw new ReleaseError(
      'P0_EVIDENCE_MISSING',
      'Required safety and regression evidence is incomplete.',
    );
  const currentTarget = `${manifest.platform}-${manifest.architecture}`;
  if (!installerBindings.has(currentTarget))
    throw new ReleaseError(
      'INSTALLER_BINDING_REQUIRED',
      'Independent review of this platform installer and payload binding is required.',
    );
  for (const target of RELEASE_TARGETS)
    for (const engine of ['gui', 'native'])
      for (const fixture of REQUIRED_FIXTURES)
        if (!coverage.has(`${target}:${engine}:${fixture}`))
          throw new ReleaseError(
            'PHYSICAL_BASELINE_MISSING',
            'Three-platform GUI and Native manual baseline coverage is incomplete.',
          );
  return {
    targets: RELEASE_TARGETS,
    parityRuns: coverage.size,
    reviewerKeyId: evidence.signature.keyId,
    installerSha256: installerBindings.get(currentTarget),
  };
}

/**
 * Verify real platform installer signatures through the operating-system verifier.
 * Args:
 *   artifact (string): Actual signed installer or application selected by the release owner.
 *   options (object): Expected certificate, team identity, or isolated GPG trust keyring.
 * Returns:
 *   Promise<object>: Verified platform signing evidence with artifact hash.
 */
export async function verifyPlatformSigning(artifact, options = {}) {
  if (!artifact)
    throw new ReleaseError('CODE_SIGNING_REQUIRED', 'A signed platform installer is required.');
  const metadata = await lstat(artifact);
  if (metadata.isSymbolicLink())
    throw new ReleaseError('CODE_SIGNING_REQUIRED', 'Signing artifact is redirected.');
  const filename = path.resolve(artifact);
  if (process.platform === 'win32') {
    if (
      !metadata.isFile() ||
      !/\.(msi|exe)$/i.test(filename) ||
      !/^[A-Fa-f0-9]{40}$/.test(options.certificateThumbprint ?? '')
    )
      throw new ReleaseError(
        'CODE_SIGNING_REQUIRED',
        'Windows requires a signed installer and configured certificate thumbprint.',
      );
    const output = JSON.parse(
      await command(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$abrSignature = Get-AuthenticodeSignature -LiteralPath $env:ABR_SIGNING_ARTIFACT; [pscustomobject]@{status=[string]$abrSignature.Status; thumbprint=[string]$abrSignature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
        ],
        {
          env: { ...process.env, ABR_SIGNING_ARTIFACT: filename },
          label: 'release-authenticode-verify',
        },
      ),
    );
    if (
      output.status !== 'Valid' ||
      output.thumbprint.toLowerCase() !== options.certificateThumbprint.toLowerCase()
    )
      throw new ReleaseError(
        'CODE_SIGNATURE_INVALID',
        'Windows installer Authenticode identity or validity failed.',
      );
    return {
      platform: 'win32',
      kind: 'authenticode',
      sha256: await fileSha256(filename),
      certificateThumbprint: output.thumbprint.toLowerCase(),
    };
  }
  if (process.platform === 'darwin') {
    if (!/\.(app|pkg)$/.test(filename) || !/^[A-Z0-9]{10}$/.test(options.teamId ?? ''))
      throw new ReleaseError(
        'NOTARIZATION_REQUIRED',
        'macOS requires a signed and notarized application or installer.',
      );
    if (filename.endsWith('.app')) {
      await command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', filename], {
        label: 'release-codesign-verify',
      });
      const identity = await command('codesign', ['--display', '--verbose=4', filename], {
        label: 'release-codesign-identity',
        captureStderr: true,
      });
      if (!identity.split('\n').some((line) => line.trim() === `TeamIdentifier=${options.teamId}`))
        throw new ReleaseError(
          'CODE_SIGNATURE_INVALID',
          'Application Developer ID team differs from its configured trust identity.',
        );
    } else {
      const identity = await command('pkgutil', ['--check-signature', filename], {
        label: 'release-package-signature-verify',
      });
      if (
        !identity.includes('signed by a certificate trusted by macOS') ||
        !identity.includes(`(${options.teamId})`)
      )
        throw new ReleaseError(
          'CODE_SIGNATURE_INVALID',
          'Installer Developer ID team or trusted certificate validity failed.',
        );
    }
    await command('xcrun', ['stapler', 'validate', filename], {
      label: 'release-notarization-verify',
    });
    await command(
      'spctl',
      [
        '--assess',
        '--type',
        filename.endsWith('.pkg') ? 'install' : 'execute',
        '--verbose=4',
        filename,
      ],
      { label: 'release-gatekeeper-verify' },
    );
    return {
      platform: 'darwin',
      kind: 'codesign-notarized',
      artifactType: path.extname(filename).slice(1),
      sha256: metadata.isFile()
        ? await fileSha256(filename)
        : await signedApplicationDigest(filename),
      teamId: options.teamId,
    };
  }
  if (
    !metadata.isFile() ||
    !/\.(deb|rpm|AppImage)$/.test(filename) ||
    !options.gpgSignature ||
    !options.gpgKeyring ||
    !/^[A-Fa-f0-9]{40,64}$/.test(options.gpgFingerprint ?? '')
  )
    throw new ReleaseError(
      'CODE_SIGNING_REQUIRED',
      'Linux requires a package signature and explicitly selected trust keyring.',
    );
  const output = await command(
    'gpg',
    [
      '--batch',
      '--no-default-keyring',
      '--keyring',
      path.resolve(options.gpgKeyring),
      '--status-fd=1',
      '--verify',
      path.resolve(options.gpgSignature),
      filename,
    ],
    { label: 'release-linux-signature-verify' },
  );
  if (!output.includes(`[GNUPG:] VALIDSIG ${options.gpgFingerprint.toUpperCase()} `))
    throw new ReleaseError('CODE_SIGNATURE_INVALID', 'Linux package publisher fingerprint failed.');
  return {
    platform: 'linux',
    kind: 'gpg-package',
    sha256: await fileSha256(filename),
    fingerprint: options.gpgFingerprint.toUpperCase(),
  };
}
