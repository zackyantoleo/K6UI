// "Save to CSV" with the real k6 binary through POST /api/run (skipped when `k6` is
// not on PATH): k6 prints each row through console.log, the server turns those
// lines into `export` SSE events, and none of them reaches the live log.
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

// Synthetic target on 127.0.0.1: every other order is created.
function target() {
  let orders = 0;
  return http.createServer((req, res) => {
    if (req.url === '/login') return res.end('{"data":{"token":"synthetic-token,\\"1"}}');
    if (req.url === '/order') {
      orders += 1;
      return res.end(orders % 2 ? `{"data":{"order_number":"ORD-${orders}"}}` : '{"data":{}}');
    }
    res.end('{}');
  });
}

// → [{ event, data }] of one /api/run stream.
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

const get = (url, extra = {}) => ({ method: 'GET', url, checkStatus: false, sleepAfter: '0', ...extra });

test('real k6: found orders are saved as rows, missing ones are skipped, nothing leaks into the log', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = await runStream({
      load: { mode: 'iterations', vus: '2', iterations: '3' },
      options: { logRequests: true },
      scenario: {
        requests: [
          get(`${origin}/login`, { extractions: [{ varName: 'token', source: 'json', selector: 'data.token', default: 'TOKEN_NOT_FOUND' }] }),
          get(`${origin}/order`, {
            extractions: [{ varName: 'order_number', source: 'json', selector: 'data.order_number', default: 'ORDER_NOT_FOUND' }],
            exports: [{ file: 'orders_created.csv', skipMissing: true, columns: [{ name: 'order_number', value: '{{order_number}}' }, { name: 'auth', value: 'Bearer {{token}}' }] }],
          }),
        ],
      },
    });
    const done = events.find(item => item.event === 'done');
    assert.equal(done?.data.outcome, 'passed');
    const exports = events.filter(item => item.event === 'export').map(item => item.data);
    assert.ok(exports.length >= 1);
    assert.ok(events.findIndex(item => item.event === 'export') < events.findIndex(item => item.event === 'done'));
    assert.ok(exports.every(data => data.file === 'orders_created.csv' && data.truncated === false));
    assert.deepEqual(exports[0].columns, ['order_number', 'auth']);
    const rows = exports.flatMap(data => data.rows).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(rows, [['ORD-1', 'Bearer synthetic-token,"1'], ['ORD-3', 'Bearer synthetic-token,"1'], ['ORD-5', 'Bearer synthetic-token,"1']]);
    const log = events.filter(item => item.event === 'log').map(item => item.data.line).join('');
    assert.doesNotMatch(log, /k6uiExport|synthetic-token/);
  } finally {
    server.close();
  }
});
