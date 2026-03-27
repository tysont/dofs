// ABOUTME: Worker entrypoint and DOFS Durable Object class.
// ABOUTME: Routes HTTP requests to per-agent DOs that communicate with Containers via raw TCP.

import { Container, getContainer } from '@cloudflare/containers';
import { initSchema, SCHEMA_TABLES } from './schema';

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
