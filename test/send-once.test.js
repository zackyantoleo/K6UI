// Send once (POST /api/send-once, server/send-once.js): the one-request project,
// reading k6's output, the limits, and a real send with k6 to a local target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server/index.js';
import { generateScript } from '../server/generator/index.js';
import {
  SEND_ONCE_LIMITS, readOutputLine, sendOnce, sendOnceConfig, sendOnceResult, unresolvedNames,
} from '../server/send-once.js';

const project = (extra = {}) => ({
  variables: [{ key: 'base_url', value: 'http://127.0.0.1:9' }],
  globalHeaders: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Level', value: 'global' }],
  load: { mode: 'race', vus: '5', race: { request: 'req_me' } },
  thresholds: { p95: '300', errorRate: '1', outcomes: [{ request: 'req_me', label: 'ok', op: '>', value: '1' }] },
  options: { logRequests: true, logFilter: 'errors', logRedact: true },
  scenario: {
    groups: [{ id: 'grp_a', name: 'Account', enabled: false, headers: [{ key: 'X-Level', value: 'group' }], runIf: { variable: 'base_url', operator: 'equals', values: ['x'] } }],
    requests: [
      { id: 'req_login', name: 'Log in', type: 'http', method: 'POST', url: '{{base_url}}/login', body: '{}', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] },
      {
        id: 'req_me', name: 'Me', type: 'http', method: 'GET', url: '{{base_url}}/me', groupId: 'grp_a', enabled: false,
        headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], checkStatus: true, sleepAfter: '3',
        extractions: [{ varName: 'id', source: 'json', selector: 'id' }], assertions: [{ type: 'status-eq', value: '200', value2: '' }],
        exports: [{ file: 'a.csv', columns: [{ name: 'id', value: '{{id}}' }] }],
        outcomes: { rules: [{ label: 'ok', status: '200', source: 'none', selector: '', operator: 'equals', value: '' }], fallback: 'other' },
        preScript: 'vars.ts = Date.now();', postScript: 'vars.x = 1;',
      },
      { id: 'req_old', name: 'Old', type: 'http', method: 'GET', url: '{{base_url}}/old', pre: { method: 'GET', url: '{{base_url}}/warm' } },
    ],
  },
  ...extra,
});

test('sendOnceConfig keeps only that request: on, in its group without the condition, nothing after the response, 1 VU once', () => {
  const config = sendOnceConfig(project(), 'req_me');
  assert.deepEqual(config.load, { mode: 'iterations', vus: '1', iterations: '1', maxDuration: '20s' });
  assert.deepEqual(config.thresholds, {});
  assert.deepEqual(config.options, { logRequests: true, logFilter: 'all', logRedact: false });
  assert.equal(config.scenario.requests.length, 1);
  const [request] = config.scenario.requests;
  assert.equal(request.id, 'req_me');
  assert.equal(request.enabled, true);
  assert.equal(request.sleepAfter, '0');
  assert.deepEqual([request.extractions, request.assertions, request.postScript, request.exports, request.outcomes], [[], [], '', undefined, undefined]);
  assert.equal(request.preScript, 'vars.ts = Date.now();');
  assert.deepEqual(config.scenario.groups[0], { ...project().scenario.groups[0], enabled: true, runIf: null });
  assert.deepEqual([config.variables, config.globalHeaders], [project().variables, project().globalHeaders]);

  // A Before sub-request of an older project is its own request.
  assert.equal(sendOnceConfig(project(), 'req_old_before').scenario.requests[0].url, '{{base_url}}/warm');

  const script = generateScript(config, null, { logBodyLimit: SEND_ONCE_LIMITS.bodyChars });
  assert.match(script, /"per-vu-iterations"[\s\S]*"vus": 1,\s*"iterations": 1,\s*"maxDuration": "20s"/);
  assert.match(script, /"X-Level": "group"/, 'group header over the shared one');
  assert.match(script, /"Accept": "application\/json"/);
  assert.match(script, /"bodyLimit":262144/);
  assert.doesNotMatch(script, /thresholds|outcomeOf_|k6uiExport|k6uiRace/);
  const flow = script.slice(script.indexOf('export default function'));
  assert.doesNotMatch(flow, /sleep\(|if \(|Post-processor|let id =/);
  assert.match(script, /Pre-processor: request 1/);
});

test('sendOnceConfig refuses what cannot be sent', () => {
  assert.throws(() => sendOnceConfig(null, 'x'), { status: 400, message: /Send the project/ });
  assert.throws(() => sendOnceConfig(project(), ''), { status: 400, message: /Choose the request/ });
  assert.throws(() => sendOnceConfig(project(), 'req_gone'), { status: 400, message: /not in the project/ });
  const blank = project();
  blank.scenario.requests[0].url = '  ';
  assert.throws(() => sendOnceConfig(blank, 'req_login'), { status: 400, message: /Type a URL first/ });
});

test('k6 output: the record, messages without the temp path, cut bodies and {{names}} left as text', () => {
  const record = {
    __r: 1, vu: 1, it: 0, i: 0, m: 'GET', url: 'http://127.0.0.1:9/me?x={{ token }}', s: 200, d: 12.5, ok: true, er: '',
    rqh: { Authorization: ['Bearer {{token}}'], 'X-Id': '{{$outcome}}' }, rq: '',
    rh: { 'Content-Type': 'application/json' }, rb: `{"a":"<b>"}\n… [70 more characters not shown]`,
  };
  const line = JSON.stringify({ level: 'info', msg: JSON.stringify(record), source: 'console' });
  assert.deepEqual(readOutputLine(line).record, record);
  assert.deepEqual(readOutputLine(JSON.stringify({ level: 'error', msg: 'Error: boom\n\tat default (file:///tmp/k6ui-send-once-x/script.js:7:9(26))\n', source: 'stacktrace' })).message,
    { level: 'error', text: 'Error: boom\n\tat default (script.js:7:9(26))' });
  assert.deepEqual(readOutputLine(JSON.stringify({ level: 'warning', msg: 'Request Failed', error: 'dial tcp: connection refused' })).message,
    { level: 'warning', text: 'Request Failed: dial tcp: connection refused' });
  assert.equal(readOutputLine('  █ TOTAL RESULTS'), null);
  assert.deepEqual(unresolvedNames(record), ['$outcome', 'token']);
  const result = sendOnceResult(record);
  assert.deepEqual(result.response, {
    status: 200, durationMs: 12.5, headers: { 'Content-Type': 'application/json' }, body: '{"a":"<b>"}', truncated: true, totalChars: 81,
  });
  assert.equal(result.request.headers.Authorization, 'Bearer {{token}}');
  assert.equal(result.sent, true);
});

// A fake k6 on PATH: prints one record (or sleeps); nothing is contacted.
async function fakeK6(body) {
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-fake-k6-'));
  await writeFile(join(dir, 'k6'), `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(join(dir, 'k6'), 0o755);
  return { dir, bin: join(dir, 'k6'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const RECORD_LINE = JSON.stringify({
  level: 'info', source: 'console',
  msg: JSON.stringify({ __r: 1, m: 'GET', url: 'http://127.0.0.1:9/me', s: 200, d: 3, ok: true, er: '', rqh: {}, rq: '', rh: { 'Content-Type': 'text/html' }, rb: '<script>alert(1)</script>' }),
});

test('POST /api/send-once answers JSON that is never sniffed or cached, and 400 for a request that cannot be sent', async () => {
  const fake = await fakeK6(`echo '${RECORD_LINE.replace(/'/g, "'\\''")}'`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fake.dir}:${previousPath}`;
  const server = createServer({ port: 0, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/send-once`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = await post({ config: project(), requestId: 'req_login' });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^application\/json/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const result = await ok.json();
    assert.equal(result.response.body, '<script>alert(1)</script>', 'markup comes back as text');
    assert.equal(result.response.status, 200);

    const missing = await post({ config: project(), requestId: 'nope' });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /not in the project/);
    const broken = await post({ config: { ...project(), dataSets: [{ name: 'u.csv', columns: ['a'], content: '"open\n' }] }, requestId: 'req_login' });
    assert.equal(broken.status, 400);
    assert.match((await broken.json()).error, /never closed/);
  } finally {
    process.env.PATH = previousPath;
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await fake.cleanup();
  }
});

test('Send once stops k6 after the timeout (504), allows only so many at once (429), and says when k6 is missing (503)', async () => {
  const fake = await fakeK6('exec sleep 30');
  try {
    const limits = { ...SEND_ONCE_LIMITS, timeoutMs: 300, concurrent: 1 };
    const started = Date.now();
    const slow = sendOnce(project(), 'req_login', { limits, k6: fake.bin });
    await assert.rejects(sendOnce(project(), 'req_login', { limits, k6: fake.bin }), { status: 429, message: /still running/ });
    await assert.rejects(slow, { status: 504, message: /No answer within 0 s/ });
    assert.ok(Date.now() - started < 5000, 'k6 was killed, not waited for');

    const controller = new AbortController();
    const aborted = sendOnce(project(), 'req_login', { limits: { ...limits, timeoutMs: 10_000 }, k6: fake.bin, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.deepEqual(await aborted, { sent: false, error: 'k6 ended without sending the request.', log: [] });

    await assert.rejects(sendOnce(project(), 'req_login', { k6: join(fake.dir, 'missing-k6') }), { status: 503, message: /k6 was not found/ });
  } finally {
    await fake.cleanup();
  }
});

let k6Installed = true;
try { execFileSync('k6', ['version'], { stdio: 'ignore' }); } catch { k6Installed = false; }

test('a real k6 sends the request as a run would and reads back the response', { skip: !k6Installed && 'k6 is not installed' }, async () => {
  const seen = [];
  const target = createHttpServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith('/big')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(5000));
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Request-Id': 'r-1' });
      res.end(JSON.stringify({ data: { token: 'abc', items: [{ id: 7 }] }, html: '<img src=x onerror=alert(1)>' }));
    });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const base = `http://127.0.0.1:${target.address().port}`;
  try {
    const config = {
      variables: [{ key: 'base_url', value: base }],
      globalHeaders: [{ key: 'X-Level', value: 'global' }, { key: 'Accept', value: 'application/json' }],
      dataSets: [{ id: 'ds', name: 'Users', fileName: 'u.csv', delimiter: ',', skipHeader: true, columns: [], content: 'email\nfirst@x.test\nsecond@x.test\n', share: 'next-row', onEnd: 'recycle' }],
      scenario: {
        groups: [{ id: 'grp', name: 'G', enabled: false, headers: [{ key: 'x-level', value: 'group' }], runIf: { variable: 'base_url', operator: 'equals', values: ['never'] } }],
        requests: [{
          id: 'req_login', type: 'http', method: 'POST', url: '{{base_url}}/login?u={{email}}', groupId: 'grp', enabled: false,
          headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }, { key: 'Content-Type', value: 'application/json' }],
          body: '{"email":"{{email}}","ts":"{{ts}}"}', preScript: 'vars.ts = "pre";', checkStatus: true, sleepAfter: '5',
        }, {
          id: 'req_big', type: 'http', method: 'GET', url: '{{base_url}}/big',
        }],
      },
    };
    const result = await sendOnce(config, 'req_login');
    assert.equal(seen.length, 1, 'one request, no warm-up and no other request');
    assert.equal(seen[0].url, '/login?u=first@x.test');
    assert.equal(seen[0].headers['x-level'], 'group');
    assert.equal(seen[0].headers.authorization, 'Bearer {{token}}');
    assert.equal(seen[0].body, '{"email":"first@x.test","ts":"pre"}');
    assert.equal(result.sent, true);
    assert.equal(result.ok, true);
    assert.equal(result.response.status, 201);
    assert.equal(result.response.headers['X-Request-Id'], 'r-1');
    assert.deepEqual(JSON.parse(result.response.body), { data: { token: 'abc', items: [{ id: 7 }] }, html: '<img src=x onerror=alert(1)>' });
    assert.deepEqual(result.unresolved, ['token']);
    assert.equal(result.request.url, `${base}/login?u=first@x.test`);

    const big = await sendOnce(config, 'req_big', { limits: { ...SEND_ONCE_LIMITS, bodyChars: 1000 } });
    assert.equal(big.response.body, 'x'.repeat(1000));
    assert.equal(big.response.truncated, true);
    assert.equal(big.response.totalChars, 5000);

    target.close();
    const refused = await sendOnce(config, 'req_big');
    assert.equal(refused.sent, true);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /refused/);
  } finally {
    target.close();
  }
});

// The message text of a k6 line is trimmed with trimEnd() after a cut: /\s+$/ took
// quadratic time on a long run of spaces (seconds for 100,000), with the server stuck.
test('readOutputLine: a megabyte line of spaces is cut and trimmed at once', () => {
  const msg = `start${' '.repeat(1024 * 1024)}end   `;
  const started = Date.now();
  const { message } = readOutputLine(JSON.stringify({ level: 'info', msg }));
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assert.equal(message.text, 'start');
  assert.equal(message.text.length <= SEND_ONCE_LIMITS.messageChars, true);
  const path = readOutputLine(JSON.stringify({ level: 'error', msg: `${'x'.repeat(400)} at file:///tmp/k6ui-send-once-abc/script.js:7:9   ` })).message.text;
  assert.equal(path, `${'x'.repeat(400)} at script.js:7:9`);
});

// A data file of another group is read when that group starts, which Send once never
// does: it reads the first row up front instead of sending its {{columns}} as "".
test('sendOnceConfig: data files of groups that are on read their first row; a turned-off group stays unused', () => {
  const config = {
    scenario: {
      groups: [{ id: 'grp_a', name: 'A' }, { id: 'grp_off', name: 'Off', enabled: false }, { id: 'grp_b', name: 'B', runIf: { variable: 'x', operator: 'equals', values: ['1'] } }],
      requests: [
        { id: 'r1', method: 'GET', url: 'http://127.0.0.1:9/a', groupId: 'grp_a' },
        { id: 'r2', method: 'GET', url: 'http://127.0.0.1:9/{{col_a}}/{{col_b}}/{{col_off}}', groupId: 'grp_b' },
      ],
    },
    dataSets: [
      { id: 'da', name: 'A', content: 'col_a\nVALUE_A\n', skipHeader: true, columns: [], groupId: 'grp_a' },
      { id: 'db', name: 'B', content: 'col_b\nVALUE_B\n', skipHeader: true, columns: [], groupId: 'grp_b' },
      { id: 'doff', name: 'Off', content: 'col_off\nVALUE_OFF\n', skipHeader: true, columns: [], groupId: 'grp_off' },
    ],
    load: { mode: 'simple', vus: '1', duration: '1s' },
  };
  const once = sendOnceConfig(config, 'r2');
  assert.deepEqual(once.dataSets.map(set => [set.id, set.groupId]), [['da', ''], ['db', ''], ['doff', 'grp_off']]);
  assert.equal(config.dataSets[0].groupId, 'grp_a', 'the project itself is unchanged');
  const script = generateScript(once);
  assert.match(script, /const DATA_1_ROW = DATA_1\[/);
  assert.match(script, /`http:\/\/127\.0\.0\.1:9\/\$\{DATA_1_ROW\.col_a\}\/\$\{DATA_2_ROW\.col_b\}\/\{\{col_off\}\}`/);
  assert.doesNotMatch(script, /let DATA_\d_ROW = \{/, 'no row is left empty');
});
