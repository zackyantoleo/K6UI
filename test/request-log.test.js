// Request details (Run & Results → Requests): settings, the helpers the generated
// script uses to log each request (run in Node through test/helpers/load-script.js),
// the import round trip, and the server-side rate limit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScript, requestLogBudget } from '../server/generator/index.js';
import { buildOptions } from '../server/generator/options.js';
import { importK6Script } from '../server/importer/index.js';
import { createRequestLogThrottle } from '../server/request-log-throttle.js';
import { normalizeRequestLog, DEFAULT_SAMPLE_EVERY, MAX_SAMPLE_EVERY } from '../public/js/shared/request-log.js';
import { loadScript } from './helpers/load-script.js';

const configOf = (requests, options) => ({
  scenario: { requests },
  load: { mode: 'simple', vus: '1', duration: '1s' },
  options,
});

const post = {
  method: 'POST', url: 'https://api.test/login?api_key=k-123&page=2', sleepAfter: '0',
  headers: [{ key: 'Authorization', value: 'Bearer abc.def' }, { key: 'Content-Type', value: 'application/json' }],
  body: '{"user":"ana","password":"hunter2"}',
};

// What k6 hands back: res.request carries the sent headers (name → array) and body.
function respond(status, body, headers = {}) {
  return (call) => ({
    status,
    body,
    headers,
    error: status === 0 ? 'dial: connection refused' : '',
    request: {
      method: call.method,
      url: call.url,
      body: call.body ?? '',
      headers: Object.fromEntries(Object.entries(call.params?.headers || {}).map(([name, value]) => [name, [value]])),
    },
  });
}

const records = (script) => script.logs.map(line => JSON.parse(line));

test('settings: unknown filter → all, sample interval is a whole number in range', () => {
  assert.deepEqual(normalizeRequestLog(undefined),
    { logRequests: false, logFilter: 'all', logSampleEvery: DEFAULT_SAMPLE_EVERY, logRedact: false });
  assert.deepEqual(normalizeRequestLog({ logRequests: true, logFilter: 'errors', logSampleEvery: '3', logRedact: true }),
    { logRequests: true, logFilter: 'errors', logSampleEvery: 3, logRedact: true });
  assert.equal(normalizeRequestLog({ logRedact: 'yes' }).logRedact, false, 'only true turns Hide secrets on');
  assert.equal(normalizeRequestLog({ logFilter: 'nope' }).logFilter, 'all');
  for (const bad of ['0', '-2', '1.5', 'abc', '']) {
    assert.equal(normalizeRequestLog({ logSampleEvery: bad }).logSampleEvery, DEFAULT_SAMPLE_EVERY, bad);
  }
  assert.equal(normalizeRequestLog({ logSampleEvery: 10 ** 9 }).logSampleEvery, MAX_SAMPLE_EVERY);
});

test('no request log code at all while recording is off', () => {
  const script = generateScript(configOf([post], { logRequests: false, logFilter: 'errors' }));
  assert.doesNotMatch(script, /REQUEST_LOG|logHttpRequest|redact/);
});

test('with Hide secrets, a record carries the request payload and headers and the response headers and body, redacted', () => {
  const script = loadScript(generateScript(configOf([post], { logRequests: true, logRedact: true })), {
    respond: respond(200, '{"token":"tok-1","name":"<b>ana</b>"}', {
      'Content-Type': 'application/json', 'Set-Cookie': 'sid=secret', 'X-Trace': 'abc',
    }),
  });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.equal(record.__r, 1);
  assert.equal(record.m, 'POST');
  assert.equal(record.s, 200);
  assert.equal(record.ok, true);
  assert.equal(record.er, '');
  assert.equal(record.url, 'https://api.test/login?api_key=[REDACTED]&page=2');
  assert.deepEqual(record.rqh, { Authorization: '[REDACTED]', 'Content-Type': 'application/json' });
  assert.equal(record.rq, '{"user":"ana","password":"[REDACTED]"}');
  assert.deepEqual(record.rh, { 'Content-Type': 'application/json', 'Set-Cookie': '[REDACTED]', 'X-Trace': 'abc' });
  assert.equal(record.rb, '{"token":"[REDACTED]","name":"<b>ana</b>"}');
  assert.ok(!JSON.stringify(record).includes('hunter2') && !JSON.stringify(record).includes('tok-1'));
});

test('by default (Hide secrets off) a record shows every value exactly as sent and received', () => {
  const script = loadScript(generateScript(configOf([post], { logRequests: true })), {
    respond: respond(200, '{"token":"tok-1"}', { 'Set-Cookie': 'sid=secret', 'X-Trace': 'abc' }),
  });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.equal(record.url, 'https://api.test/login?api_key=k-123&page=2');
  assert.deepEqual(record.rqh, { Authorization: 'Bearer abc.def', 'Content-Type': 'application/json' });
  assert.equal(record.rq, '{"user":"ana","password":"hunter2"}');
  assert.deepEqual(record.rh, { 'Set-Cookie': 'sid=secret', 'X-Trace': 'abc' });
  assert.equal(record.rb, '{"token":"tok-1"}');
  assert.ok(!JSON.stringify(record).includes('[REDACTED]'));
});

test('a K6UI script from before Hide secrets existed imports with it on (those scripts always redacted)', () => {
  const script = generateScript(configOf([post], { logRequests: true }))
    .replace(/"redact":false,/, '');
  assert.doesNotMatch(script, /"redact"/);
  assert.equal(importK6Script(script).config.options.logRedact, true);
});

test('bodies are capped at 4 KB with a note of what was left out', () => {
  const big = 'x'.repeat(5000);
  const script = loadScript(generateScript(configOf([{ ...post, body: big, headers: [] }], { logRequests: true })), {
    respond: respond(200, big),
  });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.equal(record.rq, `${'x'.repeat(4096)}\n… [904 more characters not shown]`);
  assert.equal(record.rb, record.rq);
});

test('a failed connection is logged with its error message', () => {
  const script = loadScript(generateScript(configOf([post], { logRequests: true })), { respond: respond(0, null) });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.equal(record.s, 0);
  assert.equal(record.ok, false);
  assert.equal(record.er, 'dial: connection refused');
  assert.equal(record.rb, '');
});

test('"errors" logs failed requests only; "sample" logs every Nth iteration plus every failure', () => {
  const statuses = [200, 500, 200, 200, 404, 200];
  const run = (options) => {
    let call = 0;
    const script = loadScript(generateScript(configOf([post], { logRequests: true, ...options })), {
      respond: (request) => respond(statuses[call++], '{}')(request),
    });
    statuses.forEach((_, iteration) => script.iteration(1, iteration));
    return records(script).map(record => `${record.it}:${record.s}`);
  };
  assert.deepEqual(run({ logFilter: 'all' }), ['0:200', '1:500', '2:200', '3:200', '4:404', '5:200']);
  assert.deepEqual(run({ logFilter: 'errors' }), ['1:500', '4:404']);
  assert.deepEqual(run({ logFilter: 'sample', logSampleEvery: 3 }), ['0:200', '1:500', '3:200', '4:404']);
});

test('a gRPC record carries the message, metadata, response message and the measured duration', () => {
  const grpc = {
    type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.Greeter/SayHello', grpcPlaintext: true,
    body: '{"name":"ana"}', headers: [{ key: 'x-request-id', value: 'r1' }, { key: 'authorization', value: 'secret' }],
  };
  const script = loadScript(generateScript(configOf([grpc], { logRequests: true, logRedact: true })), {
    grpcResponse: { message: { reply: 'hi ana' }, headers: { 'content-type': ['application/grpc'] } },
  });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.equal(record.m, 'gRPC');
  assert.equal(record.url, 'localhost:50051/hello.Greeter/SayHello');
  assert.equal(record.ok, true);
  assert.equal(typeof record.d, 'number');
  assert.equal(record.rq, '{"name":"ana"}');
  assert.deepEqual(record.rqh, { 'x-request-id': 'r1', authorization: '[REDACTED]' });
  assert.deepEqual(record.rh, { 'content-type': 'application/grpc' });
  assert.equal(record.rb, '{"reply":"hi ana"}');
});

test('importing a K6UI script keeps which requests it records, without warnings', () => {
  for (const options of [
    { logRequests: true, logFilter: 'sample', logSampleEvery: 7, logRedact: false },
    { logRequests: true, logFilter: 'errors', logSampleEvery: 10, logRedact: true },
  ]) {
    const { config, warnings } = importK6Script(generateScript(configOf([post], options)));
    assert.deepEqual(config.options, options);
    assert.deepEqual(warnings, []);
  }
  const { config } = importK6Script(generateScript(configOf([post], { logRequests: false })));
  assert.deepEqual(config.options, { logRequests: false });
});

test('the server forwards at most `rate` passed and `rate` failed records a second and counts the rest', () => {
  let time = 0;
  const events = [];
  const throttle = createRequestLogThrottle((event, data) => events.push({ event, data }), { rate: 2, now: () => time });
  for (let i = 0; i < 4; i++) throttle.add({ i, ok: true });
  throttle.add({ i: 'e1', ok: false });
  throttle.add({ i: 'e2', ok: false });
  throttle.add({ i: 'e3', ok: false });
  time = 1000;
  throttle.add({ i: 'next', ok: true });
  throttle.flush();

  assert.deepEqual(events.filter(e => e.event === 'req-log').map(e => e.data.i), [0, 1, 'e1', 'e2', 'next']);
  const skipped = events.filter(e => e.event === 'req-log-skipped').map(e => e.data.skipped);
  assert.deepEqual(skipped, [1, 3], 'reported once in the first second, then the total on flush');
});

test('the record budget of a VU: twice the server rate over all VUs, a first burst that covers a short race run', () => {
  const budgetOf = load => requestLogBudget(buildOptions({ load }));
  assert.deepEqual(budgetOf({ mode: 'simple', vus: '1', duration: '1s' }), { rate: 100, burst: 10 });
  assert.deepEqual(budgetOf({ mode: 'simple', vus: '50', duration: '1s' }), { rate: 2, burst: 10 });
  assert.deepEqual(budgetOf({ mode: 'iterations', vus: '98', iterations: '1' }), { rate: 1.02, burst: 6 });
  assert.deepEqual(budgetOf({ mode: 'stages', stages: [{ duration: '1m', target: '10' }, { duration: '1m', target: '500' }] }), { rate: 0.2, burst: 1 });
  const script = generateScript(configOf([post], { logRequests: true }));
  assert.match(script, /const REQUEST_LOG = \{"filter":"all","every":10,"redact":false,"bodyLimit":4096,"rate":100,"burst":10\};/);
});

test('a VU past its budget builds no record and counts it on its next record (sk), passed and failed apart', () => {
  const realNow = Date.now;
  let time = 1_000_000;
  Date.now = () => time;
  try {
    let status = 200;
    const k6 = loadScript(generateScript(configOf([post], { logRequests: true })), { respond: call => respond(status, '{}')(call) });
    for (let i = 0; i < 25; i++) k6.iteration(1, i);              // burst 10, no time passes
    status = 500;
    for (let i = 25; i < 27; i++) k6.iteration(1, i);             // failed requests have their own budget
    assert.deepEqual(records(k6).map(r => `${r.it}:${r.s}:${r.sk}`),
      ['0:200:0', '1:200:0', '2:200:0', '3:200:0', '4:200:0', '5:200:0', '6:200:0', '7:200:0', '8:200:0', '9:200:0', '25:500:15', '26:500:0']);
    status = 200;
    time += 10;                                                    // 100 a second: one more passed record
    k6.iteration(1, 27);
    k6.iteration(1, 28);
    assert.deepEqual(records(k6).slice(12).map(r => `${r.it}:${r.sk}`), ['27:0']);
    time += 1000;                                                  // refills up to the burst only
    for (let i = 29; i < 45; i++) k6.iteration(1, i);
    assert.deepEqual(records(k6).slice(13).map(r => `${r.it}:${r.sk}`),
      ['29:1', '30:0', '31:0', '32:0', '33:0', '34:0', '35:0', '36:0', '37:0', '38:0']);
  } finally {
    Date.now = realNow;
  }
});

test('the server adds what the script left out (sk) to the skipped count and drops the field', () => {
  let time = 0;
  const events = [];
  const throttle = createRequestLogThrottle((event, data) => events.push({ event, data }), { rate: 2, now: () => time });
  throttle.add({ i: 'a', ok: true, sk: 0 });
  throttle.add({ i: 'b', ok: true, sk: 7 });
  throttle.add({ i: 'c', ok: false, sk: 'nope' });
  throttle.flush();
  assert.deepEqual(events.filter(e => e.event === 'req-log').map(e => e.data), [{ i: 'a', ok: true }, { i: 'b', ok: true }, { i: 'c', ok: false }]);
  assert.deepEqual(events.filter(e => e.event === 'req-log-skipped').map(e => e.data.skipped), [7]);
});

test('flush reports nothing when no record was left out', () => {
  const events = [];
  const throttle = createRequestLogThrottle((event, data) => events.push({ event, data }));
  throttle.add({ ok: true });
  throttle.flush();
  assert.deepEqual(events.map(e => e.event), ['req-log']);
});

test('"Authorization: Bearer <token>" in a body hides the token, not just the word Bearer', () => {
  const script = loadScript(generateScript(configOf([post], { logRequests: true, logRedact: true })), {
    respond: respond(200, 'echo Authorization: Bearer secret-777'),
  });
  script.iteration(1, 0);
  const [record] = records(script);
  assert.ok(!record.rb.includes('secret-777'), record.rb);
});
