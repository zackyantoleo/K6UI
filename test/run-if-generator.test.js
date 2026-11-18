import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parse } from 'acorn';

import { createServer } from '../server/index.js';
import { generateScript } from '../server/generator/index.js';
import { loadScript } from './helpers/load-script.js';

// The generated script must be valid module syntax.
const assertSyntax = script => assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));

const request = (overrides = {}) => ({ method: 'GET', url: 'https://api.test/x', checkStatus: false, sleepAfter: '0', ...overrides });
const inGroup = (overrides = {}) => request({ groupId: 'grp_a', ...overrides });

// One group "Orders" (condition on the global variable MODE) plus whatever requests the test gives.
function configOf(requests, { runIf = { variable: 'MODE', operator: 'equals', values: ['A'] }, mode = 'A', group = {}, ...extra } = {}) {
  return {
    load: { mode: 'simple', vus: 1, duration: '1s' },
    variables: [{ key: 'MODE', value: mode }],
    scenario: { groups: [{ id: 'grp_a', name: 'Orders', enabled: true, runIf, ...group }], requests },
    ...extra,
  };
}

const bodyOf = script => script.slice(script.indexOf('export default function() {'));
const urls = calls => calls.map(call => call.url);

// ── Golden output ─────────────────────────────────────────────

test('golden output: equals', () => {
  const script = generateScript(configOf([inGroup()]));
  assertSyntax(script);
  assert.equal(bodyOf(script), `export default function() {

  // Group "Orders" runs only if MODE is A
  if (String(GLOBALS.MODE) === "A") {

  // Group: Orders

  // Request 1: GET https://api.test/x
  const res_main_0 = http.request("GET", "https://api.test/x", null, {});
  }
}
`);
});

test('golden output: not-equals and one-of', () => {
  const notEquals = generateScript(configOf([inGroup()], { runIf: { variable: 'MODE', operator: 'not-equals', values: ['A'] } }));
  assertSyntax(notEquals);
  assert.ok(notEquals.includes(`  // Group "Orders" runs only if MODE is not A\n  if (String(GLOBALS.MODE) !== "A") {\n`));

  const oneOf = generateScript(configOf([inGroup()], { runIf: { variable: 'MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] } }));
  assertSyntax(oneOf);
  assert.ok(oneOf.includes(`  // Group "Orders" runs only if MODE is one of ORDER_FLOW, ALL\n  if (["ORDER_FLOW", "ALL"].includes(String(GLOBALS.MODE))) {\n`));
  assert.ok(oneOf.endsWith('  }\n}\n'));
});

test('a group without a condition is exactly what it was before (null, missing, or empty)', () => {
  const plain = generateScript(configOf([inGroup()], { group: { runIf: undefined } }));
  assert.doesNotMatch(plain, /\bif \(|runs only if/);
  assert.equal(generateScript(configOf([inGroup()], { runIf: null })), plain);
});

test('values with quotes and line separators stay string literals, and the comment stays on one line', () => {
  const tricky = 'say "hi"\\ \u2028 end';
  const script = generateScript(configOf([inGroup()], { runIf: { variable: 'MODE', operator: 'equals', values: [tricky] }, group: { name: 'Line\nbreak' } }));
  assertSyntax(script);
  assert.doesNotMatch(script, /\u2028/);
  const run = loadScript(script);
  assert.equal(run.iteration(1, 0).length, 0);
});

test('the condition compares strings and is case-sensitive', () => {
  const ran = (value, runIf) => loadScript(generateScript(configOf([inGroup()], { mode: value, runIf }))).iteration(1, 0).length;
  const oneOf = { variable: 'MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] };
  assert.deepEqual(['ORDER_FLOW', 'ALL', 'REDEEM_FLOW', 'all', ''].map(value => ran(value, oneOf)), [1, 1, 0, 0, 0]);
  const equals = { variable: 'MODE', operator: 'equals', values: ['A'] };
  assert.deepEqual(['A', 'B', 'a'].map(value => ran(value, equals)), [1, 0, 0]);
  const notEquals = { variable: 'MODE', operator: 'not-equals', values: ['A'] };
  assert.deepEqual(['A', 'B', ''].map(value => ran(value, notEquals)), [0, 1, 1]);
});

// ── Both branches against stubbed k6 ──────────────────────────

test('the group runs when the condition holds and is skipped otherwise; other requests always run', () => {
  const requests = [
    request({ url: 'https://api.test/before' }),
    inGroup({ url: 'https://api.test/in-1' }),
    inGroup({ url: 'https://api.test/in-2' }),
    request({ url: 'https://api.test/after' }),
  ];
  const on = loadScript(generateScript(configOf(requests, { mode: 'A' })));
  assert.deepEqual(urls(on.iteration(1, 0)), ['https://api.test/before', 'https://api.test/in-1', 'https://api.test/in-2', 'https://api.test/after']);
  const off = loadScript(generateScript(configOf(requests, { mode: 'B' })));
  assert.deepEqual(urls(off.iteration(1, 0)), ['https://api.test/before', 'https://api.test/after']);
});

test('the eratech shape: two groups, the second one turned off, only the matching flow runs', () => {
  const groups = [
    { id: 'grp_a', name: 'Order flow', enabled: true, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] } },
    { id: 'grp_b', name: 'Redeem flow', enabled: false, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['REDEEM_FLOW', 'ALL'] } },
  ];
  const requests = [
    request({ groupId: 'grp_a', url: 'https://api.test/login' }),
    request({ groupId: 'grp_b', url: 'https://api.test/redeem' }),
  ];
  const generate = mode => generateScript({
    load: { mode: 'iterations', vus: '1', iterations: '1' },
    variables: [{ key: 'EXECUTION_MODE', value: mode }],
    scenario: { groups, requests },
  });
  assert.deepEqual(urls(loadScript(generate('ORDER_FLOW')).iteration(1, 0)), ['https://api.test/login']);
  assert.deepEqual(urls(loadScript(generate('ALL')).iteration(1, 0)), ['https://api.test/login'], 'a turned-off group stays off even when its condition holds');
  assert.deepEqual(urls(loadScript(generate('REDEEM_FLOW')).iteration(1, 0)), []);
  assert.doesNotMatch(generate('ORDER_FLOW'), /redeem/);
});

test('a group split by other requests is checked each time it starts', () => {
  const requests = [
    inGroup({ url: 'https://api.test/a1' }),
    request({ url: 'https://api.test/between' }),
    inGroup({ url: 'https://api.test/a2' }),
  ];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  assert.equal(script.match(/\n  if \(String\(GLOBALS\.MODE\)/g).length, 2);
  assert.deepEqual(urls(loadScript(script).iteration(1, 0)), ['https://api.test/a1', 'https://api.test/between', 'https://api.test/a2']);
});

// ── Extractions are hoisted ───────────────────────────────────

test('a variable extracted inside the group is declared above the block and readable after it', () => {
  const requests = [
    inGroup({ url: 'https://api.test/login', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] }),
    inGroup({ url: 'https://api.test/me/{{token}}' }),
    request({ url: 'https://api.test/after/{{token}}' }),
  ];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  assert.ok(script.indexOf('let token = "";') < script.indexOf('  if (String(GLOBALS.MODE)'), 'declared above the if');
  assert.equal(script.match(/\blet token\b/g).length, 1, 'declared once');
  assert.match(script, /\n  token = res_main_0\.json\("/);

  const respond = call => (call.url.endsWith('/login') ? { body: '{"token":"T1"}' } : {});
  assert.deepEqual(urls(loadScript(script, { respond }).iteration(1, 0)), ['https://api.test/login', 'https://api.test/me/T1', 'https://api.test/after/T1']);
  assert.deepEqual(urls(loadScript(generateScript(configOf(requests, { mode: 'B' })), { respond }).iteration(1, 0)), ['https://api.test/after/'],
    'the group did not run, so the variable is still empty');
});

test('hoisting covers Before/After requests, gRPC extractions, and a name extracted twice', () => {
  const requests = [
    inGroup({
      url: 'https://api.test/a',
      pre: { method: 'GET', url: 'https://api.test/pre', headers: [], body: '', extractions: [{ varName: 'seed', source: 'json', selector: 'seed' }] },
      extractions: [{ varName: 'token', source: 'json', selector: 'token' }],
      post: { method: 'GET', url: 'https://api.test/post', headers: [], body: '', extractions: [{ varName: 'done', source: 'header', selector: 'X-Done' }] },
    }),
    inGroup({ type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.Greeter/SayHello', grpcPlaintext: true, extractions: [{ varName: 'token', source: 'json', selector: 'reply' }, { varName: 'reply', source: 'json', selector: 'reply' }] }),
    request({ url: 'https://api.test/after/{{seed}}/{{token}}/{{done}}/{{reply}}' }),
  ];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  for (const name of ['seed', 'token', 'done', 'reply']) {
    assert.equal(script.match(new RegExp(`\\blet ${name}\\b`, 'g')).length, 1, `${name} is declared once`);
  }
  const run = loadScript(script, {
    respond: call => ({ body: '{"seed":"S","token":"T"}', headers: call.url.endsWith('/post') ? { 'X-Done': 'D' } : {} }),
    grpcResponse: { message: { reply: 'R' } },
  });
  assert.equal(run.iteration(1, 0).at(-1).url, 'https://api.test/after/S/R/D/R');
});

test('a name that is already declared before the group is only assigned inside it', () => {
  const requests = [
    request({ url: 'https://api.test/first', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] }),
    inGroup({ url: 'https://api.test/second', extractions: [{ varName: 'token', source: 'json', selector: 'other' }] }),
    request({ url: 'https://api.test/after/{{token}}' }),
  ];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  assert.equal(script.match(/\blet token\b/g).length, 1);
  assert.doesNotMatch(script, /let token = "";/, 'nothing to hoist');
  const run = loadScript(script, { respond: call => ({ body: call.url.endsWith('/first') ? '{"token":"T1"}' : '{"other":"T2"}' }) });
  assert.equal(run.iteration(1, 0).at(-1).url, 'https://api.test/after/T2');
  const off = loadScript(generateScript(configOf(requests, { mode: 'B' })), { respond: () => ({ body: '{"token":"T1"}' }) });
  assert.equal(off.iteration(1, 0).at(-1).url, 'https://api.test/after/T1', 'the earlier value survives a skipped group');
});

test('precedence stays: a data column of the same name is read until the extracting request has run', () => {
  const requests = [
    inGroup({ url: 'https://api.test/before/{{token}}' }),
    inGroup({ url: 'https://api.test/login', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] }),
    inGroup({ url: 'https://api.test/after/{{token}}' }),
  ];
  const script = generateScript(configOf(requests, {
    dataSets: [{ id: 'ds_a', name: 'tokens.csv', skipHeader: true, columns: ['token'], content: 'token\nFROM_FILE\n' }],
  }));
  assertSyntax(script);
  assert.match(script, /before\/\$\{DATA_1_ROW\.token\}/);
  assert.match(script, /after\/\$\{token\}/);
  const run = loadScript(script, { respond: call => (call.url.endsWith('/login') ? { body: '{"token":"EXTRACTED"}' } : {}) });
  assert.deepEqual(urls(run.iteration(1, 0)), ['https://api.test/before/FROM_FILE', 'https://api.test/login', 'https://api.test/after/EXTRACTED']);
});

test('variables assigned by processor scripts inside the group start empty outside it', () => {
  const requests = [
    inGroup({ url: 'https://api.test/a', postScript: 'vars.seen = res.status;' }),
    request({ url: 'https://api.test/after/{{seen}}' }),
  ];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  assert.equal(loadScript(script).iteration(1, 0).at(-1).url, 'https://api.test/after/200');
  assert.equal(loadScript(generateScript(configOf(requests, { mode: 'B' }))).iteration(1, 0).at(-1).url, 'https://api.test/after/');
});

// ── Everything of a request stays inside the block ────────────

test('Before/After requests, processors, assertions, request logs, and pauses run only with their group', () => {
  const requests = [inGroup({
    url: 'https://api.test/main', method: 'POST', body: '{"a":1}', sleepAfter: '2', checkStatus: true,
    pre: { method: 'GET', url: 'https://api.test/pre', headers: [], body: '', extractions: [] },
    preScript: 'vars.start = 1;',
    assertions: [{ type: 'status-eq', value: '200', value2: '' }],
    postScript: 'vars.end = res.status;',
    post: { method: 'GET', url: 'https://api.test/post', headers: [], body: '', extractions: [] },
  })];
  const on = loadScript(generateScript(configOf(requests, { options: { logRequests: true } })));
  assert.deepEqual(urls(on.iteration(1, 0)), ['https://api.test/pre', 'https://api.test/main', 'https://api.test/post']);
  assert.deepEqual(on.sleeps, [2]);
  assert.ok(on.logs.length > 0, 'the request log runs with the group');

  const off = loadScript(generateScript(configOf(requests, { mode: 'B', options: { logRequests: true } })));
  assert.deepEqual(off.iteration(1, 0), []);
  assert.deepEqual(off.sleeps, []);
  assert.deepEqual(off.logs, []);
});

test('a gRPC request runs only with its group', () => {
  const requests = [inGroup({ type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.Greeter/SayHello', grpcPlaintext: true, body: '{"name":"x"}', checkStatus: true })];
  const script = generateScript(configOf(requests));
  assertSyntax(script);
  const on = loadScript(script);
  on.iteration(1, 0);
  assert.deepEqual(on.grpcCalls.map(call => call.step), ['connect', 'invoke', 'close']);
  const off = loadScript(generateScript(configOf(requests, { mode: 'B' })));
  off.iteration(1, 0);
  assert.deepEqual(off.grpcCalls, []);
});

// ── Which variable the condition reads ────────────────────────

test('the condition reads a variable by the same precedence as {{variable}}', () => {
  const runIf = { variable: 'kind', operator: 'equals', values: ['x'] };
  const group = inGroup();

  const global = generateScript(configOf([group], { runIf, variables: [{ key: 'kind', value: 'x' }] }));
  assert.match(global, /String\(GLOBALS\.kind\) === "x"/);

  const column = generateScript(configOf([group], {
    runIf, variables: [{ key: 'kind', value: 'g' }],
    dataSets: [{ id: 'ds_a', name: 'k.csv', skipHeader: true, columns: ['kind'], content: 'kind\nx\n' }],
  }));
  assert.match(column, /String\(DATA_1_ROW\.kind\) === "x"/, 'a data column beats a global variable');
  assert.deepEqual(urls(loadScript(column).iteration(1, 0)), ['https://api.test/x']);

  const processor = generateScript(configOf([request({ preScript: 'vars.kind = "x";' }), group], { runIf }));
  assert.match(processor, /String\(vars\.kind\) === "x"/);

  const extracted = generateScript(configOf(
    [request({ url: 'https://api.test/first', extractions: [{ varName: 'kind', source: 'json', selector: 'n' }] }), group],
    { runIf: { variable: 'kind', operator: 'equals', values: ['5'] } },
  ));
  assert.match(extracted, /String\(kind\) === "5"/);
  const run = loadScript(extracted, { respond: call => (call.url.endsWith('/first') ? { body: '{"n":5}' } : {}) });
  assert.deepEqual(urls(run.iteration(1, 0)), ['https://api.test/first', 'https://api.test/x'], 'a number compares as its text');
});

// ── Errors are a 400, not a silent "always false" ─────────────

test('a condition on an unknown variable names the group and the variable', () => {
  assert.throws(
    () => generateScript(configOf([inGroup()], { variables: [], runIf: { variable: 'EXECUTION_MODE', operator: 'equals', values: ['A'] } })),
    /Group "Orders": the "run only if" condition reads \{\{EXECUTION_MODE\}\}, but it is not a known variable at this point/,
  );
  // A variable that a LATER request extracts is not known when the group starts.
  assert.throws(
    () => generateScript(configOf([inGroup(), request({ extractions: [{ varName: 'late', source: 'json', selector: 'x' }] })], {
      runIf: { variable: 'late', operator: 'equals', values: ['A'] },
    })),
    /reads \{\{late\}\}/,
  );
  // A group without a name is named by its position.
  assert.throws(
    () => generateScript(configOf([inGroup()], { variables: [], group: { name: '' } })),
    /^Error: Request group 1: /,
  );
});

test('a column of a data file read inside the same group cannot decide that group', () => {
  assert.throws(
    () => generateScript(configOf([inGroup()], {
      runIf: { variable: 'kind', operator: 'equals', values: ['x'] },
      dataSets: [{ id: 'ds_a', name: 'k.csv', skipHeader: true, columns: ['kind'], content: 'kind\nx\n', groupId: 'grp_a' }],
    })),
    /Group "Orders": .*reads \{\{kind\}\}, but it is a column of a data file that is read inside this group/,
  );
});

test('a condition that cannot work is rejected instead of ignored', () => {
  const generate = runIf => () => generateScript(configOf([inGroup()], { runIf }));
  assert.throws(generate({ variable: 'MODE', operator: 'matches', values: ['A'] }), /Group "Orders": invalid "run only if" condition\. Choose/);
  assert.throws(generate({ variable: 'MODE', operator: 'equals', values: [] }), /Enter at least one value/);
  assert.throws(generate({ variable: 'MODE', operator: 'equals', values: ['A', 'B'] }), /use "is one of" for several/);
  assert.throws(generate({ variable: 'my mode', operator: 'equals', values: ['A'] }), /"my mode" is not a valid variable name/);
  assert.throws(generate('MODE=A'), /must be an object/);
});

let server;
let baseUrl;
before(async () => {
  server = createServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await once(server, 'close');
});

test('POST /api/generate answers 400 with the message, and 200 with a script for a good condition', async () => {
  const post = body => fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const bad = await post(configOf([inGroup()], { variables: [] }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Group "Orders": the "run only if" condition reads \{\{MODE\}\}/);
  const good = await post(configOf([inGroup()]));
  assert.equal(good.status, 200);
  assert.match((await good.json()).script, /if \(String\(GLOBALS\.MODE\) === "A"\) \{/);
});

// ── Data files of a conditional or turned-off group ───────────

const LOGIN = 'email,password\nuser1@example.com,p1\nuser2@example.com,p2\n';
const loginSet = (overrides = {}) => ({
  id: 'ds_login', name: 'login.csv', fileName: 'login.csv', skipHeader: true, columns: ['email', 'password'],
  content: LOGIN, share: 'next-row', onEnd: 'stop', groupId: 'grp_a', ...overrides,
});
const userOf = call => /u=([^&]+)/.exec(call.url)?.[1];

test('a data file of a conditional group picks its row, and stops, only inside that group', () => {
  const requests = [request({ url: 'https://api.test/always' }), inGroup({ url: 'https://api.test/login?u={{email}}' })];
  const script = generateScript(configOf(requests, { dataSets: [loginSet()] }));
  assertSyntax(script);
  // The row variable is declared empty up front; the pick and the `stop` live inside the if.
  assert.ok(script.indexOf('let DATA_1_ROW = {"email":"","password":""};') < script.indexOf('  if (String(GLOBALS.MODE)'));
  assert.ok(script.indexOf('  if (String(GLOBALS.MODE)') < script.indexOf('DATA_1_ROW = DATA_1[exec.scenario.iterationInTest];'));
  assert.doesNotMatch(script, /const DATA_1_ROW/);

  const on = loadScript(script);
  assert.deepEqual(on.iteration(1, 0).map(call => userOf(call) ?? 'always'), ['always', 'user1@example.com']);
  assert.deepEqual(on.iteration(1, 1).map(call => userOf(call) ?? 'always'), ['always', 'user2@example.com']);
  assert.deepEqual(urls(on.iteration(1, 2)), ['https://api.test/always'], 'out of rows: the iteration ends when the group starts');
  assert.equal(on.logs.length, 1);

  // The condition fails, so the file never ends the iteration, however many rows are used up.
  const off = loadScript(generateScript(configOf(requests, { mode: 'B', dataSets: [loginSet()] })));
  for (let iteration = 0; iteration < 6; iteration++) assert.deepEqual(urls(off.iteration(1, iteration)), ['https://api.test/always']);
  assert.deepEqual(off.logs, []);
  assert.deepEqual(off.sleeps, []);
});

test('rows follow the iteration number, not how often the group ran', () => {
  const requests = [inGroup({ url: 'https://api.test/login?u={{email}}' })];
  const script = generateScript(configOf(requests, { dataSets: [loginSet({ onEnd: 'recycle', content: `${LOGIN}user3@example.com,p3\n` })] }));
  const run = loadScript(script);
  assert.deepEqual([0, 1, 2, 3].map(iteration => userOf(run.iteration(1, iteration)[0])),
    ['user1@example.com', 'user2@example.com', 'user3@example.com', 'user1@example.com']);
});

test('a request after the group reads the empty column when the group did not run, and the row when it did', () => {
  const requests = [inGroup({ url: 'https://api.test/in' }), request({ url: 'https://api.test/after?u={{email}}' })];
  const on = loadScript(generateScript(configOf(requests, { dataSets: [loginSet({ onEnd: 'recycle' })] })));
  assert.equal(userOf(on.iteration(1, 0).at(-1)), 'user1@example.com');
  const off = loadScript(generateScript(configOf(requests, { mode: 'B', dataSets: [loginSet({ onEnd: 'recycle' })] })));
  assert.equal(off.iteration(1, 0).at(-1).url, 'https://api.test/after?u=');
});

test('a data file of a group without a condition is read when that group starts', () => {
  const requests = [request({ url: 'https://api.test/first' }), inGroup({ url: 'https://api.test/login?u={{email}}' })];
  const script = generateScript(configOf(requests, { runIf: null, dataSets: [loginSet()] }));
  assertSyntax(script);
  assert.doesNotMatch(script, /runs only if/);
  const run = loadScript(script);
  assert.deepEqual(urls(run.iteration(1, 2)), ['https://api.test/first'], 'out of rows: only what comes before the group ran');
});

test('a data file of a turned-off group is not used at all', () => {
  const requests = [request({ url: 'https://api.test/always?u={{email}}' }), inGroup({ url: 'https://api.test/in?u={{email}}' })];
  const script = generateScript(configOf(requests, { group: { enabled: false }, dataSets: [loginSet()] }));
  assertSyntax(script);
  assert.doesNotMatch(script, /SharedArray|DATA_1|k6\/execution/);
  assert.match(script, /always\?u=\{\{email\}\}/, 'its columns are not available');
  const run = loadScript(script);
  for (let iteration = 0; iteration < 5; iteration++) assert.deepEqual(urls(run.iteration(1, iteration)), ['https://api.test/always?u={{email}}']);
  assert.deepEqual(run.logs, []);
});

test('a data file of a turned-off group does not count towards the size limits', () => {
  const huge = `email\n${'x'.repeat(6 * 1024 * 1024)}`;
  assert.doesNotThrow(() => generateScript(configOf([inGroup()], { group: { enabled: false }, dataSets: [loginSet({ content: huge })] })));
});

test('a groupId that points nowhere means a global data file', () => {
  const script = generateScript(configOf([request({ url: 'https://api.test/in?u={{email}}' })], { dataSets: [loginSet({ groupId: 'grp_gone' })] }));
  assert.match(script, /const DATA_1_ROW = DATA_1\[/);
});

test('an interleaved group picks its row at each run, and still agrees with itself', () => {
  const requests = [
    inGroup({ url: 'https://api.test/a1?u={{email}}' }),
    request({ url: 'https://api.test/between' }),
    inGroup({ url: 'https://api.test/a2?u={{email}}' }),
  ];
  const script = generateScript(configOf(requests, { dataSets: [loginSet({ onEnd: 'recycle' })] }));
  assertSyntax(script);
  const calls = loadScript(script).iteration(1, 1);
  assert.deepEqual(calls.map(userOf), ['user2@example.com', undefined, 'user2@example.com']);
});
