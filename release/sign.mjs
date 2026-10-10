// -*- coding: utf-8 -*-
/**
 * sign.mjs
 * Evidence-gated publisher signing
 * =====================
 * Verify independent production evidence and platform signatures before signing a release manifest.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ReleaseError, canonicalJson, fail, fileSha256, isMain, report } from './common.mjs';
import { verifyPlatformSigning, verifyReleaseEvidence } from './gates.mjs';
import { readJson, validateManifest, verifyDirectory } from './manifest.mjs';
import { writeZip } from './zip.mjs';

/**
 * Sign a candidate after complete exact-source evidence and real OS verification.
 * Args:
 *   options (object): Staging directory, evidence, trust anchors, signer, and output archive.
 * Returns:
 *   Promise<object>: Signed archive checksum and publisher identity.
 */
export async function signRelease(options) {
  const started = performance.now();
  const directory = path.resolve(options.directory);
  const manifest = validateManifest(await readJson(path.join(directory, 'version-manifest.json')));
  await verifyDirectory(directory, manifest);
  const review = await verifyReleaseEvidence(
    manifest,
    await readJson(options.evidence),
    path.dirname(path.resolve(options.evidence)),
    await readJson(options.reviewKeys, 65536),
  );
  const osSigning = await verifyPlatformSigning(options.platformArtifact, options);
  if (osSigning.sha256 !== review.installerSha256)
    throw new ReleaseError(
      'INSTALLER_BINDING_INVALID',
      'OS signature artifact differs from its independently reviewed payload binding.',
    );
  if (!options.privateKey || !/^[A-Za-z0-9._-]{1,100}$/.test(options.keyId ?? ''))
    throw new ReleaseError(
      'PUBLISHER_KEY_REQUIRED',
      'A protected publisher key and key identifier are required.',
    );
  let key;
  try {
    key = createPrivateKey(await readFile(options.privateKey));
  } catch {
    throw new ReleaseError('PUBLISHER_KEY_INVALID', 'Publisher private key could not be read.');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new ReleaseError('PUBLISHER_KEY_INVALID', 'Publisher key requires Ed25519.');
  manifest.channel = 'signed';
  manifest.components.productionEvidence = { ...review, osSigning };
  manifest.features.productionRelease = {
    approved: true,
    signing: 'verified',
    notarization: process.platform === 'darwin' ? 'verified' : 'not-applicable',
    threePlatformManualBaselines: 'verified',
  };
  const envelope = {
    algorithm: 'Ed25519',
    keyId: options.keyId,
    signature: sign(null, Buffer.from(canonicalJson(manifest)), key).toString('base64'),
  };
  await writeFile(path.join(directory, 'version-manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(directory, 'release-signature.json'), `${canonicalJson(envelope)}\n`, {
    flag: 'wx',
  });
  await writeZip(directory, path.resolve(options.output));
  const digest = await fileSha256(path.resolve(options.output));
  report('release-sign-finished', {
    keyId: options.keyId,
    sha256: digest,
    durationMs: Math.round(performance.now() - started),
  });
  return { channel: 'signed', keyId: options.keyId, sha256: digest };
}

/**
 * Dispatch evidence-gated signing using local protected input files.
 * Args:
 *   argv (string[]): Signing arguments.
 * Returns:
 *   Promise<void>: Completion of signed archive creation.
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      directory: { type: 'string' },
      evidence: { type: 'string' },
      'review-keys': { type: 'string' },
      'private-key': { type: 'string' },
      'key-id': { type: 'string' },
      output: { type: 'string' },
      'platform-artifact': { type: 'string' },
      'certificate-thumbprint': { type: 'string' },
      'team-id': { type: 'string' },
      'gpg-signature': { type: 'string' },
      'gpg-keyring': { type: 'string' },
      'gpg-fingerprint': { type: 'string' },
    },
  });
  if (
    !parsed.values.directory ||
    !parsed.values.evidence ||
    !parsed.values['review-keys'] ||
    !parsed.values.output
  )
    throw new ReleaseError(
      'RELEASE_GATES_REQUIRED',
      'Production signing requires complete local source, evidence, trust, and installer inputs.',
    );
  console.log(
    JSON.stringify(
      await signRelease({
        directory: parsed.values.directory,
        evidence: parsed.values.evidence,
        reviewKeys: parsed.values['review-keys'],
        privateKey: parsed.values['private-key'] ?? process.env.ABR_RELEASE_SIGNING_KEY_FILE,
        keyId: parsed.values['key-id'],
        output: parsed.values.output,
        platformArtifact: parsed.values['platform-artifact'],
        certificateThumbprint: parsed.values['certificate-thumbprint'],
        teamId: parsed.values['team-id'],
        gpgSignature: parsed.values['gpg-signature'],
        gpgKeyring: parsed.values['gpg-keyring'],
        gpgFingerprint: parsed.values['gpg-fingerprint'],
      }),
    ),
  );
}

// Direct invocation runs the evidence-gated signing entry point.
if (isMain(import.meta.url)) void main().catch(fail);
