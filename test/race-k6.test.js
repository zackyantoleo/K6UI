// Race burst with the real k6 binary through POST /api/run (skipped when `k6` is not
// on PATH), against a synthetic server on 127.0.0.1 that records, per request, the
// socket it came on and how many requests that socket served before it.
// The race request's pre-processor runs right after the wait, so it records the
// k6-side send time (Date.now()) and T0 (setup()'s data) in the request body.
// Timing depends on the machine and on what else runs: each timing check takes the
// best of up to three runs (the numbers of every run are in the assertion message).
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

const options = { skip: !hasK6() && 'the k6 binary is not on PATH', timeout: 180_000 };

async function target() {
  const records = [];
  let sockets = 0;
  const server = http.createServer((req, res) => {
    const socket = req.socket;
    const record = { method: req.method, path: req.url, socket: socket.k6uiId, before: socket.k6uiServed++, at: Date.now() };
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (body) record.body = JSON.parse(body);
      records.push(record);
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;
  server.on('connection', socket => {
    socket.k6uiId = ++sockets;
    socket.k6uiServed = 0;
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    records,
    sockets: () => sockets,
    close: () => { server.closeAllConnections?.(); return new Promise(done => server.close(done)); },
  };
}

async function runStream(config) {
  const app = createServer({ port: 0, host: '127.0.0.1' });
  await once(app, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
    });
    assert.equal(response.status, 200, await response.clone().text());
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

// One race run: a login request, then the race request (POST /race), which reports
// its VU, T0 and send time. → { done, races, records, sockets }
async function race(raceSettings, load = {}) {
  const server = await target();
  try {
    const events = await runStream({
      load: { mode: 'race', vus: '4', maxDuration: '1m', ...load, race: { request: 'req_race', ...raceSettings } },
      scenario: {
        requests: [
          { id: 'req_login', method: 'GET', url: `${server.origin}/login`, checkStatus: false, sleepAfter: '0' },
          {
            id: 'req_race', method: 'POST', url: `${server.origin}/race`, checkStatus: false, sleepAfter: '0',
            preScript: 'vars.vu = __VU; vars.t0 = data.k6uiRaceT0; vars.sent = Date.now();',
            body: '{"vu":{{vu}},"t0":{{t0}},"sent":{{sent}}}',
          },
        ],
      },
    });
    const done = events.find(event => event.event === 'done')?.data;
    assert.ok(done, `no done event: ${JSON.stringify(events.filter(event => event.event !== 'log')).slice(0, 2000)}`);
    const races = server.records.filter(record => record.path === '/race');
    return { done, races, records: server.records, sockets: server.sockets() };
  } finally {
    await server.close();
  }
}

// Run up to three times; keep the first run `ok` accepts, else the last. → { run, tries }
async function bestOf(attempt, ok) {
  const tries = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await attempt();
    tries.push(run);
    if (ok(run)) return { run, tries };
  }
  return { run: tries.at(-1), tries };
}

test('offsets 0,1000,1000,1030: every VU sends within 2 ms of its planned time', options, async t => {
  const OFFSETS = [0, 1000, 1000, 1030];
  const errorsOf = run => run.races.map(({ body }) => body.sent - (body.t0 + OFFSETS[body.vu - 1]));
  const { run, tries } = await bestOf(
    () => race({ timing: 'offsets', offsets: OFFSETS.join(','), leadMs: '1000' }),
    attempt => attempt.races.length === 4 && errorsOf(attempt).every(error => error >= 0 && error <= 2),
  );
  assert.equal(run.done.code, 0);
  assert.deepEqual(run.races.map(record => record.body.vu).sort(), [1, 2, 3, 4]);
  const errors = errorsOf(run);
  t.diagnostic(`send time − plan (ms) per try: ${JSON.stringify(tries.map(errorsOf))}`);
  assert.ok(errors.every(error => error >= 0 && error <= 2), `send time − plan (ms) per try: ${JSON.stringify(tries.map(errorsOf))}`);
  const result = run.done.race;
  assert.deepEqual({ rq: result.rq, method: result.method, vus: result.vus, failIfLate: result.failIfLate, late: result.late, sent: result.sent, missing: result.missing },
    { rq: 2, method: 'POST', vus: 4, failIfLate: false, late: 0, sent: 4, missing: 0 });
  // The script's own records (k6uiRaceRecord) agree with what the server received:
  // planned times as typed, send time right after the pre-processor's Date.now().
  assert.deepEqual(result.records.map(record => record.offset), [0, 1000, 1000, 1030]);
  for (const record of result.records) {
    const body = run.races.find(entry => entry.body.vu === record.vu).body;
    assert.equal(result.t0, body.t0);
    const after = result.t0 + record.sent - body.sent;
    assert.ok(after >= 0 && after <= 1, `VU ${record.vu}: record sent ${after} ms after the pre-processor`);
    assert.ok(record.sent - record.offset >= 0 && record.sent - record.offset <= 2, `VU ${record.vu}: ${record.sent - record.offset} ms off`);
    assert.equal(record.late, false);
    assert.equal(record.status, 200);
    assert.ok(record.arrived < record.offset, 'reached the wait before its time');
  }
  assert.ok(Math.abs(result.stats.spreadMs - 1030) <= 2, `spread ${result.stats.spreadMs}`);
  assert.equal(result.stats.newConnections, 0, 'the login and the warm-up opened the connection');
  t.diagnostic(`stats: ${JSON.stringify(result.stats)}`);
});

test('200 VUs together: the k6-side spread is at most 2 ms, and the warm-up leaves no new connection at race time', options, async t => {
  const spreadOf = run => {
    const sent = run.races.map(record => record.body.sent);
    return Math.max(...sent) - Math.min(...sent);
  };
  const { run, tries } = await bestOf(
    () => race({ timing: 'together', leadMs: '2000' }, { vus: '200' }),
    attempt => attempt.races.length === 200 && spreadOf(attempt) <= 2,
  );
  assert.equal(run.done.code, 0);
  assert.equal(run.races.length, 200);
  assert.equal(run.done.race.late, 0);
  t.diagnostic(`k6-side spread (ms) per try: ${JSON.stringify(tries.map(spreadOf))}`);
  assert.ok(spreadOf(run) <= 2, `k6-side spread (ms) per try: ${JSON.stringify(tries.map(spreadOf))}`);
  // Each VU opened one connection (for the login), the warm-up reused it, and so did
  // the race request: no race request was the first on its socket.
  const warmups = run.records.filter(record => record.method === 'GET' && record.path === '/');
  const fresh = run.races.filter(record => record.before === 0).length;
  t.diagnostic(`sockets: ${run.sockets}, race requests on a new connection: ${fresh}`);
  assert.equal(warmups.length, 200);
  assert.equal(fresh, 0, 'race requests on a new connection');
  assert.equal(run.sockets, 200);
  // The Race card says the same from the k6 side.
  const { stats, sent, missing } = run.done.race;
  t.diagnostic(`Race card: ${JSON.stringify(stats)}`);
  assert.equal(sent, 200);
  assert.equal(missing, 0);
  assert.equal(stats.newConnections, 0);
  assert.ok(stats.spreadMs <= spreadOf(run) + 1, `records spread ${stats.spreadMs}, server-side bodies ${spreadOf(run)}`);
  assert.ok(stats.peakInFlight > 1, `peak in flight ${stats.peakInFlight}`);
});

test('without the warm-up and with nothing before it, every race request opens its own connection', options, async t => {
  const server = await target();
  try {
    const events = await runStream({
      load: { mode: 'race', vus: '50', maxDuration: '1m', race: { timing: 'together', leadMs: '1000', warmup: false } },
      scenario: { requests: [{ id: 'req_race', method: 'GET', url: `${server.origin}/race`, checkStatus: false, sleepAfter: '0' }] },
    });
    assert.equal(events.find(event => event.event === 'done')?.data.code, 0);
    const races = server.records.filter(record => record.path === '/race');
    assert.equal(races.length, 50);
    t.diagnostic(`race requests on a new connection: ${races.filter(record => record.before === 0).length} of 50`);
    assert.equal(races.filter(record => record.before === 0).length, 50, 'the control: the socket count sees new connections');
    // k6's own timings see the same: every race request had to connect.
    assert.equal(events.find(event => event.event === 'done').data.race.stats.newConnections, 50);
  } finally {
    await server.close();
  }
});

test('a lead time too short reports late VUs; the run fails only with "fail if late"', options, async t => {
  const warn = await race({ timing: 'together', leadMs: '0' }, { vus: '20' });
  t.diagnostic(`lead 0 ms, 20 VUs: ${warn.done.race.late} late`);
  assert.equal(warn.done.code, 0, 'a late VU is a warning');
  assert.ok(warn.done.race.late > 0, `late: ${warn.done.race.late}`);
  assert.equal(warn.races.length, 20, 'a late VU still sends');
  assert.equal(warn.done.race.records.filter(record => record.late).length, warn.done.race.late, 'the records name the late VUs');
  assert.ok(warn.done.race.stats.marginMs <= 0, `margin ${warn.done.race.stats.marginMs}`);
  const fail = await race({ timing: 'together', leadMs: '0', failIfLate: true }, { vus: '20' });
  assert.equal(fail.done.code, 99);
  assert.equal(fail.done.outcome, 'threshold-failed');
  assert.ok(fail.done.race.late > 0);
  assert.equal(fail.done.race.failIfLate, true);
});

test('VUs that end their iteration before the race request are missing; outcome labels come with each record', options, async () => {
  const server = await target();
  try {
    const events = await runStream({
      load: { mode: 'race', vus: '4', maxDuration: '1m', race: { request: 'req_race', timing: 'together', leadMs: '1000' } },
      scenario: {
        requests: [
          { id: 'req_login', method: 'GET', url: `${server.origin}/login`, checkStatus: false, sleepAfter: '0', postScript: 'if (__VU > 2) throw new Error("no login");' },
          {
            id: 'req_race', method: 'GET', url: `${server.origin}/race`, checkStatus: false, sleepAfter: '0',
            outcomes: { rules: [{ label: 'redeemed', status: '200', source: 'none' }], fallback: 'other' },
          },
        ],
      },
    });
    const done = events.find(event => event.event === 'done')?.data;
    assert.equal(done.code, 0, 'an iteration error does not fail the run');
    const result = done.race;
    assert.equal(result.sent, 2);
    assert.equal(result.missing, 2);
    assert.deepEqual(result.records.map(record => record.vu).sort(), [1, 2]);
    assert.deepEqual(result.records.map(record => record.outcome), ['redeemed', 'redeemed']);
    assert.deepEqual(result.labels, ['redeemed', 'other']);
    assert.equal(result.fallback, 'other');
    assert.ok(!events.some(event => event.event === 'log' && event.data.line.includes('k6uiRace')), 'records never reach the live log');
  } finally {
    await server.close();
  }
});
