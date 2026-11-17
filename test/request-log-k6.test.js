// Request details with the real k6 binary through POST /api/run (skipped when `k6`
// is not on PATH): k6's own res.request / res.headers reach the req-log events,
// redacted, and the "errors" filter leaves passed requests out.
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

// Synthetic target on 127.0.0.1: /echo returns what it got, /fail is a 500.
function target() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'sid=cookie-secret');
      res.setHeader('X-Trace', 'trace-1');
      if (req.url === '/fail') {
        res.statusCode = 500;
        return res.end('{"error":"boom"}');
      }
      res.end(JSON.stringify({ got: JSON.parse(body || '{}').user, token: 'tok-secret' }));
    });
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

const request = (url, extra = {}) => ({
  method: 'POST', url, checkStatus: false, sleepAfter: '0',
  headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Authorization', value: 'Bearer auth-secret' }],
  body: '{"user":"ana","password":"pw-secret"}',
  ...extra,
});

test('real k6: with Hide secrets, a record shows the payload, both sets of headers and the response, secrets redacted', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = await runStream({
      load: { mode: 'iterations', vus: '1', iterations: '2' },
      options: { logRequests: true, logFilter: 'all', logRedact: true },
      scenario: { requests: [request(`${origin}/echo`)] },
    });
    assert.equal(events.find(item => item.event === 'done')?.data.outcome, 'passed');
    const records = events.filter(item => item.event === 'req-log').map(item => item.data);
    assert.equal(records.length, 2);
    const [record] = records;
    assert.equal(record.m, 'POST');
    assert.equal(record.s, 200);
    assert.equal(record.rq, '{"user":"ana","password":"[REDACTED]"}');
    assert.equal(record.rqh.Authorization, '[REDACTED]');
    assert.equal(record.rqh['Content-Type'], 'application/json');
    assert.equal(record.rh['X-Trace'], 'trace-1');
    assert.equal(record.rh['Set-Cookie'], '[REDACTED]');
    assert.equal(record.rb, '{"got":"ana","token":"[REDACTED]"}');
    const all = JSON.stringify(events);
    for (const secret of ['pw-secret', 'auth-secret', 'cookie-secret', 'tok-secret']) assert.ok(!all.includes(secret), secret);
  } finally {
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});

test('real k6: "errors" records failed requests only', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = await runStream({
      load: { mode: 'iterations', vus: '1', iterations: '2' },
      options: { logRequests: true, logFilter: 'errors' },
      scenario: { requests: [request(`${origin}/echo`), request(`${origin}/fail`)] },
    });
    const records = events.filter(item => item.event === 'req-log').map(item => item.data);
    assert.deepEqual(records.map(record => `${record.i}:${record.s}`), ['1:500', '1:500']);
    assert.equal(records[0].rb, '{"error":"boom"}');
  } finally {
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});

test('real k6: by default nothing is redacted', options, async () => {
  const server = target();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = await runStream({
      load: { mode: 'iterations', vus: '1', iterations: '1' },
      options: { logRequests: true },
      scenario: { requests: [request(`${origin}/echo`)] },
    });
    const [record] = events.filter(item => item.event === 'req-log').map(item => item.data);
    assert.equal(record.rq, '{"user":"ana","password":"pw-secret"}');
    assert.equal(record.rqh.Authorization, 'Bearer auth-secret');
    assert.equal(record.rh['Set-Cookie'], 'sid=cookie-secret');
    assert.equal(record.rb, '{"got":"ana","token":"tok-secret"}');
    assert.ok(!JSON.stringify(events).includes('[REDACTED]'));
  } finally {
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});
