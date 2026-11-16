import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Runs a generated script with the real k6 against a throwaway server on
// 127.0.0.1 and returns the rows it sent and the k6 output.
async function runWithK6({ load, dataSet }) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.end('{}'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-data-'));
  try {
    const script = generateScript({
      load,
      scenario: { requests: [{
        method: 'GET', url: `http://127.0.0.1:${server.address().port}/?u={{email}}&p={{password}}`,
        checkStatus: false, sleepAfter: '0',
      }] },
      dataSets: [{ name: 'login.csv', skipHeader: true, columns: ['email', 'password'], ...dataSet }],
    });
    const file = join(dir, 'test.js');
    await writeFile(file, script);
    const { stdout, stderr } = await run('k6', ['run', '--quiet', file], {
      timeout: 60_000, env: { ...process.env, K6_NO_USAGE_REPORT: 'true' },
    });
    const rows = requests.map(url => /u=([^&]+)&p=(.+)$/.exec(url).slice(1, 3).join('/')).sort();
    return { rows, output: `${stdout}\n${stderr}` };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const csv = count => `email,password\n${Array.from({ length: count }, (_, i) => `user${i + 1}@example.com,pass${i + 1}`).join('\n')}\n`;
const options = { skip: !hasK6() && 'the k6 binary is not on PATH' };

test('real k6: iterations mode, 5 VUs, next-row, 5 rows → every VU gets a different row', options, async () => {
  const { rows } = await runWithK6({
    load: { mode: 'iterations', vus: '5', iterations: '1' },
    dataSet: { content: csv(5), share: 'next-row', onEnd: 'recycle' },
  });
  assert.deepEqual(rows, [1, 2, 3, 4, 5].map(n => `user${n}@example.com/pass${n}`));
});

test('real k6: 3 VUs x 2 iterations over 6 rows use six different rows', options, async () => {
  const { rows } = await runWithK6({
    load: { mode: 'iterations', vus: '3', iterations: '2' },
    dataSet: { content: csv(6), share: 'next-row', onEnd: 'recycle' },
  });
  assert.equal(new Set(rows).size, 6);
});

test('real k6: when rows run out with "stop", extra iterations send nothing and one warning is logged', options, async () => {
  const { rows, output } = await runWithK6({
    load: { mode: 'iterations', vus: '4', iterations: '1' },
    dataSet: { content: csv(3), share: 'next-row', onEnd: 'stop' },
  });
  assert.equal(rows.length, 3);
  assert.equal(output.match(/has no more rows \(3\)/g)?.length, 1);
});

test('real k6: per-vu gives VU n row n and wraps around', options, async () => {
  const { rows } = await runWithK6({
    load: { mode: 'iterations', vus: '4', iterations: '1' },
    dataSet: { content: csv(3), share: 'per-vu', onEnd: 'recycle' },
  });
  assert.deepEqual(rows, ['user1@example.com/pass1', 'user1@example.com/pass1', 'user2@example.com/pass2', 'user3@example.com/pass3']);
});
