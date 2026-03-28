// ABOUTME: HTTP server that executes shell commands with cwd=/volume (the FUSE mount).
// ABOUTME: Exposes POST /exec for running git, python, bash, etc. against the mounted filesystem.

import { createServer } from 'http';
import { exec } from 'child_process';

const PORT = 4000;
const CWD = process.env.DOFS_CWD || '/tmp';

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

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
      cwd: CWD,
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
  console.log(`Command server listening on :${PORT}, cwd=${CWD}`);
});
