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

const options = { skip: !hasK6() && 'the k6 binary is not on PATH' };

// Runs a generated script with the real k6 against a throwaway server on 127.0.0.1;
// `build(origin)` returns the config. → the paths the server saw (sorted) and k6's output.
async function runWithK6(build) {
  const paths = [];
  const server = http.createServer((req, res) => { paths.push(req.url); res.end('{"token":"T1"}'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-runif-'));
  try {
    const script = generateScript(build(`http://127.0.0.1:${server.address().port}`));
    const file = join(dir, 'test.js');
    await writeFile(file, script);
    const { stdout, stderr } = await run('k6', ['run', '--quiet', file], {
      timeout: 60_000, env: { ...process.env, K6_NO_USAGE_REPORT: 'true' },
    });
    return { paths: paths.sort(), output: `${stdout}\n${stderr}` };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const get = (url, extra = {}) => ({ method: 'GET', url, checkStatus: false, sleepAfter: '0', ...extra });
const load = { mode: 'iterations', vus: '1', iterations: '1' };

// The eratech shape: the first group runs for ORDER_FLOW or ALL, the second one is turned off.
const flows = (origin, mode, extra = {}) => ({
  load,
  variables: [{ key: 'EXECUTION_MODE', value: mode }],
  scenario: {
    groups: [
      { id: 'grp_order', name: 'Order flow', enabled: true, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] } },
      { id: 'grp_redeem', name: 'Redeem flow', enabled: false, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['REDEEM_FLOW', 'ALL'] } },
    ],
    requests: [
      get(`${origin}/health`),
      get(`${origin}/order/login`, { groupId: 'grp_order', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] }),
      get(`${origin}/order/pay/{{token}}`, { groupId: 'grp_order' }),
      get(`${origin}/redeem`, { groupId: 'grp_redeem' }),
      get(`${origin}/after/{{token}}`),
    ],
  },
  ...extra,
});

test('real k6: EXECUTION_MODE=ORDER_FLOW runs the order flow, and the extracted token is readable after it', options, async () => {
  const { paths } = await runWithK6(origin => flows(origin, 'ORDER_FLOW'));
  assert.deepEqual(paths, ['/after/T1', '/health', '/order/login', '/order/pay/T1']);
});

test('real k6: ALL runs it too, and the turned-off redeem flow never runs', options, async () => {
  const { paths } = await runWithK6(origin => flows(origin, 'ALL'));
  assert.deepEqual(paths, ['/after/T1', '/health', '/order/login', '/order/pay/T1']);
});

test('real k6: any other value skips the group; the request after it sees an empty token', options, async () => {
  const { paths } = await runWithK6(origin => flows(origin, 'REDEEM_FLOW'));
  assert.deepEqual(paths, ['/after/', '/health']);
});

test('real k6: a data file of a skipped group never ends the iteration; of a running group it does', options, async () => {
  const dataSet = { id: 'ds_login', name: 'login.csv', skipHeader: true, columns: ['email'], content: 'email\nuser1@example.com\n', onEnd: 'stop', groupId: 'grp_order' };
  const build = mode => origin => flows(origin, mode, {
    load: { mode: 'iterations', vus: '3', iterations: '1' },
    dataSets: [dataSet],
  });

  // Off: three iterations, none reads the file, so none stops early and nothing is logged.
  const off = await runWithK6(build('REDEEM_FLOW'));
  assert.deepEqual(off.paths, ['/after/', '/after/', '/after/', '/health', '/health', '/health']);
  assert.doesNotMatch(off.output, /has no more rows/);

  // On: one row for three iterations, so two of them end when the group starts.
  const on = await runWithK6(build('ORDER_FLOW'));
  assert.equal(on.paths.filter(path => path === '/health').length, 3);
  assert.equal(on.paths.filter(path => path === '/order/login').length, 1);
  assert.equal(on.output.match(/has no more rows \(1\)/g)?.length, 1);
});
