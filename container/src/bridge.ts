// ABOUTME: TCP↔WebSocket bridge for Hrana protocol relay.
// ABOUTME: TCP :9000 from DO (length-prefixed frames) ↔ WS ws://localhost:8080 for libsql client.

import { createServer as createTcpServer, type Socket } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';

const TCP_PORT = 9000;
const WS_PORT = 8080;

// ---------------------------------------------------------------------------
// State: one TCP connection (from DO), many WS clients (from libsql)
// ---------------------------------------------------------------------------

let doSocket: Socket | null = null;
const wsClients = new Set<WebSocket>();

// Buffer for incomplete TCP frames
let tcpBuffer = Buffer.alloc(0);

// ---------------------------------------------------------------------------
// TCP → WS: read length-prefixed frames, forward as WS text messages
// ---------------------------------------------------------------------------

function handleTcpData(data: Buffer): void {
  tcpBuffer = Buffer.concat([tcpBuffer, data]);

  while (true) {
    if (tcpBuffer.length < 4) break;

    const jsonLen = tcpBuffer.readUInt32BE(0);
    if (tcpBuffer.length < 4 + jsonLen) break;

    const jsonStr = tcpBuffer.subarray(4, 4 + jsonLen).toString('utf-8');
    tcpBuffer = tcpBuffer.subarray(4 + jsonLen);

    // Forward to all connected WS clients
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(jsonStr);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WS → TCP: receive WS text messages, wrap in length-prefixed frames
// ---------------------------------------------------------------------------

function handleWsMessage(data: string): void {
  if (!doSocket || doSocket.destroyed) {
    console.error('No DO TCP connection available');
    return;
  }

  const jsonBuf = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(jsonBuf.length, 0);
  doSocket.write(Buffer.concat([header, jsonBuf]));
}

// ---------------------------------------------------------------------------
// TCP server on :9000 — accepts connection from DO
// ---------------------------------------------------------------------------

const tcpServer = createTcpServer((socket) => {
  console.log('DO connected via TCP');

  if (doSocket && !doSocket.destroyed) {
    console.warn('Replacing existing DO TCP connection');
    doSocket.destroy();
  }

  doSocket = socket;
  tcpBuffer = Buffer.alloc(0);

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
// WebSocket server on :8080 — accepts connections from libsql client
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' }, () => {
  console.log(`Bridge WebSocket server listening on :${WS_PORT}`);
});

wss.on('connection', (ws, req) => {
  console.log(`WS client connected from ${req.socket.remoteAddress}`);

  // Check for Hrana subprotocol
  const protocols = req.headers['sec-websocket-protocol'];
  if (protocols) {
    console.log(`WS subprotocol requested: ${protocols}`);
  }

  wsClients.add(ws);

  ws.on('message', (data) => {
    const msg = typeof data === 'string' ? data : data.toString('utf-8');
    handleWsMessage(msg);
  });

  ws.on('close', () => {
    console.log('WS client disconnected');
    wsClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WS client error:', err.message);
    wsClients.delete(ws);
  });
});
