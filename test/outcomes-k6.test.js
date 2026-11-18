// Outcome rules with the real k6 binary through POST /api/run (skipped when `k6` is
// not on PATH): the counter's submetrics reach --summary-export only through their
// always-passing thresholds, and `done` carries what each label counted.
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

// Synthetic voucher endpoint on 127.0.0.1: two redeems succeed, then the quota is
// gone; every third later call is turned away by a lock. Both rejections are 400,
// told apart only by the error code in the body.
function target() {
  let calls = 0;
  return http.createServer((req, res) => {
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    if (calls <= 2) return res.end('{"data":{"redeemed":true}}');
    res.statusCode = 400;
    res.end(calls % 3 ? '{"error":{"code":"PROM-422001"}}' : '{"error":{"code":"PROM-429001"}}');
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

test('real k6: every response gets one label and done reports the count of each', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = await runStream({
      load: { mode: 'iterations', vus: '4', iterations: '3' },
      thresholds: { p95: '', errorRate: '' },
      scenario: {
        requests: [{
          name: 'Redeem voucher', method: 'POST', url: `${origin}/redeem`, body: '{}', checkStatus: false, sleepAfter: '0',
          outcomes: {
            rules: [
              { label: 'success', status: '2xx', source: 'none' },
              { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
              { label: 'lock_rejected', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-429001' },
              { label: 'unused', status: '5xx', source: 'none' },
            ],
            fallback: 'other',
          },
        }],
      },
    });
    const done = events.find(item => item.event === 'done');
    assert.equal(done?.data.outcome, 'passed');
    const [result] = done.data.outcomes;
    assert.equal(result.rq, 1);
    assert.equal(result.name, 'Redeem voucher');
    assert.equal(result.total, 12);
    const counts = Object.fromEntries(result.outcomes.map(item => [item.label, item.count]));
    // Calls 3..12 are rejected: 3, 6, 9, 12 by the lock, the other six by the quota.
    assert.deepEqual(counts, { success: 2, quota_reached: 6, lock_rejected: 4, unused: 0, other: 0 });
    assert.equal(done.data.summary.metrics['k6ui_outcome{rq:1,outcome:unused}'].count, 0);
  } finally {
    server.close();
  }
});
