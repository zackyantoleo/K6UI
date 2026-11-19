// Expected statuses with the real k6 binary through POST /api/run (skipped when `k6`
// is not on PATH): a 400 the request expects is not a failed request (http_req_failed
// 0%), passes the status check and is a passed record; without the list the same 400s
// fail. {{$outcome}} saves each response's label to CSV.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';

import { createServer } from '../server/index.js';

function hasK6() {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const options = { skip: !hasK6() && 'the k6 binary is not on PATH', timeout: 90_000 };

// Synthetic voucher endpoint on 127.0.0.1: the first two redeems succeed, every
// later one is turned away with a 400 because the quota is gone.
function target() {
  let calls = 0;
  return http.createServer((req, res) => {
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    if (calls <= 2) return res.end('{"data":{"redeemed":true}}');
    res.statusCode = 400;
    res.end('{"error":{"code":"PROM-422001"}}');
  });
}

async function runStream(config) {
  const app = createServer({ port: 0, host: '127.0.0.1' });
  await once(app, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    return text.split(/\n\n/).filter(Boolean).map(chunk => ({
      event: /^event: (.+)$/m.exec(chunk)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null'),
    }));
  } finally {
    app.closeAllConnections?.();
    await new Promise(done => app.close(done));
  }
}

async function runRedeems(expectedStatuses) {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    return await runStream({
      load: { mode: 'iterations', vus: '4', iterations: '3' },
      options: { logRequests: true, logFilter: 'all' },
      scenario: {
        requests: [{
          id: 'req_redeem', name: 'Redeem voucher', method: 'POST', body: '{}', checkStatus: true, sleepAfter: '0',
          url: `http://127.0.0.1:${server.address().port}/redeem`,
          ...(expectedStatuses ? { expectedStatuses } : {}),
          outcomes: {
            rules: [
              { label: 'success', status: '2xx', source: 'none' },
              { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
            ],
            fallback: 'other',
          },
          exports: [{ file: 'redeems.csv', columns: [{ name: 'outcome', value: '{{$outcome}}' }] }],
        }],
      },
      thresholds: { p95: '', errorRate: '' },
    });
  } finally {
    server.close();
  }
}

const statusCheck = (done, name) => done.summary.root_group.checks[name];

test('real k6: an expected 400 is not a failed request, passes the status check and is a passed record', options, async () => {
  const events = await runRedeems('200,400');
  const done = events.find(item => item.event === 'done')?.data;
  assert.equal(done.code, 0);
  const failed = done.summary.metrics.http_req_failed;
  assert.equal(failed.value, 0, 'http_req_failed 0%');
  assert.equal(done.summary.metrics.http_reqs.count, 12);
  assert.deepEqual(
    { passes: statusCheck(done, 'status 200,400: request 1').passes, fails: statusCheck(done, 'status 200,400: request 1').fails },
    { passes: 12, fails: 0 },
  );
  const records = events.filter(item => item.event === 'req-log').map(item => item.data);
  assert.equal(records.length, 12);
  assert.ok(records.every(record => record.ok === true), 'every record passed');
  assert.deepEqual(records.map(record => `${record.s}:${record.oc}`).sort(), [
    ...Array(2).fill('200:success'), ...Array(10).fill('400:quota_reached'),
  ].sort());
  const rows = events.filter(item => item.event === 'export').flatMap(item => item.data.rows);
  assert.deepEqual(rows.map(row => row[0]).sort(), [...Array(2).fill('success'), ...Array(10).fill('quota_reached')].sort());
  assert.deepEqual(done.outcomes[0].outcomes.map(item => [item.label, item.count]), [['success', 2], ['quota_reached', 10], ['other', 0]]);
});

test('real k6: without expected statuses the same 400s are failed requests and fail the status check', options, async () => {
  const events = await runRedeems('');
  const done = events.find(item => item.event === 'done')?.data;
  assert.equal(done.summary.metrics.http_req_failed.value, 10 / 12);
  const check = statusCheck(done, 'status 2xx: request 1');
  assert.deepEqual({ passes: check.passes, fails: check.fails }, { passes: 2, fails: 10 });
  const records = events.filter(item => item.event === 'req-log').map(item => item.data);
  assert.equal(records.filter(record => record.ok === false).length, 10);
});
