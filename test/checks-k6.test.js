// Checks and extractions with the real k6 binary (skipped when `k6` is not on PATH):
// a response without a body (a refused connection) no longer ends the iteration with
// a TypeError, and a header typed in lower case (as browser DevTools show it) is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { generateScript } from '../server/generator/index.js';

const run = promisify(execFile);

function hasK6() {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('no body: checks fail instead of throwing; lower-case header names are found', { skip: !hasK6() && 'the k6 binary is not on PATH' }, async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('x-request-id', 'rid-7');   // lower case on the wire
    res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  // A port nothing listens on: k6 gets "connection refused" and a response with body null.
  const closed = http.createServer();
  await new Promise(done => closed.listen(0, '127.0.0.1', done));
  const refusedPort = closed.address().port;
  await new Promise(done => closed.close(done));
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-checks-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = generateScript({
      scenario: { requests: [
        {
          method: 'GET', url: `http://127.0.0.1:${refusedPort}/refused`, checkStatus: false,
          assertions: [
            { type: 'body-contains', value: 'ok' },     // fails
            { type: 'body-not-contains', value: 'x' },  // passes: there is no body
            { type: 'body-matches', value: 'null' },    // fails: no body is not the text "null"
          ],
          extractions: [{ varName: 'sid', source: 'regex', selector: 'sid=(\\w+)' }],
        },
        {
          method: 'GET', url: `${base}/headers/{{sid}}`,
          assertions: [{ type: 'header-exists', value: 'x-request-id' }, { type: 'header-eq', value: 'X-REQUEST-ID', value2: 'rid-7' }],
          extractions: [{ varName: 'rid', source: 'header', selector: 'x-request-id' }],
        },
        { method: 'GET', url: `${base}/seen/{{rid}}` },
      ] },
      load: { mode: 'iterations', vus: '1', iterations: '1' },
    });
    const file = join(dir, 'test.js');
    const summary = join(dir, 'summary.json');
    await writeFile(file, script);
    const { stdout, stderr } = await run('k6', ['run', '--quiet', '--summary-export', summary, file], {
      timeout: 60_000, env: { ...process.env, K6_NO_USAGE_REPORT: 'true' },
    });
    assert.doesNotMatch(`${stdout}\n${stderr}`, /TypeError|ReferenceError/);
    assert.deepEqual(paths, ['/headers/', '/seen/rid-7'], 'the iteration went on after the refused request');
    const { metrics } = JSON.parse(await readFile(summary, 'utf8'));
    // body-not-contains, header-exists, header-eq and the status checks of requests 2 and 3 pass.
    assert.equal(metrics.checks.fails, 2);
    assert.equal(metrics.checks.passes, 5);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
