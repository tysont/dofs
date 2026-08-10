# AiryFS

AiryFS gives every application, agent, user, or task its own isolated POSIX-style filesystem built on [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/). Each volume lives entirely inside one Durable Object's SQLite database — that database is the *only* durable copy of the data. Ordinary file operations run directly in the Durable Object with no other compute involved. When a workload needs Git, Python, a compiler, or any other native Linux tool, AiryFS attaches an on-demand [Container](https://developers.cloudflare.com/containers/) and exposes the same SQLite rows at `/volume` through FUSE.

The Container is a disposable client of the volume, never its owner. There is no second durable copy to synchronize, no object store behind the mount, and no clone-back step when compute goes away. Losing the Container means a remount, not data recovery.

```
   HTTP clients, TypeScript SDK, CLI        Workers holding a DO stub
                  |                                   |
                  v                                   |
            Worker router                             |
                  |                                   |
                  +----------------+------------------+
                                   v
                        AiryFS Durable Object
                    owns the volume in its SQLite DB
                       |                      |
          file operations                    exec
          answered here against              starts the Container
          ctx.storage.sql,                   and sends it the command
          no Container involved                       |
                                                      v
                                             Attached Container
                                          runs the command in /volume,
                                          a FUSE mount whose syscalls
                                          become SQL sent back to the
                                          Durable Object's database
```

Once a FUSE write commits, the direct API sees it immediately. Direct-path changes reach mounted FUSE clients asynchronously through journal-driven cache invalidation, with bounded cache TTLs as a fallback.

## Table of contents

- [Why AiryFS](#why-airyfs)
- [How it compares](#how-it-compares)
- [Quick start](#quick-start)
  - [Deploy](#deploy)
  - [Inside a Durable Object](#inside-a-durable-object)
  - [HTTP API](#http-api)
  - [Workers RPC](#workers-rpc)
  - [TypeScript SDK](#typescript-sdk)
  - [CLI](#cli)
- [What you can do](#what-you-can-do)
- [Capabilities at a glance](#capabilities-at-a-glance)
- [Architecture](#architecture)
  - [The direct path](#the-direct-path)
  - [The execution path](#the-execution-path)
  - [Anatomy of a FUSE read](#anatomy-of-a-fuse-read)
  - [The Hrana subset](#the-hrana-subset)
  - [Bridge reliability](#bridge-reliability)
  - [Relationship to AgentFS](#relationship-to-agentfs)
  - [On-disk schema](#on-disk-schema)
- [Mounts](#mounts)
  - [How routing works](#how-routing-works)
  - [Boundary semantics](#boundary-semantics)
  - [What mounts are not](#what-mounts-are-not)
- [Performance model](#performance-model)
- [Consistency and durability semantics](#consistency-and-durability-semantics)
- [Security](#security)
- [Publishing and sharing](#publishing-and-sharing)
- [Interoperability](#interoperability)
- [Operations](#operations)
- [Limits](#limits)
- [Development](#development)
- [Repository layout](#repository-layout)
- [License](#license)

## Why AiryFS

Most systems that combine "files" with "compute at the edge" pick one of two owners: either compute owns the disk and storage is a sync target, or object storage owns the bytes and a FUSE layer fakes the filesystem on top. AiryFS rejects both. The Durable Object is authoritative; everything else — HTTP clients, SDK callers, CLI sessions, and the Container itself — is a client of the same SQLite tables.

That single decision buys several properties at once:

- **One authoritative namespace.** Directories, hard links, symlinks, metadata, and atomic path mutations are SQLite transactions in one place, not a consistency protocol between systems.
- **Compute scales to zero without losing anything.** The Container sleeps after 30 minutes of inactivity and its charges stop. Direct reads, writes, listings, published sites, and share links keep working because none of them need it.
- **Immediate cross-path visibility for writes that matter.** A committed FUSE write is instantly readable through the direct API — they are the same rows.
- **A small operational footprint.** One Durable Object per volume. No external storage service, no sync daemon, no garbage-collection job for orphaned workspaces. When one volume isn't enough, [mounts](#mounts) compose several under one namespace.

## How it compares

**A filesystem library over SQLite (such as AgentFS on its own).** A library that maps filesystem calls onto `ctx.storage.sql` gives fast reads and writes, but only from code running inside the Durable Object. A process in a Container cannot `open`, `stat`, or `readdir` those rows because nothing exposes them as a real filesystem. AiryFS uses exactly such a library for its direct path and adds what the library cannot: the Container lifecycle, remote SQL transport, and FUSE mount that present the same rows at `/volume`. Direct access still runs inside the Durable Object, so ordinary operations never pay for the mount.

**A Container workspace synced to storage.** A Container-local disk is convenient for execution, but it makes compute the gateway to the files. Reading one file or serving one artifact requires a running Container, and persistence usually means an external volume, object store, or clone-and-sync process — which raises its own questions about upload completion, write visibility, partial synchronization, and recovery after compute disappears. AiryFS keeps the Durable Object authoritative and treats the Container as replaceable.

**Object-storage FUSE layers.** An s3fs-, JuiceFS-, or R2-backed filesystem makes object storage another persistent system and needs a separate model for directories, links, metadata, and atomic path mutations. AiryFS uses SQLite transactions, indexes, and AgentFS's inode/dentry model inside the same Durable Object that coordinates the namespace.

**Remote development environments.** A dev environment starts with a machine and treats its disk as the workspace, so direct edge access and compute-independent persistence become secondary concerns. AiryFS starts with durable storage and attaches compute only when a command needs it.

## Quick start

Volumes are created on first use, or explicitly with a chosen chunk size. All interfaces below operate on the same persistent volume; the examples use a volume named `myproject`.

### Deploy

Requirements: Wrangler 4.x, Node.js 22+, Docker, and a Cloudflare account with Containers enabled at instance type `standard-1` or larger (see [Limits](#limits)).

```sh
git clone https://github.com/tysont/airyfs && cd airyfs
./agentfs/build.sh                            # verify patches, run tests, build the Linux agentfs binary

export CLOUDFLARE_API_TOKEN=your-api-token    # plus CLOUDFLARE_ACCOUNT_ID or .dev.vars

./install.sh                                  # builds the SDK and CLI, links `airyfs` and the `airy` alias
airy deploy int --allow-dirty                 # deploy, set AIRYFS_AUTH_SECRET, create a local session
airy init int --volume myproject --password   # or: deploy, create a session, and secure a volume in one step
```

`airy deploy` publishes the Worker, generates and installs `AIRYFS_AUTH_SECRET`, discovers the `workers.dev` URL, and creates a local session holding the root credential. `airy init` additionally creates a volume, sets a volume password, and downgrades the session to a scoped token. Each deploy generates a fresh root secret, invalidating prior root credentials, capabilities, and S3 credentials. Both commands run from inside the repository because they build the Worker and Container from source.

The checked-in Wrangler configuration defines isolated `int` and `prod` environments, plus `airyfs-local` for `npm run dev` with state under `.airyfs/local`. Production deploys require a clean tree and an explicit `--allow-prod` guard; use the package scripts rather than raw Wrangler so the clean-tree, account-consistency, locking, and Docker-credential safeguards apply.

### Inside a Durable Object

The `AiryFS` class lazily creates an AgentFS filesystem backed by `ctx.storage.sql`. Add methods to the class to combine coordinated direct file access with real Container execution — without copying data between them:

```ts
async runPython(source: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}> {
  // Direct path: a coordinated write to Durable Object SQLite, no Container.
  await this.writeFile('/main.py', source);
  const input = await this.statPath('/main.py');
  if (input.type !== 'file') throw new Error('Expected /main.py');

  // Execution path: mount the same tables and run a real process.
  const result = await this.exec('python3 main.py > output.txt');
  if (result.exitCode !== 0) throw new Error(result.stderr);

  // Direct path again: read the Container's output without another exec.
  return { ...result, output: await this.readFile('/output.txt') };
}
```

The built-in AiryFS wrappers already coordinate access and append mutation-journal entries. Custom methods that call the underlying AgentFS instance directly must guard overlapping content access with `VolumeAccessCoordinator` and must record direct mutations so mounted FUSE clients invalidate stale cache entries.

The underlying AgentFS interface includes `readFile`, `writeFile`, `readdir`, `readdirPlus`, `stat`, `lstat`, `mkdir`, `rm`, `rename`, `copyFile`, `symlink`, `readlink`, `access`, `statfs`, and random-access handles through `open` (handles support operations like `truncate(size)`). AiryFS adds coordinated direct primitives for timestamps, permissions, true hard links, bounded append, and subtree usage where the TypeScript AgentFS interface has no equivalent.

### HTTP API

The resource-oriented HTTP API supports binary streaming, metadata, path mutations, execution, and diagnostics. Ordinary file operations never start the Container.

```sh
BASE=https://your-worker.workers.dev
VOLUME=myproject

# Create the volume and a source directory.
curl -X PUT "$BASE/v1/volumes/$VOLUME" \
  -H "Content-Type: application/json" \
  -d '{"chunkSize":262144}'
curl -X PUT "$BASE/v1/volumes/$VOLUME/directories/src"

# Stream a file directly into Durable Object SQLite, then read it back.
curl -X PUT "$BASE/v1/volumes/$VOLUME/files/src/main.py" \
  --data-binary 'print("hello from AiryFS")'
curl "$BASE/v1/volumes/$VOLUME/files/src/main.py"

# Run a real process against the same file and inspect runtime health.
curl -X POST "$BASE/v1/volumes/$VOLUME/exec" \
  -H "Content-Type: application/json" \
  -d '{"command":"python3 src/main.py"}'
curl "$BASE/v1/volumes/$VOLUME/usage"
```

File writes do not create missing parent directories — create the directory first or the write returns `ENOENT`. A `PUT` replaces the whole file; a `PATCH` with a `Content-Range: bytes <start>-<end>/*` header (or an `?offset=` query parameter) writes bytes in place starting at that offset, extending the file when the write runs past its end and returning the number of bytes written in `X-AiryFS-Bytes-Written`. This lets a client edit part of a large file without materializing the whole thing.

File responses carry `Content-Length`, `Accept-Ranges`, `ETag`, `Last-Modified`, and `X-AiryFS-Inode`; reads honor `If-None-Match`, `If-Modified-Since`, single byte `Range`, and `If-Range` with correct 304/206/200 semantics. Errors are structured JSON with stable POSIX-style codes mapped to HTTP statuses (`ENOENT` → 404, `EEXIST`/`ENOTEMPTY` → 409, `EINVAL` → 400, `EPERM` → 403, `ENOSPC` → 507).

Buffered and streaming exec accept an optional base64 `stdin` field alongside `command`; the bytes are fed to the process on its standard input, which is then closed so readers observe EOF instead of blocking until the command deadline.

The full v1 surface covers volume lifecycle (`PUT` to create, `DELETE` to permanently delete), files (whole-file `PUT` and in-place ranged `PATCH`), directories (including recursive `mkdir -p` and `cp -r`), path operations (rename, copy, symlink, hard link, truncate, touch, chmod, append, checksum, du), typed text operations (line reads, regex replace, line/word/byte stats, JSONPath queries), tree archives, exec (buffered and streaming NDJSON, with optional stdin), resumable checksummed uploads, browser uploads, content-addressed assets, snapshots and forks, [mounts](#mounts), scoped application SQL, durable jobs and logs, schedules, change feeds, webhooks, search, quotas, auth and capabilities, sites and shares, usage, usage history, and Prometheus metrics.

### Workers RPC

A Worker holding a compatible namespace binding calls the same Durable Object without an HTTP serialization layer:

```ts
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const volume = getContainer<AiryFS>(env.AiryFS, 'myproject');

    await volume.writeFile('/message.txt', 'hello from RPC');
    const message = await volume.readFile('/message.txt');
    const result = await volume.exec('wc -c message.txt');

    return Response.json({ message, result });
  },
};
```

String methods are convenient for small text; `readFileStream` / `writeFileStream` provide binary streaming, and the metadata, mutation, tree, upload, snapshot, mount, job, change-feed, usage, and lifecycle methods expose the rest of the surface.

### TypeScript SDK

`airyfs-sdk` is dependency-free and uses web-standard `fetch`, streams, `Blob`, and Web Crypto. It runs in Node.js 22+, modern browsers, and Workers.

```ts
import {
  AiryFSClient,
  AiryFSCommandOutcomeUnknownError,
  waitForJob,
  watchChanges,
} from 'airyfs-sdk';

const client = new AiryFSClient(
  'https://your-worker.workers.dev',
  'myproject',
  { token: process.env.AIRYFS_TOKEN },
);

await client.makeDirectory('/src');
await client.writeFile('/src/main.ts', 'console.log("hello")\n');

// exec is durable by default. Reuse the key with the same command to recover
// the existing command and replay its persisted output after a client failure.
try {
  const result = await client.exec('node src/main.ts', {
    idempotencyKey: 'build-main-v1',
  });
  console.log(result.commandId, result.stdout);
} catch (error) {
  if (error instanceof AiryFSCommandOutcomeUnknownError) {
    console.error('Inspect durable command', error.commandId);
  }
  throw error;
}

// Durable jobs with followed logs.
const submitted = await client.submitJob('node src/main.ts', '/');
await waitForJob(client, submitted.id, {
  onLog(entry) {
    const bytes = Uint8Array.from(atob(entry.data), c => c.charCodeAt(0));
    console.log(new TextDecoder().decode(bytes));
  },
});

// Ordered change feed under a path prefix.
const current = await client.getChanges({ path: '/src', since: 'latest' });
const controller = new AbortController();
const changes = watchChanges(client, {
  path: '/src',
  since: current.cursor,
  signal: controller.signal,
})[Symbol.asyncIterator]();
const next = changes.next();
await client.writeFile('/src/observed.txt', 'watch this');
const { value: change } = await next;
if (change) console.log(change.type, change.oldPath, change.path);
controller.abort();
```

The client exposes files (whole-file writes and in-place ranged writes via `writeFileRange`), directories (`makeDirectory(path, recursive?)`, unified `remove`), metadata, timestamps, permissions, symbolic and hard links, bounded append, subtree usage, recursive `copy`, typed text operations (`readLines`, `replaceText`, `lineStats`, `jsonQuery`), tree archives, buffered and streaming exec (transient variants accept optional stdin), resumable upload primitives, checksums, durable jobs and logs, snapshots, mounts (`listMounts`/`createMount`/`deleteMount`), change feeds, auth and capabilities, usage, diagnostics, lifecycle, KV state, and scoped application SQL. High-level helpers manage long-poll cursors, job output, exec IDs, and resumable `Blob` uploads.

### CLI

The CLI (Node.js 22+) combines the HTTP filesystem API and Container execution behind named local sessions:

```sh
airy session create work \
  --endpoint https://your-worker.workers.dev \
  --volume myproject
airy volume create --chunk-size 256k

airy mkdir -p /src
airy upload /tmp/main.py /src/main.py
airy upload -r ./project /project --replace
airy cd /src && airy cat main.py

airy warm                                       # pre-start the Container and mount
airy exec --idempotency-key build-main-v1 python3 main.py
airy job submit --wait python3 main.py
airy snapshot create before-refactor --note "known good"
airy sql 'SELECT body FROM app_notes WHERE id = ?' --arg 1
airy watch /src
airy shell
```

A session stores an endpoint, volume, bearer token, and remote working directory under `~/.airyfs`; `--session` and `AIRYFS_SESSION` let separate terminals or scripts pin different sessions. Portable session exports include the bearer token — treat them as credentials.

The command surface spans navigation, inspection, mutation, resumable and transactional transfers, trash/undo/snapshot recovery, durable and interactive (`--pty`) execution, jobs, schedules, watches, webhooks, preview services, find/glob/grep/sql/kv, typed text operations (`lines`, `replace`, `stats`, `json`), publishing (`site`, `share`, `asset`, `browser-upload`), volume operations (`volume create/info/list/fork/quota`, and `volume delete` to permanently remove a volume), mounts (`mount create /data --target big-2 --create`, `mount list`, `mount rm`), and auth. Global options: `--session`, `--json`, `--no-color`, `--quiet`.

**Durable exec by default.** CLI `exec` persists one command ID before execution, retries transient submission and polling failures without changing the idempotency key, replays paginated output from durable logs, and never automatically replays an admitted command whose outcome is ambiguous. Reusing an idempotency key with a different command or working directory returns `409 IDEMPOTENCY_CONFLICT`. `--no-wait` selects the lower-level transient route and fails fast with `EXEC_BUSY` when the single execution slot is held. `--stdin-file <path>` feeds a local file (or `-` for the process's own stdin) to the command on standard input, running through the transient route that carries stdin. The CLI also recognizes exact read-only argv (`cat`, `ls`, `pwd`, `readlink` with safe relative paths) and serves them straight from the Durable Object without a Container; `--container` disables that fast path. `write --offset <bytes>` patches stdin into an existing file at a byte offset instead of replacing it.

## What you can do

Each volume is a real filesystem living in one Durable Object, with a Container attached that runs ordinary Linux programs against the same bytes. Files move over the direct HTTP, SDK, and CLI path with no compute; programs, jobs, and services start only when you ask for them. Every clip below is a real recording against a live deployment, sourced from a one-liner in [`demos/scripts/`](demos/scripts/).

**Run code against your files in the cloud.** Give each user, project, or task an isolated filesystem, write to it over HTTP, and immediately run a program against those files. The bytes you write through the direct API are the same bytes a compiler, Git, or interpreter sees at `/volume`.

![Create a volume, write a file over HTTP, list it, then run wc against it in the cloud](demos/gifs/01-filesystem-and-run.gif)

Normal Linux tooling works unmodified against the mounted volume, with directories, links, POSIX metadata, and quotas underneath.

![Run ls -la against the real filesystem mounted at /volume](demos/gifs/11-real-filesystem-in-container.gif)

Command output streams back live, and long or interactive runs stay attached over a PTY.

![Stream command output line by line from the container](demos/gifs/12-stream-command-output.gif)

**Automate durably.** Queue background jobs that keep running across retries and Container replacement, then read their logs when you come back.

![Submit a durable job and read its logs](demos/gifs/13-durable-jobs.gif)

Subscribe to an ordered change feed of filesystem events, or fan the same events out through signed webhooks and UTC cron schedules.

![Touch a file and watch it appear on the change feed](demos/gifs/22-change-feed.gif)

Expose a long-lived process on a public URL for previews and demos.

![Create a public preview service and list it](demos/gifs/15-preview-service.gif)

When nothing is running, compute scales to zero and the direct APIs keep serving straight from Durable Object SQLite. Static sites with atomic deploy and rollback, immutable content-addressed assets, browser uploads, and expiring share links are served the same way, with no Container in the path.

![Destroy the container; a file still reads back straight from SQLite](demos/gifs/32-scale-to-zero.gif)

**Serve and share over the open web.** Publish a volume as a static website, with atomic deploy and rollback.

![Write an index.html and publish the volume as a static site](demos/gifs/07-static-site.gif)

Hand out an expiring public link to any file or folder.

![Create a public share link for a file](demos/gifs/08-public-share.gif)

Point any S3-compatible client at a volume as a path-style bucket.

![List a volume's objects with the aws S3 CLI](demos/gifs/09-s3-bucket.gif)

Or open the same volume in Finder, or any WebDAV client.

![Probe the WebDAV endpoint and see the supported methods](demos/gifs/10-webdav.gif)

**Move data in and out.** Patch huge files in place with random-access ranged writes, next to resumable checksummed uploads and conditional range reads.

![Write a file, then patch five bytes in place at an offset](demos/gifs/03-ranged-write.gif)

Import and export whole directory trees transactionally.

![Push a local directory tree into a volume, then print it](demos/gifs/28-tree-archives.gif)

**Compose and grow volumes.** Mount other volumes as subdirectories to grow past a single volume's limits; a write through the mountpoint lands in the target volume. See [Mounts](#mounts) for the full model.

![Mount another volume at /data and read a write back through it](demos/gifs/16-mount-volumes.gif)

Create and mount a fresh volume in a single command.

![Create and mount a new volume, then list the mounts](demos/gifs/17-create-and-mount.gif)

**Experiment safely.** Deletes go to a per-volume trash with restore and undo.

![Remove a file, undo the delete, and list it back](demos/gifs/20-safe-delete-undo.gif)

Snapshot a volume instantly, diff it, and restore just as fast.

![Snapshot a volume, change it, diff, then restore](demos/gifs/18-snapshot-restore.gif)

Fork a live volume into an independent point-in-time copy.

![Fork a live volume and read the same contents from the copy](demos/gifs/19-fork.gif)

AiryFS is not optimized for workloads dominated by thousands of sequential metadata operations through FUSE — see the [performance model](#performance-model).

## Capabilities at a glance

| Area | Capability |
|---|---|
| Persistent storage | Files, directories, links, POSIX metadata, and file chunks in Durable Object SQLite |
| Direct file access | Binary-safe streaming reads and writes without starting the Container |
| HTTP semantics | GET, HEAD, single byte ranges, content length, last-modified, inode headers, structured errors |
| File mutations | Atomic replacement, in-place ranged writes, append, delete, copy, rename, truncate, touch, chmod, true hard links |
| Directory operations | Create, list with metadata, remove, recursive remove, tree views, logical usage |
| Volume composition | Cross-volume mounts with path-plane routing, cycle rejection, structured degraded errors, per-mount health |
| Authentication | Optional root bearer auth, signed expiring capabilities scoped by volume/operation/path, per-volume passwords minting scoped tokens |
| Web hosting | Opt-in static sites, atomic deploy with rollback, immutable assets, browser uploads, expiring shares |
| Bulk transfer | Transactional streaming directory push/pull, resumable checksummed large-file transfer |
| Recovery | Trash, restore, undo, snapshots, diffs, clones, live volume forks |
| Automation | Ordered change feeds, path-filtered webhooks, UTC cron schedules, durable jobs, preview services |
| Search | Server-side filename FTS, glob, content grep, tree views, directory usage |
| Text operations | Typed line reads (head/tail/range), regex find/replace, line/word/byte counts, and JSONPath queries — computed in the Durable Object with no Container |
| Interoperability | WebDAV mounting and path-style S3-compatible access per volume |
| Workers RPC | Streams, metadata, mutations, trees, uploads, snapshots, mounts, jobs, changes, usage, lifecycle, exec |
| TypeScript SDK | Typed HTTP client plus change-watch, job-follow, exec-id, and resumable Blob helpers |
| CLI | Sessions, remote cwd, familiar file commands, transfers, snapshots, jobs, auth, hosting, JSON output, interactive shell |
| Container execution | Shell commands, live output, cancellation, PTY sessions, standard Linux tooling at `/volume` |
| Concurrency | Path-scoped direct locks, a volume-wide FUSE mutation lock, change triggers, journal-driven cache invalidation |
| Observability | Prometheus exposition plus bounded filesystem, quota, and SQLite usage history |
| Application SQL | Scoped single-statement SQLite over user-owned `app_*` tables and indexes |

## Architecture

Each volume is one instance of the `AiryFS` Durable Object class and one attached Container instance. Deployment-wide volume listing is the sole exception to single-object routing: a separate registry Durable Object records volume names on first use, because Durable Object namespaces cannot enumerate the names used to derive object IDs. The registry is never on the filesystem data path.

### The direct path

The direct path calls the AgentFS TypeScript Cloudflare adapter with the Durable Object's storage context. Its asynchronous filesystem methods execute SQL against `ctx.storage.sql` without crossing a network boundary or starting the Container.

Streaming writes stage into a temporary AgentFS path and rename over the destination only after the request body completes, making HTTP file replacement atomic. Streaming reads fetch file chunks incrementally and support a single HTTP byte range.

Higher-level work also runs here, in the Durable Object, with no Container: recursive `mkdir -p` and `cp -r`; filename FTS, glob, and content grep ([search](#interoperability)); tree views and directory usage; and a set of typed text operations — line-addressed reads (`head`/`tail`/`range`), bounded regex find/replace written back atomically, line/word/byte counts, and JSONPath queries via SQLite's JSON functions. These are AiryFS operations with JSON schemas, not shell commands, so the two execution tiers are distinct: **typed operations on the direct path (milliseconds, no Container) and a real Linux shell on the execution path when a workload needs one.** Reach for the Container when a task needs arbitrary binaries or composition; everything above stays on the direct path.

### The execution path

The first `exec` on a volume performs four steps:

1. Start the attached Container and wait for its command server.
2. Start the in-process HTTP-to-TCP bridge inside the Container.
3. Open data and invalidation TCP connections from the Durable Object and start a Hrana server on each. (Hrana is libSQL's remote SQL protocol; AiryFS implements the subset AgentFS needs.)
4. Start the AgentFS FUSE daemon and wait until `/volume` is mounted.

```
                Attached Container
  command execution in /volume (FUSE mount)
                     |
          AgentFS libSQL client
    HTTP :8080 (data)   HTTP :8081 (invalidation)
                     |
            HTTP-to-TCP bridge
    TCP :9000 (data)    TCP :9001 (invalidation)
                     |
             framed TCP frames
                     |
        Durable Object Hrana servers
                     |
            ctx.storage.sql
   (the same tables the direct path uses)
```

Inside the Container, AgentFS connects with `libsql::Builder::new_remote("http://localhost:8080", "")`. A filesystem operation becomes a Hrana HTTP request to the bridge, which forwards a length-framed request over TCP to the Durable Object; the Durable Object executes the SQL against `ctx.storage.sql` and returns the result along the same path. The second channel carries mutation-journal polling so direct-path changes can invalidate FUSE kernel caches without competing with ordinary filesystem SQL.

The empty auth token on the mount is intentional: the bridge listeners are loopback-only inside the Container, and external authentication is enforced at the Worker API boundary. No SQLite database file is ever created in the Container — the image, process state, and everything outside `/volume` are ephemeral, and `/volume` is reconstructed from Durable Object SQLite on remount.

The Durable Object requests automatic Container sleep after 30 minutes of inactivity. Direct filesystem requests do not wake it; the next `exec` starts a fresh session and remounts the persistent volume. `POST /destroy` destroys only the Container — never the Durable Object or its data.

### Anatomy of a FUSE read

When a command runs `cat /volume/hello.txt`, the read crosses these layers:

1. **Linux and FUSE.** `cat` calls `open`, `stat`, and `read`; the kernel routes `/volume` requests to the AgentFS userspace daemon through `/dev/fuse`.
2. **AgentFS FUSE adapter.** The synchronous FUSE callback invokes the async AgentFS `FileSystem` implementation through its Tokio runtime.
3. **AgentFS filesystem layer.** A lookup or read becomes SQL against the AgentFS schema:

   ```sql
   SELECT d.ino, i.mode, i.nlink, i.uid, i.gid, i.size,
          i.atime, i.mtime, i.ctime, i.rdev
   FROM fs_dentry d
   JOIN fs_inode i ON d.ino = i.ino
   WHERE d.parent_ino = ? AND d.name = ?
   ```

4. **libSQL remote client.** Row-returning queries use `POST /v3/cursor`; other operations use `POST /v3/pipeline`.
5. **Container HTTP bridge.** Cursor requests are translated into pipeline batches so the Durable Object needs only one request format.
6. **Framed TCP transport.** The bridge serializes the pipeline JSON as a 4-byte big-endian length prefix plus UTF-8 JSON on port 9000.
7. **Durable Object Hrana server.** `FrameBuffer` accumulates arbitrary TCP chunks and drains complete frames; `HranaServer` processes each request sequentially.
8. **Durable Object SQLite.** Hrana tagged values become SQLite bindings; `ctx.storage.sql.exec()` runs against the same tables the direct path uses.
9. **Response transport.** Rows are converted back into Hrana values, framed, and resolved in FIFO order; cursor responses are emitted as newline-delimited entries; libSQL returns rows to AgentFS; AgentFS answers FUSE; the kernel returns bytes to `cat`.

File content follows the same path: `pread` selects rows from `fs_data` (BLOBs base64-encoded in Hrana), and writes reverse the flow with `INSERT`/`UPDATE`/`DELETE`. Once SQLite commits a FUSE write, the direct API can read it immediately.

### The Hrana subset

AiryFS implements the Hrana operations the AgentFS libSQL client actually uses — it is not a general-purpose libSQL server:

- `execute`, `batch` (with ordered steps and `ok`/`error`/`not`/`and`/`or`/`is_autocommit` conditions), `sequence`, `store_sql`/`close_sql`, `get_autocommit`, and `describe`.
- A mutating batch holds one volume-wide write lock from first step through last, so direct API mutations never observe an intermediate batch state.
- Values support null, integer, float, text, and BLOB. Integers outside JavaScript's safe range are rejected rather than silently rounded.
- `PRAGMA table_info` is answered through `pragma_table_info`; unsupported PRAGMA writes return empty compatibility results.
- Explicit transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`) is a compatibility no-op because Durable Object SQLite cannot hold a transaction open across separate Hrana requests. Batch locking prevents interleaving but does not provide cross-request rollback.

### Bridge reliability

TCP does not preserve message boundaries, and Containers are the least reliable component in the system, so the bridge is defensive by construction:

- **Bounded admission.** Each channel admits at most 16 requests with local IDs, serialized backpressured writes, and FIFO resolution. Every request has a 30-second response deadline and an 8 MiB frame limit.
- **Generation safety.** A write failure, timeout, oversized response, or socket error invalidates that connection generation, clears buffered bytes, and rejects pending requests. On reconnect, the retired generation stays isolated until its admitted requests drain or time out. Runtime generations also prevent a stale failure from destroying a replacement runtime.
- **Health enforcement.** Buffered execution probes a dedicated control endpoint; three failed probes quarantine and recycle the runtime. Streaming execution requires a heartbeat or output bytes every 15 seconds. Three infrastructure failures within two minutes open a 30-second circuit followed by one bounded half-open recovery attempt. Container recycling never touches Durable Object SQLite.
- **FUSE-path hygiene.** The command server enforces an invariant: no synchronous filesystem call on a FUSE path from its event loop, and spawned daemons get `cwd=/` with drained, non-FUSE stdio. A single violation of this rule once starved a guest-mount handshake and wedged the runtime. A permanent separate-process `/proc` watchdog captures the state of the command server and every daemon from outside, so a wedged runtime is diagnosable rather than a mystery.
- **Honest failure surfaces.** The bridge returns 503 with `Retry-After` when the TCP connection is absent or admission is full, and 502 for transport failures. A dead FUSE daemon produces a structured 503 rather than running a command in an unmounted directory. Commands whose admitted outcome cannot be proven enter a terminal `unknown` state and are never automatically replayed.

**Container sizing is a correctness issue, not a cost knob.** A July 2026 investigation reproduced intermittent buffered-exec hangs under sustained filesystem load and localized them below the Durable Object: the bridge stayed connected with no queued work while independent probes to both Container ports timed out. The dominant trigger is CPU starvation — the VM runs the Node command server, the in-process bridge, the FUSE daemon, and the user process at once, and on the `lite` tier (1/16 vCPU, 256 MiB) trivial FUSE-plus-hash commands took 9–12 seconds each while the shared event loop missed watchdog and proxy deadlines. AiryFS therefore requires `standard-1` (1/2 vCPU, 4 GiB) as the minimum instance type; the heartbeats, quarantine, unknown outcomes, and circuit breaker remain the safety net for genuine platform unreachability.

### Relationship to AgentFS

AgentFS is the embedded filesystem implementation AiryFS builds on. It defines the SQLite inode, dentry, file-chunk, symlink, overlay, key-value, and tool-call semantics. Its vendored TypeScript Cloudflare adapter runs in the Durable Object against `ctx.storage.sql`; its Rust SDK and CLI run inside the Container and expose the same database through FUSE.

AiryFS is not a replacement for AgentFS — it is the Cloudflare architecture around it. Named-volume routing, the HTTP and RPC surfaces, the SDK, the CLI, streaming and range handling, mutation coordination, schema migration, Container lifecycle management, the remote SQL bridge, the on-demand mount, and cross-volume mounts are all AiryFS.

AiryFS vendors pristine AgentFS v0.6.4 (commit `3a5ed2b8`) and applies an ordered patch series adding the direct remote libSQL connection, bounded FUSE caching, cross-runtime cache invalidation, and lease-aware open-inode behavior needed when Durable Object code and remote FUSE clients mutate one filesystem. Any change that can live in the Worker, bridge, or Container layers goes there instead, keeping the patch series a minimal compatibility surface. `agentfs/build.sh` materializes a fresh tree, verifies and applies each patch, runs both test suites, and builds the Linux CLI; see `docs/AGENTFS_PATCHES.md` for the patch inventory and refresh procedure.

### On-disk schema

AgentFS stores the filesystem as normalized SQLite tables: `fs_inode` (mode, ownership, size, link count, timestamps), `fs_dentry` (parent inode + name → child inode), `fs_data` (indexed content chunks), `fs_symlink`, `fs_config`, and overlay tables.

AiryFS adds durable state alongside them: `fs_mutation_journal` (direct-write records driving FUSE cache invalidation), `fs_open_inode` (expiring open-handle leases so a direct unlink retains a file a remote handle is still reading), `fs_mount` (the cross-volume mount table, deliberately outside the snapshotted filesystem), snapshot metadata and payload tables, `fs_upload` (resumable-upload state), `fs_job` and `fs_job_log` (durable execution and binary output), `fs_change_sequence` and `fs_change_feed` (an ordered, bounded mutation feed that doesn't perturb `last_insert_rowid()`), `fs_usage_sample`, `capability_revocations`, `kv_store`, and `tool_calls`.

Schema initialization is idempotent: the initializer recreates missing tables after an interrupted setup and runs supported migrations inside `transactionSync`. Arbitrary externally modified schemas are not repaired automatically.

Volumes default to 256 KiB chunks; explicit sizes must be powers of two from 4 KiB through 1 MiB, are immutable once filesystem data exists (`409 CHUNK_SIZE_IMMUTABLE`), and any filesystem request implicitly creates an unconfigured volume with the default.

## Mounts

A single volume is bounded by one Durable Object's SQLite storage. Mounts remove that ceiling for a *namespace*: graft another volume at a subdirectory, and everything under that path is served by the target volume's Durable Object.

```sh
# HTTP: graft volume big-2 at /data inside volume A, creating big-2 in the same request
curl -X PUT "$BASE/v1/volumes/A/mounts/data" \
  -H "Content-Type: application/json" \
  -d '{"target":"big-2","create":true}'

# CLI
airy mount create /data --target big-2 --create
airy mount list
airy mount rm /data
```

Reads and writes under `/data` are served by `big-2`; everything else stays in A. Each mounted volume keeps its own independent quota, snapshots, trash, and parallelism, so N volumes give roughly N volumes' worth of addressable space under one namespace. Without `create`, the target must already exist — mounting a non-existent (e.g. typo'd) target is refused with `MOUNT_TARGET_NOT_FOUND` rather than silently mounting an auto-instantiated empty volume that would swallow writes.

### How routing works

Routing happens on the path plane, never by rewriting SQL. Direct-path requests (HTTP, Workers RPC, SDK, CLI, S3, WebDAV) resolve the longest matching mountpoint in the host volume's mount table and forward the operation to the target volume's Durable Object, translating the path and carrying a scoped, revocable capability minted on the target. This plane is the primary interface and covers reads, writes, ranges, listings, checksums, appends, and streams under a mount. Forwarding costs one extra Durable Object hop — on the order of tens of milliseconds per operation (~60 ms observed on the integration environment for a small read) — which the streaming paths amortize over the transfer.

Inside exec (and jobs and scheduled runs), a mounted subtree appears through a nested agentfs FUSE mount grafted over its stub directory, so reads and writes see the target volume's data — writes land in the target. The guest volume's Hrana traffic is proxied through the host Durable Object to the target's SQLite, so it never leaves the deployment; each guest FUSE operation crosses container → host Durable Object → target Durable Object, carrying a per-operation hop comparable to the direct-path forward, which the streaming paths amortize.

Exec admission waits for every guest mount to become live before a command runs, so a command never sees a half-mounted subtree. If a mount cannot come up within its bound, the command fails with `MOUNT_TARGET_UNAVAILABLE` (retryable, `Retry-After`) rather than running against an empty stub, and the Container is left running so the retry finds the mount ready without a cold restart. With guest FUSE disabled (`GUEST_FUSE_ENABLED`), a mounted subtree inside the Container instead degrades to a read-only stub directory carrying an `AIRYFS-MOUNT-UNAVAILABLE.txt` marker — reads surface the marker, writes fail `EROFS` — never a silently writable shadow. Direct-path reads and writes are unaffected either way.

Degraded mounts are honest and observable. If a target is deleted or transiently fails, a forwarded operation returns the structured `MOUNT_TARGET_UNAVAILABLE` (503) rather than a raw 5xx or a false-empty listing, and mount health surfaces per mount in `/usage` and as the `airyfs_mount_healthy` gauge in `/metrics`. Mount creation walks the target's mount graph and every forwarded operation carries a bounded hop counter, so A→B→A loops and deep A→B→C chains are rejected.

### Boundary semantics

Boundaries follow POSIX:

- **Operations wholly inside one volume** — reads, writes, ranges, checksums, appends, streams — forward transparently.
- **Cross-boundary `rename` and hard `link` return `EXDEV`**, exactly as across Linux filesystems, so a client `mv` falls back to copy-and-delete.
- **A delete under a mountpoint forwards to the target** before any local trash move, so it lands in the target volume's trash and is undone there.
- **Snapshots, forks, trash, quotas, and site publishing are per-volume by design**: a host volume's snapshot captures its own filesystem, never the target's data. The mount table (`fs_mount`) lives outside the snapshotted filesystem, so a restore or site rollback preserves the mounts and re-establishes any stub directory the restored snapshot predates.
- **Fork and snapshot-clone deliberately do not carry the mount table.** They copy the source filesystem into a different volume, and a mount's stored credential is scoped to and held by the source; replaying it into a fork would silently create a second writer against the same target under the source's credential. A fork or clone materializes former mountpoints as plain empty directories, independent and writable in the new volume; re-mount explicitly if the copy should share the target.
- **Search, glob, tree, and change-feed run only against the host volume's own filesystem.** When their scope contains a mountpoint they do not descend into the target's data; rather than return a silently incomplete result, they set an `X-AiryFS-Truncated-At-Mounts` response header listing the omitted mountpoints. `du` reports the host subtree's own usage (a mountpoint counts as its stub); a `du` whose path falls under a mount forwards to the target and reports that subtree in full.
- **One known limitation:** a symbolic link in the host volume whose target points into a mounted subtree resolves correctly through FUSE (the kernel walks it) but not through the direct path, which does not yet do link-aware resolution before prefix matching.

### What mounts are not

Mounts expand storage by subtree, not by striping: a single file or a single hot directory still lives inside one volume. Growing one directory beyond a volume's capacity would require a truly sharded volume, which is a different primitive.

One residual on target-existence validation: a volume explicitly created before the registry existed and never written to has neither a registry name nor any directory entry, so it reads as absent and cannot be mounted. This is an empty set in practice; write to (or re-create) such a volume before mounting it.

## Performance model

The two paths have different cost profiles by design:

| Operation | Expected behavior |
|---|---|
| Direct read, write, or listing | Runs in the Durable Object without a Container |
| Direct operation under a mount | Adds one Durable-Object-to-Durable-Object hop (~60 ms observed for a small read) |
| First `exec` | Starts the Container, bridge, TCP session, and FUSE mount |
| Warm `exec` | Reuses the running Container and mounted volume, reattaches the request-scoped data channel |
| FUSE file operation | Adds a Container-to-DO round trip and SQL execution |
| Guest FUSE operation (under a mount) | Adds a further host-DO-to-target-DO hop |

Development measurements have typically shown direct file operations below 100 ms, warm exec in roughly 2–10 seconds, and a cold mount around 30 seconds. Metadata-heavy programs can be much slower because every FUSE syscall crosses the Container-to-Durable-Object boundary: an integration Git commit has taken more than two minutes, and a subsequent clean `git status` about 21 seconds. Deployment location, Container state, command behavior, and syscall count all matter.

Practical guidance:

- Use **direct writes** for ingestion, generated source trees, and bulk updates; use **direct reads** for inspection, API responses, and artifact retrieval.
- Use **`exec`** for computation that benefits from real Linux tools — not for creating large metadata-heavy trees one syscall at a time when the direct API can do it in bulk.
- Server-side **search never starts the Container**: filename lookup uses a transactionally maintained FTS5 trigram index, `glob` and `grep` traverse AgentFS directly (grep skips binaries and files over 10 MiB, scans at most 100 MiB per request), traversal caps at 100,000 entries, and results cap at 1,000.

**Billing.** Cloudflare bills SQLite-backed Durable Objects for requests, active duration, rows read/written, and stored data; a hibernation-eligible object stops duration charges but its stored data remains billable. After exec starts the Container, AiryFS keeps the outbound TCP bridge open through the warm-idle window; current platform behavior lets each active outbound connection pin the Durable Object for at most 15 minutes before the normal inactivity window resumes. Containers bill separately for provisioned memory/disk while running and for active CPU; AiryFS scales Container compute to zero after the 30-minute idle threshold while the volume stays available to direct APIs. See Cloudflare's Durable Objects and Containers pricing documentation for current rates.

## Consistency and durability semantics

AiryFS coordinates direct access and FUSE mutations, but it does not implement every POSIX or transactional guarantee. The precise contract:

- **Locking.** File-content reads, streaming reads, stat, directory listing, symlink resolution (RPC `readSymlink` and the HTTP `operations/readlink` endpoint), and direct mutations use fair path-scoped locks. FUSE writes take a volume-wide lock because Hrana SQL statements do not carry normalized filesystem paths. When in-container guest FUSE is enabled, a mount target serves each guest FUSE session through its own Hrana session; the volume-wide write lock lives in that target's Durable Object, so it serializes every session — host and guests — independently of the host volume.
- **Cross-path visibility.** FUSE-committed writes are immediately visible to the direct path. Direct-path mutations reach mounted FUSE clients asynchronously: bounded one-second entry/attribute caches, writeback caching disabled in bounded mode, and journal polling every 100 ms in batches of up to 256, with invalidations delivered on a transport channel independent of ordinary FUSE SQL.
- **Atomicity.** HTTP file replacement is atomic after upload completion. Directory archive imports stage the complete tree and publish under a write lock, rolling back on failed publication. Resumable uploads enforce sequential offsets, 1 MiB chunks, per-chunk SHA-256, and full-file SHA-256 before atomic publication. Snapshot create/diff/restore/delete/clone use whole-volume coordination; restore and clone replace the live namespace and recycle attached compute.
- **Open-inode leases.** A live remote FUSE handle pins its inode in `fs_open_inode`, so a direct unlink or streaming rename-over drops the pathname immediately but retains the inode and data until the handle closes or its 120-second lease expires. Heartbeats renew live handles and abort the mount if renewal fails, so a handle never outlasts its lease; stale leases from vanished mounts are reaped lazily. See `docs/OPEN_INODE_LEASES.md`.
- **Symlinks are create/inspect-only on the direct path.** `symlink`, `lstat`, and `readlink` create and report links, but the direct path does not *traverse* them: reading, `stat`, or `readdir` through a symlink does not follow it to the target. Symlinks resolve normally inside the Container (the kernel walks them over FUSE). There is therefore no follow-symlink `stat` on the direct path — `lstat` is the metadata operation.
- **Recovery.** Direct API and CLI deletes move paths into durable per-volume trash by default (`trash list/restore/purge`, `undo`); trashed content counts against quota until purged. Deletes through FUSE are permanent because that path exposes only opaque SQL — snapshot before destructive exec operations when recovery matters.
- **Change feed.** SQLite triggers on the inode and dentry tables observe both direct and FUSE writes; per-volume sequence numbers order create/modify/remove/rename events. The latest 10,000 sequence values are retained, and clients whose cursor predates that window receive `gap: true` and should resynchronize.
- **Integer bounds.** Hrana integer bindings are limited to JavaScript's safe integer range because Durable Object SQLite bindings do not accept `bigint`.

## Security

Authentication is opt-in: set `AIRYFS_AUTH_SECRET` to require `Authorization: Bearer ...` on HTTP requests. The configured value is the root administrative credential and the base secret from which each volume's capability signing key is derived via HKDF-SHA256 — a token minted for one volume cannot verify against another even under the same deployment secret. Leave it unset only for trusted local/test deployments.

**Capabilities.** Root callers and admin capabilities mint expiring capabilities restricted to one volume, a subset of `read`, `write`, `exec`, `sql`, and `admin`, and normalized path prefixes (admin grants are always volume-wide). Every request verifies signature, expiry, volume, operation, path scope, and revocation state. Revocation blocks subsequent requests but does not terminate already-admitted work. Direct `lstat`, `touch`, and `chmod` refuse to traverse symlinks so scoped capabilities cannot escape through a link target. Cross-volume mounts carry a scoped, revocable capability minted on the target at creation; revoking it degrades the mount to `MOUNT_TARGET_UNAVAILABLE` rather than granting stale access.

**Volume passwords.** Each volume can carry its own password, stored as a PBKDF2 verifier in the volume's SQLite. `POST /v1/volumes/V/auth/password` sets or rotates it; `POST /v1/volumes/V/auth/login` exchanges it for a volume-scoped `read,write,exec` capability without the root secret, so a volume can be secured at creation and accessed from multiple machines. The login endpoint has no built-in attempt throttling — use strong passwords and apply external rate limiting or WAF policy on internet-exposed deployments.

**Browser uploads.** `airy browser-upload /inbox/photo.jpg --expires 15m` mints a write-only capability restricted to that exact path. Browser code streams the raw `File` body with the bearer token — no multipart, no credentials in URLs, no Worker-side buffering. Revoke the capability ID when no longer needed.

**Boundaries worth stating plainly.** Authentication does not make arbitrary execution safe for mutually untrusted users sharing a volume: `exec` and durable jobs run shell commands with access to the complete mounted volume — including any mounted subtrees — so deployments still need their own identity, command-policy, and volume-isolation model. S3 access uses the deployment-wide root credential only (capabilities and volume passwords cannot authenticate S3). Deploy provisioning output includes the generated root credential — treat captured output as sensitive — and the Worker is briefly reachable unauthenticated between publish and secret installation.

## Publishing and sharing

A volume can serve content publicly without a bearer token. Public serving is opt-in per volume — nothing is exposed until a site is published or a share link is minted — and everything is served straight from Durable Object SQLite with no Container cold start.

```sh
airy upload -r ./dist /site
airy site publish /site --spa --cache "public, max-age=300"
# served at https://<endpoint>/s/<volume>/

airy site deploy ./dist        # transactional replacement; prints a rollback snapshot name
airy site rollback site-deploy-2026-07-18T12-00-00-000Z

airy share /reports/q3.pdf --expires 24h
# prints https://<endpoint>/d/<volume>/<id>
```

Sites get inferred content types, optional `Cache-Control`, `ETag`/`Last-Modified` validators, index-document resolution, optional generated directory listings (`--listing`), and SPA fallback. `site deploy` requires an existing publication so routing configuration cannot change during cutover; `site rollback` restores the named full-volume snapshot, so unrelated changes after that snapshot are also reverted (mounts are preserved — the mount table lives outside the snapshotted filesystem).

Content-addressed assets (`airy asset put ./bundle.wasm`) are hashed locally, verified independently by the server, published atomically, idempotent on re-upload, and served with `Cache-Control: public, max-age=31536000, immutable`.

Path-based URLs (`/s/<volume>/...`, `/d/<volume>/<id>`) work on any deployment including `workers.dev`. To serve sites on their own hostnames, set the `SITES_ZONE` Worker variable and add a wildcard route; `<volume>.sites.example.com` then serves that volume's published site, with arbitrary custom domains layerable through Cloudflare for SaaS.

Publishing exposes the selected subtree to anyone with the URL — prefer a dedicated public subtree, and never publish a volume that also holds private files outside the web root.

## Interoperability

**AI agents.** An AiryFS volume is a natural durable workspace for an agent: a coding harness's split between file operations and command execution maps directly onto AiryFS's [direct path](#the-direct-path) and [execution path](#the-execution-path), so the agent reads, writes, and lists for free on Durable Object SQLite and only wakes a Container when it needs a real shell. Keying the volume to the agent's instance id gives it durable files that persist across turns, restarts, and Container eviction — decoupled from the agent's own conversation state. Three integrations live in [`integrations/`](./integrations) and [`examples/`](./examples):

- **`@airyfs/flue-sandbox`** — a [Flue](https://flueframework.com) `SandboxApi` adapter over the SDK. The default choice for a Flue agent; talks to any AiryFS deployment over HTTP.
- **`@airyfs/agents-toolkit`** — AiryFS as [Agents SDK](https://developers.cloudflare.com/agents/) tools (read/write/list/bash, durable-job handoff, published artifacts) plus `runFiber`/`stash` durable-execution composition. Use it for agents built directly on the Agents SDK.
- **Workers RPC** — the Flue adapter over a cross-script Durable Object binding (`script_name`) rather than HTTP. Use it when the agent Worker and AiryFS share an account and you want DO-to-DO calls with no HTTP layer, without merging AiryFS into your Worker.

**S3.** Each volume is a path-style S3 bucket at `/s3/<volume>` supporting `HeadBucket`, `GetBucketLocation`, `ListObjectsV2`, and single-object `HeadObject`, `GetObject` (with ranges), `PutObject`, and `DeleteObject`. Keys map to unambiguous filesystem paths; `PutObject` creates missing parents; listings bound at 100,000 entries. Multipart uploads, object metadata, ACLs, versioning, batch deletion, presigned query auth, and `STREAMING-*` signatures are not implemented. Authenticated deployments use SigV4 with access key `airyfs` and `AIRYFS_AUTH_SECRET` as the secret:

```sh
AWS_ACCESS_KEY_ID=airyfs \
AWS_SECRET_ACCESS_KEY="$AIRYFS_AUTH_SECRET" \
aws --endpoint-url https://airyfs.example.workers.dev/s3 --region auto s3 ls s3://my-volume
```

**WebDAV.** Volumes mount at `/dav/<volume>/` (macOS Finder: Go → Connect to Server). The dependency-free adapter supports OPTIONS, finite PROPFIND, GET/HEAD, streaming PUT, MKCOL, recoverable DELETE, same-volume MOVE, bounded recursive COPY, ranges, validators, and Finder-compatible LOCK/UNLOCK. It advertises DAV classes 1 and 2 for client compatibility, but lock tokens are advisory shims — not persisted or enforced — and must not be used for concurrency control. Basic auth accepts the root credential, a capability token, or the volume password.

**Application SQL.** `POST /v1/volumes/V/sql` runs one statement against user-owned `app_*` tables and indexes in the volume Durable Object, without the Container. AiryFS/AgentFS/system objects, PRAGMAs, views, triggers, attached databases, CTEs, and multi-statement requests are rejected; results cap at 1,000 rows; the dedicated `sql` capability (or admin) is required.

**Legacy endpoints.** The original query-oriented routes (`/fs/write`, `/fs/read`, `/fs/ls`, `/exec`, `/destroy`, `/usage`, `/db-info`, `/perf`, `/kv/*`) remain available and share the same streaming, range, atomic-replacement, and coordination implementation as v1.

## Operations

- **Usage.** `GET /v1/volumes/V/usage` returns AgentFS logical statistics, physical SQLite size, Container/Hrana/bridge/FUSE state, per-mount health, and current-session Hrana counters. `GET /v1/volumes/V/usage-history` returns newest-first five-minute samples (latest 2,016 — seven days at continuous observation). Sampling is demand-driven: no perpetual alarms, no waking idle volumes, no writes on filesystem mutations or Prometheus scrapes.
- **Metrics.** `/v1/volumes/V/metrics` exposes per-volume Prometheus text: filesystem and quota gauges, physical SQLite size, Container/FUSE/Hrana health, the `airyfs_mount_healthy` gauge per mount, current-session Hrana counts, and bounded table row counts. Snapshots are cached five seconds; metrics never fan out through the registry or add writes to hot paths. Hrana counters are per-session in-memory values, not billing or lifetime metrics.
- **Quotas.** `airy volume quota --bytes 10g --inodes 100000` sets persistent logical-byte and inode limits, enforced by SQLite triggers for both direct HTTP writes and Container/FUSE writes at the shared filesystem boundary; rejected HTTP writes return `507 ENOSPC`.
- **Diagnostics.** `GET /db-info` returns per-table row counts; `GET /perf` returns Hrana session counters, active-operation and lock state, runtime generation, and exec-circuit state. `airy tail --follow` composes range reads with the change feed, so following a log file holds no Worker request and starts no Container.
- **Logging.** Bridge failures with admitted work emit `bridge_connection_failed`; 5xx Worker responses emit `request_failed` with bounded route labels, edge request ID, status, error code, and session identity. User-controlled paths, command bodies, raw error messages, and SQL text are never logged.
- **Preview services.** `airy service create web --public -- node server.js` persists a command definition in SQLite while the process stays disposable Container compute: `$PORT` is allocated from 5000–5015, enabled services restart lazily on the next proxy request after Container sleep or replacement, and public exposure at `/p/<volume>/web/` is opt-in. Service logs are ephemeral ring buffers with generation-aware `--follow`.

## Limits

- **10 GB per volume.** Cloudflare currently caps each SQLite-backed Durable Object at 10 GB. Files, snapshots, trash, upload staging, job logs, application tables, and AiryFS metadata all share that database, so usable file capacity is lower. [Mounts](#mounts) compose multiple volumes under one namespace, but each individual volume — and therefore any single file or directory — remains capped. See the [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) for the current platform figure.
- **Container minimum `standard-1`.** The checked-in `wrangler.jsonc` sets it on every environment; the smaller `lite` and `basic` tiers starve the shared runtime and surface commands as `unknown` (see [Bridge reliability](#bridge-reliability)). Raise the instance type through `standard-4` for heavier native workloads. The example config caps concurrent attached Containers at `max_instances: 50`; all volumes remain directly addressable regardless.
- **One execution slot per volume.** Buffered, streaming, durable, and PTY commands share it; durable submissions queue, transient execution fails fast with `EXEC_BUSY`.
- **Exec bounds.** Commands run with `cwd=/volume`, a 300-second process timeout inside a 310-second Worker-side deadline, a 10 MiB transient buffered response limit, and up to 50 MiB of paginated durable logs.
- **Deletion is permanent and irreversible.** `DELETE /v1/volumes/V` (SDK `deleteVolume`, CLI `volume delete`) destroys the Container and wipes all Durable Object storage; it requires root or an auth-disabled deployment and cannot be undone by trash or snapshots. `destroy` is different — it removes only the disposable Container and preserves volume data.
- **Not for metadata-storm workloads over FUSE.** Every syscall crosses the Container-to-DO boundary — use the direct API for bulk creation and transfer, then `exec` for the computation.

## Development

```sh
# Worker: Hrana framing/execution, transport bounds, schema migration, locking,
# streaming, archives, auth, snapshots, uploads, exec ownership, jobs, change
# feeds, leases, chunk boundaries, mounts, and HTTP error semantics.
cd worker && npm test && npm run typecheck

# Container: bridge admission, FIFO handling, cancellation, generation
# replacement, streaming exec events, process-group termination, slot coordination.
cd container && npm run build && npm test

# CLI: sessions, streaming/resumable transfer, snapshots, durable idempotent
# submission, unknown outcomes, watching, shell, completion (mock servers only).
cd cli && npm run typecheck && npm test && npm run build

# SDK: full HTTP contract, structured errors, NDJSON, job waiting, resumable Blobs.
cd sdk && npm test && npm run typecheck && npm run build
```

Deployed verification against a live endpoint:

```sh
AIRYFS_URL=https://your-worker.workers.dev ./e2e/test.sh
AIRYFS_URL=... npm run test:features:deployed      # feature smoke, including mount scenarios
AIRYFS_URL=... npm run test:regression:quick       # runtime, POSIX lifecycle, coherence
AIRYFS_URL=... npm run test:regression:broad       # binary I/O, native builds, restarts
AIRYFS_URL=... npm run test:prepush:deployed       # smoke + broad
```

The end-to-end flow covers direct-write-to-FUSE-read, mutation invalidation, FUSE-write-to-direct-read, Git on a mixed-access volume, open-handle leases surviving direct unlink and rename-over, persistence across Container destruction, and mount scenarios (creation and typo rejection, forwarded reads and writes, `EXDEV`, cycle and self-mount rejection, degraded targets, restore preserving mounts). Benchmarks (`npm run benchmark:deployed`, `npm run benchmark:chunks`) measure direct HTTP, FUSE amplification, metadata traversal, small files, and Git workloads; see `docs/PERFORMANCE_BENCHMARK.md` and `docs/CHUNK_SIZE_BENCHMARK.md`.

Verify the cross-compiled Linux binary before deployment:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD/container/bin/agentfs:/usr/local/bin/agentfs:ro" \
  debian:bookworm-slim agentfs --version
```

## Repository layout

```
airyfs/
  worker/
    src/
      index.ts                  DO class, routing, RPC, and Container lifecycle
      files-api.ts              Streaming resource API and access coordination
      hrana-server.ts           Hrana execution against Durable Object SQLite
      hrana-protocol.ts         Protocol types and frame serialization
      schema.ts                 AgentFS schema initialization and migrations
      auth.ts                   Root and scoped-capability authentication
      archive.ts                Streaming AiryFS tree archive protocol
      snapshots.ts              Full-volume capture, diff, restore, and export
      uploads.ts                Durable resumable upload sessions
      jobs.ts                   Durable queue, state machine, and persisted logs
      change-feed.ts            Trigger-driven ordered filesystem changes
      container-http-stream.ts  Unbuffered Container exec transport
      sse-stream.ts             Internal SSE to public NDJSON translation
    test/                       Vitest unit tests
    wrangler.jsonc              Worker, Container, and Durable Object config
  container/
    src/
      command-server.ts         Setup, mount, exec, and health endpoints
      bridge.ts                 HTTP/libSQL to framed TCP bridge
    Dockerfile
  agentfs/
    upstream/                   Pristine pinned AgentFS source
    patches/                    Ordered AiryFS compatibility patches
    build.sh                    Patch verification, tests, and Linux build
  cli/                          Typed API client, sessions, commands, and shell
  sdk/                          Universal typed client, DTOs, and async workflows
  integrations/                 Flue and Agents SDK adapters (file:-linked to sdk/)
  examples/                     Runnable agent samples for the integrations
  demos/                        Recorded CLI demos and the scripts that produce them
  e2e/                          Deployed end-to-end tests, smoke tests, benchmarks
  docs/                         Design and operational notes
  scripts/deploy.mjs            Guarded int/prod deployment
```

## License

MIT
