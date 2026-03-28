// ABOUTME: HTTP-to-TCP bridge for Hrana pipeline protocol.
// ABOUTME: HTTP :8080 serves /v3/pipeline and /v3/cursor, relays over TCP :9000 to DO.

import { createServer as createTcpServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';

const TCP_PORT = 9000;
const HTTP_PORT = 8080;
const HEADER_SIZE = 4;

let doSocket: Socket | null = null;
let tcpBuffer = Buffer.alloc(0);

// Queue of pending response handlers. Responses arrive in order (DO processes
// requests sequentially) so we resolve them FIFO.
const pendingQueue: Array<{
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
}> = [];

function handleTcpData(data: Buffer): void {
  tcpBuffer = Buffer.concat([tcpBuffer, data]);
  drainFrames();
}

function drainFrames(): void {
  while (pendingQueue.length > 0) {
    if (tcpBuffer.length < HEADER_SIZE) return;
    const jsonLen = tcpBuffer.readUInt32BE(0);
    if (tcpBuffer.length < HEADER_SIZE + jsonLen) return;

    const frame = tcpBuffer.subarray(HEADER_SIZE, HEADER_SIZE + jsonLen);
    tcpBuffer = tcpBuffer.subarray(HEADER_SIZE + jsonLen);

    const pending = pendingQueue.shift()!;
    pending.resolve(Buffer.from(frame));
  }
}

/** Send a length-prefixed JSON frame and wait for the next response frame. */
function sendAndReceive(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!doSocket || doSocket.destroyed) {
      reject(new Error('No DO TCP connection'));
      return;
    }

    pendingQueue.push({ resolve, reject });

    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);
    doSocket.write(Buffer.concat([header, payload]), (err) => {
      if (err) {
        // Remove from queue and reject
        const idx = pendingQueue.findIndex(p => p.resolve === resolve);
        if (idx >= 0) pendingQueue.splice(idx, 1);
        reject(err);
      }
    });

    // Check if we already have a buffered response
    drainFrames();
  });
}

/** Translate a cursor request to a pipeline batch, stream NDJSON response. */
async function handleCursor(body: string, res: import('http').ServerResponse): Promise<void> {
  const cursorReq = JSON.parse(body);
  const pipelineReq = {
    baton: cursorReq.baton || null,
    requests: [{ type: 'batch', batch: cursorReq.batch }],
  };

  const responseFrame = await sendAndReceive(Buffer.from(JSON.stringify(pipelineReq), 'utf-8'));
  const pipelineResp = JSON.parse(responseFrame.toString('utf-8'));

  res.writeHead(200, { 'Content-Type': 'text/plain' });

  res.write(JSON.stringify({
    baton: pipelineResp.baton,
    base_url: pipelineResp.base_url,
  }) + '\n');

  const batchResult = pipelineResp.results?.[0];
  if (batchResult?.type === 'ok' && batchResult.response?.type === 'batch') {
    const result = batchResult.response.result;
    const stepResults = result.step_results || [];
    const stepErrors = result.step_errors || [];

    for (let i = 0; i < stepResults.length; i++) {
      if (stepErrors[i]) {
        res.write(JSON.stringify({
          type: 'step_error', step: i,
          error: { message: stepErrors[i].message, code: stepErrors[i].code || 'UNKNOWN' },
        }) + '\n');
        continue;
      }
      const stepResult = stepResults[i];
      if (!stepResult) continue;

      res.write(JSON.stringify({
        type: 'step_begin', step: i, cols: stepResult.cols || [],
      }) + '\n');

      for (const row of stepResult.rows || []) {
        res.write(JSON.stringify({
          type: 'row', row: row.values || row,
        }) + '\n');
      }

      res.write(JSON.stringify({
        type: 'step_end',
        affected_row_count: stepResult.affected_row_count || 0,
        last_inserted_rowid: stepResult.last_insert_rowid || null,
      }) + '\n');
    }
  } else if (batchResult?.type === 'error') {
    res.write(JSON.stringify({
      type: 'error', error: batchResult.error?.message || 'unknown error',
    }) + '\n');
  }

  res.end();
}

export function startBridge(): Promise<void> {
  return new Promise((resolve) => {
    let tcpReady = false;
    let httpReady = false;
    function checkReady(): void { if (tcpReady && httpReady) resolve(); }

    const tcpServer = createTcpServer((socket) => {
      if (doSocket && !doSocket.destroyed) doSocket.destroy();
      doSocket = socket;
      tcpBuffer = Buffer.alloc(0);
      // Reject all pending requests from the old connection
      while (pendingQueue.length) {
        pendingQueue.shift()!.reject(new Error('TCP connection replaced'));
      }
      socket.on('data', handleTcpData);
      socket.on('end', () => { doSocket = null; });
      socket.on('error', () => { doSocket = null; });
    });

    tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
      tcpReady = true;
      checkReady();
    });

    const httpServer = createHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (!doSocket || doSocket.destroyed) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No DO TCP connection' }));
        return;
      }

      let body = '';
      for await (const chunk of req) body += chunk;

      if (req.method === 'POST' && req.url?.startsWith('/v3/pipeline')) {
        try {
          const responseFrame = await sendAndReceive(Buffer.from(body, 'utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(responseFrame);
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/v3/cursor')) {
        try {
          await handleCursor(body, res);
        } catch (err) {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${req.method} ${req.url}`);
    });

    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      httpReady = true;
      checkReady();
    });
  });
}
