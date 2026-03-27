// ABOUTME: Hrana 3 protocol types, serialization, and TCP frame buffering.
// ABOUTME: Implements the subset needed for DO↔Container communication.

// ---------------------------------------------------------------------------
// SQL Value encoding — matches Hrana 3 spec exactly
// ---------------------------------------------------------------------------

export type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string };

// ---------------------------------------------------------------------------
// SQL statement and result types
// ---------------------------------------------------------------------------

export interface Stmt {
  sql?: string | null;
  sql_id?: number | null;
  args?: HranaValue[];
  named_args?: { name: string; value: HranaValue }[];
  want_rows?: boolean;
}

export interface Col {
  name: string | null;
  decltype: string | null;
}

export interface StmtResult {
  cols: Col[];
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid: string | null;
  rows_read: number;
  rows_written: number;
  query_duration_ms: number;
}

export interface HranaError {
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

export type BatchCond =
  | { type: 'ok'; step: number }
  | { type: 'error'; step: number }
  | { type: 'not'; cond: BatchCond }
  | { type: 'and'; conds: BatchCond[] }
  | { type: 'or'; conds: BatchCond[] }
  | { type: 'is_autocommit' };

export interface BatchStep {
  condition?: BatchCond | null;
  stmt: Stmt;
}

export interface Batch {
  steps: BatchStep[];
}

export interface BatchResult {
  step_results: (StmtResult | null)[];
  step_errors: (HranaError | null)[];
}

// ---------------------------------------------------------------------------
// Request bodies (client → server, inside a "request" wrapper)
// ---------------------------------------------------------------------------

export type HranaRequest =
  | { type: 'open_stream'; stream_id: number }
  | { type: 'close_stream'; stream_id: number }
  | { type: 'execute'; stream_id: number; stmt: Stmt }
  | { type: 'batch'; stream_id: number; batch: Batch };

// ---------------------------------------------------------------------------
// Response bodies (server → client, inside a "response_ok" wrapper)
// ---------------------------------------------------------------------------

export type HranaResponse =
  | { type: 'open_stream' }
  | { type: 'close_stream' }
  | { type: 'execute'; result: StmtResult }
  | { type: 'batch'; result: BatchResult };

// ---------------------------------------------------------------------------
// Top-level messages (one per WebSocket frame / TCP length-prefixed frame)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'hello'; jwt: string | null }
  | { type: 'request'; request_id: number; request: HranaRequest };

export type ServerMessage =
  | { type: 'hello_ok' }
  | { type: 'hello_error'; error: HranaError }
  | { type: 'response_ok'; request_id: number; response: HranaResponse }
  | { type: 'response_error'; request_id: number; error: HranaError };

export type HranaMessage = ClientMessage | ServerMessage;

// ---------------------------------------------------------------------------
// Frame serialization: 4-byte big-endian length prefix + JSON
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_SIZE = 4;

/**
 * Serialize a Hrana message into a length-prefixed frame.
 * Format: [4 bytes big-endian uint32 length][JSON UTF-8 bytes]
 */
export function serializeFrame(msg: HranaMessage): Uint8Array {
  const json = encoder.encode(JSON.stringify(msg));
  const frame = new Uint8Array(HEADER_SIZE + json.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.length, false); // big-endian
  frame.set(json, HEADER_SIZE);
  return frame;
}

/**
 * Try to deserialize one frame from a buffer starting at `offset`.
 * Returns null if there isn't enough data for a complete frame.
 */
export function deserializeFrame(
  buf: Uint8Array,
  offset: number
): { msg: HranaMessage; bytesConsumed: number } | null {
  const remaining = buf.length - offset;
  if (remaining < HEADER_SIZE) return null;

  const view = new DataView(buf.buffer, buf.byteOffset + offset, remaining);
  const jsonLength = view.getUint32(0, false); // big-endian

  if (remaining < HEADER_SIZE + jsonLength) return null;

  const jsonBytes = buf.subarray(
    offset + HEADER_SIZE,
    offset + HEADER_SIZE + jsonLength
  );
  const msg = JSON.parse(decoder.decode(jsonBytes)) as HranaMessage;

  return { msg, bytesConsumed: HEADER_SIZE + jsonLength };
}

// ---------------------------------------------------------------------------
// FrameBuffer: accumulates TCP chunks, yields complete Hrana messages
// ---------------------------------------------------------------------------

/**
 * Buffers incoming TCP data and extracts complete length-prefixed Hrana
 * frames. Handles the reality that TCP chunks don't align with message
 * boundaries — a chunk may contain half a frame, multiple frames, or
 * a frame split across chunks.
 */
export class FrameBuffer {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  /** Add a chunk of data received from the TCP stream. */
  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  /**
   * Extract all complete messages from the buffer.
   * Partial trailing data is retained for the next push+drain cycle.
   */
  drain(): HranaMessage[] {
    if (this.totalLength < HEADER_SIZE) return [];

    // Consolidate chunks into a single contiguous buffer for parsing
    const buf = this.consolidate();
    const messages: HranaMessage[] = [];
    let offset = 0;

    while (true) {
      const result = deserializeFrame(buf, offset);
      if (result === null) break;
      messages.push(result.msg);
      offset += result.bytesConsumed;
    }

    // Retain any unconsumed bytes
    if (offset < buf.length) {
      const remainder = buf.slice(offset);
      this.chunks = [remainder];
      this.totalLength = remainder.length;
    } else {
      this.chunks = [];
      this.totalLength = 0;
    }

    return messages;
  }

  private consolidate(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const buf = new Uint8Array(this.totalLength);
    let pos = 0;
    for (const chunk of this.chunks) {
      buf.set(chunk, pos);
      pos += chunk.length;
    }
    this.chunks = [buf];
    return buf;
  }
}
