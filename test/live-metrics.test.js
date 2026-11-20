// Live metrics (server/live-metrics.js, k6-runner.js, /api/run): reading k6's
// /v1/metrics answer, polling it (a fake REST server), and the runner with a fake k6
// that serves that API on the --address it is given. Nothing here needs real k6.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, readLiveMetrics, startMetricsPoller } from '../server/live-metrics.js';
import { startK6Run } from '../server/k6-runner.js';
import { createServer } from '../server/index.js';
import { readLiveOutcomeThresholdResults } from '../public/js/shared/outcome-thresholds.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));

// One /v1/metrics answer as k6 v2.4.0 gives it (trimmed to the fields read).
function restAnswer({ success = 0, quota = 0, vus = 2 } = {}) {
  const metric = (id, type, sample) => ({ type: 'metrics', id, attributes: { type, contains: 'default', tainted: null, sample } });
  return {
    data: [
      metric('vus', 'gauge', { value: vus }),
      metric('http_reqs', 'counter', { count: success + quota, rate: 19.5 }),
      metric('http_req_duration', 'trend', { avg: 1.25, max: 6.4, med: 0.6, min: 0.2, 'p(90)': 1.4, 'p(95)': 4.5 }),
      metric('http_req_duration{expected_response:true}', 'trend', { avg: 1, 'p(95)': 4 }),
      metric('http_req_failed', 'rate', { rate: 0.25 }),
      metric('k6ui_outcome', 'counter', { count: success + quota, rate: 19.5 }),
      metric('k6ui_outcome{rq:1,outcome:success}', 'counter', { count: success, rate: 10 }),
      metric('k6ui_outcome{rq:1,outcome:quota_reached}', 'counter', { count: quota, rate: 9.5 }),
      metric('k6ui_outcome{rq:1,outcome:other}', 'counter', { count: 0, rate: 0 }),
      metric('checks', 'rate', { rate: 1 }),
    ],
  };
}

test('readLiveMetrics: the values of a /v1/metrics answer, outcome submetrics by key', () => {
  assert.deepEqual(readLiveMetrics(restAnswer({ success: 12, quota: 7, vus: 4 })), {
    vus: 4,
    requests: 19,
    requestRate: 19.5,
    durationAvg: 1.25,
    durationP95: 4.5,
    failedRate: 0.25,
    outcomeCounts: {
      'k6ui_outcome{rq:1,outcome:success}': 12,
      'k6ui_outcome{rq:1,outcome:quota_reached}': 7,
      'k6ui_outcome{rq:1,outcome:other}': 0,
    },
  });
});

test('readLiveMetrics: values k6 has not reported yet are null; anything else is not an answer', () => {
  assert.deepEqual(readLiveMetrics({ data: [] }), {
    vus: null, requests: null, requestRate: null, durationAvg: null, durationP95: null, failedRate: null, outcomeCounts: {},
  });
  assert.deepEqual(readLiveMetrics({ data: [{ id: 'vus', attributes: { sample: { value: 'x' } } }, null, { id: 7 }] }).vus, null);
  for (const body of [null, undefined, 'text', 42, [], {}, { data: {} }]) assert.equal(readLiveMetrics(body), null);
});

test('freePort: a port on 127.0.0.1 that can be listened on', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(done => server.close(done));
});

// A fake k6 REST API: answer(n) decides what the n-th poll gets.
async function fakeRest(answer) {
  let polls = 0;
  const server = http.createServer((req, res) => {
    polls += 1;
    if (req.url !== '/v1/metrics') {
      res.statusCode = 404;
      res.end();
      return;
    }
    answer(polls, req, res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/metrics`,
    polls: () => polls,
    close: () => {
      server.closeAllConnections?.();
      return new Promise(done => server.close(done));
    },
  };
}

const json = (res, body) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

test('poller: one metrics call per answer, every interval, counts as k6 gives them', async () => {
  const rest = await fakeRest((n, _req, res) => json(res, restAnswer({ success: n * 3, quota: n })));
  const seen = [];
  const poller = startMetricsPoller({ url: rest.url, intervalMs: 50, onMetrics: metrics => seen.push(metrics) });
  try {
    await sleep(25);
    assert.equal(seen.length, 0, 'the first poll waits one interval');
    while (seen.length < 4) await sleep(10);
  } finally {
    poller.stop();
    await rest.close();
  }
  const firstFour = seen.slice(0, 4);
  assert.deepEqual(firstFour.map(metrics => metrics.outcomeCounts['k6ui_outcome{rq:1,outcome:success}']), [3, 6, 9, 12]);
  assert.deepEqual(firstFour.map(metrics => metrics.requests), [4, 8, 12, 16]);
});

test('poller: a failed poll is skipped and the next one still reads', async () => {
  // 1: 500, 2: not JSON, 3: connection dropped, 4: no answer in time, 5: not k6's shape, 6+: an answer.
  const rest = await fakeRest((n, req, res) => {
    if (n === 1) {
      res.statusCode = 500;
      res.end('{}');
    } else if (n === 2) res.end('{not json');
    else if (n === 3) req.socket.destroy();
    else if (n === 4) return;
    else if (n === 5) json(res, { error: 'nope' });
    else json(res, restAnswer({ success: n }));
  });
  const seen = [];
  let threw = 0;
  const poller = startMetricsPoller({
    url: rest.url,
    intervalMs: 60,
    onMetrics: metrics => {
      seen.push(metrics);
      if (seen.length === 1) {
        threw += 1;
        throw new Error('a broken listener does not stop the polling either');
      }
    },
  });
  try {
    const deadline = Date.now() + 5000;
    while (seen.length < 2 && Date.now() < deadline) await sleep(10);
  } finally {
    poller.stop();
    await rest.close();
  }
  assert.equal(threw, 1);
  assert.deepEqual(seen.map(metrics => metrics.outcomeCounts['k6ui_outcome{rq:1,outcome:success}']), [6, 7]);
});

test('poller: nothing listening is only a skipped poll', async () => {
  const port = await freePort();
  const seen = [];
  const poller = startMetricsPoller({ url: `http://127.0.0.1:${port}/v1/metrics`, intervalMs: 20, onMetrics: m => seen.push(m) });
  await sleep(150);
  poller.stop();
  assert.deepEqual(seen, []);
});

test('poller: stop() ends it at once, an answer on its way included', async () => {
  let release = null;
  const rest = await fakeRest((n, _req, res) => {
    if (n === 1) json(res, restAnswer({ success: 1 }));
    else release = () => json(res, restAnswer({ success: n })); // held until after stop()
  });
  const seen = [];
  const poller = startMetricsPoller({ url: rest.url, intervalMs: 40, onMetrics: m => seen.push(m) });
  try {
    while (!release) await sleep(5);
    poller.stop();
    release();
    const polls = rest.polls();
    await sleep(200);
    assert.equal(seen.length, 1);
    assert.equal(rest.polls(), polls, 'no poll after stop()');
  } finally {
    poller.stop();
    await rest.close();
  }
});

test('live target statuses: what the count so far already says', () => {
  const target = (op, resolved, extra = {}) => ({
    number: 1, request: 'r1', rq: 1, label: 'success', op, value: String(resolved), resolved,
    expression: `count${op}${resolved}`, skipped: '', ...extra,
  });
  const status = (op, resolved, count) => readLiveOutcomeThresholdResults(
    [target(op, resolved)], { 'k6ui_outcome{rq:1,outcome:success}': count },
  )[0].status;
  assert.equal(status('<=', 3, 3), 'on-track');
  assert.equal(status('<=', 3, 4), 'not-met');
  assert.equal(status('<', 3, 2), 'on-track');
  assert.equal(status('<', 3, 3), 'not-met');
  assert.equal(status('>=', 3, 2), 'not-yet');
  assert.equal(status('>=', 3, 3), 'met');
  assert.equal(status('>', 3, 3), 'not-yet');
  assert.equal(status('>', 3, 4), 'met');
  assert.equal(status('==', 3, 2), 'not-yet');
  assert.equal(status('==', 3, 3), 'on-track');
  assert.equal(status('==', 3, 4), 'not-met');

  const [counted] = readLiveOutcomeThresholdResults([target('<=', 3)], { 'k6ui_outcome{rq:1,outcome:success}': 2 });
  assert.equal(counted.count, 2);
  assert.equal(counted.expression, 'count<=3');
  const [noCount] = readLiveOutcomeThresholdResults([target('<=', 3)], {});
  assert.deepEqual([noCount.status, noCount.count], ['unknown', null]);
  const [skipped] = readLiveOutcomeThresholdResults([target('<=', 3, { rq: null, skipped: 'it is turned off' })], {});
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(readLiveOutcomeThresholdResults(null, {}), []);
});

// A fake `k6` (Node) on PATH: records its arguments, serves a REST API on the
// --address it gets (mode "counts": counts that grow with every poll; "broken":
// every poll fails; "none": nothing listens), then writes the summary and exits
// after K6UI_FAKE_RUN_MS. SIGTERM (stop) ends it like k6.
const FAKE_K6 = `
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const valueOf = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const mode = process.env.K6UI_FAKE_REST || 'counts';
if (process.env.K6UI_FAKE_ARGS) fs.writeFileSync(process.env.K6UI_FAKE_ARGS, JSON.stringify(args));
const address = valueOf('--address');
let polls = 0;
if (address && mode !== 'none') {
  const at = address.lastIndexOf(':');
  http.createServer((req, res) => {
    polls += 1;
    if (mode === 'broken') {
      if (polls % 3 === 1) { res.statusCode = 500; res.end('{}'); }
      else if (polls % 3 === 2) res.end('{not json');
      else req.socket.destroy();
      return;
    }
    const metric = (id, sample) => ({ type: 'metrics', id, attributes: { sample } });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [
      metric('vus', { value: 2 }),
      metric('http_reqs', { count: polls * 5, rate: 10 }),
      metric('http_req_duration', { avg: 1.5, 'p(95)': 3.25 }),
      metric('http_req_failed', { rate: 0 }),
      metric('k6ui_outcome{rq:1,outcome:success}', { count: polls * 3, rate: 6 }),
      metric('k6ui_outcome{rq:1,outcome:quota_reached}', { count: polls * 2, rate: 4 }),
      metric('k6ui_outcome{rq:1,outcome:other}', { count: 0, rate: 0 }),
    ] }));
  }).listen(Number(address.slice(at + 1)), address.slice(0, at));
}
setTimeout(() => {
  const summary = valueOf('--summary-export');
  if (summary) fs.writeFileSync(summary, JSON.stringify({ metrics: { http_reqs: { count: polls * 5 } } }));
  process.exit(0);
}, Number(process.env.K6UI_FAKE_RUN_MS || 1000));
`;

async function withFakeK6(env, callback) {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-rest-'));
  await writeFile(join(binDir, 'k6'), `#!${process.execPath}\n${FAKE_K6}`, 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const saved = { PATH: process.env.PATH };
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  Object.assign(process.env, env);
  try {
    return await callback(binDir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(binDir, { recursive: true, force: true });
  }
}

function runFake(options = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let run = null;
    startK6Run('export default function () {}', {
      metricsIntervalMs: 100,
      ...options,
      onEvent: (event, data) => {
        events.push({ event, data, at: Date.now() });
        options.onEvent?.(event, data, run);
      },
      onEnd: () => resolve(events),
    }).then(started => { run = started; }, reject);
  });
}

const successCount = data => data.outcomeCounts['k6ui_outcome{rq:1,outcome:success}'];

test('runner: k6 gets a free --address, and metrics events with growing counts come before done', async () => {
  await withFakeK6({ K6UI_FAKE_REST: 'counts', K6UI_FAKE_RUN_MS: '700' }, async binDir => {
    const argsFile = join(binDir, 'args.json');
    process.env.K6UI_FAKE_ARGS = argsFile;
    const events = await runFake();
    delete process.env.K6UI_FAKE_ARGS;
    const args = JSON.parse(await readFile(argsFile, 'utf8'));
    const address = args[args.indexOf('--address') + 1];
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    assert.equal(args.at(-1).endsWith('test.js'), true, 'the script stays the last argument');

    const names = events.map(item => item.event);
    const metrics = events.filter(item => item.event === 'metrics').map(item => item.data);
    assert.ok(metrics.length >= 3, `expected a few metrics events, got ${metrics.length}`);
    assert.equal(names.at(-1), 'done', 'nothing comes after done');
    assert.equal(names.indexOf('done'), names.length - 1);
    const counts = metrics.map(successCount);
    assert.ok(counts.every((count, index) => count % 3 === 0 && (index === 0 || count > counts[index - 1])),
      `counts grow from one event to the next: ${counts}`);
    assert.deepEqual(Object.keys(metrics[0]).sort(),
      ['durationAvg', 'durationP95', 'failedRate', 'outcomeCounts', 'requestRate', 'requests', 'vus']);
    assert.equal(metrics[0].vus, 2);
  });
});

test('runner: polls that all fail never touch the run', async () => {
  for (const mode of ['broken', 'none']) {
    await withFakeK6({ K6UI_FAKE_REST: mode, K6UI_FAKE_RUN_MS: '500' }, async () => {
      const events = await runFake();
      const names = events.map(item => item.event);
      assert.deepEqual(names.filter(name => name === 'metrics' || name === 'error'), [], mode);
      const done = events.find(item => item.event === 'done');
      assert.equal(done?.data.code, 0, mode);
      assert.equal(done?.data.outcome, 'passed', mode);
      assert.equal(done?.data.summary?.metrics?.http_reqs?.count >= 0, true, mode);
    });
  }
});

test('runner: stop() ends the polling at once', async () => {
  await withFakeK6({ K6UI_FAKE_REST: 'counts', K6UI_FAKE_RUN_MS: '20000' }, async () => {
    let stoppedAt = 0;
    const events = await runFake({
      onEvent: (event, _data, run) => {
        if (event === 'metrics' && !stoppedAt) {
          stoppedAt = Date.now();
          run.stop();
        }
      },
    });
    assert.ok(stoppedAt, 'a metrics event came before stop');
    const late = events.filter(item => item.event === 'metrics' && item.at > stoppedAt);
    assert.deepEqual(late, []);
    assert.equal(events.at(-1).event, 'done');
  });
});

// /api/run: the route adds `outcomes` and live `outcomeThresholds` to each metrics event.
test('/api/run: metrics events carry live outcomes and target statuses', { timeout: 20_000 }, async () => {
  await withFakeK6({ K6UI_FAKE_REST: 'counts', K6UI_FAKE_RUN_MS: '2600' }, async () => {
    const app = createServer({ port: 0, host: '127.0.0.1' });
    await once(app, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.address().port}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: {
            requests: [{
              id: 'req_redeem', name: 'Redeem', method: 'POST', url: 'http://127.0.0.1:9/never-contacted',
              outcomes: {
                rules: [
                  { label: 'success', status: '200', source: 'none' },
                  { label: 'quota_reached', status: '400', source: 'none' },
                ],
                fallback: 'other',
              },
            }],
          },
          thresholds: {
            p95: '', errorRate: '',
            outcomes: [
              { request: 'req_redeem', label: 'success', op: '<=', value: '4' },
              { request: 'req_redeem', label: 'quota_reached', op: '>=', value: '3' },
            ],
          },
          load: { mode: 'simple', vus: '1', duration: '1s' },
        }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).split(/\n\n/).filter(Boolean).map(chunk => ({
        event: /^event: (.+)$/m.exec(chunk)?.[1],
        data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null'),
      }));
      const metrics = events.filter(item => item.event === 'metrics').map(item => item.data);
      assert.ok(metrics.length >= 2, `expected at least two metrics events, got ${metrics.length}`);
      const [first, second] = metrics;
      assert.deepEqual(first.outcomes, [{
        rq: 1, name: 'Redeem', method: 'POST', url: 'http://127.0.0.1:9/never-contacted', fallback: 'other', total: 5,
        outcomes: [
          { label: 'success', count: 3, share: 0.6 },
          { label: 'quota_reached', count: 2, share: 0.4 },
          { label: 'other', count: 0, share: 0 },
        ],
      }]);
      assert.deepEqual(first.outcomeThresholds.map(target => [target.number, target.status, target.count]),
        [[1, 'on-track', 3], [2, 'not-yet', 2]]);
      assert.deepEqual(second.outcomeThresholds.map(target => [target.number, target.status, target.count]),
        [[1, 'not-met', 6], [2, 'met', 4]]);
      assert.equal(events.at(-1).event, 'done');
    } finally {
      app.closeAllConnections?.();
      await new Promise(done => app.close(done));
    }
  });
});
