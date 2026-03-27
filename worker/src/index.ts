// ABOUTME: Worker entrypoint and DOFS Durable Object class.
// ABOUTME: Routes HTTP requests to per-agent DOs that communicate with Containers via raw TCP.

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

  private agentFs: AgentFS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initSchema(this.ctx.storage.sql);
    });
    this.agentFs = AgentFS.create(this.ctx.storage as unknown as CloudflareStorage);
  }

  override onStart() {
    console.log('Container started');
  }

  override onStop() {
    console.log('Container stopped');
  }

  override onError(error: unknown) {
    console.error('Container error:', error);
  }

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

  /**
   * Start the Container with the Hrana test client, connect raw TCP,
   * run HranaServer on the stream, then fetch results from the Container.
   */
  async hranaTest(): Promise<unknown> {
    this.entrypoint = ['node', 'dist/hrana-test-client.js'];
    await this.startAndWaitForPorts({ ports: [9000, 8080] });

    // Connect raw TCP to Container port 9000
    const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
    await socket.opened;

    // Run the Hrana server on the TCP stream — serves SQL until client disconnects
    const server = new HranaServer({
      readable: socket.readable,
      writable: socket.writable,
      sql: wrapSqlStorage(this.ctx.storage.sql),
    });
    await server.serve();

    // Container test client exposes results via HTTP on :8080
    const resp = await this.containerFetch('http://localhost/results', 8080);
    return resp.json();
  }

  /**
   * Start the bridge + libsql test client, run HranaServer on TCP,
   * wait for the test to complete, fetch results.
   */
  async libsqlTest(): Promise<unknown> {
    this.entrypoint = ['bash', 'scripts/libsql-test.sh'];
    await this.startAndWaitForPorts({ ports: [9000, 4000] });

    // Connect raw TCP — bridge is on :9000
    const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
    await socket.opened;

    // Run Hrana server — serves until bridge/client disconnect
    const server = new HranaServer({
      readable: socket.readable,
      writable: socket.writable,
      sql: wrapSqlStorage(this.ctx.storage.sql),
    });

    // Don't await serve() — it blocks until the TCP closes.
    // Poll the test results endpoint instead.
    const servePromise = server.serve();

    // Poll for test completion
    let result: unknown = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const resp = await this.containerFetch('http://localhost/results', 4000);
        const data = (await resp.json()) as { status: string };
        if (data.status === 'success' || data.status === 'error') {
          result = data;
          break;
        }
      } catch {
        // Bridge or test not ready yet
      }
    }

    // Close the TCP socket to end the Hrana server
    await socket.close();
    await servePromise.catch(() => {});

    if (!result) {
      return { status: 'timeout', error: 'Test did not complete within 30s' };
    }

    // Cross-check: read the test data from DO side
    try {
      const row = this.ctx.storage.sql
        .exec<{ msg: string }>("SELECT msg FROM libsql_test WHERE id=1")
        .one();
      (result as Record<string, unknown>).doSideRead = row.msg;
    } catch {
      (result as Record<string, unknown>).doSideRead = 'table not found';
    }

    return result;
  }

  /**
   * Test AgentFS operations from Container via Hrana bridge.
   * DO seeds a file, Container reads it + writes its own, DO verifies.
   */
  async sdkTest(): Promise<unknown> {
    // 1. DO writes seed file via AgentFS SDK
    await this.agentFs.writeFile('/seed.txt', 'hello from DO');

    // 2. Start Container with bridge + SDK test
    this.entrypoint = ['bash', 'scripts/sdk-test.sh'];
    await this.startAndWaitForPorts({ ports: [9000, 4000] });

    const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
    await socket.opened;

    const server = new HranaServer({
      readable: socket.readable,
      writable: socket.writable,
      sql: wrapSqlStorage(this.ctx.storage.sql),
    });

    const servePromise = server.serve();

    // Poll for test completion
    let result: unknown = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const resp = await this.containerFetch('http://localhost/results', 4000);
        const data = (await resp.json()) as { status: string };
        if (data.status === 'success' || data.status === 'error') {
          result = data;
          break;
        }
      } catch {
        // Not ready yet
      }
    }

    await socket.close();
    await servePromise.catch(() => {});

    if (!result) {
      return { status: 'timeout', error: 'Test did not complete within 30s' };
    }

    // 3. DO reads the file written by Container
    try {
      const content = await this.agentFs.readFile('/from-container.txt', 'utf8');
      (result as Record<string, unknown>).doReadContainerFile = content;
    } catch (err) {
      (result as Record<string, unknown>).doReadContainerFile =
        `error: ${err instanceof Error ? err.message : err}`;
    }

    return result;
  }

  /**
   * Test FUSE mount in Container. DO seeds a file, Container mounts via
   * FUSE and verifies the file is visible as a real POSIX file.
   */
  async fuseTest(): Promise<unknown> {
    // 1. DO writes seed file via AgentFS SDK
    await this.agentFs.writeFile('/seed.txt', 'hello from DO');

    // 2. Start Container with bridge + FUSE mount
    this.entrypoint = ['bash', 'scripts/fuse-mount.sh'];
    await this.startAndWaitForPorts({ ports: [9000, 4000] });

    // 3. Connect TCP — bridge is on :9000
    const socket = this.ctx.container!.getTcpPort(9000).connect('0.0.0.0:9000');
    await socket.opened;

    const server = new HranaServer({
      readable: socket.readable,
      writable: socket.writable,
      sql: wrapSqlStorage(this.ctx.storage.sql),
    });

    // Don't await serve() — it blocks until TCP closes
    const servePromise = server.serve();

    // 4. Poll for mount readiness and check results
    let result: unknown = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const resp = await this.containerFetch('http://localhost/status', 4000);
        const data = (await resp.json()) as { mounted: boolean; entries: string[]; error?: string };
        if (data.mounted) {
          result = data;
          break;
        }
      } catch {
        // Not ready yet
      }
    }

    // 5. Clean up
    await socket.close();
    await servePromise.catch(() => {});

    if (!result) {
      return { status: 'timeout', error: 'FUSE mount did not become ready within 60s' };
    }

    return result;
  }

  /**
   * Execute a shell command in the Container against the FUSE-mounted filesystem.
   * Starts Container if not running, connects Hrana, sends command via HTTP.
   */
  async exec(command: string): Promise<unknown> {
    // Start Container with FUSE mount if not already running
    this.entrypoint = ['bash', 'scripts/fuse-mount.sh'];
    await this.startAndWaitForPorts({ ports: [9000, 4000] });

    // Ensure Hrana server is running on the TCP stream
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

    // Send command to the Container's command server
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

  // Track the active Hrana serve promise so we don't open multiple TCP connections
  private activeServePromise: Promise<void> | null = null;

  async ping(): Promise<string> {
    await this.startAndWaitForPorts({ ports: [9000] });

    const tcpPort = this.ctx.container!.getTcpPort(9000);
    const socket = tcpPort.connect('0.0.0.0:9000');
    await socket.opened;

    const encoder = new TextEncoder();
    const writer = socket.writable.getWriter();
    await writer.write(encoder.encode('ping'));
    await writer.close();

    const decoder = new TextDecoder();
    let response = '';
    const reader = socket.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      response += decoder.decode(value, { stream: true });
    }
    response += decoder.decode();

    return response;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ping') {
      try {
        const result = await this.ping();
        return new Response(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/exec' && request.method === 'POST') {
      try {
        const body = (await request.json()) as { command: string };
        const result = await this.exec(body.command);
        return Response.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/destroy' && request.method === 'POST') {
      try {
        await this.destroy();
        this.activeServePromise = null;
        return new Response('ok');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/fuse-test') {
      try {
        const result = await this.fuseTest();
        return Response.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/sdk-test') {
      try {
        const result = await this.sdkTest();
        return Response.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/libsql-test') {
      try {
        const result = await this.libsqlTest();
        return Response.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/hrana-test') {
      try {
        const result = await this.hranaTest();
        return Response.json(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return new Response(`Error: ${msg}`, { status: 500 });
      }
    }

    if (url.pathname === '/db-info') {
      const info = this.dbInfo();
      return Response.json(info);
    }

    // -- Filesystem endpoints (AgentFS SDK, no Container needed) --

    if (url.pathname === '/fs/write' && request.method === 'POST') {
      const path = url.searchParams.get('path');
      if (!path) return new Response('Missing ?path=', { status: 400 });
      const content = await request.text();
      await this.agentFs.writeFile(path, content);
      return new Response('ok');
    }

    if (url.pathname === '/fs/read') {
      const path = url.searchParams.get('path');
      if (!path) return new Response('Missing ?path=', { status: 400 });
      try {
        const content = await this.agentFs.readFile(path, 'utf8');
        return new Response(content);
      } catch (err) {
        return new Response(
          `Error: ${err instanceof Error ? err.message : err}`,
          { status: 404 }
        );
      }
    }

    if (url.pathname === '/fs/ls') {
      const path = url.searchParams.get('path') ?? '/';
      const entries = await this.agentFs.readdir(path);
      return Response.json(entries);
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

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const agent = url.searchParams.get('agent');

    if (!agent) {
      return new Response('Missing ?agent= parameter', { status: 400 });
    }

    const container = getContainer<DOFS>(env.DOFS, agent);
    return container.fetch(request);
  },
};
