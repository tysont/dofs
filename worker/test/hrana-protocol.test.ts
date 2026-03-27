// ABOUTME: Tests for Hrana 3 protocol serialization, deserialization, and frame buffering.
// ABOUTME: Verifies round-trips, partial frames, multi-frame buffers, and all value types.

import { describe, it, expect } from 'vitest';
import {
  serializeFrame,
  deserializeFrame,
  FrameBuffer,
  type HranaMessage,
  type HranaValue,
  type StmtResult,
} from '../src/hrana-protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize, then deserialize at offset 0. Verifies clean round-trip. */
function roundTrip(msg: HranaMessage): HranaMessage {
  const frame = serializeFrame(msg);
  const result = deserializeFrame(frame, 0);
  expect(result).not.toBeNull();
  expect(result!.bytesConsumed).toBe(frame.length);
  return result!.msg;
}

/** Concatenate multiple Uint8Arrays into one. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    buf.set(a, pos);
    pos += a.length;
  }
  return buf;
}

// A reusable StmtResult for testing
const sampleResult: StmtResult = {
  cols: [
    { name: 'id', decltype: 'INTEGER' },
    { name: 'name', decltype: 'TEXT' },
  ],
  rows: [
    [
      { type: 'integer', value: '1' },
      { type: 'text', value: 'alice' },
    ],
    [
      { type: 'integer', value: '2' },
      { type: 'text', value: 'bob' },
    ],
  ],
  affected_row_count: 0,
  last_insert_rowid: null,
  rows_read: 2,
  rows_written: 0,
  query_duration_ms: 0.5,
};

// ---------------------------------------------------------------------------
// Round-trip tests: every message type
// ---------------------------------------------------------------------------

describe('serializeFrame / deserializeFrame round-trip', () => {
  it('hello', () => {
    const msg: HranaMessage = { type: 'hello', jwt: null };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('hello with JWT', () => {
    const msg: HranaMessage = { type: 'hello', jwt: 'eyJhbGciOi...' };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('hello_ok', () => {
    const msg: HranaMessage = { type: 'hello_ok' };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('hello_error', () => {
    const msg: HranaMessage = {
      type: 'hello_error',
      error: { message: 'auth failed' },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('request: open_stream', () => {
    const msg: HranaMessage = {
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('request: close_stream', () => {
    const msg: HranaMessage = {
      type: 'request',
      request_id: 2,
      request: { type: 'close_stream', stream_id: 0 },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('request: execute with positional args', () => {
    const msg: HranaMessage = {
      type: 'request',
      request_id: 3,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: {
          sql: 'INSERT INTO t VALUES (?, ?)',
          args: [
            { type: 'integer', value: '42' },
            { type: 'text', value: 'hello' },
          ],
          want_rows: false,
        },
      },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('request: execute with named args', () => {
    const msg: HranaMessage = {
      type: 'request',
      request_id: 4,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: {
          sql: 'SELECT * FROM t WHERE id = :id',
          named_args: [{ name: 'id', value: { type: 'integer', value: '1' } }],
          want_rows: true,
        },
      },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('request: batch', () => {
    const msg: HranaMessage = {
      type: 'request',
      request_id: 5,
      request: {
        type: 'batch',
        stream_id: 0,
        batch: {
          steps: [
            { stmt: { sql: 'INSERT INTO t VALUES (1)' } },
            {
              condition: { type: 'ok', step: 0 },
              stmt: { sql: 'INSERT INTO t VALUES (2)' },
            },
            {
              condition: {
                type: 'not',
                cond: { type: 'error', step: 0 },
              },
              stmt: { sql: 'INSERT INTO t VALUES (3)' },
            },
          ],
        },
      },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('response_ok: open_stream', () => {
    const msg: HranaMessage = {
      type: 'response_ok',
      request_id: 1,
      response: { type: 'open_stream' },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('response_ok: execute with results', () => {
    const msg: HranaMessage = {
      type: 'response_ok',
      request_id: 3,
      response: { type: 'execute', result: sampleResult },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('response_ok: batch', () => {
    const msg: HranaMessage = {
      type: 'response_ok',
      request_id: 5,
      response: {
        type: 'batch',
        result: {
          step_results: [sampleResult, null, sampleResult],
          step_errors: [null, { message: 'constraint violated' }, null],
        },
      },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('response_error', () => {
    const msg: HranaMessage = {
      type: 'response_error',
      request_id: 99,
      error: { message: 'no such table: foo', code: 'SQLITE_ERROR' },
    };
    expect(roundTrip(msg)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Value encoding round-trips
// ---------------------------------------------------------------------------

describe('Value type encoding', () => {
  // Wrap a value in an execute response to test it through the full pipeline
  function roundTripValue(val: HranaValue): HranaValue {
    const msg: HranaMessage = {
      type: 'response_ok',
      request_id: 0,
      response: {
        type: 'execute',
        result: {
          cols: [{ name: 'v', decltype: null }],
          rows: [[val]],
          affected_row_count: 0,
          last_insert_rowid: null,
          rows_read: 1,
          rows_written: 0,
          query_duration_ms: 0,
        },
      },
    };
    const out = roundTrip(msg);
    // Extract the value from the response
    if (out.type !== 'response_ok') throw new Error('unexpected');
    if (out.response.type !== 'execute') throw new Error('unexpected');
    return out.response.result.rows[0][0];
  }

  it('null', () => {
    expect(roundTripValue({ type: 'null' })).toEqual({ type: 'null' });
  });

  it('integer (positive)', () => {
    expect(roundTripValue({ type: 'integer', value: '9007199254740993' })).toEqual({
      type: 'integer',
      value: '9007199254740993', // > Number.MAX_SAFE_INTEGER, preserved as string
    });
  });

  it('integer (negative)', () => {
    expect(roundTripValue({ type: 'integer', value: '-1' })).toEqual({
      type: 'integer',
      value: '-1',
    });
  });

  it('integer (zero)', () => {
    expect(roundTripValue({ type: 'integer', value: '0' })).toEqual({
      type: 'integer',
      value: '0',
    });
  });

  it('float', () => {
    expect(roundTripValue({ type: 'float', value: 3.14 })).toEqual({
      type: 'float',
      value: 3.14,
    });
  });

  it('float (NaN becomes null in JSON)', () => {
    // JSON.stringify(NaN) === 'null', so this tests that edge case
    const val: HranaValue = { type: 'float', value: NaN };
    const result = roundTripValue(val);
    // NaN is not preservable through JSON; value becomes null
    expect(result.type).toBe('float');
    expect((result as { type: 'float'; value: number }).value).toBeNull();
  });

  it('text (empty string)', () => {
    expect(roundTripValue({ type: 'text', value: '' })).toEqual({
      type: 'text',
      value: '',
    });
  });

  it('text (unicode)', () => {
    expect(roundTripValue({ type: 'text', value: '日本語テスト🎉' })).toEqual({
      type: 'text',
      value: '日本語テスト🎉',
    });
  });

  it('blob (base64)', () => {
    // btoa('hello') === 'aGVsbG8='
    expect(roundTripValue({ type: 'blob', base64: 'aGVsbG8=' })).toEqual({
      type: 'blob',
      base64: 'aGVsbG8=',
    });
  });

  it('blob (empty)', () => {
    expect(roundTripValue({ type: 'blob', base64: '' })).toEqual({
      type: 'blob',
      base64: '',
    });
  });
});

// ---------------------------------------------------------------------------
// deserializeFrame edge cases
// ---------------------------------------------------------------------------

describe('deserializeFrame', () => {
  it('returns null for empty buffer', () => {
    expect(deserializeFrame(new Uint8Array(0), 0)).toBeNull();
  });

  it('returns null for buffer shorter than header', () => {
    expect(deserializeFrame(new Uint8Array([0, 0, 0]), 0)).toBeNull();
  });

  it('returns null when header says more bytes than available', () => {
    // Header says 100 bytes of JSON but we only have 4 bytes total
    const buf = new Uint8Array([0, 0, 0, 100]);
    expect(deserializeFrame(buf, 0)).toBeNull();
  });

  it('respects offset parameter', () => {
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);
    // Prepend 10 garbage bytes
    const padded = concat(new Uint8Array(10), frame);
    const result = deserializeFrame(padded, 10);
    expect(result).not.toBeNull();
    expect(result!.msg).toEqual(msg);
    expect(result!.bytesConsumed).toBe(frame.length);
  });

  it('parses first frame and ignores trailing data', () => {
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);
    const withTrailing = concat(frame, new Uint8Array([99, 99, 99]));
    const result = deserializeFrame(withTrailing, 0);
    expect(result).not.toBeNull();
    expect(result!.msg).toEqual(msg);
    expect(result!.bytesConsumed).toBe(frame.length);
  });
});

// ---------------------------------------------------------------------------
// FrameBuffer
// ---------------------------------------------------------------------------

describe('FrameBuffer', () => {
  it('drains empty buffer returns empty array', () => {
    const fb = new FrameBuffer();
    expect(fb.drain()).toEqual([]);
  });

  it('drains single complete frame', () => {
    const fb = new FrameBuffer();
    const msg: HranaMessage = { type: 'hello', jwt: null };
    fb.push(serializeFrame(msg));
    const messages = fb.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('handles partial frame — returns nothing until complete', () => {
    const fb = new FrameBuffer();
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);

    // Push first half
    const mid = Math.floor(frame.length / 2);
    fb.push(frame.slice(0, mid));
    expect(fb.drain()).toEqual([]);

    // Push second half
    fb.push(frame.slice(mid));
    const messages = fb.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('handles frame split at header boundary', () => {
    const fb = new FrameBuffer();
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);

    // Push just the 4-byte header
    fb.push(frame.slice(0, 4));
    expect(fb.drain()).toEqual([]);

    // Push the JSON body
    fb.push(frame.slice(4));
    const messages = fb.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('handles multiple complete frames in one chunk', () => {
    const fb = new FrameBuffer();
    const msg1: HranaMessage = { type: 'hello', jwt: null };
    const msg2: HranaMessage = { type: 'hello_ok' };
    const msg3: HranaMessage = {
      type: 'response_error',
      request_id: 1,
      error: { message: 'fail' },
    };

    fb.push(concat(serializeFrame(msg1), serializeFrame(msg2), serializeFrame(msg3)));
    const messages = fb.drain();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
    expect(messages[2]).toEqual(msg3);
  });

  it('handles two complete frames + partial third', () => {
    const fb = new FrameBuffer();
    const msg1: HranaMessage = { type: 'hello', jwt: null };
    const msg2: HranaMessage = { type: 'hello_ok' };
    const msg3: HranaMessage = {
      type: 'response_ok',
      request_id: 0,
      response: { type: 'open_stream' },
    };

    const frame3 = serializeFrame(msg3);
    const partial3 = frame3.slice(0, 5); // just header + 1 byte

    fb.push(concat(serializeFrame(msg1), serializeFrame(msg2), partial3));
    const batch1 = fb.drain();
    expect(batch1).toHaveLength(2);
    expect(batch1[0]).toEqual(msg1);
    expect(batch1[1]).toEqual(msg2);

    // Now push the rest of frame 3
    fb.push(frame3.slice(5));
    const batch2 = fb.drain();
    expect(batch2).toHaveLength(1);
    expect(batch2[0]).toEqual(msg3);
  });

  it('handles data pushed one byte at a time', () => {
    const fb = new FrameBuffer();
    const msg: HranaMessage = { type: 'hello', jwt: null };
    const frame = serializeFrame(msg);

    // Push byte by byte — only the last push should yield the message
    for (let i = 0; i < frame.length - 1; i++) {
      fb.push(frame.slice(i, i + 1));
      expect(fb.drain()).toEqual([]);
    }
    fb.push(frame.slice(frame.length - 1));
    const messages = fb.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
  });

  it('drain is repeatable — second drain after no new data returns empty', () => {
    const fb = new FrameBuffer();
    const msg: HranaMessage = { type: 'hello_ok' };
    fb.push(serializeFrame(msg));

    expect(fb.drain()).toHaveLength(1);
    expect(fb.drain()).toEqual([]);
  });

  it('handles large payload', () => {
    const fb = new FrameBuffer();
    const bigSql = 'SELECT ' + 'x'.repeat(100_000);
    const msg: HranaMessage = {
      type: 'request',
      request_id: 1,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: bigSql },
      },
    };
    fb.push(serializeFrame(msg));
    const messages = fb.drain();
    expect(messages).toHaveLength(1);
    const req = messages[0];
    expect(req.type).toBe('request');
    if (req.type === 'request' && req.request.type === 'execute') {
      expect(req.request.stmt.sql).toBe(bigSql);
    }
  });
});

// ---------------------------------------------------------------------------
// Frame format verification
// ---------------------------------------------------------------------------

describe('frame format', () => {
  it('frame starts with 4-byte big-endian length of JSON body', () => {
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    const declaredLength = view.getUint32(0, false);
    const jsonBytes = frame.slice(4);

    expect(declaredLength).toBe(jsonBytes.length);
    expect(JSON.parse(new TextDecoder().decode(jsonBytes))).toEqual(msg);
  });

  it('empty-ish message has minimal frame size', () => {
    const msg: HranaMessage = { type: 'hello_ok' };
    const frame = serializeFrame(msg);
    const json = JSON.stringify(msg);
    // 4 bytes header + JSON bytes
    expect(frame.length).toBe(4 + new TextEncoder().encode(json).length);
  });
});
