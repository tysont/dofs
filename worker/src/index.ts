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

  private fs: AgentFS;

  // Track the active Hrana serve promise so we don't open multiple TCP connections
  private activeServePromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initSchema(this.ctx.storage.sql);
    });
    this.fs = AgentFS.create(this.ctx.storage as unknown as CloudflareStorage);
  }

  override onStart() {
    console.log('Container started');
  }

  override onStop() {
    console.log('Container stopped');
    this.activeServePromise = null;
  }

  override onError(error: unknown) {
    console.error('Container error:', error);
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /** Execute a shell command in the Container against the FUSE-mounted filesystem. */
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
      const row = this.ctx.storage.sql
        .exec<{ count: number }>(`SELECT count(*) as count FROM ${table}`)
        .one();
      result[table] = row.count;
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

  /** Start the Container with FUSE mount and Hrana bridge if not already running. */
  private async ensureContainer(): Promise<void> {
    this.entrypoint = ['bash', 'scripts/fuse-mount.sh'];
    await this.startAndWaitForPorts({ ports: [9000, 4000] });

    if (!this.activeServePromise) {
      const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
      await socket.opened;

      const server = new HranaServer({
        readable: socket.readable,
        writable: socket.writable,
        sql: wrapSqlStorage(this.ctx.storage.sql),
      });

      this.activeServePromise = server.serve().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP routing
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // -- Container commands --

      if (url.pathname === '/exec' && request.method === 'POST') {
        const body = (await request.json()) as { command: string };
        return Response.json(await this.exec(body.command));
      }

      if (url.pathname === '/destroy' && request.method === 'POST') {
        await this.destroyContainer();
        return new Response('ok');
      }

      // -- Filesystem (direct DO access, no Container) --

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

      // -- KV store --

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

      // -- Volume info --

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
