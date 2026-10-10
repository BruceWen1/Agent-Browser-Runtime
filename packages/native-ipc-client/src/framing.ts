// -*- coding: utf-8 -*-
/**
 * framing.ts
 * Bounded local IPC frame encoding
 * =====================
 * Decode strict UTF-8 JSON envelopes after validating declared allocation limits.
 */
import { BrowserError } from '@abr/contracts';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Encode one bounded UTF-8 JSON frame.
 * Args:
 *   value (unknown): Versioned request or response envelope.
 * Returns:
 *   Buffer: Big-endian length header followed by JSON bytes.
 */
export function encodeFrame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  // Reject excessive payloads before constructing the framed allocation.
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES)
    throw new BrowserError('INVALID_ARGUMENT', 'IPC frame length is invalid.');
  const result = Buffer.allocUnsafe(bytes.length + 4);
  result.writeUInt32BE(bytes.length, 0);
  bytes.copy(result, 4);
  return result;
}

/** FrameDecoder handles arbitrary transport chunk boundaries with bounded pending storage. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  private length: number | undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  /**
   * Decode complete JSON frames from one transport chunk.
   * Args:
   *   chunk (Buffer): Incoming local transport bytes.
   * Returns:
   *   unknown[]: Fully decoded envelopes in transport order.
   */
  feed(chunk: Buffer): unknown[] {
    const values: unknown[] = [];
    let offset = 0;
    // Copy only the next bounded header or payload segment from the supplied chunk.
    while (offset < chunk.length) {
      const required = this.length === undefined ? 4 : this.length;
      const count = Math.min(required - this.pending.length, chunk.length - offset);
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (this.pending.length !== required) continue;
      if (this.length === undefined) {
        const length = this.pending.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES)
          throw new BrowserError('INVALID_ARGUMENT', 'IPC frame length is invalid.');
        this.length = length;
        this.pending = Buffer.alloc(0);
      } else {
        // Reject malformed UTF-8 and JSON instead of accepting replacement characters.
        try {
          values.push(JSON.parse(this.decoder.decode(this.pending)) as unknown);
        } catch {
          throw new BrowserError('INVALID_ARGUMENT', 'IPC payload is invalid UTF-8 JSON.');
        }
        this.length = undefined;
        this.pending = Buffer.alloc(0);
      }
    }
    return values;
  }

  /**
   * Validate that the transport ended on a complete frame boundary.
   * Args:
   *   None.
   * Returns:
   *   void: Completion of end-of-stream validation.
   */
  finish(): void {
    if (this.length !== undefined || this.pending.length > 0)
      throw new BrowserError('INVALID_ARGUMENT', 'IPC stream ended inside a frame.');
  }
}
