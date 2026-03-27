// ABOUTME: AgentFS schema initialization for DO SQLite.
// ABOUTME: Creates all tables from AgentFS SPEC v0.4 and seeds root inode + config.

// Minimal interface matching the subset of SqlStorage that initSchema needs.
// DO SqlStorage satisfies this; tests can provide a lightweight adapter.
export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const DDL_STATEMENTS = [
  // Filesystem configuration
  `CREATE TABLE fs_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Inode metadata (POSIX-style)
  `CREATE TABLE fs_inode (
    ino INTEGER PRIMARY KEY AUTOINCREMENT,
    mode INTEGER NOT NULL,
    nlink INTEGER NOT NULL DEFAULT 0,
    uid INTEGER NOT NULL DEFAULT 0,
    gid INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    atime INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    ctime INTEGER NOT NULL,
    rdev INTEGER NOT NULL DEFAULT 0,
    atime_nsec INTEGER NOT NULL DEFAULT 0,
    mtime_nsec INTEGER NOT NULL DEFAULT 0,
    ctime_nsec INTEGER NOT NULL DEFAULT 0
  )`,

  // Directory entries: (parent_ino, name) -> ino
  `CREATE TABLE fs_dentry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_ino INTEGER NOT NULL,
    ino INTEGER NOT NULL,
    UNIQUE(parent_ino, name)
  )`,
  `CREATE INDEX idx_fs_dentry_parent ON fs_dentry(parent_ino, name)`,

  // File content in 4096-byte chunks
  `CREATE TABLE fs_data (
    ino INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (ino, chunk_index)
  )`,

  // Symbolic link targets
  `CREATE TABLE fs_symlink (
    ino INTEGER PRIMARY KEY,
    target TEXT NOT NULL
  )`,

  // Overlay filesystem whiteouts (copy-on-write support)
  `CREATE TABLE fs_whiteout (
    path TEXT PRIMARY KEY,
    parent_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_fs_whiteout_parent ON fs_whiteout(parent_path)`,

  // Origin inode tracking (overlay filesystem)
  `CREATE TABLE fs_origin (
    delta_ino INTEGER PRIMARY KEY,
    base_ino INTEGER NOT NULL
  )`,

  // Key-value store for agent state
  `CREATE TABLE kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )`,
  `CREATE INDEX idx_kv_store_created_at ON kv_store(created_at)`,

  // Tool call audit trail (append-only)
  `CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parameters TEXT,
    result TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_tool_calls_name ON tool_calls(name)`,
  `CREATE INDEX idx_tool_calls_started_at ON tool_calls(started_at)`,
];

const SEED_STATEMENTS = [
  // Default chunk size
  `INSERT INTO fs_config (key, value) VALUES ('chunk_size', '4096')`,

  // Root directory: inode 1, mode 0o040755 = 16877 (directory, rwxr-xr-x)
  `INSERT INTO fs_inode (ino, mode, nlink, uid, gid, size, atime, mtime, ctime)
    VALUES (1, 16877, 1, 0, 0, 0, unixepoch(), unixepoch(), unixepoch())`,
];

// All table names that initSchema creates, for verification.
export const SCHEMA_TABLES = [
  'fs_config',
  'fs_inode',
  'fs_dentry',
  'fs_data',
  'fs_symlink',
  'fs_whiteout',
  'fs_origin',
  'kv_store',
  'tool_calls',
] as const;

/**
 * Initialize the AgentFS schema in DO SQLite. Idempotent — checks for
 * existing tables before running DDL. Safe to call on every DO startup.
 */
export function initSchema(sql: SqlExec): void {
  const existing = sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_config'")
    .toArray();

  if (existing.length > 0) {
    return;
  }

  for (const stmt of DDL_STATEMENTS) {
    sql.exec(stmt);
  }

  for (const stmt of SEED_STATEMENTS) {
    sql.exec(stmt);
  }
}
