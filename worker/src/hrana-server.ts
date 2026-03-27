// ABOUTME: Hrana 3 protocol server that executes SQL against a backend.
// ABOUTME: Reads length-prefixed frames from a stream, dispatches requests, writes responses.

import {
  FrameBuffer,
  serializeFrame,
  type ClientMessage,
  type ServerMessage,
  type HranaRequest,
  type HranaResponse,
  type HranaValue,
  type StmtResult,
  type Stmt,
  type BatchResult,
} from './hrana-protocol';

// ---------------------------------------------------------------------------
// SQL backend interface
// ---------------------------------------------------------------------------

/** Result of executing a SQL statement against the backend. */
export interface SqlCursorResult {
  columnNames: string[];
  rows: Record<string, unknown>[];
  rowsRead: number;
  rowsWritten: number;
}

/**
 * Minimal SQL execution interface. DO's SqlStorage satisfies this.
 * Tests can provide a better-sqlite3 adapter.
 */
export interface SqlBackend {
  exec(query: string, ...bindings: unknown[]): SqlCursorResult;
}

/**
 * Wraps DO SqlStorage into the SqlBackend interface.
 * Call this once and pass the result to HranaServer.
 */
export function wrapSqlStorage(sql: {
  exec(query: string, ...bindings: unknown[]): {
    columnNames: string[];
    toArray(): Record<string, unknown>[];
    rowsRead: number;
    rowsWritten: number;
  };
}): SqlBackend {
  return {
    exec(query: string, ...bindings: unknown[]): SqlCursorResult {
      const cursor = sql.exec(query, ...bindings);
      return {
        columnNames: cursor.columnNames,
        rows: cursor.toArray(),
        rowsRead: cursor.rowsRead,
        rowsWritten: cursor.rowsWritten,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Value conversion: Hrana ↔ JS
// ---------------------------------------------------------------------------

/** Convert a Hrana value to a JS value suitable for SQL binding. */
function hranaToJs(val: HranaValue): unknown {
  switch (val.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(val.value);
    case 'float':
      return val.value;
    case 'text':
      return val.value;
    case 'blob': {
      // base64 → Uint8Array (works as binding in both DO SqlStorage and better-sqlite3)
      const binary = atob(val.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
  }
}

/** Convert a JS value from a SQL result into a Hrana value. */
function jsToHrana(val: unknown): HranaValue {
  if (val === null || val === undefined) {
    return { type: 'null' };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { type: 'integer', value: String(val) };
    }
    return { type: 'float', value: val };
  }
  if (typeof val === 'bigint') {
    return { type: 'integer', value: String(val) };
  }
  if (typeof val === 'string') {
    return { type: 'text', value: val };
  }
  if (val instanceof ArrayBuffer || val instanceof Uint8Array) {
    const bytes = val instanceof Uint8Array ? val : new Uint8Array(val);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { type: 'blob', base64: btoa(binary) };
  }
  // Fallback: coerce to string
  return { type: 'text', value: String(val) };
}

// ---------------------------------------------------------------------------
// Statement execution
// ---------------------------------------------------------------------------

function executeStmt(sql: SqlBackend, stmt: Stmt): StmtResult {
  const query = stmt.sql ?? '';
  const bindings: unknown[] = [];

  if (stmt.args) {
    for (const arg of stmt.args) {
      bindings.push(hranaToJs(arg));
    }
  }
  // named_args: convert to positional by extracting values in order.
  // DO SQLite uses positional ? placeholders, but @libsql/client may send
  // named args for :name or $name placeholders. For named placeholders in
  // SQLite, the bindings are still positional — the names map to ?1, ?2, etc.
  // We append named arg values after any positional args.
  if (stmt.named_args) {
    for (const na of stmt.named_args) {
      bindings.push(hranaToJs(na.value));
    }
  }

  const cursor = sql.exec(query, ...bindings);

  // Convert rows from {colName: value} records to positional HranaValue arrays
  const cols = cursor.columnNames.map((name) => ({
    name,
    decltype: null as string | null,
  }));

  const rows: HranaValue[][] = cursor.rows.map((row) =>
    cursor.columnNames.map((col) => jsToHrana(row[col]))
  );

  // Determine last_insert_rowid: if rowsWritten > 0, query for it
  let lastInsertRowid: string | null = null;
  if (cursor.rowsWritten > 0) {
    try {
      const ridCursor = sql.exec('SELECT last_insert_rowid() as rid');
      const ridRow = ridCursor.rows[0];
      if (ridRow) {
        const rid = ridRow['rid'];
        if (rid !== null && rid !== undefined) {
          lastInsertRowid = String(rid);
        }
      }
    } catch {
      // Ignore — last_insert_rowid not critical
    }
  }

  return {
    cols,
    rows,
    affected_row_count: cursor.rowsWritten,
    last_insert_rowid: lastInsertRowid,
    rows_read: cursor.rowsRead,
    rows_written: cursor.rowsWritten,
    query_duration_ms: 0,
  };
}

// ---------------------------------------------------------------------------
// HranaServer
// ---------------------------------------------------------------------------

export class HranaServer {
  private sql: SqlBackend;
  private readable: ReadableStream<Uint8Array>;
  private writable: WritableStream<Uint8Array>;
  private openStreams = new Set<number>();

  constructor(opts: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    sql: SqlBackend;
  }) {
    this.readable = opts.readable;
    this.writable = opts.writable;
    this.sql = opts.sql;
  }

  /** Run the server loop until the readable stream closes. */
  async serve(): Promise<void> {
    const reader = this.readable.getReader();
    const writer = this.writable.getWriter();
    const buffer = new FrameBuffer();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer.push(value);
        const messages = buffer.drain();

        for (const msg of messages) {
          const response = this.handleMessage(msg as ClientMessage);
          await writer.write(serializeFrame(response));
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      try { await writer.close(); } catch { /* already closed */ }
    }
  }

  private handleMessage(msg: ClientMessage): ServerMessage {
    if (msg.type === 'hello') {
      return { type: 'hello_ok' };
    }

    if (msg.type === 'request') {
      try {
        const response = this.handleRequest(msg.request);
        return {
          type: 'response_ok',
          request_id: msg.request_id,
          response,
        };
      } catch (err) {
        return {
          type: 'response_error',
          request_id: msg.request_id,
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    // Unknown message type — return an error if it has a request_id
    return {
      type: 'hello_error',
      error: { message: `Unknown message type: ${(msg as { type: string }).type}` },
    };
  }

  private handleRequest(req: HranaRequest): HranaResponse {
    switch (req.type) {
      case 'open_stream':
        this.openStreams.add(req.stream_id);
        return { type: 'open_stream' };

      case 'close_stream':
        this.openStreams.delete(req.stream_id);
        return { type: 'close_stream' };

      case 'execute': {
        this.requireStream(req.stream_id);
        const result = executeStmt(this.sql, req.stmt);
        return { type: 'execute', result };
      }

      case 'batch': {
        this.requireStream(req.stream_id);
        const result = this.executeBatch(req.batch.steps);
        return { type: 'batch', result };
      }

      default:
        throw new Error(`Unsupported request type: ${(req as { type: string }).type}`);
    }
  }

  private requireStream(streamId: number): void {
    if (!this.openStreams.has(streamId)) {
      throw new Error(`Stream ${streamId} is not open`);
    }
  }

  private executeBatch(steps: { condition?: unknown; stmt: Stmt }[]): BatchResult {
    const stepResults: (StmtResult | null)[] = [];
    const stepErrors: ({ message: string } | null)[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Evaluate condition if present
      if (step.condition && !this.evaluateCondition(step.condition, stepResults, stepErrors)) {
        stepResults.push(null);
        stepErrors.push(null);
        continue;
      }

      try {
        const result = executeStmt(this.sql, step.stmt);
        stepResults.push(result);
        stepErrors.push(null);
      } catch (err) {
        stepResults.push(null);
        stepErrors.push({
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { step_results: stepResults, step_errors: stepErrors };
  }

  private evaluateCondition(
    cond: unknown,
    results: (StmtResult | null)[],
    errors: ({ message: string } | null)[]
  ): boolean {
    const c = cond as { type: string; step?: number; cond?: unknown; conds?: unknown[] };

    switch (c.type) {
      case 'ok':
        return c.step !== undefined && c.step < results.length && results[c.step] !== null;
      case 'error':
        return c.step !== undefined && c.step < errors.length && errors[c.step] !== null;
      case 'not':
        return !this.evaluateCondition(c.cond, results, errors);
      case 'and':
        return (c.conds ?? []).every((sub) => this.evaluateCondition(sub, results, errors));
      case 'or':
        return (c.conds ?? []).some((sub) => this.evaluateCondition(sub, results, errors));
      case 'is_autocommit':
        return true; // DO SQLite is always in autocommit mode
      default:
        return true; // Unknown condition — execute the step
    }
  }
}
