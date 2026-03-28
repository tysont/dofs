// ABOUTME: HTTP-to-TCP bridge for Hrana pipeline protocol.
// ABOUTME: HTTP :8080 serves /v3/pipeline and /v3/cursor, relays over TCP :9000 to DO.

import { createServer as createTcpServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';

const TCP_PORT = 9000;
const HTTP_PORT = 8080;
const HEADER_SIZE = 4;

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

function sendAndReceive(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!doSocket || doSocket.destroyed) {
      reject(new Error('No DO TCP connection'));
      return;
    }
    pendingResolve = resolve;
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);
    doSocket.write(Buffer.concat([header, payload]), (err) => {
      if (err) { pendingResolve = null; reject(err); }
    });
    tryDeliverFrame();
  });
}

/**
 * Convert a cursor request to a pipeline request, execute via TCP,
 * then convert the pipeline response to cursor NDJSON streaming format.
 */
async function handleCursor(body: string, res: import('http').ServerResponse): Promise<void> {
  // Parse cursor request: { baton, batch: { steps: [...] } }
  const cursorReq = JSON.parse(body);
  const batch = cursorReq.batch;
  const baton = cursorReq.baton || null;

  // Convert to pipeline request with a single batch
  const pipelineReq = {
    baton,
    requests: [{ type: 'batch', batch }],
  };

  const responseFrame = await sendAndReceive(Buffer.from(JSON.stringify(pipelineReq), 'utf-8'));
  const pipelineResp = JSON.parse(responseFrame.toString('utf-8'));

  // Stream NDJSON cursor response
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Transfer-Encoding': 'chunked',
  });

  // First line: cursor metadata
  res.write(JSON.stringify({ baton: pipelineResp.baton, base_url: pipelineResp.base_url }) + '\n');

  // Convert batch result to cursor entries
  const batchResult = pipelineResp.results?.[0];
  if (batchResult?.type === 'ok' && batchResult.response?.type === 'batch') {
    const result = batchResult.response.result;
    const stepResults = result.step_results || [];
    const stepErrors = result.step_errors || [];

    for (let i = 0; i < stepResults.length; i++) {
      const stepResult = stepResults[i];
      const stepError = stepErrors[i];

      if (stepError) {
        res.write(JSON.stringify({
          type: 'step_error',
          step: i,
          error: { message: stepError.message, code: stepError.code || 'UNKNOWN' },
        }) + '\n');
        continue;
      }

      if (!stepResult) continue;

      // step_begin
      res.write(JSON.stringify({
        type: 'step_begin',
        step: i,
        cols: stepResult.cols || [],
      }) + '\n');

      // rows
      for (const row of stepResult.rows || []) {
        res.write(JSON.stringify({
          type: 'row',
          row: row.values || row,
        }) + '\n');
      }

      // step_end
      res.write(JSON.stringify({
        type: 'step_end',
        affected_row_count: stepResult.affected_row_count || 0,
        last_inserted_rowid: stepResult.last_insert_rowid || null,
      }) + '\n');
    }
  } else if (batchResult?.type === 'error') {
    res.write(JSON.stringify({
      type: 'error',
      error: batchResult.error?.message || 'unknown error',
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
      console.log('DO connected via TCP');
      if (doSocket && !doSocket.destroyed) {
        console.warn('Replacing existing DO TCP connection');
        doSocket.destroy();
      }
      doSocket = socket;
      tcpBuffer = Buffer.alloc(0);
      pendingResolve = null;
      socket.on('data', handleTcpData);
      socket.on('end', () => { console.log('DO TCP closed'); doSocket = null; });
      socket.on('error', (err) => { console.error('DO TCP error:', err.message); doSocket = null; });
    });

    tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
      console.log(`Bridge TCP listening on :${TCP_PORT}`);
      tcpReady = true;
      checkReady();
    });

    const httpServer = createHttpServer(async (req, res) => {
      // Health check
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
      for await (const chunk of req) { body += chunk; }

      // Pipeline endpoint — forward directly over TCP
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

      // Cursor endpoint — translate to pipeline, stream NDJSON response
      if (req.method === 'POST' && req.url?.startsWith('/v3/cursor')) {
        try {
          await handleCursor(body, res);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${req.method} ${req.url}`);
    });

    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`Bridge HTTP listening on :${HTTP_PORT}`);
      httpReady = true;
      checkReady();
    });
  });
}
