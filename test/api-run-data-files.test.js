import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server/index.js';

// The fake k6 copies the script it was asked to run (its last argument) and
// lists the folder it runs in, so the test sees exactly what k6 would get.
async function withFakeK6(callback) {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  const capture = join(binDir, 'captured.js');
  const listing = join(binDir, 'folder.txt');
  await writeFile(join(binDir, 'k6'), [
    '#!/bin/sh',
    'summary=""; script=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--summary-export" ]; then summary="$2"; shift 2; else script="$1"; shift; fi',
    'done',
    `cp "$script" '${capture}'`,
    `ls "$(dirname "$script")" > '${listing}'`,
    'printf "{}" > "$summary"',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  const server = createServer({ port: 0, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    await callback(`http://127.0.0.1:${server.address().port}`, { capture, listing });
  } finally {
    process.env.PATH = previousPath;
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await rm(binDir, { recursive: true, force: true });
  }
}

const config = dataSet => ({
  load: { mode: 'iterations', vus: '5', iterations: '1' },
  scenario: { requests: [{ method: 'GET', url: 'http://127.0.0.1:9/never-contacted?u={{email}}' }] },
  dataSets: [{ name: 'login.csv', skipHeader: true, columns: ['email', 'password'], share: 'next-row', onEnd: 'recycle', ...dataSet }],
});

test('/api/run hands k6 one script file that carries the rows; no data file is written next to it', async () => {
  await withFakeK6(async (baseUrl, { capture, listing }) => {
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config({ content: 'email,password\nuser1@example.com,pass1\nuser2@example.com,pass2\n' })),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /event: done/);

    const script = await readFile(capture, 'utf8');
    assert.match(script, /import \{ SharedArray \} from 'k6\/data';/);
    assert.match(script, /\["user2@example\.com","pass2"\]/);
    assert.match(script, /u=\$\{DATA_1_ROW\.email\}/);
    assert.equal((await readFile(listing, 'utf8')).trim(), 'test.js');
  });
});

test('/api/run answers 400 or 413 as JSON, before any k6 process starts, for unusable data', async () => {
  await withFakeK6(async (baseUrl, { capture }) => {
    const post = body => fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const unclosed = await post(config({ content: 'email,password\n"oops\n' }));
    assert.equal(unclosed.status, 400);
    assert.match(unclosed.headers.get('content-type'), /application\/json/);
    assert.match((await unclosed.json()).error, /never closed/);

    const tooBig = await post(config({ content: `email\n${'x'.repeat(5 * 1024 * 1024)}` }));
    assert.equal(tooBig.status, 413);
    assert.match((await tooBig.json()).error, /limit is 5\.0 MB per file/);

    await assert.rejects(readFile(capture, 'utf8'), { code: 'ENOENT' }, 'k6 was never started');
  });
});
