// ABOUTME: Hrana pipeline server that executes SQL against a backend.
// ABOUTME: Reads pipeline requests from a TCP stream, executes SQL, writes pipeline responses.

import {
  FrameBuffer,
  serializeFrame,
  type PipelineRequest,
  type PipelineResponse,
  type StreamRequest,
  type StreamResult,
  type StreamResponse,
  type HranaValue,
  type StmtResult,
  type Stmt,
  type BatchResult,
  type Row,
} from './hrana-protocol';

// ---------------------------------------------------------------------------
// SQL backend interface
// ---------------------------------------------------------------------------

export interface SqlCursorResult {
  columnNames: string[];
  rows: Record<string, unknown>[];
  rowsRead: number;
  rowsWritten: number;
}

export interface SqlBackend {
  exec(query: string, ...bindings: unknown[]): SqlCursorResult;
}

/** Wraps DO SqlStorage into the SqlBackend interface. */
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
      const binary = atob(val.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
  }
}

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
  if (stmt.named_args) {
    for (const na of stmt.named_args) {
      bindings.push(hranaToJs(na.value));
    }
  }

  const cursor = sql.exec(query, ...bindings);

  const cols = cursor.columnNames.map((name) => ({
    name,
    decltype: null as string | null,
  }));

  const rows: Row[] = cursor.rows.map((row) => ({
    values: cursor.columnNames.map((col) => jsToHrana(row[col])),
  }));

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
      // Not critical
    }
  }

  return {
    cols,
    rows,
    affected_row_count: cursor.rowsWritten,
    last_insert_rowid: lastInsertRowid,
    replication_index: null,
    rows_read: cursor.rowsRead,
    rows_written: cursor.rowsWritten,
    query_duration_ms: 0,
  };
}

// ---------------------------------------------------------------------------
// HranaServer — pipeline format
// ---------------------------------------------------------------------------

export class HranaServer {
  private sql: SqlBackend;
  private readable: ReadableStream<Uint8Array>;
  private writable: WritableStream<Uint8Array>;
  private baton: string | null = null;

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
          const response = this.handlePipeline(msg as PipelineRequest);
          await writer.write(serializeFrame(response));
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      try { await writer.close(); } catch { /* already closed */ }
    }
  }

  private handlePipeline(req: PipelineRequest): PipelineResponse {
    const results: StreamResult[] = [];

    for (const streamReq of req.requests) {
      try {
        const response = this.handleStreamRequest(streamReq);
        results.push({ type: 'ok', response });
      } catch (err) {
        results.push({
          type: 'error',
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // Generate a baton for session continuity if still open
    // (close request sets baton to null, and we don't regenerate it)
    const wasOpen = this.baton !== null || !req.requests.some(r => r.type === 'close');
    if (wasOpen && !this.baton) {
      this.baton = 'dofs-1';
    }

    return {
      baton: this.baton,
      base_url: null,
      results,
    };
  }

  private handleStreamRequest(req: StreamRequest): StreamResponse {
    switch (req.type) {
      case 'close':
        this.baton = null;
        return { type: 'close' };

      case 'execute': {
        const result = executeStmt(this.sql, req.stmt);
        return { type: 'execute', result };
      }

      case 'batch': {
        const result = this.executeBatch(req.batch.steps);
        return { type: 'batch', result };
      }

      case 'get_autocommit':
        return { type: 'get_autocommit', is_autocommit: true };

      case 'sequence': {
        // Execute SQL without returning results
        const query = req.sql ?? '';
        if (query) {
          this.sql.exec(query);
        }
        return { type: 'sequence' };
      }

      case 'store_sql':
        // We don't cache SQL statements — just acknowledge
        return { type: 'store_sql' };

      case 'close_sql':
        return { type: 'close_sql' };

      case 'describe':
        // Minimal describe response
        return { type: 'describe', result: { params: [], cols: [], is_explain: false, is_readonly: false } };

      default:
        throw new Error(`Unsupported stream request type: ${(req as { type: string }).type}`);
    }
  }

  private executeBatch(steps: { condition?: unknown; stmt: Stmt }[]): BatchResult {
    const stepResults: (StmtResult | null)[] = [];
    const stepErrors: ({ message: string } | null)[] = [];

    for (const step of steps) {
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
        return true;
      default:
        return true;
    }
  }
}
