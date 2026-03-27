// ABOUTME: Tests for HranaServer against a real SQLite database via better-sqlite3.
// ABOUTME: Verifies the full request/response cycle: hello, execute, batch, errors.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HranaServer, type SqlBackend } from '../src/hrana-server';
import {
  serializeFrame,
  FrameBuffer,
  type ClientMessage,
  type ServerMessage,
  type HranaValue,
} from '../src/hrana-protocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Wraps better-sqlite3 into the SqlBackend interface that HranaServer expects.
 *
 * better-sqlite3's stmt.all() returns rows as objects keyed by column name.
 * stmt.columns() gives column metadata. stmt.reader distinguishes SELECTs
 * from DDL/DML.
 */
function createTestBackend(db: Database.Database): SqlBackend {
  db.function('unixepoch', () => Math.floor(Date.now() / 1000));

  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);

      if (stmt.reader) {
        const columns = stmt.columns();
        const rows = stmt.all(...bindings) as Record<string, unknown>[];
        return {
          columnNames: columns.map((c) => c.name),
          rows,
          rowsRead: rows.length,
          rowsWritten: 0,
        };
      }

      const info = stmt.run(...bindings);
      return {
        columnNames: [],
        rows: [],
        rowsRead: 0,
        rowsWritten: info.changes,
      };
    },
  };
}

/**
 * Drives a HranaServer by sending client messages and collecting responses.
 *
 * Creates a pair of TransformStreams to simulate the bidirectional TCP pipe:
 *   clientWriter → [toServer readable] → HranaServer → [toClient writable] → clientReader
 */
class TestClient {
  private toServerWriter: WritableStreamDefaultWriter<Uint8Array>;
  private fromServerReader: ReadableStreamDefaultReader<Uint8Array>;
  private frameBuffer = new FrameBuffer();
  public serverDone: Promise<void>;

  constructor(sql: SqlBackend) {
    // Client → Server pipe
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    // Server → Client pipe
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

  /** Send a client message and read one server response. */
  async send(msg: ClientMessage): Promise<ServerMessage> {
    await this.toServerWriter.write(serializeFrame(msg));

    // Read chunks until we get a complete response frame
    while (true) {
      const messages = this.frameBuffer.drain();
      if (messages.length > 0) {
        return messages[0] as ServerMessage;
      }
      const { value, done } = await this.fromServerReader.read();
      if (done) throw new Error('Server closed before responding');
      this.frameBuffer.push(value);
    }
  }

  /** Close the client side of the connection. */
  async close(): Promise<void> {
    await this.toServerWriter.close();
    await this.serverDone;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HranaServer', () => {
  let db: Database.Database;
  let sql: SqlBackend;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createTestBackend(db);
  });

  it('responds to hello with hello_ok', async () => {
    const client = new TestClient(sql);
    const resp = await client.send({ type: 'hello', jwt: null });
    expect(resp.type).toBe('hello_ok');
    await client.close();
  });

  it('opens and closes a stream', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });

    const open = await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    expect(open.type).toBe('response_ok');
    if (open.type === 'response_ok') {
      expect(open.response.type).toBe('open_stream');
    }

    const close = await client.send({
      type: 'request',
      request_id: 2,
      request: { type: 'close_stream', stream_id: 0 },
    });
    expect(close.type).toBe('response_ok');
    if (close.type === 'response_ok') {
      expect(close.response.type).toBe('close_stream');
    }

    await client.close();
  });

  it('executes CREATE TABLE', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)' },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      expect(resp.response.result.cols).toEqual([]);
      expect(resp.response.result.rows).toEqual([]);
    }

    await client.close();
  });

  it('executes INSERT and returns affected_row_count', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER, name TEXT)' },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: {
          sql: 'INSERT INTO test VALUES (?, ?)',
          args: [
            { type: 'integer', value: '1' },
            { type: 'text', value: 'alice' },
          ],
        },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      expect(resp.response.result.affected_row_count).toBe(1);
      expect(resp.response.result.last_insert_rowid).not.toBeNull();
    }

    await client.close();
  });

  it('executes SELECT and returns rows', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER, name TEXT)' },
      },
    });
    await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: {
          sql: "INSERT INTO test VALUES (1, 'alice'), (2, 'bob')",
        },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 4,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT id, name FROM test ORDER BY id' },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      const result = resp.response.result;
      expect(result.cols).toEqual([
        { name: 'id', decltype: null },
        { name: 'name', decltype: null },
      ]);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual([
        { type: 'integer', value: '1' },
        { type: 'text', value: 'alice' },
      ]);
      expect(result.rows[1]).toEqual([
        { type: 'integer', value: '2' },
        { type: 'text', value: 'bob' },
      ]);
      expect(result.rows_read).toBe(2);
    }

    await client.close();
  });

  it('executes SELECT with NULL values', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER, name TEXT)' },
      },
    });
    await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'INSERT INTO test VALUES (1, NULL)' },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 4,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT * FROM test' },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      expect(resp.response.result.rows[0][1]).toEqual({ type: 'null' });
    }

    await client.close();
  });

  it('executes batch with multiple statements', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY)' },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'batch',
        stream_id: 0,
        batch: {
          steps: [
            { stmt: { sql: 'INSERT INTO test VALUES (1)' } },
            { stmt: { sql: 'INSERT INTO test VALUES (2)' } },
            { stmt: { sql: 'INSERT INTO test VALUES (3)' } },
          ],
        },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'batch') {
      const result = resp.response.result;
      expect(result.step_results).toHaveLength(3);
      expect(result.step_errors).toHaveLength(3);
      // All should succeed
      for (let i = 0; i < 3; i++) {
        expect(result.step_results[i]).not.toBeNull();
        expect(result.step_results[i]!.affected_row_count).toBe(1);
        expect(result.step_errors[i]).toBeNull();
      }
    }

    // Verify all rows were inserted
    const count = db.prepare('SELECT count(*) as c FROM test').get() as { c: number };
    expect(count.c).toBe(3);

    await client.close();
  });

  it('executes batch with conditions', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE test (id INTEGER PRIMARY KEY)' },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'batch',
        stream_id: 0,
        batch: {
          steps: [
            // Step 0: succeeds
            { stmt: { sql: 'INSERT INTO test VALUES (1)' } },
            // Step 1: only runs if step 0 succeeded
            {
              condition: { type: 'ok', step: 0 },
              stmt: { sql: 'INSERT INTO test VALUES (2)' },
            },
            // Step 2: only runs if step 0 failed (should be skipped)
            {
              condition: { type: 'error', step: 0 },
              stmt: { sql: 'INSERT INTO test VALUES (99)' },
            },
          ],
        },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'batch') {
      const result = resp.response.result;
      // Step 0: success
      expect(result.step_results[0]).not.toBeNull();
      // Step 1: success (condition met)
      expect(result.step_results[1]).not.toBeNull();
      // Step 2: skipped (condition not met)
      expect(result.step_results[2]).toBeNull();
      expect(result.step_errors[2]).toBeNull();
    }

    // Verify: 1 and 2 inserted, 99 was not
    const rows = db.prepare('SELECT id FROM test ORDER BY id').all() as { id: number }[];
    expect(rows.map((r) => r.id)).toEqual([1, 2]);

    await client.close();
  });

  it('returns response_error for bad SQL', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT * FROM nonexistent_table' },
      },
    });

    expect(resp.type).toBe('response_error');
    if (resp.type === 'response_error') {
      expect(resp.request_id).toBe(2);
      expect(resp.error.message).toContain('nonexistent_table');
    }

    await client.close();
  });

  it('returns error for execute on unopened stream', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });

    const resp = await client.send({
      type: 'request',
      request_id: 1,
      request: {
        type: 'execute',
        stream_id: 999,
        stmt: { sql: 'SELECT 1' },
      },
    });

    expect(resp.type).toBe('response_error');
    if (resp.type === 'response_error') {
      expect(resp.error.message).toContain('999');
      expect(resp.error.message).toContain('not open');
    }

    await client.close();
  });

  it('serve() exits cleanly when client closes', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });

    // Close should not throw
    await client.close();
  });

  it('preserves request_id in responses', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });

    const open = await client.send({
      type: 'request',
      request_id: 42,
      request: { type: 'open_stream', stream_id: 0 },
    });
    expect(open.type).toBe('response_ok');
    if (open.type === 'response_ok') {
      expect(open.request_id).toBe(42);
    }

    const exec = await client.send({
      type: 'request',
      request_id: 7777,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT 1 as v' },
      },
    });
    if (exec.type === 'response_ok') {
      expect(exec.request_id).toBe(7777);
    }

    await client.close();
  });

  it('handles SELECT 1', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT 1 as v' },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      const result = resp.response.result;
      expect(result.cols).toEqual([{ name: 'v', decltype: null }]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0][0]).toEqual({ type: 'integer', value: '1' });
    }

    await client.close();
  });

  it('handles BLOB values', async () => {
    const client = new TestClient(sql);
    await client.send({ type: 'hello', jwt: null });
    await client.send({
      type: 'request',
      request_id: 1,
      request: { type: 'open_stream', stream_id: 0 },
    });
    await client.send({
      type: 'request',
      request_id: 2,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'CREATE TABLE blobs (data BLOB)' },
      },
    });

    // Insert a blob (base64 of "hello" = "aGVsbG8=")
    await client.send({
      type: 'request',
      request_id: 3,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: {
          sql: 'INSERT INTO blobs VALUES (?)',
          args: [{ type: 'blob', base64: 'aGVsbG8=' }],
        },
      },
    });

    const resp = await client.send({
      type: 'request',
      request_id: 4,
      request: {
        type: 'execute',
        stream_id: 0,
        stmt: { sql: 'SELECT data FROM blobs' },
      },
    });

    expect(resp.type).toBe('response_ok');
    if (resp.type === 'response_ok' && resp.response.type === 'execute') {
      const val = resp.response.result.rows[0][0];
      expect(val.type).toBe('blob');
      if (val.type === 'blob') {
        // Decode base64 back to string to verify content
        expect(atob(val.base64)).toBe('hello');
      }
    }

    await client.close();
  });
});
