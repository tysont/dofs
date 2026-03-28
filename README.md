# DOFS

A POSIX filesystem backed by Cloudflare Durable Object SQLite, mountable via FUSE in Containers.

Each **volume** is a named, persistent filesystem unit: one Durable Object = one volume. Files written from the DO (via SDK) are visible inside the Container (via FUSE mount), and vice versa. Data persists across Container destruction -- the DO's SQLite database is the source of truth.

## Architecture

```
Client
  | POST /exec?volume=myvolume {"command": "python3 main.py"}
  v
Worker (HTTP entrypoint)
  | Routes to DO by volume name
  v
Durable Object (per-volume)
  |-- SQLite: AgentFS schema (fs_inode, fs_dentry, fs_data, ...)
  |-- AgentFS TS SDK: direct filesystem access (no Container needed)
  |     Used by: /fs/read, /fs/write, /fs/ls
  |
  |-- HranaServer: reads SQL requests from TCP, executes against
  |     ctx.storage.sql, writes responses back
  |
  +-- TCP to Container bridge (:9000)
        |
        | Length-prefixed JSON frames (Hrana pipeline protocol)
        |
        v
Container (node:22-slim + fuse3 + agentfs binary)
  |-- Bridge (in-process): HTTP on :8080
  |     /v3/pipeline -> forward over TCP to DO
  |     /v3/cursor -> translate to pipeline, stream NDJSON
  |     TCP :9000 accepts DO connection
  |
  |-- AgentFS FUSE daemon: mounts /volume
  |     libsql remote -> http://localhost:8080
  |     Every FUSE op = SQL query over the network
  |
  +-- Command server on :4000
        /setup -> start bridge
        /mount -> start FUSE daemon
        /exec  -> run shell commands (cwd=/volume)
        /health -> status
```

### Container startup sequence

The DO drives setup via HTTP:

1. Container starts with `node command-server.js` (port 4000)
2. `POST /setup` -- bridge starts in-process (ports 9000 + 8080)
3. DO connects TCP to :9000, starts HranaServer
4. `POST /mount` -- agentfs FUSE daemon at /volume
5. Poll `/health` until `fuseMounted: true`

## API

All endpoints require `?volume=<name>`.

### Filesystem (DO SDK, no Container)

```
POST /fs/write?volume=V&path=/file.txt    Body: file content
GET  /fs/read?volume=V&path=/file.txt     -> file content
GET  /fs/ls?volume=V&path=/               -> ["file.txt", "dir"]
```

### Container exec (FUSE mount)

```
POST /exec?volume=V    Body: {"command": "..."}
                       -> {"exitCode": 0, "stdout": "...", "stderr": "..."}
```

First exec triggers Container startup + FUSE mount (~30s cold start).

### KV store

```
POST /kv/set?volume=V&key=K    Body: value
GET  /kv/get?volume=V&key=K    -> value
```

### Management

```
POST /destroy?volume=V    Kill Container. Data persists in DO SQLite.
GET  /db-info?volume=V    -> {"fs_inode": 5, "fs_data": 3, ...}
```

## Deployment

### Prerequisites

- Wrangler 4.x
- Docker
- Cloudflare account with Containers enabled

### Build the AgentFS binary

```bash
./container/scripts/build-agentfs.sh
```

Cross-compiles the `tysont/agentfs` fork for linux/amd64 via Docker. Output: `container/bin/agentfs`.

### Deploy

```bash
cd worker
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
```

### Run tests

```bash
cd worker && npm test                                      # 43 unit tests
DOFS_URL=https://your-worker.workers.dev ./e2e/test.sh     # e2e tests
```

## Project structure

```
dofs/
  worker/
    src/index.ts           DO class, HTTP routing, Container lifecycle
    src/hrana-server.ts     Hrana pipeline server (SQL over TCP)
    src/hrana-protocol.ts   Protocol types and frame serialization
    src/schema.ts           AgentFS DDL for DO SQLite
    test/                   43 unit tests
  container/
    src/command-server.ts   /setup, /mount, /exec, /health endpoints
    src/bridge.ts           HTTP<->TCP bridge (pipeline + cursor)
    bin/                    Pre-built agentfs binary (gitignored)
    scripts/build-agentfs.sh
  e2e/test.sh              End-to-end test script
```

## AgentFS fork

Depends on `tysont/agentfs`, a fork of `tursodatabase/agentfs`:

1. **turso -> libsql**: Replaces proprietary Turso SDK with open-source libsql. Enables `Builder::new_remote()` for pure network connections.
2. **PRAGMA fix**: Uses `execute()` instead of `execute_batch()` for PRAGMAs (libsql parser rejects `PRAGMA name = value` in batch mode).

These enable `agentfs mount --remote-url http://host:port` with no local file.

## How it works

Filesystem data lives in DO SQLite using the [AgentFS schema](https://github.com/tursodatabase/agentfs/blob/main/SPEC.md). The FUSE daemon translates POSIX operations into SQL queries that flow:

```
FUSE op -> libsql -> POST /v3/pipeline -> bridge -> TCP -> DO HranaServer -> ctx.storage.sql
```

DO SQLite has restrictions (no PRAGMAs, no explicit transactions). The Hrana server filters these and simulates `PRAGMA table_info` by parsing DDL from `sqlite_master`.
