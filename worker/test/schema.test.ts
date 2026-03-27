// ABOUTME: Tests for AgentFS schema initialization against a real SQLite database.
// ABOUTME: Verifies table creation, column structure, seed data, and idempotency.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, SCHEMA_TABLES, type SqlExec } from '../src/schema';

/**
 * Wraps better-sqlite3 to satisfy the SqlExec interface that initSchema expects.
 *
 * better-sqlite3 uses synchronous APIs:
 *   db.prepare(sql).all(...bindings)  -> rows for SELECT
 *   db.prepare(sql).run(...bindings)  -> run for DDL/DML
 *
 * SqlExec.exec() needs to return { toArray(): Record<string, unknown>[] }.
 * We detect SELECTs by trying .all() first — if the statement returns columns,
 * it's a query. Otherwise it's DDL/DML.
 *
 * Note: better-sqlite3 doesn't support SQLite's unixepoch() function natively,
 * so we register it as a custom function for testing.
 */
function createTestSql(db: Database.Database): SqlExec {
  // Register unixepoch() — returns current Unix timestamp in seconds.
  // In production DO SQLite this is a built-in function.
  db.function('unixepoch', () => Math.floor(Date.now() / 1000));

  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      // If the statement returns columns, it's a SELECT-like query
      if (stmt.reader) {
        const rows = stmt.all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      // DDL/DML: run it and return empty results
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

describe('initSchema', () => {
  let db: Database.Database;
  let sql: SqlExec;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createTestSql(db);
  });

  it('creates all expected tables', () => {
    initSchema(sql);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    for (const expected of SCHEMA_TABLES) {
      expect(tableNames).toContain(expected);
    }
  });

  it('creates all expected indexes', () => {
    initSchema(sql);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_fs_dentry_parent');
    expect(indexNames).toContain('idx_fs_whiteout_parent');
    expect(indexNames).toContain('idx_kv_store_created_at');
    expect(indexNames).toContain('idx_tool_calls_name');
    expect(indexNames).toContain('idx_tool_calls_started_at');
  });

  it('seeds fs_config with chunk_size=4096', () => {
    initSchema(sql);

    const row = db
      .prepare("SELECT value FROM fs_config WHERE key='chunk_size'")
      .get() as { value: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.value).toBe('4096');
  });

  it('seeds root inode (ino=1, directory, mode=16877)', () => {
    initSchema(sql);

    const row = db
      .prepare('SELECT ino, mode, nlink, uid, gid, size FROM fs_inode WHERE ino=1')
      .get() as { ino: number; mode: number; nlink: number; uid: number; gid: number; size: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.ino).toBe(1);
    expect(row!.mode).toBe(16877);  // 0o040755: directory + rwxr-xr-x
    expect(row!.nlink).toBe(1);
    expect(row!.uid).toBe(0);
    expect(row!.gid).toBe(0);
    expect(row!.size).toBe(0);
  });

  it('sets timestamps on root inode', () => {
    initSchema(sql);

    const row = db
      .prepare('SELECT atime, mtime, ctime FROM fs_inode WHERE ino=1')
      .get() as { atime: number; mtime: number; ctime: number } | undefined;

    expect(row).toBeDefined();
    // Timestamps should be recent (within last 10 seconds)
    const now = Math.floor(Date.now() / 1000);
    expect(row!.atime).toBeGreaterThan(now - 10);
    expect(row!.atime).toBeLessThanOrEqual(now);
    expect(row!.mtime).toBeGreaterThan(now - 10);
    expect(row!.ctime).toBeGreaterThan(now - 10);
  });

  it('creates exactly 1 row in fs_inode (root) and 1 in fs_config', () => {
    initSchema(sql);

    const inodeCount = db.prepare('SELECT count(*) as c FROM fs_inode').get() as { c: number };
    const configCount = db.prepare('SELECT count(*) as c FROM fs_config').get() as { c: number };

    expect(inodeCount.c).toBe(1);
    expect(configCount.c).toBe(1);
  });

  it('creates empty data tables', () => {
    initSchema(sql);

    for (const table of ['fs_dentry', 'fs_data', 'fs_symlink', 'fs_whiteout', 'fs_origin', 'kv_store', 'tool_calls']) {
      const row = db.prepare(`SELECT count(*) as c FROM ${table}`).get() as { c: number };
      expect(row.c).toBe(0);
    }
  });

  it('verifies fs_inode has all expected columns', () => {
    initSchema(sql);

    const columns = db.prepare("PRAGMA table_info('fs_inode')").all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    const expected = [
      'ino', 'mode', 'nlink', 'uid', 'gid', 'size',
      'atime', 'mtime', 'ctime', 'rdev',
      'atime_nsec', 'mtime_nsec', 'ctime_nsec',
    ];
    for (const col of expected) {
      expect(columnNames).toContain(col);
    }
  });

  it('verifies fs_dentry has UNIQUE constraint on (parent_ino, name)', () => {
    initSchema(sql);

    // Insert two entries with different (parent_ino, name) — should succeed
    db.prepare('INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)').run('a', 1, 2);
    db.prepare('INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)').run('b', 1, 3);

    // Insert duplicate (parent_ino, name) — should fail
    expect(() => {
      db.prepare('INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)').run('a', 1, 4);
    }).toThrow();
  });

  it('verifies fs_data has composite primary key (ino, chunk_index)', () => {
    initSchema(sql);

    // Insert two chunks for same inode — should succeed
    db.prepare('INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, ?, ?)').run(2, 0, Buffer.from('hello'));
    db.prepare('INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, ?, ?)').run(2, 1, Buffer.from('world'));

    // Duplicate (ino, chunk_index) — should fail
    expect(() => {
      db.prepare('INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, ?, ?)').run(2, 0, Buffer.from('dup'));
    }).toThrow();
  });

  it('is idempotent — calling twice does not error or duplicate data', () => {
    initSchema(sql);
    initSchema(sql);

    const inodeCount = db.prepare('SELECT count(*) as c FROM fs_inode').get() as { c: number };
    const configCount = db.prepare('SELECT count(*) as c FROM fs_config').get() as { c: number };

    expect(inodeCount.c).toBe(1);
    expect(configCount.c).toBe(1);
  });
});
