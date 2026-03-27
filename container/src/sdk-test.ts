// ABOUTME: Tests AgentFS SDK from Container side via the Hrana bridge.
// ABOUTME: Reads a seed file written by DO, writes its own file, verifies bidirectional visibility.

import { createClient } from '@libsql/client';
import { createServer } from 'http';

interface TestResults {
  status: 'pending' | 'running' | 'success' | 'error';
  seedContent?: string;
  dirEntries?: string[];
  wroteFile?: boolean;
  error?: string;
}

const results: TestResults = { status: 'pending' };

/**
 * Since AgentFS SDK requires specific database adapters, we use @libsql/client
 * with raw AgentFS SQL queries. This proves the Hrana bridge works for the same
 * SQL operations the AgentFS FUSE daemon would issue.
 */
async function runTest(): Promise<void> {
  results.status = 'running';

  await new Promise((r) => setTimeout(r, 1500));

  const client = createClient({ url: 'ws://localhost:8080' });

  try {
    // 1. Read the seed file written by the DO via AgentFS SDK
    //    AgentFS stores files as: dentry -> inode -> data chunks
    //    To read /seed.txt: resolve dentry(parent_ino=1, name='seed.txt') -> ino,
    //    then read data chunks for that ino.
    const dentry = await client.execute({
      sql: "SELECT ino FROM fs_dentry WHERE parent_ino = 1 AND name = 'seed.txt'",
      args: [],
    });

    if (dentry.rows.length === 0) {
      throw new Error('seed.txt not found in fs_dentry — DO may not have written it');
    }

    const seedIno = dentry.rows[0]['ino'] as number;

    // Read file content from fs_data (may be multiple chunks)
    const chunks = await client.execute({
      sql: 'SELECT data FROM fs_data WHERE ino = ? ORDER BY chunk_index',
      args: [seedIno],
    });

    // Concatenate chunks — data is stored as blobs
    let content = '';
    for (const row of chunks.rows) {
      const data = row['data'];
      if (typeof data === 'string') {
        content += data;
      } else if (data instanceof Uint8Array || data instanceof Buffer) {
        content += new TextDecoder().decode(data);
      } else {
        content += String(data);
      }
    }
    results.seedContent = content;
    console.log('Read seed.txt:', content);

    // 2. List root directory entries
    const entries = await client.execute({
      sql: 'SELECT name FROM fs_dentry WHERE parent_ino = 1',
      args: [],
    });
    results.dirEntries = entries.rows.map((r) => r['name'] as string);
    console.log('Root entries:', results.dirEntries);

    // 3. Write /from-container.txt using AgentFS SQL operations
    const now = Math.floor(Date.now() / 1000);
    const fileContent = Buffer.from('written in container');
    const mode = 0o100644; // regular file, rw-r--r--

    // Create inode
    await client.execute({
      sql: `INSERT INTO fs_inode (mode, nlink, uid, gid, size, atime, mtime, ctime)
            VALUES (?, 1, 0, 0, ?, ?, ?, ?)`,
      args: [mode, fileContent.length, now, now, now],
    });

    // Get the new inode number
    const newIno = await client.execute({
      sql: 'SELECT last_insert_rowid() as ino',
      args: [],
    });
    const ino = newIno.rows[0]['ino'] as number;

    // Create directory entry
    await client.execute({
      sql: 'INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, 1, ?)',
      args: ['from-container.txt', ino],
    });

    // Write data chunk
    await client.execute({
      sql: 'INSERT INTO fs_data (ino, chunk_index, data) VALUES (?, 0, ?)',
      args: [ino, fileContent],
    });

    results.wroteFile = true;
    console.log('Wrote from-container.txt with ino', ino);

    results.status = 'success';
  } catch (err) {
    results.status = 'error';
    results.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('Test failed:', results.error);
    if (err instanceof Error && err.stack) console.error(err.stack);
  } finally {
    client.close();
  }
}

// HTTP server on :4000
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(results, null, 2));
});

httpServer.listen(4000, '0.0.0.0', () => {
  console.log('sdk-test results server on :4000');
  runTest().catch(console.error);
});
