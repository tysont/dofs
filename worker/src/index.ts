// ABOUTME: Worker entrypoint and DOFS Durable Object class.
// ABOUTME: Routes HTTP requests to per-agent DOs that communicate with Containers via raw TCP.

import { Container, getContainer } from '@cloudflare/containers';
import { initSchema, SCHEMA_TABLES } from './schema';
import { HranaServer, wrapSqlStorage } from './hrana-server';

interface Env {
  DOFS: DurableObjectNamespace<DOFS>;
}

export class DOFS extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env);
    this.ctx.blockConcurrencyWhile(async () => {
      initSchema(this.ctx.storage.sql);
    });
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
