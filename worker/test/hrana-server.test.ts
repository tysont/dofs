// ABOUTME: Tests for HranaServer pipeline format against a real SQLite database.
// ABOUTME: Verifies execute, batch, get_autocommit, close, and error handling.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HranaServer, type SqlBackend } from '../src/hrana-server';
import {
  serializeFrame,
  FrameBuffer,
  type PipelineRequest,
  type PipelineResponse,
} from '../src/hrana-protocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestBackend(db: Database.Database): SqlBackend {
  db.function('unixepoch', () => Math.floor(Date.now() / 1000));
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (stmt.reader) {
        const columns = stmt.columns();
        const rows = stmt.all(...bindings) as Record<string, unknown>[];
        return { columnNames: columns.map((c) => c.name), rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const info = stmt.run(...bindings);
      return { columnNames: [], rows: [], rowsRead: 0, rowsWritten: info.changes };
    },
  };
}

class TestClient {
  private toServerWriter: WritableStreamDefaultWriter<Uint8Array>;
  private fromServerReader: ReadableStreamDefaultReader<Uint8Array>;
  private frameBuffer = new FrameBuffer();
  public serverDone: Promise<void>;

  constructor(sql: SqlBackend) {
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const fromServer = new TransformStream<Uint8Array, Uint8Array>();
    this.toServerWriter = toServer.writable.getWriter();
    this.fromServerReader = fromServer.readable.getReader();

    const server = new HranaServer({
      readable: toServer.readable,
      writable: fromServer.writable,
      sql,
    });
    this.serverDone = server.serve();
  }

  async send(req: PipelineRequest): Promise<PipelineResponse> {
    await this.toServerWriter.write(serializeFrame(req));
    while (true) {
      const messages = this.frameBuffer.drain();
      if (messages.length > 0) return messages[0] as PipelineResponse;
      const { value, done } = await this.fromServerReader.read();
      if (done) throw new Error('Server closed');
      this.frameBuffer.push(value);
    }
  }

  async close(): Promise<void> {
    await this.toServerWriter.close();
    await this.serverDone;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HranaServer pipeline', () => {
  let db: Database.Database;
  let sql: SqlBackend;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createTestBackend(db);
  });

  it('executes SELECT 1', async () => {
    const client = new TestClient(sql);
    const resp = await client.send({
      baton: null,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT 1 as v' } }],
    });

    expect(resp.baton).not.toBeNull();
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].type).toBe('ok');
    if (resp.results[0].type === 'ok' && resp.results[0].response.type === 'execute') {
      const result = resp.results[0].response.result;
      expect(result.cols).toEqual([{ name: 'v', decltype: null }]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].values[0]).toEqual({ type: 'integer', value: '1' });
    }
    await client.close();
  });

  it('creates table and inserts data', async () => {
    const client = new TestClient(sql);

    // Create table
    let resp = await client.send({
      baton: null,
      requests: [{ type: 'execute', stmt: { sql: 'CREATE TABLE test (id INTEGER, name TEXT)' } }],
    });
    expect(resp.results[0].type).toBe('ok');

    // Insert with args
    resp = await client.send({
      baton: resp.baton,
      requests: [{
        type: 'execute',
        stmt: {
          sql: 'INSERT INTO test VALUES (?, ?)',
          args: [{ type: 'integer', value: '1' }, { type: 'text', value: 'alice' }],
        },
      }],
    });
    expect(resp.results[0].type).toBe('ok');
    if (resp.results[0].type === 'ok' && resp.results[0].response.type === 'execute') {
      expect(resp.results[0].response.result.affected_row_count).toBe(1);
    }

    // Select back
    resp = await client.send({
      baton: resp.baton,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT * FROM test' } }],
    });
    if (resp.results[0].type === 'ok' && resp.results[0].response.type === 'execute') {
      expect(resp.results[0].response.result.rows).toHaveLength(1);
      expect(resp.results[0].response.result.rows[0].values).toEqual([
        { type: 'integer', value: '1' },
        { type: 'text', value: 'alice' },
      ]);
    }

    await client.close();
  });

  it('handles multiple requests in one pipeline', async () => {
    const client = new TestClient(sql);

    const resp = await client.send({
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'CREATE TABLE t (x INTEGER)' } },
        { type: 'execute', stmt: { sql: 'INSERT INTO t VALUES (1)' } },
        { type: 'execute', stmt: { sql: 'INSERT INTO t VALUES (2)' } },
        { type: 'execute', stmt: { sql: 'SELECT count(*) as c FROM t' } },
        { type: 'get_autocommit' },
      ],
    });

    expect(resp.results).toHaveLength(5);
    // All should succeed
    for (let i = 0; i < 4; i++) {
      expect(resp.results[i].type).toBe('ok');
    }
    // get_autocommit
    if (resp.results[4].type === 'ok' && resp.results[4].response.type === 'get_autocommit') {
      expect(resp.results[4].response.is_autocommit).toBe(true);
    }
    // Count should be 2
    if (resp.results[3].type === 'ok' && resp.results[3].response.type === 'execute') {
      expect(resp.results[3].response.result.rows[0].values[0]).toEqual({ type: 'integer', value: '2' });
    }

    await client.close();
  });

  it('handles batch with conditions', async () => {
    const client = new TestClient(sql);
    await client.send({ baton: null, requests: [{ type: 'execute', stmt: { sql: 'CREATE TABLE t (x INTEGER PRIMARY KEY)' } }] });

    const resp = await client.send({
      baton: null,
      requests: [{
        type: 'batch',
        batch: {
          steps: [
            { stmt: { sql: 'INSERT INTO t VALUES (1)' } },
            { condition: { type: 'ok', step: 0 }, stmt: { sql: 'INSERT INTO t VALUES (2)' } },
            { condition: { type: 'error', step: 0 }, stmt: { sql: 'INSERT INTO t VALUES (99)' } },
          ],
        },
      }],
    });

    if (resp.results[0].type === 'ok' && resp.results[0].response.type === 'batch') {
      const batch = resp.results[0].response.result;
      expect(batch.step_results[0]).not.toBeNull(); // step 0 succeeded
      expect(batch.step_results[1]).not.toBeNull(); // step 1 ran (ok condition met)
      expect(batch.step_results[2]).toBeNull();      // step 2 skipped (error condition not met)
    }

    const rows = db.prepare('SELECT x FROM t ORDER BY x').all() as { x: number }[];
    expect(rows.map((r) => r.x)).toEqual([1, 2]);

    await client.close();
  });

  it('returns error for bad SQL', async () => {
    const client = new TestClient(sql);
    const resp = await client.send({
      baton: null,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT * FROM nonexistent' } }],
    });

    expect(resp.results[0].type).toBe('error');
    if (resp.results[0].type === 'error') {
      expect(resp.results[0].error.message).toContain('nonexistent');
    }
    await client.close();
  });

  it('handles close', async () => {
    const client = new TestClient(sql);
    const resp = await client.send({
      baton: null,
      requests: [{ type: 'close' }],
    });
    expect(resp.results[0].type).toBe('ok');
    if (resp.results[0].type === 'ok') {
      expect(resp.results[0].response.type).toBe('close');
    }
    // After close, baton should be null
    expect(resp.baton).toBeNull();
    await client.close();
  });

  it('handles BLOB values', async () => {
    const client = new TestClient(sql);
    await client.send({ baton: null, requests: [{ type: 'execute', stmt: { sql: 'CREATE TABLE blobs (data BLOB)' } }] });

    await client.send({
      baton: null,
      requests: [{
        type: 'execute',
        stmt: { sql: 'INSERT INTO blobs VALUES (?)', args: [{ type: 'blob', base64: 'aGVsbG8=' }] },
      }],
    });

    const resp = await client.send({
      baton: null,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT data FROM blobs' } }],
    });

    if (resp.results[0].type === 'ok' && resp.results[0].response.type === 'execute') {
      const val = resp.results[0].response.result.rows[0].values[0];
      expect(val.type).toBe('blob');
      if (val.type === 'blob') {
        expect(atob(val.base64)).toBe('hello');
      }
    }
    await client.close();
  });

  it('serve exits cleanly on stream close', async () => {
    const client = new TestClient(sql);
    await client.send({ baton: null, requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }] });
    await client.close(); // Should not throw
  });
});
