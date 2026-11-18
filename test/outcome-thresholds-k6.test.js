// Outcome targets with the real k6 binary through POST /api/run (skipped when `k6` is
// not on PATH): `success <= {{QUOTA}}` passes when the quota holds and fails (exit
// code 99) when more responses succeeded, and `done` says which target was met.
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
// later one is turned away because the quota is gone.
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

async function runRedeems(quota) {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redeem = {
    method: 'POST', body: '{}', checkStatus: false, sleepAfter: '0',
    outcomes: {
      rules: [
        { label: 'success', status: '2xx', source: 'none' },
        { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
      ],
      fallback: 'other',
    },
  };
  try {
    const events = await runStream({
      variables: [{ key: 'QUOTA', value: String(quota) }],
      load: { mode: 'iterations', vus: '4', iterations: '3' },
      scenario: {
        requests: [
          { ...redeem, id: 'req_warm', name: 'Warm up', url: `${origin}/warm`, enabled: false },
          { ...redeem, id: 'req_redeem', name: 'Redeem voucher', url: `${origin}/redeem` },
        ],
      },
      thresholds: {
        p95: '', errorRate: '',
        outcomes: [
          { request: 'req_redeem', label: 'success', op: '<=', value: '{{QUOTA}}' },
          { request: 'req_redeem', label: 'other', op: '==', value: '0' },
          { request: 'req_redeem', label: 'quota_reached', op: '>', value: '0' },
          { request: 'req_warm', label: 'success', op: '>', value: '0' },
        ],
      },
    });
    return events.find(item => item.event === 'done')?.data;
  } finally {
    server.close();
  }
}

const statuses = done => done.outcomeThresholds.map(item => [item.number, item.status, item.count]);

test('real k6: success <= {{QUOTA}} is met when no more than the quota succeeded', options, async () => {
  const done = await runRedeems(2);
  assert.equal(done.code, 0);
  assert.equal(done.outcome, 'passed');
  assert.deepEqual(statuses(done), [[1, 'met', 2], [2, 'met', 0], [3, 'met', 10], [4, 'skipped', null]]);
  assert.equal(done.outcomeThresholds[0].resolved, 2);
  assert.equal(done.outcomeThresholds[0].value, '{{QUOTA}}');
  const success = done.summary.metrics['k6ui_outcome{rq:1,outcome:success}'];
  assert.deepEqual(success.thresholds, { 'count>=0': false, 'count<=2': false });
});

test('real k6: more successes than the quota fail the target and k6 exits with 99', options, async () => {
  const done = await runRedeems(1);
  assert.equal(done.code, 99);
  assert.equal(done.outcome, 'threshold-failed');
  assert.deepEqual(statuses(done), [[1, 'not-met', 2], [2, 'met', 0], [3, 'met', 10], [4, 'skipped', null]]);
  const success = done.summary.metrics['k6ui_outcome{rq:1,outcome:success}'];
  assert.deepEqual(success.thresholds, { 'count>=0': false, 'count<=1': true });
});
