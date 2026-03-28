// ABOUTME: Tests for Hrana pipeline protocol serialization and frame buffering.
// ABOUTME: Verifies round-trips, partial frames, multi-frame buffers, and Value types.

import { describe, it, expect } from 'vitest';
import {
  serializeFrame,
  deserializeFrame,
  FrameBuffer,
  type PipelineRequest,
  type PipelineResponse,
  type HranaValue,
} from '../src/hrana-protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(msg: unknown): unknown {
  const frame = serializeFrame(msg);
  const result = deserializeFrame(frame, 0);
  expect(result).not.toBeNull();
  expect(result!.bytesConsumed).toBe(frame.length);
  return result!.msg;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { buf.set(a, pos); pos += a.length; }
  return buf;
}

// ---------------------------------------------------------------------------
// Pipeline request/response round-trips
// ---------------------------------------------------------------------------

describe('pipeline format round-trip', () => {
  it('execute request', () => {
    const req: PipelineRequest = {
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'SELECT 1' } },
      ],
    };
    expect(roundTrip(req)).toEqual(req);
  });

  it('execute with args', () => {
    const req: PipelineRequest = {
      baton: null,
      requests: [
        {
          type: 'execute',
          stmt: {
            sql: 'INSERT INTO t VALUES (?, ?)',
            args: [
              { type: 'integer', value: '42' },
              { type: 'text', value: 'hello' },
            ],
          },
        },
      ],
    };
    expect(roundTrip(req)).toEqual(req);
  });

  it('batch request', () => {
    const req: PipelineRequest = {
      baton: 'session-1',
      requests: [
        {
          type: 'batch',
          batch: {
            steps: [
              { stmt: { sql: 'INSERT INTO t VALUES (1)' } },
              {
                condition: { type: 'ok', step: 0 },
                stmt: { sql: 'INSERT INTO t VALUES (2)' },
              },
            ],
          },
        },
        { type: 'get_autocommit' },
      ],
    };
    expect(roundTrip(req)).toEqual(req);
  });

  it('pipeline response', () => {
    const resp: PipelineResponse = {
      baton: 'session-1',
      base_url: null,
      results: [
        {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: [{ name: 'v', decltype: null }],
              rows: [{ values: [{ type: 'integer', value: '1' }] }],
              affected_row_count: 0,
              last_insert_rowid: null,
              replication_index: null,
              rows_read: 1,
              rows_written: 0,
              query_duration_ms: 0,
            },
          },
        },
      ],
    };
    expect(roundTrip(resp)).toEqual(resp);
  });

  it('close + get_autocommit', () => {
    const req: PipelineRequest = {
      baton: 'b',
      requests: [
        { type: 'get_autocommit' },
        { type: 'close' },
      ],
    };
    expect(roundTrip(req)).toEqual(req);
  });
});

// ---------------------------------------------------------------------------
// Value encoding round-trips
// ---------------------------------------------------------------------------

describe('Value type encoding', () => {
  function roundTripValue(val: HranaValue): HranaValue {
    const resp: PipelineResponse = {
      baton: null,
      base_url: null,
      results: [{
        type: 'ok',
        response: {
          type: 'execute',
          result: {
            cols: [{ name: 'v', decltype: null }],
            rows: [{ values: [val] }],
            affected_row_count: 0,
            last_insert_rowid: null,
            replication_index: null,
            rows_read: 1,
            rows_written: 0,
            query_duration_ms: 0,
          },
        },
      }],
    };
    const out = roundTrip(resp) as PipelineResponse;
    const r = out.results[0];
    if (r.type !== 'ok') throw new Error('unexpected');
    if (r.response.type !== 'execute') throw new Error('unexpected');
    return r.response.result.rows[0].values[0];
  }

  it('null', () => expect(roundTripValue({ type: 'null' })).toEqual({ type: 'null' }));
  it('integer', () => expect(roundTripValue({ type: 'integer', value: '9007199254740993' })).toEqual({ type: 'integer', value: '9007199254740993' }));
  it('float', () => expect(roundTripValue({ type: 'float', value: 3.14 })).toEqual({ type: 'float', value: 3.14 }));
  it('text', () => expect(roundTripValue({ type: 'text', value: '日本語🎉' })).toEqual({ type: 'text', value: '日本語🎉' }));
  it('blob', () => expect(roundTripValue({ type: 'blob', base64: 'aGVsbG8=' })).toEqual({ type: 'blob', base64: 'aGVsbG8=' }));
  it('empty blob', () => expect(roundTripValue({ type: 'blob', base64: '' })).toEqual({ type: 'blob', base64: '' }));
});

// ---------------------------------------------------------------------------
// FrameBuffer
// ---------------------------------------------------------------------------

describe('FrameBuffer', () => {
  it('drains single frame', () => {
    const fb = new FrameBuffer();
    const msg: PipelineRequest = { baton: null, requests: [{ type: 'close' }] };
    fb.push(serializeFrame(msg));
    const msgs = fb.drain();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(msg);
  });

  it('handles partial frame', () => {
    const fb = new FrameBuffer();
    const msg: PipelineRequest = { baton: null, requests: [{ type: 'close' }] };
    const frame = serializeFrame(msg);
    const mid = Math.floor(frame.length / 2);
    fb.push(frame.slice(0, mid));
    expect(fb.drain()).toEqual([]);
    fb.push(frame.slice(mid));
    expect(fb.drain()).toHaveLength(1);
  });

  it('handles multiple frames in one chunk', () => {
    const fb = new FrameBuffer();
    const msg1: PipelineRequest = { baton: null, requests: [{ type: 'close' }] };
    const msg2: PipelineRequest = { baton: 'b', requests: [{ type: 'get_autocommit' }] };
    fb.push(concat(serializeFrame(msg1), serializeFrame(msg2)));
    expect(fb.drain()).toHaveLength(2);
  });

  it('drain is idempotent', () => {
    const fb = new FrameBuffer();
    fb.push(serializeFrame({ baton: null, requests: [] }));
    expect(fb.drain()).toHaveLength(1);
    expect(fb.drain()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Frame format
// ---------------------------------------------------------------------------

describe('frame format', () => {
  it('4-byte BE length prefix', () => {
    const msg = { baton: null, requests: [] };
    const frame = serializeFrame(msg);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    const len = view.getUint32(0, false);
    expect(len).toBe(frame.length - 4);
    expect(JSON.parse(new TextDecoder().decode(frame.slice(4)))).toEqual(msg);
  });
});
