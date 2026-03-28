// ABOUTME: HTTP server that manages the Container lifecycle and executes commands.
// ABOUTME: POST /setup starts the bridge, POST /mount starts FUSE, POST /exec runs commands.

import { createServer } from 'http';
import { exec, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';

const PORT = 4000;
const MOUNT_POINT = '/volume';
const MOUNT_POLL_INTERVAL_MS = 1000;
const MOUNT_POLL_MAX_ATTEMPTS = 30;
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

let cwd = '/tmp';
let bridgeStarted = false;
let fuseProcess: ChildProcess | null = null;
let fuseExitCode: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isMounted(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`mountpoint -q ${MOUNT_POINT}`, (err) => resolve(!err));
  });
}

/** Check whether the FUSE daemon is alive. Returns error message if dead. */
function fuseDaemonError(): string | null {
  if (!fuseProcess) return 'FUSE daemon not started';
  if (fuseExitCode !== null) return `FUSE daemon exited with code ${fuseExitCode}`;
  return null;
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const mounted = await isMounted();
    if (mounted && cwd !== MOUNT_POINT) cwd = MOUNT_POINT;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bridgeStarted,
      fuseMounted: mounted,
      fuseExitCode,
      cwd,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/setup') {
    if (bridgeStarted) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    try {
      const { startBridge } = await import('./bridge.js');
      await startBridge();
      bridgeStarted = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Bridge startup failed: ${err instanceof Error ? err.message : err}` }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/mount') {
    if (fuseProcess && fuseExitCode === null) {
      const mounted = await isMounted();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mounted }));
      return;
    }

    try { mkdirSync(MOUNT_POINT, { recursive: true }); } catch { /* exists */ }

    fuseExitCode = null;
    const child = exec(
      `agentfs mount --remote-url http://localhost:8080 --auth-token "" --foreground volume ${MOUNT_POINT}`,
      { env: process.env }
    );
    fuseProcess = child;

    child.stdout?.on('data', (d: string) => process.stdout.write(`[fuse] ${d}`));
    child.stderr?.on('data', (d: string) => process.stderr.write(`[fuse] ${d}`));
    child.on('exit', (code) => {
      fuseExitCode = code ?? 1;
    });

    let mounted = false;
    for (let i = 0; i < MOUNT_POLL_MAX_ATTEMPTS; i++) {
      await sleep(MOUNT_POLL_INTERVAL_MS);
      if (fuseExitCode !== null) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `agentfs exited with code ${fuseExitCode}` }));
        return;
      }
      mounted = await isMounted();
      if (mounted) break;
    }

    if (mounted || fuseExitCode === null) cwd = MOUNT_POINT;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: mounted || fuseExitCode === null, mounted }));
    return;
  }

  if (req.method === 'POST' && req.url === '/exec') {
    // Check FUSE health before executing
    const fuseErr = fuseDaemonError();
    if (cwd === MOUNT_POINT && fuseErr) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `FUSE unavailable: ${fuseErr}` }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    let command: string;
    try {
      const parsed = JSON.parse(body);
      command = parsed.command;
      if (typeof command !== 'string' || !command.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "command" string in request body' }));
        return;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
      return;
    }

    exec(command, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: '/root',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      maxBuffer: EXEC_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        exitCode: error ? (error.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0');
