// ABOUTME: Hrana pipeline protocol types and TCP frame serialization.
// ABOUTME: Implements the HTTP pipeline format used by libsql's remote client.

// ---------------------------------------------------------------------------
// SQL Value encoding — matches Hrana spec (tagged union, integer as string)
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

export interface Row {
  values: HranaValue[];
}

export interface StmtResult {
  cols: Col[];
  rows: Row[];
  affected_row_count: number;
  last_insert_rowid: string | null;
  replication_index: string | null;
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

export interface Batch {
  steps: BatchStep[];
}

export interface BatchStep {
  condition?: BatchCond | null;
  stmt: Stmt;
}

export type BatchCond =
  | { type: 'ok'; step: number }
  | { type: 'error'; step: number }
  | { type: 'not'; cond: BatchCond }
  | { type: 'and'; conds: BatchCond[] }
  | { type: 'or'; conds: BatchCond[] }
  | { type: 'is_autocommit' };

export interface BatchResult {
  step_results: (StmtResult | null)[];
  step_errors: (HranaError | null)[];
}

// ---------------------------------------------------------------------------
// Pipeline request/response (the HTTP pipeline API format)
// ---------------------------------------------------------------------------

export type StreamRequest =
  | { type: 'close' }
  | { type: 'execute'; stmt: Stmt }
  | { type: 'batch'; batch: Batch }
  | { type: 'get_autocommit' }
  | { type: 'sequence'; sql?: string | null; sql_id?: number | null }
  | { type: 'store_sql'; sql: string; sql_id: number }
  | { type: 'close_sql'; sql_id: number }
  | { type: 'describe'; sql?: string | null; sql_id?: number | null };

export type StreamResponse =
  | { type: 'close' }
  | { type: 'execute'; result: StmtResult }
  | { type: 'batch'; result: BatchResult }
  | { type: 'get_autocommit'; is_autocommit: boolean }
  | { type: 'sequence' }
  | { type: 'store_sql' }
  | { type: 'close_sql' }
  | { type: 'describe'; result: unknown };

export type StreamResult =
  | { type: 'ok'; response: StreamResponse }
  | { type: 'error'; error: HranaError }
  | { type: 'none' };

export interface PipelineRequest {
  baton: string | null;
  requests: StreamRequest[];
}

export interface PipelineResponse {
  baton: string | null;
  base_url: string | null;
  results: StreamResult[];
}

// ---------------------------------------------------------------------------
// TCP frame serialization: 4-byte big-endian length prefix + JSON
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_SIZE = 4;

/** Serialize a message into a length-prefixed frame. */
export function serializeFrame(msg: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(msg));
  const frame = new Uint8Array(HEADER_SIZE + json.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.length, false);
  frame.set(json, HEADER_SIZE);
  return frame;
}

/** Try to deserialize one frame from a buffer at offset. Returns null if incomplete. */
export function deserializeFrame(
  buf: Uint8Array,
  offset: number
): { msg: unknown; bytesConsumed: number } | null {
  const remaining = buf.length - offset;
  if (remaining < HEADER_SIZE) return null;

  const view = new DataView(buf.buffer, buf.byteOffset + offset, remaining);
  const jsonLength = view.getUint32(0, false);

  if (remaining < HEADER_SIZE + jsonLength) return null;

  const jsonBytes = buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + jsonLength);
  const msg = JSON.parse(decoder.decode(jsonBytes));

  return { msg, bytesConsumed: HEADER_SIZE + jsonLength };
}

/** Accumulates TCP chunks and yields complete frames. */
export class FrameBuffer {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  drain(): unknown[] {
    if (this.totalLength < HEADER_SIZE) return [];

    const buf = this.consolidate();
    const messages: unknown[] = [];
    let offset = 0;

    while (true) {
      const result = deserializeFrame(buf, offset);
      if (result === null) break;
      messages.push(result.msg);
      offset += result.bytesConsumed;
    }

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
