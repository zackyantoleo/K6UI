// Live metrics with the real k6 binary through POST /api/run (skipped when `k6` is
// not on PATH): k6 serves its REST API on the free port K6UI gives it, and `metrics`
// events arrive while the test runs, with outcome counts that grow, before `done`.
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

// Synthetic voucher endpoint on 127.0.0.1: the first five redeems succeed, every
// later one is a 400 "quota reached".
function target() {
  let calls = 0;
  return http.createServer((_req, res) => {
    calls += 1;
    res.setHeader('Content-Type', 'application/json');
    if (calls <= 5) return res.end('{"data":{"redeemed":true}}');
    res.statusCode = 400;
    res.end('{"error":{"code":"PROM-422001"}}');
  });
}

test('real k6: metrics events arrive during the run with growing outcome counts', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const app = createServer({ port: 0, host: '127.0.0.1' });
  await once(app, 'listening');
  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: {
          requests: [{
            id: 'req_redeem', name: 'Redeem', method: 'POST',
            url: `http://127.0.0.1:${server.address().port}/redeem`, body: '{}',
            sleepAfter: '0.05', expectedStatuses: '200,400',
            outcomes: {
              rules: [
                { label: 'success', status: '200', source: 'none' },
                { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
              ],
              fallback: 'other',
            },
          }],
        },
        thresholds: { p95: '', errorRate: '', outcomes: [{ request: 'req_redeem', label: 'success', op: '<=', value: '5' }] },
        load: { mode: 'simple', vus: '2', duration: '4s' },
      }),
    });
    assert.equal(response.status, 200);

    // Read the stream as it comes, to see that metrics events arrive before the end.
    const events = [];
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts.filter(Boolean)) {
        events.push({
          event: /^event: (.+)$/m.exec(part)?.[1],
          data: JSON.parse(/^data: (.*)$/m.exec(part)?.[1] ?? 'null'),
          at: Date.now() - startedAt,
        });
      }
    }

    const done = events.find(item => item.event === 'done');
    assert.equal(done?.data.code, 0, 'the run passes (expected statuses, target met)');
    const metrics = events.filter(item => item.event === 'metrics');
    assert.ok(metrics.length >= 2, `expected at least two metrics events, got ${metrics.length}`);
    assert.ok(events.findLastIndex(item => item.event === 'metrics') < events.indexOf(done), 'every metrics event comes before done');
    assert.ok(metrics[0].at < done.at - 1000, 'the first metrics event arrives well before the run ends');

    const totals = metrics.map(item => item.data.outcomes[0].total);
    assert.ok(totals.at(-1) > totals[0], `outcome counts grow during the run: ${totals}`);
    assert.ok(totals.every((total, index) => index === 0 || total >= totals[index - 1]), `never shrink: ${totals}`);
    const last = metrics.at(-1).data;
    assert.equal(typeof last.vus, 'number');
    assert.ok(last.requests >= totals.at(-1), 'http_reqs counts every request');
    assert.equal(last.failedRate, 0, 'a 400 the request expects is not a failure');
    assert.equal(typeof last.durationAvg, 'number');
    assert.equal(typeof last.durationP95, 'number');
    assert.ok(last.outcomeCounts['k6ui_outcome{rq:1,outcome:quota_reached}'] > 0);
    assert.equal(last.outcomes[0].outcomes.find(item => item.label === 'success').count, 5);
    assert.deepEqual(last.outcomeThresholds.map(item => [item.status, item.count]), [['on-track', 5]]);

    // done replaces the live values: final counts are at least the last live ones.
    assert.ok(done.data.outcomes[0].total >= totals.at(-1));
    assert.deepEqual(done.data.outcomeThresholds.map(item => item.status), ['met']);
  } finally {
    app.closeAllConnections?.();
    await new Promise(done => app.close(done));
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});
