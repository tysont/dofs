// ABOUTME: Tests @libsql/client through the bridge to validate Hrana compatibility.
// ABOUTME: Creates a table, inserts data, selects it back — all via ws://localhost:8080.

import { createClient } from '@libsql/client';
import { createServer } from 'http';

interface TestResults {
  status: 'pending' | 'running' | 'success' | 'error';
  createTable?: string;
  insert?: string;
  select?: unknown;
  fsInodeCount?: unknown;
  error?: string;
}

const results: TestResults = { status: 'pending' };

async function runTest(): Promise<void> {
  results.status = 'running';

  // Wait a moment for the bridge to be ready
  await new Promise((r) => setTimeout(r, 1000));

  const client = createClient({ url: 'ws://localhost:8080' });

  try {
    // 1. Create a test table
    await client.execute('CREATE TABLE IF NOT EXISTS libsql_test (id INTEGER PRIMARY KEY, msg TEXT)');
    results.createTable = 'ok';
    console.log('CREATE TABLE: ok');

    // 2. Insert data
    await client.execute({
      sql: 'INSERT INTO libsql_test VALUES (?, ?)',
      args: [1, 'from-container'],
    });
    results.insert = 'ok';
    console.log('INSERT: ok');

    // 3. Select it back
    const selectResult = await client.execute('SELECT id, msg FROM libsql_test');
    results.select = selectResult.rows;
    console.log('SELECT:', JSON.stringify(selectResult.rows));

    // 4. Query the AgentFS schema (proves bridge works with existing DO data)
    const countResult = await client.execute('SELECT count(*) as c FROM fs_inode');
    results.fsInodeCount = countResult.rows[0];
    console.log('fs_inode count:', JSON.stringify(countResult.rows[0]));

    results.status = 'success';
  } catch (err) {
    results.status = 'error';
    results.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('Test failed:', results.error);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  } finally {
    client.close();
  }
}

// HTTP server on :4000 to expose results
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(results, null, 2));
});

httpServer.listen(4000, '0.0.0.0', () => {
  console.log('libsql-test results server on :4000');
  // Start the test after HTTP server is ready
  runTest().catch(console.error);
});
