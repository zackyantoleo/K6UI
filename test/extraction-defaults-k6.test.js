// Extraction defaults with the real k6 binary (skipped when `k6` is not on PATH):
// a missing JSON path, a body that is not JSON, and a skipped "Run only if" group
// all give the default, and the iteration carries on.
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

// Synthetic responses only: no credentials, no real service.
const RESPONSES = {
  '/login': '{"data":{}}',
  '/login-ok': '{"data":{"token":"T1"}}',
  '/gateway': '<html>502 Bad Gateway</html>',
  '/address': '{"data":{"address":{"id":42}}}',
};

// Runs a generated script with the real k6 against a throwaway server on 127.0.0.1.
// → the paths the server saw (sorted) and k6's output.
async function runWithK6(build) {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.end(RESPONSES[req.url] ?? '{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-defaults-'));
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

// The eratech shape: login → (conditional) get address → use both.
const flow = (origin, { mode, login = '/login' }) => ({
  load: { mode: 'iterations', vus: '1', iterations: '1' },
  variables: [{ key: 'EXECUTION_MODE', value: mode }],
  scenario: {
    groups: [{ id: 'grp_order', name: 'Order flow', enabled: true, runIf: { variable: 'EXECUTION_MODE', operator: 'equals', values: ['ORDER_FLOW'] } }],
    requests: [
      get(`${origin}${login}`, { extractions: [{ varName: 'token', source: 'json', selector: 'data.token', default: 'TOKEN_NOT_FOUND' }] }),
      get(`${origin}/gateway`, {
        extractions: [
          { varName: 'page', source: 'json', selector: 'data.page', default: 'NOT_JSON' },
          { varName: 'rid', source: 'regex', selector: 'id=(\\d+)', default: 'NO_ID' },
        ],
      }),
      get(`${origin}/address`, { groupId: 'grp_order', extractions: [{ varName: 'address_id', source: 'json', selector: 'data.address.id', default: 'ADDRESS_ID_NOT_FOUND' }] }),
      get(`${origin}/use/{{token}}/{{page}}/{{rid}}/{{address_id}}`),
    ],
  },
});

test('real k6: nothing found and a skipped group give the defaults, without a script error', options, async () => {
  const { paths, output } = await runWithK6(origin => flow(origin, { mode: 'REDEEM_FLOW' }));
  assert.deepEqual(paths, ['/gateway', '/login', '/use/TOKEN_NOT_FOUND/NOT_JSON/NO_ID/ADDRESS_ID_NOT_FOUND']);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ReferenceError|level=error/);
});

test('real k6: values that are found win over the defaults', options, async () => {
  const { paths, output } = await runWithK6(origin => flow(origin, { mode: 'ORDER_FLOW', login: '/login-ok' }));
  assert.deepEqual(paths, ['/address', '/gateway', '/login-ok', '/use/T1/NOT_JSON/NO_ID/42']);
  assert.doesNotMatch(output, /SyntaxError|TypeError|ReferenceError|level=error/);
});
