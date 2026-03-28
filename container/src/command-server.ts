// ABOUTME: HTTP server that executes shell commands with cwd=/volume (the FUSE mount).
// ABOUTME: Exposes POST /exec for running git, python, bash, etc. against the mounted filesystem.

import { createServer } from 'http';
import { spawn } from 'child_process';

const PORT = 4000;
const CWD = '/tmp';

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Execute a command
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
        res.end(JSON.stringify({ error: 'Missing "command" string in request body' }));
        return;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
      return;
    }

    try {
      const result = await execCommand(command);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function execCommand(command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: CWD,
      env: {
        ...process.env,
        HOME: '/root',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', reject);

    child.on('close', (exitCode: number | null) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Command server listening on :${PORT}`);
});
