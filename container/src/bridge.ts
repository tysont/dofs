// ABOUTME: HTTP-to-TCP bridge for Hrana pipeline protocol.
// ABOUTME: HTTP :8080 serves POST /v3/pipeline from FUSE daemon, relays over TCP :9000 to DO.

import { createServer as createTcpServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';

const TCP_PORT = 9000;
const HTTP_PORT = 8080;
const HEADER_SIZE = 4;

// ---------------------------------------------------------------------------
// TCP connection to the DO (length-prefixed JSON frames)
// ---------------------------------------------------------------------------

let doSocket: Socket | null = null;
let tcpBuffer = Buffer.alloc(0);
let pendingResolve: ((data: Buffer) => void) | null = null;

function handleTcpData(data: Buffer): void {
  tcpBuffer = Buffer.concat([tcpBuffer, data]);
  tryDeliverFrame();
}

function tryDeliverFrame(): void {
  if (!pendingResolve) return;
  if (tcpBuffer.length < HEADER_SIZE) return;

  const jsonLen = tcpBuffer.readUInt32BE(0);
  if (tcpBuffer.length < HEADER_SIZE + jsonLen) return;

  const frame = tcpBuffer.subarray(HEADER_SIZE, HEADER_SIZE + jsonLen);
  tcpBuffer = tcpBuffer.subarray(HEADER_SIZE + jsonLen);

  const resolve = pendingResolve;
  pendingResolve = null;
  resolve(frame);
}

/** Send a length-prefixed JSON frame over TCP and wait for one response frame. */
function sendAndReceive(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!doSocket || doSocket.destroyed) {
      reject(new Error('No DO TCP connection'));
      return;
    }

    // Register the pending response handler
    pendingResolve = resolve;

    // Write the request frame
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);
    doSocket.write(Buffer.concat([header, payload]), (err) => {
      if (err) {
        pendingResolve = null;
        reject(err);
      }
    });

    // Check if we already have a buffered response
    tryDeliverFrame();
  });
}

// TCP server on :9000 — accepts connection from DO
const tcpServer = createTcpServer((socket) => {
  console.log('DO connected via TCP');

  if (doSocket && !doSocket.destroyed) {
    console.warn('Replacing existing DO TCP connection');
    doSocket.destroy();
  }

  doSocket = socket;
  tcpBuffer = Buffer.alloc(0);
  pendingResolve = null;

  socket.on('data', handleTcpData);

  socket.on('end', () => {
    console.log('DO TCP connection closed');
    doSocket = null;
  });

  socket.on('error', (err) => {
    console.error('DO TCP error:', err.message);
    doSocket = null;
  });
});

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`Bridge TCP server listening on :${TCP_PORT}`);
});

// ---------------------------------------------------------------------------
// HTTP server on :8080 — serves Hrana pipeline API for the FUSE daemon
// ---------------------------------------------------------------------------

const httpServer = createHttpServer(async (req, res) => {
  // Health check (used by Container class port readiness)
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Hrana pipeline endpoint
  if (req.method === 'POST' && (req.url === '/v3/pipeline' || req.url?.startsWith('/v3/pipeline'))) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    if (!doSocket || doSocket.destroyed) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No DO TCP connection available' }));
      return;
    }

    try {
      const responseFrame = await sendAndReceive(Buffer.from(body, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseFrame);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return;
  }

  // Cursor endpoint (streaming — not yet implemented)
  if (req.method === 'POST' && req.url?.startsWith('/v3/cursor')) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Cursor API not implemented' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Bridge HTTP server listening on :${HTTP_PORT}`);
});
