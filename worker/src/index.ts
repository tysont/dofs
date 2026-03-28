// ABOUTME: Worker entrypoint and DOFS Durable Object class.
// ABOUTME: Routes HTTP requests to named volumes, each backed by a DO with persistent SQLite.

import { Container, getContainer } from '@cloudflare/containers';
import { AgentFS, type CloudflareStorage } from 'agentfs-sdk/cloudflare';
import { initSchema, SCHEMA_TABLES } from './schema';
import { HranaServer, wrapSqlStorage } from './hrana-server';

interface Env {
  DOFS: DurableObjectNamespace<DOFS>;
}

export class DOFS extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  private fs!: AgentFS;
  private activeServePromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initSchema(this.ctx.storage.sql);
      this.fs = AgentFS.create(this.ctx.storage as unknown as CloudflareStorage);
    });
  }

  override onStop() {
    this.activeServePromise = null;
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /** Execute a shell command in the Container against the FUSE-mounted volume. */
  async exec(command: string): Promise<unknown> {
    await this.ensureContainer();

    const resp = await this.containerFetch(
      new Request('http://localhost/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      }),
      4000
    );

    return resp.json();
  }

  /** Read a file from the volume (direct DO access, no Container needed). */
  async readFile(path: string): Promise<string> {
    return this.fs.readFile(path, 'utf8');
  }

  /** Write a file to the volume (direct DO access, no Container needed). */
  async writeFile(path: string, content: string): Promise<void> {
    await this.fs.writeFile(path, content);
  }

  /** List a directory on the volume (direct DO access, no Container needed). */
  async listDir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  /** Get volume metadata: table row counts. */
  dbInfo(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const table of SCHEMA_TABLES) {
      try {
        const row = this.ctx.storage.sql
          .exec<{ count: number }>(`SELECT count(*) as count FROM ${table}`)
          .one();
        result[table] = row.count;
      } catch {
        // Table may not exist if AgentFS.create() hasn't run yet
      }
    }
    return result;
  }

  /** Destroy the Container. Volume data persists in DO SQLite. */
  async destroyContainer(): Promise<void> {
    await this.destroy();
    this.activeServePromise = null;
  }

  // ---------------------------------------------------------------------------
  // Container lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the Container and set up bridge + FUSE mount via HTTP calls.
   *
   * The DO drives the sequence:
   *   1. Container starts with command-server.js (port 4000)
   *   2. POST /setup → bridge starts in-process (ports 9000 + 8080)
   *   3. DO connects TCP to :9000, starts HranaServer
   *   4. POST /mount → agentfs FUSE daemon at /volume
   *
   * If the Hrana TCP connection drops (container eviction, crash),
   * activeServePromise resets to null so the next call reconnects.
   */
  private async ensureContainer(): Promise<void> {
    if (this.activeServePromise) return;

    this.entrypoint = ['node', '/app/dist/command-server.js'];

    // 1. Wait for command server
    await this.startAndWaitForPorts({ ports: [4000] });

    // 2. Start bridge in-process
    const setupResp = await this.containerFetch(
      new Request('http://localhost/setup', { method: 'POST' }),
      4000
    );
    const setupResult = (await setupResp.json()) as { ok: boolean; error?: string };
    if (!setupResult.ok) {
      throw new Error(`Bridge setup failed: ${setupResult.error}`);
    }

    // 3. Connect TCP to bridge, start Hrana server in background.
    // On TCP close or error, reset activeServePromise so the next
    // ensureContainer() call reconnects instead of returning early.
    const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
    await socket.opened;

    const server = new HranaServer({
      readable: socket.readable,
      writable: socket.writable,
      sql: wrapSqlStorage(this.ctx.storage.sql),
    });

    this.activeServePromise = server.serve().then(
      () => { this.activeServePromise = null; },
      () => { this.activeServePromise = null; }
    );

    // 4. Mount FUSE — fire-and-forget, then poll for readiness.
    // Can't await because the mount blocks while FUSE queries flow through serve().
    this.containerFetch(
      new Request('http://localhost/mount', { method: 'POST' }),
      4000
    ).catch(() => {
      // Mount request itself failing is not fatal — the health poll below
      // will detect whether the mount actually succeeded.
    });

    // Poll until FUSE is mounted or we give up. The health endpoint checks
    // mountpoint -q and reports fuseExitCode if the daemon crashed.
    let mounted = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const healthResp = await this.containerFetch('http://localhost/health', 4000);
        const health = (await healthResp.json()) as {
          fuseMounted?: boolean;
          fuseExitCode?: number | null;
        };
        if (health.fuseMounted) {
          mounted = true;
          break;
        }
        // If daemon exited, stop polling
        if (health.fuseExitCode !== null && health.fuseExitCode !== undefined) {
          throw new Error(`FUSE daemon exited with code ${health.fuseExitCode}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('FUSE daemon')) throw err;
        // Container not ready yet — keep polling
      }
    }

    if (!mounted) {
      throw new Error('FUSE mount did not complete within 30 seconds');
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP routing
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/exec' && request.method === 'POST') {
        const body = (await request.json()) as { command: string };
        return Response.json(await this.exec(body.command));
      }

      if (url.pathname === '/destroy' && request.method === 'POST') {
        await this.destroyContainer();
        return new Response('ok');
      }

      if (url.pathname === '/fs/write' && request.method === 'POST') {
        const path = url.searchParams.get('path');
        if (!path) return new Response('Missing ?path=', { status: 400 });
        await this.writeFile(path, await request.text());
        return new Response('ok');
      }

      if (url.pathname === '/fs/read') {
        const path = url.searchParams.get('path');
        if (!path) return new Response('Missing ?path=', { status: 400 });
        return new Response(await this.readFile(path));
      }

      if (url.pathname === '/fs/ls') {
        const path = url.searchParams.get('path') ?? '/';
        return Response.json(await this.listDir(path));
      }

      if (url.pathname === '/kv/set' && request.method === 'POST') {
        const key = url.searchParams.get('key');
        if (!key) return new Response('Missing ?key=', { status: 400 });
        const value = await request.text();
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO kv_store (key, value, created_at, updated_at) VALUES (?, ?, unixepoch(), unixepoch())",
          key,
          value
        );
        return new Response('ok');
      }

      if (url.pathname === '/kv/get') {
        const key = url.searchParams.get('key');
        if (!key) return new Response('Missing ?key=', { status: 400 });
        const rows = this.ctx.storage.sql
          .exec<{ value: string }>("SELECT value FROM kv_store WHERE key = ?", key)
          .toArray();
        if (rows.length === 0) return new Response('Not found', { status: 404 });
        return new Response(rows[0].value);
      }

      if (url.pathname === '/db-info') {
        return Response.json(this.dbInfo());
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return new Response(`Error: ${msg}`, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const volume = url.searchParams.get('volume');

    if (!volume) {
      return new Response('Missing ?volume= parameter', { status: 400 });
    }

    const stub = getContainer<DOFS>(env.DOFS, volume);
    return stub.fetch(request);
  },
};
