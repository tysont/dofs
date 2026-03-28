# DOFS

Durable Object FileSystem — a POSIX filesystem backed by Cloudflare Durable Object SQLite, mountable via FUSE in Containers.

Cloudflare Durable Objects have SQLite storage but no filesystem. DOFS gives each DO a real POSIX filesystem by storing file data in the DO's SQLite (using the [AgentFS](https://github.com/tursodatabase/agentfs) schema) and mounting it via FUSE in an attached Container. The result is a persistent, named volume where standard tools — git, python, compilers, shell scripts — work against files that live in DO SQLite.

Each **volume** is one Durable Object. Files can be read and written directly from the DO (via the AgentFS TypeScript SDK, no Container needed) or from inside the Container (via the FUSE mount at `/volume`). Both paths hit the same SQLite tables, so changes are immediately visible from either side. Data persists across Container destruction — the DO's SQLite is the sole source of truth.

## Quick start

Volumes are created on first use. Every request includes `?volume=<name>` to identify which volume to operate on.

### Write and read files

```bash
BASE=https://your-worker.workers.dev

# Write a file
curl -X POST "$BASE/fs/write?volume=myproject&path=/config.json" \
  -d '{"debug": false, "workers": 4}'
# ok

# Read it back
curl "$BASE/fs/read?volume=myproject&path=/config.json"
# {"debug": false, "workers": 4}

# List the root directory
curl "$BASE/fs/ls?volume=myproject&path=/"
# ["config.json"]
```

These operations run directly in the Durable Object — no Container is started and latency is minimal.

### Run commands

```bash
# Execute a command inside a Linux container with the volume mounted at /volume
curl -X POST "$BASE/exec?volume=myproject" \
  -H "Content-Type: application/json" \
  -d '{"command": "cat /volume/config.json"}'
# {"exitCode":0,"stdout":"{\"debug\": false, \"workers\": 4}","stderr":""}
```

The first exec cold-starts a Container and mounts the volume via FUSE (~30s). Subsequent calls reuse the warm Container (~2s). Files written via `/fs/write` are visible at `/volume/` inside the Container, and files written inside the Container are readable via `/fs/read`.

### Use real tools

The Container has git, python3, and standard Linux utilities:

```bash
# Write a Python script via the DO SDK (fast, no Container needed)
curl -X POST "$BASE/fs/write?volume=myproject&path=/main.py" -d 'print(42)'

# Run it inside the Container
curl -X POST "$BASE/exec?volume=myproject" \
  -H "Content-Type: application/json" \
  -d '{"command": "python3 /volume/main.py"}'
# {"exitCode":0,"stdout":"42\n","stderr":""}

# Initialize a git repo (git init is slow on FUSE due to many small file writes;
# use --template= to skip hook templates and speed it up)
curl -X POST "$BASE/exec?volume=myproject" \
  -H "Content-Type: application/json" \
  -d '{"command": "cd /volume && git init --template= && git add -A && git -c user.name=dofs -c user.email=dofs@test commit -m initial 2>&1"}'
# {"exitCode":0,"stdout":"Initialized empty Git repository in /volume/.git/\n[master ...] initial\n...","stderr":""}

# Verify from the DO side
curl "$BASE/fs/ls?volume=myproject&path=/"
# [".git","config.json","main.py"]
```

### Performance

Typical agent workloads perform well:

| Operation | Latency |
|-----------|---------|
| `/fs/write` + `/fs/read` (DO SDK, no Container) | <100ms |
| `/exec` warm container (run a script, read output) | 2-10s |
| `/exec` cold start (first call to a new volume) | ~30s |
| `git init --template= && git add . && git commit` | 30-50s |

The bottleneck for FUSE operations is the DO-to-Container network round-trip (~29ms). Every FUSE syscall (open, read, write, stat, readdir) crosses this path. Simple operations like running a Python script involve a handful of FUSE calls and complete quickly. Metadata-heavy operations like `git init` (which creates hundreds of small files) issue 700+ sequential round-trips.

For best results with the current architecture:
- **Write files via `/fs/write`** — this hits DO SQLite directly with no FUSE overhead
- **Use `/exec` for computation** — run scripts, compilers, tools against files already on the volume
- **Avoid metadata-heavy tools in FUSE** — prefer writing project scaffolding via the DO SDK, then using exec for builds/runs
### Data persists across Container destruction

```bash
# Kill the Container
curl -X POST "$BASE/destroy?volume=myproject"
# ok

# Data is still there (read directly from DO SQLite, no Container needed)
curl "$BASE/fs/read?volume=myproject&path=/main.py"
# print(42)

# Start a new Container — previous data is visible via FUSE
curl -X POST "$BASE/exec?volume=myproject" \
  -H "Content-Type: application/json" \
  -d '{"command": "cat /volume/main.py && git -C /volume log --oneline"}'
# {"exitCode":0,"stdout":"print(42)\na1b2c3d initial\n","stderr":""}
```

### KV store

Each volume also has a simple key-value store:

```bash
curl -X POST "$BASE/kv/set?volume=myproject&key=status" -d "running"
# ok

curl "$BASE/kv/get?volume=myproject&key=status"
# running
```

### Volume isolation

Volumes are completely isolated. Each gets its own DO instance with its own SQLite database:

```bash
curl -X POST "$BASE/fs/write?volume=project-a&path=/a.txt" -d "I am A"
curl -X POST "$BASE/fs/write?volume=project-b&path=/b.txt" -d "I am B"

curl "$BASE/fs/ls?volume=project-a&path=/"
# ["a.txt"]

curl "$BASE/fs/ls?volume=project-b&path=/"
# ["b.txt"]
```

---

## How it works

### AgentFS

[AgentFS](https://github.com/tursodatabase/agentfs) is an open-source virtual filesystem backed by SQLite, built by Turso. It stores POSIX file metadata in a set of tables:

- **`fs_inode`** — inode metadata: mode, permissions, uid/gid, size, timestamps (with nanosecond precision), device number
- **`fs_dentry`** — directory entries mapping (parent_ino, name) → child_ino, with a UNIQUE constraint
- **`fs_data`** — file content in 4096-byte chunks keyed by (ino, chunk_index)
- **`fs_symlink`** — symbolic link targets
- **`fs_config`** — filesystem configuration (chunk_size, schema_version)
- **`kv_store`** — key-value pairs for arbitrary state
- **`tool_calls`** — append-only audit log

The Rust SDK provides a `FileSystem` trait with methods like `lookup`, `getattr`, `readdir`, `create_file`, `pread`, `pwrite`. The concrete implementation backs every method with SQL queries. A `lookup` does `SELECT ino FROM fs_dentry WHERE parent_ino = ? AND name = ?`. A `pread` fetches the right chunk from `fs_data` and slices into it. A `pwrite` creates or updates chunks. The filesystem logic is entirely in the SQL — there is no on-disk file tree.

The CLI wraps this with a vendored pure-Rust FUSE implementation. When you run `agentfs mount`, it opens a database connection, constructs the `FileSystem`, wraps it in a FUSE adapter that bridges async trait methods to synchronous FUSE callbacks via a Tokio runtime, and enters the kernel protocol loop. From that point on, every `open()`, `read()`, `write()`, `stat()` syscall on the mounted directory enters the FUSE kernel module, gets routed to the userspace daemon, which calls the async `FileSystem` method, which executes SQL.

### What we changed in the fork

DOFS depends on [`tysont/agentfs`](https://github.com/tysont/agentfs), a fork of `tursodatabase/agentfs`. The upstream uses a proprietary `turso` crate for database access. It only supports `Builder::new_local(path)` for local SQLite files and `sync::Builder::new_remote(path)` for embedded replicas that sync with Turso Cloud. There is no way to point it at an arbitrary remote database server.

We replaced `turso` with the open-source `libsql` crate across the entire SDK and CLI (21 files changed). The APIs are nearly identical — same `Value` enum, same `Connection` methods, same `Rows`/`Row` types — but `libsql` has `Builder::new_remote(url, token)` which creates a pure network connection where every query goes over HTTP. No local file.

The mechanical adaptations: `prepare_cached()` → `prepare()` (libsql has no statement cache), `Row::get_value(usize)` → `get_value(i32)` (index type), and ~30 sites where libsql's `Rows` type holds a reference to the underlying SQLite statement and must be dropped before the next operation on the same connection (turso copied row data; libsql reads from the live statement cursor).

We removed turso's sync functionality (pull/push/checkpoint) since it has no libsql equivalent and we don't need it. We added `ConnectionPool::new_remote(url, token)`, `AgentFSOptions::with_remote(url)`, and `--remote-url` / `--auth-token` CLI flags to the mount command.

One more fix: `execute_batch("PRAGMA synchronous = OFF")` fails because libsql's SQL parser classifies PRAGMAs with values as unsupported statements when sent through the batch path. We changed the four `execute_batch` calls for PRAGMAs to `execute()` which bypasses the parser and sends the SQL directly.

These changes produce a clean `agentfs mount --remote-url http://host:port volume /mountpoint` that operates against a remote database with no local file. 100 of 101 upstream tests pass (1 ignored — uses a turso-specific encryption cipher).

### Volume provisioning

When the Worker receives a request like `GET /fs/read?volume=myvolume&path=/hello.txt`, the fetch handler extracts the volume name, calls `getContainer(env.DOFS, "myvolume")` to get a DO stub (creating or looking up the DO by name), and forwards the request.

If this is the first request to "myvolume", Cloudflare provisions a new DO instance. The constructor runs inside `blockConcurrencyWhile` to ensure no `fetch` calls are processed until initialization completes:

1. **`initSchema`** runs the full AgentFS DDL against `ctx.storage.sql`: creates all 9 tables plus indexes, inserts the root inode (ino=1, mode=0o040755 directory) and chunk_size=4096 config. It checks for `fs_config` existence first, so it's idempotent.

2. **`AgentFS.create(ctx.storage)`** initializes the AgentFS TypeScript SDK's Cloudflare adapter. This runs synchronously against `ctx.storage.sql` — no network, no libsql, just direct DO SQLite access. It runs its own `CREATE TABLE IF NOT EXISTS` statements (no-ops since `initSchema` already created everything) and reads the chunk size from config.

After initialization, the DO is ready. A `/fs/read` call resolves the path via `fs_dentry`, reads chunks from `fs_data`, concatenates them, and returns the content. No Container involved.

### Container startup for exec

When a `POST /exec` request arrives, the DO calls `ensureContainer()`. If `activeServePromise` is already set (meaning a previous exec set everything up and the Hrana TCP connection is still alive), it returns immediately. Otherwise, the DO drives a four-step setup sequence via HTTP calls to the Container:

**Step 1: Start the Container.** The DO sets `this.entrypoint = ['node', '/app/dist/command-server.js']` and calls `this.startAndWaitForPorts({ ports: [4000] })`. The `Container` base class from `@cloudflare/containers` starts a Firecracker micro-VM with the Docker image, then polls port 4000 with HTTP health checks until the command server responds.

**Step 2: Start the bridge.** The DO calls `POST /setup` on the command server. The handler does `await import('./bridge.js'); await startBridge()`. The bridge starts two servers in the same Node.js process: a raw TCP server on port 9000 and an HTTP server on port 8080. `startBridge()` resolves when both are listening.

**Step 3: Connect TCP and start HranaServer.** The DO calls `this.ctx.container.getTcpPort(9000).connect('0.0.0.0:9000')`. This opens a raw bidirectional TCP socket from the DO to the Container through the Cloudflare Container runtime, returning a `Socket` with `readable: ReadableStream` and `writable: WritableStream`.

The DO creates a `HranaServer` with these streams and `wrapSqlStorage(this.ctx.storage.sql)` as the SQL backend, then calls `server.serve()` without awaiting it — the promise runs in the background via the event loop. The serve loop reads length-prefixed frames from the TCP stream, parses each as a Hrana `PipelineRequest`, executes the SQL statements against `ctx.storage.sql`, and writes the `PipelineResponse` back.

If the TCP connection drops (Container eviction, crash), the serve promise resolves and resets `activeServePromise` to `null`, so the next `ensureContainer()` call reconnects instead of returning early.

**Step 4: Mount FUSE.** The DO fires `POST /mount` to the command server but does NOT await it, because the mount handler blocks for up to 30 seconds while the FUSE daemon initializes and sends SQL queries through the Hrana connection that's being served concurrently by the serve loop.

The command server's `/mount` handler runs `exec('agentfs mount --remote-url http://localhost:8080 --auth-token "" --foreground volume /volume')`, spawning the agentfs binary as a tracked child process. It polls `mountpoint -q /volume` until the mount is established. If the agentfs process exits, it captures the exit code and surfaces it through `/health`.

The DO polls `GET /health` on the command server every second for up to 30 seconds. The health endpoint checks `mountpoint -q` and reports `fuseMounted: true` when the mount is ready. If the daemon crashed, `fuseExitCode` is set and the DO throws an explicit error.

### The data path: FUSE to SQLite and back

When a command executes `cat /volume/hello.txt` inside the Container:

**1. Kernel FUSE.** The `cat` process calls `open("/volume/hello.txt", O_RDONLY)`. The kernel recognizes `/volume` as a FUSE mount point and sends a FUSE_LOOKUP request to the agentfs userspace daemon via `/dev/fuse`.

**2. AgentFS FUSE adapter.** The `AgentFSFuse` struct receives the lookup request and calls `self.runtime.block_on(self.fs.lookup(parent_ino, "hello.txt"))` to bridge from the synchronous FUSE callback to the async `FileSystem` trait.

**3. AgentFS filesystem layer.** `filesystem::AgentFS::lookup` gets a connection from the `ConnectionPool` (holding a `libsql::Database` created by `Builder::new_remote("http://localhost:8080", "")`) and executes:

```sql
SELECT d.ino, i.mode, i.nlink, i.uid, i.gid, i.size, i.atime, i.mtime, i.ctime, ...
FROM fs_dentry d JOIN fs_inode i ON d.ino = i.ino
WHERE d.parent_ino = ? AND d.name = ?
```

**4. libsql remote client.** The `conn.query()` call goes through the libsql Hrana client. For queries that return rows, libsql uses the cursor API: it sends `POST http://localhost:8080/v3/cursor` with body:

```json
{
  "baton": null,
  "batch": {
    "steps": [{ "stmt": { "sql": "SELECT ...", "args": [{"type":"integer","value":"1"}, {"type":"text","value":"hello.txt"}] } }]
  }
}
```

**5. Bridge: HTTP → TCP.** The bridge's HTTP server on port 8080 receives this POST. For `/v3/cursor` requests, the bridge translates to a pipeline format: rewrites the cursor request as `{ "baton": null, "requests": [{ "type": "batch", "batch": ... }] }`, serializes it as a length-prefixed JSON frame (4-byte big-endian uint32 length + UTF-8 JSON bytes), and writes it to the TCP socket connected to the DO.

**6. DO HranaServer.** The serve loop's `reader.read()` yields the TCP chunk. The `FrameBuffer` accumulates data and extracts complete frames. `handlePipeline` parses the `PipelineRequest`, iterates over the `StreamRequest` array, and for each `batch` request, iterates over the batch steps calling `executeStmt`.

**7. Statement execution.** `executeStmt` first checks the statement filter. DO SQLite does not support PRAGMA writes or explicit transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`) — it wraps every `sql.exec()` call in an implicit transaction. The filter returns empty results for blocked statements. For `PRAGMA table_info(tablename)`, which AgentFS uses for schema version detection, the server simulates it by parsing the `CREATE TABLE` DDL from `sqlite_master`.

For the SELECT query, it converts Hrana-format args (tagged values like `{ "type": "integer", "value": "1" }`) to JS values, calls `ctx.storage.sql.exec(sql, ...bindings)`, iterates the cursor to collect column names and rows, converts the JS values back to Hrana format, queries `last_insert_rowid()` for writes, and builds a `StmtResult`.

**8. Response flows back.** The `PipelineResponse` is serialized as a length-prefixed frame and written to the TCP writable stream. The bridge receives the frame and translates the pipeline batch result into NDJSON cursor format:

```
{"baton":"dofs-1","base_url":null}
{"type":"step_begin","step":0,"cols":[{"name":"ino"},{"name":"mode"},...]}
{"type":"row","row":[{"type":"integer","value":"2"},{"type":"integer","value":"33188"},...]}
{"type":"step_end","affected_row_count":0,"last_inserted_rowid":null}
```

Each line is written as an HTTP chunk. The response ends.

**9. libsql processes the cursor.** The `Cursor` struct reads lines from the HTTP response stream, deserializes each `CursorEntry`, and feeds rows back to the `HranaRows` iterator. The `conn.query()` call returns with the resolved inode.

**10. Read follows.** The kernel sends FUSE_READ. AgentFS calls `pread(ino, offset, size)` which executes `SELECT data FROM fs_data WHERE ino = ? AND chunk_index = ?`. Same flow: libsql → cursor HTTP → bridge → TCP → DO → `ctx.storage.sql.exec()` → response. The chunk data (stored as BLOB, transmitted as base64 in Hrana) is decoded and returned to the kernel, which delivers it to `cat`'s `read()` syscall.

**For writes**, the flow is the same direction but with INSERT/UPDATE operations. `echo hello > /volume/file.txt` triggers FUSE_CREATE (INSERTs into `fs_inode` and `fs_dentry`), FUSE_WRITE (INSERTs into `fs_data`), and FUSE_RELEASE. Writes use `/v3/pipeline` (not cursor) since they don't return row data. The data lands in DO SQLite immediately — a subsequent `GET /fs/read` from outside the Container reads it directly via the AgentFS TypeScript SDK against the same `ctx.storage.sql`.

## Architecture diagram

```
Client
  | POST /exec?volume=myvolume {"command": "cat /volume/hello.txt"}
  v
Worker (HTTP entrypoint)
  | getContainer(env.DOFS, "myvolume").fetch(request)
  v
Durable Object (one per volume)
  |-- ctx.storage.sql: AgentFS schema in DO SQLite
  |-- AgentFS TS SDK: /fs/read, /fs/write, /fs/ls (no Container)
  |-- HranaServer: serve loop on TCP, executes SQL, writes responses
  |
  +-- TCP via getTcpPort(9000).connect()
        |
        | 4-byte BE length prefix + JSON (Hrana pipeline protocol)
        |
        v
Container (Firecracker micro-VM)
  |-- Command server (:4000)
  |     POST /setup  -> import bridge, start TCP+HTTP servers
  |     POST /mount  -> exec agentfs mount --remote-url http://localhost:8080
  |     POST /exec   -> exec(command, {cwd: "/volume"})
  |     GET  /health -> {fuseMounted, fuseExitCode, bridgeStarted, cwd}
  |
  |-- Bridge (in-process with command server)
  |     TCP server :9000 (accepts DO connection)
  |     HTTP server :8080 (accepts libsql/agentfs requests)
  |       POST /v3/pipeline -> forward as TCP frame, return response
  |       POST /v3/cursor   -> translate to pipeline batch, stream NDJSON
  |
  +-- AgentFS FUSE daemon (child process)
        agentfs mount --remote-url http://localhost:8080 volume /volume
        libsql::Builder::new_remote("http://localhost:8080", "")
        Mounts /volume as FUSE filesystem
        Every POSIX op = SQL query over HTTP -> bridge -> TCP -> DO -> SQLite
```

## API

All endpoints require `?volume=<name>` to identify the target volume.

### Filesystem (direct DO access, no Container needed)

```
POST /fs/write?volume=V&path=/file.txt    Body: raw file content
GET  /fs/read?volume=V&path=/file.txt     Returns: raw file content
GET  /fs/ls?volume=V&path=/               Returns: ["file.txt", "subdir"]
```

These use the AgentFS TypeScript SDK against `ctx.storage.sql` directly. No Container is started.

### Container exec (FUSE mount)

```
POST /exec?volume=V    Body: {"command": "python3 main.py"}
                       Returns: {"exitCode": 0, "stdout": "...", "stderr": "..."}
```

The first exec to a volume triggers Container startup + bridge setup + FUSE mount (~30s cold start). Subsequent calls reuse the warm Container (~2s). Commands execute with `cwd=/volume`, the FUSE mount point.

### KV store

```
POST /kv/set?volume=V&key=K    Body: value string
GET  /kv/get?volume=V&key=K    Returns: value string (404 if not found)
```

### Volume management

```
POST /destroy?volume=V    Kill the Container. Volume data persists in DO SQLite.
GET  /db-info?volume=V    Returns: {"fs_inode": 5, "fs_data": 12, "kv_store": 2, ...}
```

## Deployment

### Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) 4.x
- Docker (for Container image builds and agentfs cross-compilation)
- Cloudflare account with [Containers](https://developers.cloudflare.com/containers/) enabled

### 1. Build the AgentFS binary

The forked AgentFS binary must be cross-compiled for linux/amd64:

```bash
./container/scripts/build-agentfs.sh
```

This runs `cargo build --release` inside a Docker container with the Rust toolchain. Takes ~5 minutes on first build (cached afterward). Output: `container/bin/agentfs`.

### 2. Deploy

```bash
cd worker
export CLOUDFLARE_ACCOUNT_ID=your-account-id
export CLOUDFLARE_API_TOKEN=your-api-token
npx wrangler deploy
```

Wrangler builds the Container image from `container/Dockerfile`, pushes it to Cloudflare's registry, and deploys the Worker + Durable Object.

### 3. Verify

```bash
# Write a file
curl -X POST "https://your-worker.workers.dev/fs/write?volume=test&path=/hello.txt" -d "hello world"

# Read it back
curl "https://your-worker.workers.dev/fs/read?volume=test&path=/hello.txt"

# Run a command inside the FUSE mount
curl -X POST "https://your-worker.workers.dev/exec?volume=test" \
  -H "Content-Type: application/json" \
  -d '{"command":"cat /volume/hello.txt"}'
```

## Testing

### Unit tests (43 tests)

```bash
cd worker && npm test
```

Covers: Hrana pipeline protocol serialization, schema initialization, statement filtering (PRAGMAs, transaction control, PRAGMA table_info simulation), batch execution with conditions, cursor translation, all value types.

### End-to-end tests

```bash
DOFS_URL=https://your-worker.workers.dev ./e2e/test.sh
```

Tests the full flow: DO write → FUSE read, FUSE write → DO read, git inside FUSE, persistence across Container destruction.

## Project structure

```
dofs/
  worker/                      Cloudflare Worker + Durable Object
    src/
      index.ts                 DO class, HTTP routing, Container lifecycle
      hrana-server.ts           Hrana pipeline server with statement filtering
      hrana-protocol.ts         Protocol types and TCP frame serialization
      schema.ts                 AgentFS DDL for DO SQLite initialization
    test/                      43 Vitest unit tests
    wrangler.jsonc             Cloudflare deployment config
  container/                   Container image (runs in Firecracker VM)
    src/
      command-server.ts        /setup, /mount, /exec, /health endpoints
      bridge.ts                HTTP-to-TCP bridge (pipeline + cursor APIs)
    bin/                       Pre-built agentfs binary (gitignored)
    scripts/
      build-agentfs.sh         Cross-compile agentfs for linux/amd64
    Dockerfile
  e2e/
    test.sh                    End-to-end test script
  docs/
    IMPLEMENTATION_PLAN.md     Original 12-step implementation plan
```

## License

MIT
