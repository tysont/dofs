// ABOUTME: Hrana test client that validates the DO's Hrana server over TCP.
// ABOUTME: Listens on TCP :9000, sends test queries, reports results via HTTP :8080.

import { createServer as createTcpServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';

// ---------------------------------------------------------------------------
// Length-prefixed frame helpers (matching DO's hrana-protocol.ts)
// ---------------------------------------------------------------------------

function serializeFrame(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

interface FrameReader {
  buffer: Buffer;
  read(): unknown | null;
  push(data: Buffer): void;
}

function createFrameReader(): FrameReader {
  return {
    buffer: Buffer.alloc(0),
    push(data: Buffer) {
      this.buffer = Buffer.concat([this.buffer, data]);
    },
    read(): unknown | null {
      if (this.buffer.length < 4) return null;
      const jsonLen = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + jsonLen) return null;
      const json = this.buffer.subarray(4, 4 + jsonLen).toString('utf-8');
      this.buffer = this.buffer.subarray(4 + jsonLen);
      return JSON.parse(json);
    },
  };
}

// ---------------------------------------------------------------------------
// Test client logic
// ---------------------------------------------------------------------------

interface TestResults {
  status: 'pending' | 'success' | 'error';
  select1?: unknown;
  inodeCount?: unknown;
  error?: string;
}

const results: TestResults = { status: 'pending' };

async function runTest(socket: Socket): Promise<void> {
  const reader = createFrameReader();

  // Promisified read: waits for one complete frame
  function readFrame(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Check if we already have a complete frame buffered
      const existing = reader.read();
      if (existing !== null) {
        resolve(existing);
        return;
      }

      const onData = (data: Buffer) => {
        reader.push(data);
        const msg = reader.read();
        if (msg !== null) {
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          resolve(msg);
        }
      };
      const onError = (err: Error) => {
        socket.removeListener('data', onData);
        reject(err);
      };
      socket.on('data', onData);
      socket.on('error', onError);
    });
  }

  function writeFrame(msg: unknown): void {
    socket.write(serializeFrame(msg));
  }

  // 1. Hello
  writeFrame({ type: 'hello', jwt: null });
  const helloResp = await readFrame();
  console.log('hello response:', JSON.stringify(helloResp));

  // 2. Open stream
  writeFrame({
    type: 'request',
    request_id: 1,
    request: { type: 'open_stream', stream_id: 0 },
  });
  const openResp = await readFrame();
  console.log('open_stream response:', JSON.stringify(openResp));

  // 3. SELECT 1
  writeFrame({
    type: 'request',
    request_id: 2,
    request: {
      type: 'execute',
      stream_id: 0,
      stmt: { sql: 'SELECT 1 as v' },
    },
  });
  const select1Resp = (await readFrame()) as {
    type: string;
    response?: { result?: { rows?: unknown[][] } };
  };
  console.log('SELECT 1 response:', JSON.stringify(select1Resp));
  if (
    select1Resp.type === 'response_ok' &&
    select1Resp.response?.result?.rows?.[0]
  ) {
    results.select1 = select1Resp.response.result.rows[0][0];
  }

  // 4. SELECT count(*) FROM fs_inode
  writeFrame({
    type: 'request',
    request_id: 3,
    request: {
      type: 'execute',
      stream_id: 0,
      stmt: { sql: 'SELECT count(*) as c FROM fs_inode' },
    },
  });
  const countResp = (await readFrame()) as {
    type: string;
    response?: { result?: { rows?: unknown[][] } };
  };
  console.log('fs_inode count response:', JSON.stringify(countResp));
  if (
    countResp.type === 'response_ok' &&
    countResp.response?.result?.rows?.[0]
  ) {
    results.inodeCount = countResp.response.result.rows[0][0];
  }

  // 5. Close stream
  writeFrame({
    type: 'request',
    request_id: 4,
    request: { type: 'close_stream', stream_id: 0 },
  });
  await readFrame();

  results.status = 'success';
  console.log('Test complete:', JSON.stringify(results));

  socket.end();
}

// ---------------------------------------------------------------------------
// TCP server on :9000 — accepts connection from DO, runs test
// ---------------------------------------------------------------------------

const tcpServer = createTcpServer((socket) => {
  console.log('DO connected via TCP');
  runTest(socket).catch((err) => {
    results.status = 'error';
    results.error = err instanceof Error ? err.message : String(err);
    console.error('Test failed:', err);
    socket.destroy();
  });
});

tcpServer.listen(9000, '0.0.0.0', () => {
  console.log('Hrana test client listening on TCP :9000');
});

// ---------------------------------------------------------------------------
// HTTP server on :8080 — exposes test results for the DO to read
// ---------------------------------------------------------------------------

const httpServer = createHttpServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(results));
});

httpServer.listen(8080, '0.0.0.0', () => {
  console.log('Results server listening on HTTP :8080');
});
