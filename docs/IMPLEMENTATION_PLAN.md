# DOFS Implementation Plan

DOFS: Durable Object FileSystem — A POSIX filesystem backed by Cloudflare Durable Object SQLite, mountable via FUSE in Containers.

## Architecture

```
Worker (HTTP entrypoint)
  │
  ▼
Durable Object (per-agent, extends Container from @cloudflare/containers)
  ├── SQLite: AgentFS schema (fs_inode, fs_dentry, fs_data, fs_symlink, kv_store, tool_calls)
  ├── AgentFS TS SDK: direct programmatic access to filesystem (no Container needed)
  └── Hrana server: reads Hrana requests from raw TCP, executes against ctx.storage.sql
        │
        │ this.container.getTcpPort(9000).connect() — raw TCP Socket
        │ Length-prefixed JSON frames on the wire
        │
        ▼
Container (Linux, node:22-slim base)
  ├── Bridge process: TCP server on :9000, WebSocket server on ws://localhost:8080
  │   Relays frames: strips/adds 4-byte length prefix between TCP and WebSocket
  ├── @libsql/client: connects to ws://localhost:8080 (Hrana-over-WebSocket)
  ├── AgentFS FUSE daemon: mounts /agent backed by libsql remote client
  └── Agent tools: git, python, bash — all see /agent as normal POSIX filesystem
```

### Communication Flow

1. DO calls `this.container.getTcpPort(9000).connect()` → gets a `Socket` with `{ readable, writable, opened, closed }`
2. Container's bridge process accepts the TCP connection on port 9000
3. Bridge also runs a WebSocket server on `ws://localhost:8080`
4. `@libsql/client` (or AgentFS) connects to `ws://localhost:8080`
5. When the client sends a Hrana request (WebSocket text frame), the bridge wraps it in a 4-byte length-prefixed frame and writes it to the TCP socket
6. DO's Hrana server reads the frame, parses the Hrana request, executes SQL against `ctx.storage.sql`, sends the response back as a length-prefixed frame
7. Bridge receives the TCP frame, strips the length prefix, sends as a WebSocket text frame back to the client

### Key API Surface (from @cloudflare/workers-types)

```typescript
// Container runtime
interface ContainerInstance {
  getTcpPort(port: number): Fetcher;
  start(options?: ContainerStartupOptions): Promise<void>;
  destroy(): Promise<void>;
  monitor(): Promise<void>;
  running: boolean;
  signal(signo: number): void;
}

// Fetcher (returned by getTcpPort)
type Fetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
};

// Socket (returned by connect)
interface Socket {
  readable: ReadableStream;
  writable: WritableStream;
  closed: Promise<void>;
  opened: Promise<SocketInfo>;
  close(): Promise<void>;
}
```

### Container Base Class (`@cloudflare/containers`)

```typescript
import { Container } from '@cloudflare/containers';

class DOFS extends Container {
  defaultPort = 8080;     // HTTP health check port
  sleepAfter = '30m';     // Inactivity timeout before container stops

  override onStart() {}   // Called when container transitions to running
  override onStop() {}    // Called when container stops
  override onError(e) {}  // Called on container error
}
```

## Repository Structure

```
dofs/
├── docs/
│   └── IMPLEMENTATION_PLAN.md
├── worker/
│   ├── src/
│   │   ├── index.ts              # Worker fetch handler + DOFS DO class
│   │   ├── hrana-server.ts       # Hrana protocol server (Step 4)
│   │   ├── hrana-protocol.ts     # Hrana message types + serialization (Step 3)
│   │   └── schema.ts             # AgentFS DDL for DO SQLite init (Step 2)
│   ├── test/
│   │   ├── hrana-protocol.test.ts
│   │   └── schema.test.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── wrangler.jsonc
├── container/
│   ├── src/
│   │   ├── echo-server.ts       # TCP echo server (Step 1, replaced later)
│   │   ├── bridge.ts            # TCP↔WebSocket bridge (Step 6)
│   │   └── command-server.ts    # HTTP command execution server (Step 11)
│   ├── scripts/
│   │   └── entrypoint.sh        # Starts bridge, mounts FUSE, runs command server
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── e2e/
│   └── tests/
├── .gitignore
└── README.md
```

## AgentFS Schema (SPEC v0.4)

Exact DDL to use in `worker/src/schema.ts`. This must be byte-compatible with the AgentFS Rust CLI and TypeScript SDK.

```sql
-- Filesystem configuration
CREATE TABLE fs_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Inode metadata
CREATE TABLE fs_inode (
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
);

-- Directory entries
CREATE TABLE fs_dentry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_ino INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  UNIQUE(parent_ino, name)
);
CREATE INDEX idx_fs_dentry_parent ON fs_dentry(parent_ino, name);

-- File data chunks (4096 bytes each)
CREATE TABLE fs_data (
  ino INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (ino, chunk_index)
);

-- Symbolic links
CREATE TABLE fs_symlink (
  ino INTEGER PRIMARY KEY,
  target TEXT NOT NULL
);

-- Overlay filesystem whiteouts (for COW support)
CREATE TABLE fs_whiteout (
  path TEXT PRIMARY KEY,
  parent_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_fs_whiteout_parent ON fs_whiteout(parent_path);

-- Origin inode tracking (overlay FS)
CREATE TABLE fs_origin (
  delta_ino INTEGER PRIMARY KEY,
  base_ino INTEGER NOT NULL
);

-- Key-value store
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_kv_store_created_at ON kv_store(created_at);

-- Tool call audit trail
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parameters TEXT,
  result TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX idx_tool_calls_name ON tool_calls(name);
CREATE INDEX idx_tool_calls_started_at ON tool_calls(started_at);

-- Seed data
INSERT INTO fs_config (key, value) VALUES ('chunk_size', '4096');
INSERT INTO fs_inode (ino, mode, nlink, uid, gid, size, atime, mtime, ctime)
  VALUES (1, 16877, 1, 0, 0, 0, unixepoch(), unixepoch(), unixepoch());
-- Note: 16877 = 0o040755 (directory with rwxr-xr-x)
```

## Hrana 3 Protocol Reference

The Hrana protocol runs over WebSocket with subprotocol `hrana3`. JSON text frames.

### Message Types

**Client → Server:**
```typescript
// First message after WebSocket connects
{ "type": "hello", "jwt": null }

// All subsequent requests
{
  "type": "request",
  "request_id": number,  // int32, assigned by client
  "request": OpenStreamReq | CloseStreamReq | ExecuteReq | BatchReq
}
```

**Server → Client:**
```typescript
{ "type": "hello_ok" }
{ "type": "hello_error", "error": { "message": string } }

{
  "type": "response_ok",
  "request_id": number,
  "response": OpenStreamResp | CloseStreamResp | ExecuteResp | BatchResp
}

{
  "type": "response_error",
  "request_id": number,
  "error": { "message": string }
}
```

### Request/Response Bodies

```typescript
// Open a logical SQL stream (like a connection)
OpenStreamReq:  { "type": "open_stream", "stream_id": number }
OpenStreamResp: { "type": "open_stream" }

// Close a stream
CloseStreamReq:  { "type": "close_stream", "stream_id": number }
CloseStreamResp: { "type": "close_stream" }

// Execute a single SQL statement
ExecuteReq: {
  "type": "execute",
  "stream_id": number,
  "stmt": {
    "sql": string,
    "args"?: Value[],
    "named_args"?: { "name": string, "value": Value }[],
    "want_rows"?: boolean
  }
}
ExecuteResp: {
  "type": "execute",
  "result": {
    "cols": { "name": string | null, "decltype": string | null }[],
    "rows": Value[][],
    "affected_row_count": number,
    "last_insert_rowid": string | null
  }
}

// Batch execute (multiple statements, optional conditions)
BatchReq: {
  "type": "batch",
  "stream_id": number,
  "batch": {
    "steps": {
      "condition"?: BatchCond | null,
      "stmt": Stmt
    }[]
  }
}
BatchResp: {
  "type": "batch",
  "result": {
    "step_results": (StmtResult | null)[],
    "step_errors": (Error | null)[]
  }
}
```

### Value Encoding

```typescript
type Value =
  | { "type": "null" }
  | { "type": "integer", "value": string }   // string to preserve i64 precision
  | { "type": "float", "value": number }
  | { "type": "text", "value": string }
  | { "type": "blob", "base64": string }      // base64-encoded
```

### Stream Semantics

- Stream IDs are arbitrary int32 values assigned by the client
- Requests on the same stream are processed serially (preserves order)
- Multiple streams can be open concurrently
- For our use case (single FUSE client), a single stream suffices

### TCP Wire Framing (for DO ↔ Bridge)

Length-prefixed JSON: 4-byte big-endian uint32 length prefix, followed by that many bytes of UTF-8 JSON. Each frame contains exactly one Hrana message. This is our custom framing for the raw TCP pipe — the bridge translates to/from WebSocket frames.

---

## Implementation Steps

### Step 1: Scaffold and Bidirectional TCP

**Goal:** Prove Worker → DO → Container → DO → Worker round trip over raw TCP.

**Build:**
- `worker/` project: package.json, tsconfig.json, wrangler.jsonc
- `worker/src/index.ts`: Worker fetch handler + `DOFS` class extending `Container`
  - `DOFS.defaultPort = 8080`, `sleepAfter = '30m'`
  - Worker routes `GET /ping?agent=<name>` to the DO
  - DO handles `/ping`: calls `this.container.getTcpPort(9000).connect()`, writes `"ping"`, reads response, returns it
- `container/` project: package.json, tsconfig.json, Dockerfile
- `container/src/echo-server.ts`: TCP server on port 9000, echoes back `"echo: <data>"`
- `.gitignore`

**Test:**
- `cd worker && npm install && npx wrangler dev`
- `curl http://localhost:8787/ping?agent=test1` → `"echo: ping"`
- Second call reuses warm Container

**Open question:** The `connect()` method on the Fetcher from `getTcpPort()` takes an `address` parameter. Since `getTcpPort(9000)` already specifies the port, the address might be ignored or need to be a dummy value. Test during implementation and adjust.

**Fallback:** If `connect()` doesn't work on the container Fetcher, use WebSocket upgrade via `getTcpPort(9000).fetch()` with `Upgrade: websocket` headers. The bidirectional pattern is the same.

---

### Step 2: AgentFS Schema in DO SQLite

**Goal:** Initialize the AgentFS schema in DO SQLite, verify tables exist.

**Build:**
- `worker/src/schema.ts`: Export `initSchema(sql: SqlStorage)` — runs all CREATE TABLE/INDEX/INSERT statements from the schema section above
  - Idempotent: check `SELECT name FROM sqlite_master WHERE type='table'` before creating
- Call `initSchema` in the DO constructor via `blockConcurrencyWhile`
- DO method `dbInfo()`: returns table names and row counts via `ctx.storage.sql`
- Worker exposes `GET /db-info?agent=<name>`

**Test (Vitest unit):**
- `worker/test/schema.test.ts`: Use `better-sqlite3` to run `initSchema` against an in-memory DB
- Verify all 9 tables exist with correct columns
- Verify root inode (ino=1, mode=16877, nlink=1)
- Verify fs_config has chunk_size=4096
- Verify idempotency (run twice, no errors, no duplicate data)

**Test (integration):**
- `curl /db-info?agent=test1` → JSON with table names and row counts

---

### Step 3: Hrana Message Parsing and Serialization

**Goal:** Pure TypeScript module for Hrana protocol encoding/decoding with TCP framing.

**Build:**
- `worker/src/hrana-protocol.ts`:
  - TypeScript types for all Hrana messages (HelloMsg, RequestMsg, ResponseOkMsg, etc.)
  - Types for Value, Stmt, StmtResult, Col, Batch, BatchStep, BatchCond
  - `serializeFrame(msg: HranaMsg): Uint8Array` — JSON encode + 4-byte BE length prefix
  - `deserializeFrame(buf: Uint8Array, offset: number): { msg: HranaMsg, bytesConsumed: number } | null` — returns null if not enough data for a complete frame
  - `FrameBuffer` class: accumulates TCP chunks, yields complete messages
    - `push(chunk: Uint8Array): void`
    - `drain(): HranaMsg[]` — returns all complete messages, retains partial remainder
  - Helper functions for SQL Value encoding/decoding

**Test (Vitest unit, no network):**
- `worker/test/hrana-protocol.test.ts`:
  - Round-trip each message type through serialize/deserialize
  - Partial frame: push half a frame into FrameBuffer, drain returns empty; push rest, drain returns message
  - Multiple frames in one chunk: serialize two messages into one buffer, FrameBuffer drains both
  - All Value types: null, integer (as string), float, text, blob (base64)
  - Edge cases: empty result sets, large SQL strings, zero-length blob

**No external dependencies.**

---

### Step 4: Hrana Server in DO Serving Real SQL

**Goal:** A Hrana server class that reads frames from a stream, executes SQL against DO SQLite, writes responses.

**Build:**
- `worker/src/hrana-server.ts`: `HranaServer` class
  - Constructor takes `{ readable: ReadableStream, writable: WritableStream, sql: SqlStorage }`
  - `serve(): Promise<void>` — main loop:
    1. Read chunks from readable into a FrameBuffer
    2. For each complete message, dispatch:
       - `hello` → respond `hello_ok`
       - `request` with `open_stream` → track stream_id, respond `response_ok`
       - `request` with `close_stream` → remove stream_id, respond `response_ok`
       - `request` with `execute` → parse Stmt, call `sql.exec(stmt.sql, ...args)`, iterate cursor to collect cols + rows, respond with StmtResult
       - `request` with `batch` → execute steps sequentially, collect results, respond with BatchResult
    3. On stream close or error, exit cleanly
  - SQL value conversion: Hrana `integer` (string) → JS number/bigint for binding, Hrana `blob` (base64) → Uint8Array, etc.
  - Error handling: bad SQL → `response_error` with message, not a crash

**Test (Vitest unit):**
- Create mock ReadableStream/WritableStream (TransformStream pairs)
- Create a real SQLite database via `better-sqlite3`
- Write `hello` frame → read `hello_ok` frame
- Write `open_stream` → read `response_ok`
- Write `execute: CREATE TABLE test(x TEXT)` → read success response
- Write `execute: INSERT INTO test VALUES ('hello')` → read success (affected_row_count=1)
- Write `execute: SELECT * FROM test` → read response with rows=[["hello"]]
- Write `batch` with 3 INSERTs → read BatchResult with 3 step_results
- Close readable → serve() returns without error
- Write bad SQL → read `response_error` (not crash)

**Note:** The unit tests will need a shim layer since the DO's `SqlStorage` API differs from `better-sqlite3`. Create a thin adapter interface that both can implement.

---

### Step 5: Wire Hrana Server to Container TCP

**Goal:** Replace the echo server with a Hrana client in the Container. Prove SQL queries flow through TCP.

**Build:**
- Update Container: replace echo server with a Node.js Hrana test client
  - On TCP connection (from DO), send `hello`, read `hello_ok`
  - Send `open_stream`, read response
  - Send `execute: SELECT 1`, read response, log result
  - Send `execute: SELECT count(*) FROM fs_inode`, read response, log result
  - Send `close_stream`, close connection
  - Write results to stdout (and optionally to an HTTP endpoint for the DO to read)
- Update DO: when handling `/hrana-test`, start HranaServer on the TCP stream from `getTcpPort(9000).connect()`
- Container test client reads results, DO returns them to Worker

**Test (integration):**
- `curl /hrana-test?agent=test1`
- Response includes: `SELECT 1` → `1`, `SELECT count(*) FROM fs_inode` → `1` (root inode)

**This is the critical compatibility checkpoint.** If the Hrana framing or message format has issues, they surface here before we build the bridge.

---

### Step 6: WebSocket Bridge in Container

**Goal:** Bridge between raw TCP (from DO) and WebSocket (for libsql client) inside the Container.

**Build:**
- `container/src/bridge.ts`:
  - TCP server on port 9000: accepts connection from DO
  - WebSocket server on `ws://localhost:8080` (using `ws` npm package)
  - When both connections are established, relay bidirectionally:
    - WebSocket → TCP: receive WS text frame (JSON), serialize as length-prefixed frame, write to TCP
    - TCP → WebSocket: read TCP stream, parse length-prefixed frames, send each as WS text frame
  - Handle connection lifecycle: if either side closes, close the other
- Update `entrypoint.sh`: start bridge as main process
- Replace the test Hrana client from Step 5 with a simple script that connects to `ws://localhost:8080` and sends Hrana hello + execute

**Test (integration):**
- Container starts bridge on :9000 (TCP) and :8080 (WS)
- DO connects TCP to :9000, starts HranaServer
- Script inside Container connects to `ws://localhost:8080`, sends `hello`, gets `hello_ok`
- Script sends `execute: SELECT count(*) FROM fs_inode`, gets `1`
- Multiple sequential queries work over the same connection

---

### Step 7: libsql Remote Client Through the Bridge

**Goal:** Prove that stock `@libsql/client` works unmodified against the bridge.

**Build:**
- Add `@libsql/client` to Container's package.json
- Container test script:
  ```typescript
  import { createClient } from '@libsql/client';
  const client = createClient({ url: 'ws://localhost:8080' });
  await client.execute('CREATE TABLE test(x TEXT)');
  await client.execute({ sql: 'INSERT INTO test VALUES (?)', args: ['from-container'] });
  const result = await client.execute('SELECT * FROM test');
  console.log(result.rows);  // [{ x: 'from-container' }]
  ```
- DO method: start HranaServer, wait for Container to finish, then query `SELECT * FROM test` via `ctx.storage.sql.exec()`, return result

**Test (integration):**
- `curl /libsql-test?agent=test1`
- Container writes data via `@libsql/client`, DO reads it back
- Response confirms data written from Container is visible in DO SQLite

**This is THE critical compatibility gate.** The Hrana server must match exactly what `@libsql/client` sends. If there are protocol mismatches, debug by logging the raw WebSocket/TCP frames and comparing to the Hrana 3 spec. Common issues:
- Unexpected request types (e.g., `describe`, `get_autocommit`) — return `response_error` for unsupported types
- Value encoding differences (integer as string vs number)
- Missing fields in responses (e.g., `rows_read`, `rows_written`, `query_duration_ms` in StmtResult)

---

### Step 8: AgentFS TypeScript SDK from DO

**Goal:** Use the `agentfs-sdk` Cloudflare adapter for direct DO-side filesystem operations.

**Build:**
- Install `agentfs-sdk` in `worker/package.json`
- In the DO, initialize AgentFS: `const agent = AgentFS.create(this.ctx.storage)`
- Add DO methods wrapping the AgentFS SDK:
  - `writeFile(path, content)` → `agent.fs.writeFile(path, content)`
  - `readFile(path)` → `agent.fs.readFile(path)`
  - `listDir(path)` → `agent.fs.readdir(path)`
  - `kvSet(key, value)` → `agent.kv.set(key, value)`
  - `kvGet(key)` → `agent.kv.get(key)`
- Worker endpoints:
  - `POST /fs/write?agent=<name>&path=<path>` — body is file content
  - `GET /fs/read?agent=<name>&path=<path>`
  - `GET /fs/ls?agent=<name>&path=<path>`
  - `POST /kv/set?agent=<name>&key=<key>` — JSON body
  - `GET /kv/get?agent=<name>&key=<key>`

**Test (integration):**
- Write file → read back → matches
- List root → includes written file
- KV set → get → round-trips
- All without starting a Container (pure DO operations)
- Verify via raw SQL that data is in AgentFS schema tables

**Note:** If `agentfs-sdk/cloudflare` has compatibility issues with the current Workers runtime, fall back to implementing the filesystem operations directly against the schema using raw SQL. The schema is well-documented and the operations are straightforward CRUD.

---

### Step 9: AgentFS SDK from Container via Hrana

**Goal:** Prove the AgentFS SDK works from the Container side over the Hrana bridge.

**Build:**
- Install `agentfs-sdk` in Container's package.json
- Container test script:
  - Open AgentFS with `@libsql/client` URL `ws://localhost:8080`
  - Write a file: `agent.fs.writeFile('/from-container.txt', 'written in container')`
  - Read directory: `agent.fs.readdir('/')`
  - Print results
- DO orchestration:
  1. Write `/seed.txt` via AgentFS SDK (DO side)
  2. Start Container + HranaServer
  3. Container reads `/seed.txt` (confirms DO→Container visibility)
  4. Container writes `/from-container.txt`
  5. After Container finishes, DO reads `/from-container.txt` (confirms Container→DO visibility)

**Test (integration):**
- `curl /sdk-test?agent=test1`
- Response includes both file contents, confirming bidirectional visibility

**Note:** If `agentfs-sdk` doesn't support opening with a remote libsql URL directly, use `@libsql/client` to create the database connection and pass it to AgentFS. Check the SDK's `open()` API for remote URL support.

---

### Step 10: FUSE Mount in Container

**Goal:** Mount the AgentFS filesystem via FUSE so real POSIX operations work.

**Pre-implementation investigation (CRITICAL):**
1. Check AgentFS Rust CLI source: does `agentfs mount` accept a remote libsql URL?
2. If not, does it support embedded replica mode (local file + remote sync)?
3. What is the exact CLI invocation?

**FUSE is confirmed to work in CF Containers** (proven by the `fuse-on-r2` example which uses tigrisfs with Alpine + fuse3).

**Build (depending on investigation):**

*If AgentFS CLI supports remote URLs:*
- Install `agentfs` binary + `fuse3` in Dockerfile
- `entrypoint.sh`: start bridge, then `agentfs mount --url ws://localhost:8080 /agent`

*If AgentFS CLI only supports local files (more likely):*
- Option A — Embedded replica: AgentFS mounts a local SQLite file. A sync process periodically pushes/pulls changes via the Hrana bridge. Trades real-time consistency for simplicity.
- Option B — Custom FUSE adapter: Use `fuse-native` (Node.js) or `fuser` (Rust) to implement FUSE operations that translate directly to AgentFS SQL queries over `@libsql/client`. More work but real-time consistency.
- Option C — Use AgentFS TypeScript SDK + NFS: Run a small NFS server in the Container that uses the AgentFS TS SDK backed by the remote libsql client.

**Recommendation:** Start with Option A (embedded replica) for MVP. The sync latency is acceptable for most agent workloads. If real-time consistency is required, upgrade to Option B.

**Dockerfile additions:**
```dockerfile
RUN apt-get update && apt-get install -y fuse3 curl
# Install agentfs binary
RUN curl -L https://github.com/tursodatabase/agentfs/releases/latest/download/agentfs-linux-amd64 -o /usr/local/bin/agentfs && chmod +x /usr/local/bin/agentfs
```

**Test (integration):**
- `curl /fuse-test?agent=test1`
- DO writes `/seed.txt` via SDK
- Container mounts FUSE at `/agent`
- `cat /agent/seed.txt` → content written by DO
- `echo "from-fuse" > /agent/fuse-file.txt`
- `ls /agent/` → shows both files
- DO reads `/fuse-file.txt` via SDK → `"from-fuse"`

---

### Step 11: Real Tools on FUSE

**Goal:** Run git, python, and shell commands against the FUSE-mounted filesystem.

**Build:**
- Update Dockerfile: add `git`, `python3`, common tools
- `container/src/command-server.ts`: HTTP server on port 4000
  - `POST /exec` with `{ "command": "..." }` body
  - Spawns command with `cwd=/agent`
  - Streams stdout/stderr back in response
  - Returns exit code
- Update `entrypoint.sh`: start bridge, mount FUSE, start command server
- DO method `exec(command)`:
  1. Start Container if not running (via `startAndWaitForPorts`)
  2. Open HranaServer on TCP stream
  3. Send HTTP request to Container port 4000 via `this.container.getTcpPort(4000).fetch()`
  4. Return stdout/stderr/exitCode
- Worker exposes `POST /exec?agent=<name>` with `{ "command": "..." }` body

**Test (integration):**
- `POST /exec?agent=test1` body `{"command": "git init"}` → success
- `POST /exec` body `{"command": "echo 'print(42)' > main.py"}` → success
- `POST /exec` body `{"command": "python3 main.py"}` → stdout `"42"`
- `POST /exec` body `{"command": "git add . && git commit -m 'init'"}` → success
- `POST /exec` body `{"command": "git log --oneline"}` → shows commit
- `GET /fs/ls?agent=test1&path=/` → shows `.git`, `main.py`
- `GET /fs/read?agent=test1&path=/main.py` → `"print(42)"`

---

### Step 12: Persistence Across Container Eviction

**Goal:** Prove that filesystem state survives Container destruction and cold restart.

**Build:**
- Worker exposes `POST /destroy?agent=<name>` — calls `this.container.destroy()`
- No new code needed — this validates the architecture

**Test (integration):**
1. `POST /exec?agent=test1` body `{"command": "echo 'persistent' > /agent/survive.txt"}`
2. `POST /destroy?agent=test1` — kills Container
3. Wait 2 seconds
4. `POST /exec?agent=test1` body `{"command": "cat /agent/survive.txt"}` → `"persistent"`
5. `GET /fs/read?agent=test1&path=/survive.txt` from DO → `"persistent"`

This proves DO SQLite is the durable source of truth — Container is purely ephemeral compute.

---

## Risks and Mitigations

### Risk 1: Hrana Protocol Compatibility
**Impact:** `@libsql/client` may send messages our server doesn't handle.
**Gate:** Step 7 is the compatibility gate. If it fails, capture raw frames and compare to spec.
**Mitigations:**
- Log all unrecognized message types and return `response_error` (don't crash)
- The client may send `get_autocommit`, `describe`, or `store_sql` — handle gracefully
- StmtResult may need optional fields (`rows_read`, `rows_written`, `query_duration_ms`) that the client expects

### Risk 2: AgentFS Rust CLI Remote URL Support
**Impact:** Step 10 FUSE mount approach depends on this.
**Gate:** Investigate before Step 10. Check `agentfs --help` and source code.
**Mitigations:** Three fallback options documented in Step 10 (embedded replica, custom FUSE, NFS).

### Risk 3: FUSE Latency for Metadata-Heavy Operations
**Impact:** `git status`, `find`, etc. issue many sequential stat/readdir calls, each a round trip.
**Mitigations:**
- Kernel page cache absorbs repeated reads
- AgentFS has internal caching
- If unacceptable, add read-ahead batching (prefetch all dentries on opendir)
- Benchmark in Step 11 — if git init is slow, optimize

### Risk 4: DO Inactivity Timeout
**Impact:** DO may be evicted during long-running Container sessions.
**Mitigations:**
- Set `sleepAfter = '30m'` on the Container class
- The `Container` class from `@cloudflare/containers` handles activity timeout renewal on `containerFetch` calls
- For raw TCP (where auto-renewal doesn't work), the Container's command server sends periodic HTTP pings to the DO via `containerFetch`

### Risk 5: `connect()` on Container TcpPort
**Impact:** The `Fetcher.connect()` method is typed but may not work for container ports in practice (all CF examples use `fetch()` only).
**Gate:** Step 1 tests this immediately.
**Mitigations:** If raw TCP `connect()` doesn't work, use WebSocket upgrade via `fetch()` instead. The DO initiates a WebSocket to the Container, and the bridge becomes WS↔WS instead of TCP↔WS.

## Non-Goals

- Forking AgentFS — use it as a dependency, patches upstream if needed
- Building replication or custom durability — DO SQLite handles this
- Multi-agent access to the same filesystem — one DO = one agent = one filesystem
- Production auth, rate limiting, billing — this is a proof of concept
