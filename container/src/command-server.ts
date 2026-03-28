// ABOUTME: HTTP server that manages the Container lifecycle and executes commands.
// ABOUTME: POST /setup starts the bridge, POST /mount starts FUSE, POST /exec runs commands.

import { createServer } from 'http';
import { exec, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';

const PORT = 4000;
const MOUNT_POINT = '/volume';

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

const server = createServer(async (req, res) => {
  // -- Health check --
  if (req.method === 'GET' && req.url === '/health') {
    const mounted = await isMounted();
    // Update CWD if mount appeared
    if (mounted && cwd !== MOUNT_POINT) {
      cwd = MOUNT_POINT;
    }
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

  // -- Setup: start bridge in-process --
  if (req.method === 'POST' && req.url === '/setup') {
    if (bridgeStarted) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'already started' }));
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
      res.end(JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return;
  }

  // -- Mount: start agentfs FUSE daemon --
  if (req.method === 'POST' && req.url === '/mount') {
    if (fuseProcess && fuseExitCode === null) {
      // Already running — check if mounted
      const mounted = await isMounted();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mounted, message: 'already running' }));
      return;
    }

    try {
      mkdirSync(MOUNT_POINT, { recursive: true });
    } catch { /* exists */ }

    // Spawn agentfs mount as a tracked child process
    fuseExitCode = null;
    const child = exec(
      `agentfs mount --remote-url http://localhost:8080 --auth-token "" --foreground volume ${MOUNT_POINT}`,
      { env: process.env }
    );
    fuseProcess = child;

    child.stdout?.on('data', (d: string) => process.stdout.write(`[fuse] ${d}`));
    child.stderr?.on('data', (d: string) => process.stderr.write(`[fuse] ${d}`));
    child.on('exit', (code) => {
      console.log(`[fuse] exited with code ${code}`);
      fuseExitCode = code ?? 1;
    });

    // Poll for mount readiness
    let mounted = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (fuseExitCode !== null) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: `agentfs mount exited with code ${fuseExitCode}`,
        }));
        return;
      }
      mounted = await isMounted();
      if (mounted) break;
    }

    if (mounted) {
      cwd = MOUNT_POINT;
    } else if (fuseExitCode === null) {
      // Process still running but mount not detected yet — set CWD optimistically
      // The mount may succeed shortly after the poll timeout
      cwd = MOUNT_POINT;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: mounted || fuseExitCode === null, mounted }));
    return;
  }

  // -- Exec: run a shell command --
  if (req.method === 'POST' && req.url === '/exec') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let command: string;
    try {
      const parsed = JSON.parse(body);
      command = parsed.command;
      if (typeof command !== 'string' || !command.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "command" string' }));
        return;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    exec(command, {
      cwd,
      env: {
        ...process.env,
        HOME: '/root',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      maxBuffer: 10 * 1024 * 1024,
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Command server listening on :${PORT}`);
});
