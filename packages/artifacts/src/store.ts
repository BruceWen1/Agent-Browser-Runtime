// -*- coding: utf-8 -*-
/**
 * store.ts
 * Controlled browser artifact storage
 * =====================
 * Store bounded, owned artifacts with expiry, PNG redaction, and safe trace export.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BrowserError } from '@abr/contracts';
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';

export interface RedactionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ArtifactOptions {
  root: string;
  ttlMs?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  persistScreenshots?: boolean;
  now?: () => number;
}
interface ArtifactRecord {
  id: string;
  sessionId: string;
  mimeType: string;
  bytes: Buffer;
  expiresAt: number;
  persisted: boolean;
}
export interface TraceEvent {
  event: string;
  sessionId?: string;
  requestId?: string;
  actionId?: string;
  engine?: string;
  code?: string;
  durationMs?: number;
}

// Accept PNG screenshots and bounded textual exports; identifiers determine stored filenames.
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIME_TYPES = new Set(['image/png', 'application/json', 'text/html']);

/**
 * Escape untrusted trace text for inert HTML presentation.
 * Args:
 *   value (string): Serialized trace text.
 * Returns:
 *   string: HTML-escaped text content.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** ArtifactStore keeps artifact bytes and ownership private to the current runtime. */
export class ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly traces = new Map<string, TraceEvent[]>();
  private totalBytes = 0;
  private readonly now: () => number;

  /**
   * Initialize bounded artifact storage.
   * Args:
   *   options (ArtifactOptions): Owned directory, retention, and resource settings.
   * Returns:
   *   ArtifactStore: Initialized private storage service.
   */
  constructor(readonly options: ArtifactOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Insert an owned artifact with atomic in-memory quota accounting.
   * Args:
   *   sessionId (string): Session owning the bytes.
   *   mimeType (string): Admitted artifact media type.
   *   bytes (Buffer): Filtered artifact contents.
   *   persist (boolean): Whether a local copy is explicitly enabled.
   * Returns:
   *   Promise<string>: Opaque artifact identifier.
   */
  async put(sessionId: string, mimeType: string, bytes: Buffer, persist = false): Promise<string> {
    await this.cleanup();
    // Admit only bounded artifacts belonging to explicit sessions.
    if (
      !sessionId ||
      !MIME_TYPES.has(mimeType) ||
      bytes.length > (this.options.maxBytes ?? 8 * 1024 * 1024)
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Artifact type or size is invalid.');
    if (
      this.totalBytes + bytes.length > (this.options.maxTotalBytes ?? 32 * 1024 * 1024) ||
      this.records.size >= 1024
    )
      throw new BrowserError('DESKTOP_BUSY', 'Artifact storage quota is exhausted.');
    const id = randomUUID();
    const record = {
      id,
      sessionId,
      mimeType,
      bytes: Buffer.from(bytes),
      expiresAt: this.now() + (this.options.ttlMs ?? 604800000),
      persisted: persist,
    };
    this.records.set(id, record);
    this.totalBytes += bytes.length;
    // Persist only admitted filtered contents to an identifier-derived owned file.
    try {
      if (persist) {
        await mkdir(this.options.root, { recursive: true, mode: 0o700 });
        await writeFile(path.join(this.options.root, id), record.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      }
    } catch {
      this.records.delete(id);
      this.totalBytes -= bytes.length;
      throw new BrowserError('PERMISSION_REQUIRED', 'Artifact storage is unavailable.');
    }
    return id;
  }

  /**
   * Decode, redact, and reencode a PNG before admitting it to storage.
   * Args:
   *   sessionId (string): Session owning the screenshot.
   *   bytes (Buffer): PNG capture from an authorized browser backend.
   *   regions (RedactionRectangle[]): Sensitive regions in image pixel coordinates.
   * Returns:
   *   Promise<string>: Opaque identifier for filtered screenshot bytes.
   */
  async putPng(
    sessionId: string,
    bytes: Buffer,
    regions: RedactionRectangle[] = [],
  ): Promise<string> {
    // Reject non-PNG data before invoking the image decoder.
    if (
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.length > (this.options.maxBytes ?? 8 * 1024 * 1024)
    )
      throw new BrowserError('INVALID_ARGUMENT', 'Screenshot must be a bounded PNG.');
    let filtered: Buffer;
    // Filter sensitive pixels and remove ancillary metadata through PNG reencoding.
    try {
      const image = sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' });
      const metadata = await image.metadata();
      const overlays: OverlayOptions[] = [];
      for (const region of regions) {
        if (![region.x, region.y, region.width, region.height].every(Number.isFinite))
          throw new Error('Invalid redaction bounds.');
        const left = Math.max(0, Math.floor(region.x));
        const top = Math.max(0, Math.floor(region.y));
        const width = Math.min(Math.ceil(region.width), (metadata.width ?? 0) - left);
        const height = Math.min(Math.ceil(region.height), (metadata.height ?? 0) - top);
        if (width <= 0 || height <= 0) throw new Error('Redaction bounds are outside the image.');
        overlays.push({
          input: {
            create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
          },
          left,
          top,
        });
      }
      filtered = await image.composite(overlays).png({ compressionLevel: 9 }).toBuffer();
    } catch {
      throw new BrowserError('INVALID_ARGUMENT', 'Screenshot data or privacy regions are invalid.');
    }
    return this.put(sessionId, 'image/png', filtered, this.options.persistScreenshots ?? false);
  }

  /**
   * Read an unexpired artifact with an optional explicit session ownership check.
   * Args:
   *   id (string): Opaque artifact identifier.
   *   sessionId (string | undefined): Expected owner when supplied by a consumer.
   * Returns:
   *   Promise<object>: Owned media type and a copy of filtered bytes.
   */
  async read(
    id: string,
    sessionId?: string,
  ): Promise<{ sessionId: string; mimeType: string; bytes: Buffer }> {
    const record = this.records.get(id);
    // Expired and absent identifiers share a bounded unavailable response.
    if (!record || record.expiresAt <= this.now()) {
      await this.cleanup();
      throw new BrowserError('INVALID_ARGUMENT', 'Artifact is unavailable or expired.');
    }
    if (sessionId && record.sessionId !== sessionId)
      throw new BrowserError('POLICY_DENIED', 'Artifact belongs to a different session.');
    return {
      sessionId: record.sessionId,
      mimeType: record.mimeType,
      bytes: Buffer.from(record.bytes),
    };
  }

  /**
   * Record bounded operational metadata with an explicit field allowlist.
   * Args:
   *   event (TraceEvent): Safe operation metadata from the runtime.
   * Returns:
   *   void: Completion of trace insertion.
   */
  record(event: TraceEvent): void {
    if (!event.sessionId) return;
    const safe: TraceEvent = { event: String(event.event), sessionId: String(event.sessionId) };
    // Copy known metadata fields instead of serializing an entire request object.
    for (const key of ['requestId', 'actionId', 'engine', 'code', 'durationMs'] as const) {
      const value = event[key];
      if (value !== undefined) Object.assign(safe, { [key]: value });
    }
    const events = this.traces.get(event.sessionId) ?? [];
    if (events.length >= 10000)
      throw new BrowserError('DESKTOP_BUSY', 'Trace event quota is exhausted.');
    events.push(safe);
    this.traces.set(event.sessionId, events);
  }

  /**
   * Export safe session metadata as JSON or inert HTML.
   * Args:
   *   sessionId (string): Session whose operation history is exported.
   *   format ('json' | 'html'): Requested presentation format.
   * Returns:
   *   Promise<string>: Controlled export artifact identifier.
   */
  async exportTrace(sessionId: string, format: 'json' | 'html'): Promise<string> {
    const value = JSON.stringify(
      { schemaVersion: 1, sessionId, events: this.traces.get(sessionId) ?? [] },
      null,
      2,
    );
    const output =
      format === 'html'
        ? `<!doctype html><meta charset="utf-8"><title>ABR operation trace</title><pre>${escapeHtml(value)}</pre>`
        : value;
    return this.put(
      sessionId,
      format === 'html' ? 'text/html' : 'application/json',
      Buffer.from(output, 'utf8'),
    );
  }

  /**
   * Remove expired artifacts and their explicitly persisted identifier files.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of expiry cleanup.
   */
  async cleanup(): Promise<void> {
    // Remove only entries created by this storage instance.
    for (const [id, record] of this.records) {
      if (record.expiresAt > this.now()) continue;
      if (record.persisted) await rm(path.join(this.options.root, id), { force: true });
      this.records.delete(id);
      this.totalBytes -= record.bytes.length;
    }
  }

  /**
   * Release stored bytes and bounded operational history.
   * Args:
   *   None.
   * Returns:
   *   Promise<void>: Completion of storage cleanup.
   */
  async close(): Promise<void> {
    // Delete only identifier files belonging to the current instance.
    for (const record of this.records.values())
      if (record.persisted) await rm(path.join(this.options.root, record.id), { force: true });
    this.records.clear();
    this.traces.clear();
    this.totalBytes = 0;
  }
}
