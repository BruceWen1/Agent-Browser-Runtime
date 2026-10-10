// -*- coding: utf-8 -*-
/**
 * framing.test.ts
 * Local IPC frame validation
 * =====================
 * Verify fragmented transport decoding and rejection of malformed frame boundaries.
 */
import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from '@abr/native-ipc-client';
import { expect, test } from 'vitest';

/**
 * Verify arbitrary chunk boundaries and multiple UTF-8 frames.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of bounded roundtrip assertions.
 */
function roundtrip(): void {
  const values = [{ text: 'Unicode: \u4e2d\u6587' }, { index: 2 }];
  const bytes = Buffer.concat(values.map(encodeFrame));
  const decoder = new FrameDecoder();
  const decoded: unknown[] = [];
  // Split every header and multi-byte character through single-byte transport chunks.
  for (const byte of bytes) decoded.push(...decoder.feed(Buffer.from([byte])));
  decoder.finish();
  expect(decoded).toEqual(values);
}

/**
 * Verify allocation bounds, strict UTF-8, JSON syntax, and truncated streams.
 * Args:
 *   None.
 * Returns:
 *   void: Completion of malformed transport assertions.
 */
function malformed(): void {
  const excessive = Buffer.alloc(4);
  excessive.writeUInt32BE(MAX_FRAME_BYTES + 1);
  expect(() => new FrameDecoder().feed(excessive)).toThrow('length');
  expect(() => new FrameDecoder().feed(Buffer.alloc(4))).toThrow('length');
  expect(() => new FrameDecoder().feed(Buffer.from([0, 0, 0, 1, 0xff]))).toThrow('UTF-8');
  expect(() => new FrameDecoder().feed(Buffer.from([0, 0, 0, 1, 0x7b]))).toThrow('JSON');
  const partial = new FrameDecoder();
  partial.feed(encodeFrame({ text: 'partial' }).subarray(0, 8));
  expect(() => partial.finish()).toThrow('inside a frame');
}

test('local IPC roundtrips fragmented Unicode and coalesced frames', roundtrip);
test('local IPC rejects invalid lengths, encoding, JSON, and truncation', malformed);
