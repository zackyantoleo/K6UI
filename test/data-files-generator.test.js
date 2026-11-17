import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';

import { generateScript } from '../server/generator/index.js';
import { loadScript } from './helpers/load-script.js';
import { interpolate } from '../server/generator/interpolate.js';
import {
  DataSetError, MAX_DATA_SET_BYTES, buildDataDeclarations, buildDataRowCode, prepareDataSets,
} from '../server/generator/data.js';

const LOGIN_CSV = 'email,password\nuser1@example.com,pass1\nuser2@example.com,pass2\nuser3@example.com,pass3\n';

const dataSet = (overrides = {}) => ({
  id: 'ds_login', name: 'login.csv', fileName: 'login.csv', delimiter: ',', skipHeader: true,
  columns: ['email', 'password'], content: LOGIN_CSV, share: 'next-row', onEnd: 'recycle', ...overrides,
});

const loginRequest = {
  method: 'POST', url: 'https://api.test/login?u={{email}}',
  headers: [{ key: 'X-User', value: '{{email}}' }], body: '{"email":"{{email}}","password":"{{password}}"}',
  checkStatus: false, sleepAfter: '0',
};

const configOf = (dataSets, extra = {}) => ({
  load: { mode: 'simple', vus: 1, duration: '1s' },
  scenario: { requests: [loginRequest] },
  dataSets,
  ...extra,
});

// The generated script must be valid module syntax.
const assertSyntax = script => assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));

// ── Golden output ─────────────────────────────────────────────

test('golden output: next-row + recycle', () => {
  const script = generateScript(configOf([dataSet({ content: 'email,password\nuser1@example.com,pass1\nuser2@example.com,pass2\n' })]));
  assertSyntax(script);
  assert.ok(script.includes(`import { SharedArray } from 'k6/data';\nimport exec from 'k6/execution';\n`));
  assert.ok(script.includes(`// Data files — each iteration reads one row; use {{column}} in URLs, headers, and bodies
// login.csv: email, password (2 rows)
const DATA_1 = new SharedArray("1: login.csv", function () {
  const columns = ["email","password"];
  return [
    ["user1@example.com","pass1"],
    ["user2@example.com","pass2"]
  ].map(function (row) {
    const item = {};
    columns.forEach(function (name, i) { item[name] = row[i]; });
    return item;
  });
});
`));
  assert.ok(script.includes(`export default function() {
  // Data file: login.csv — next row for every iteration
  const DATA_1_ROW = DATA_1[(exec.scenario.iterationInTest) % DATA_1.length];
`));
  assert.match(script, /http\.request\("POST", `https:\/\/api\.test\/login\?u=\$\{DATA_1_ROW\.email\}`, body_main_0, \{ headers: \{ "X-User": `\$\{DATA_1_ROW\.email\}` \} \}\)/);
  assert.match(script, /const body_main_0 = `\{"email":"\$\{DATA_1_ROW\.email\}","password":"\$\{DATA_1_ROW\.password\}"\}`;/);
});

test('golden output: next-row + stop logs once and ends the iteration', () => {
  const rows = buildDataRowCode(prepareDataSets([dataSet({ onEnd: 'stop' })]));
  assert.equal(rows, `  // Data file: login.csv — next row for every iteration
  const DATA_1_ROW = DATA_1[exec.scenario.iterationInTest];
  if (!DATA_1_ROW) {
    if (exec.scenario.iterationInTest === DATA_1.length) console.warn("Data file \\"login.csv\\" has no more rows (3); ending iterations early.");
    sleep(1);
    return;
  }
`);
  assertSyntax(generateScript(configOf([dataSet({ onEnd: 'stop' })])));
});

test('golden output: per-vu + recycle', () => {
  const sets = prepareDataSets([dataSet({ share: 'per-vu' })]);
  assert.equal(buildDataRowCode(sets), `  // Data file: login.csv — one row per VU
  const DATA_1_ROW = DATA_1[(__VU - 1) % DATA_1.length];
`);
  assert.doesNotMatch(buildDataDeclarations(sets), /_ENDED/);
});

test('golden output: per-vu + stop logs once per VU', () => {
  const sets = prepareDataSets([dataSet({ share: 'per-vu', onEnd: 'stop' })]);
  assert.equal(buildDataRowCode(sets), `  // Data file: login.csv — one row per VU
  const DATA_1_ROW = DATA_1[__VU - 1];
  if (!DATA_1_ROW) {
    if (!DATA_1_ENDED) { DATA_1_ENDED = true; console.warn("Data file \\"login.csv\\" has no more rows (3); ending iterations early."); }
    sleep(1);
    return;
  }
`);
  assert.match(buildDataDeclarations(sets), /\nlet DATA_1_ENDED = false;\n/);
  assertSyntax(generateScript(configOf([dataSet({ share: 'per-vu', onEnd: 'stop' })])));
});

test('no data sets → the script is exactly what it was before (no imports, no row code)', () => {
  const plain = generateScript(configOf(undefined));
  assert.doesNotMatch(plain, /SharedArray|k6\/execution|DATA_/);
  assert.equal(generateScript(configOf([])), plain);
});

test('several data sets get their own array, row, and number', () => {
  const script = generateScript(configOf([
    dataSet(),
    dataSet({ id: 'ds_orders', name: 'orders.csv', columns: ['order_number'], content: 'order_number\nA1\nA2\n', share: 'per-vu' }),
  ], { scenario: { requests: [{ ...loginRequest, url: 'https://api.test/{{email}}/{{order_number}}' }] } }));
  assertSyntax(script);
  assert.match(script, /const DATA_1 = new SharedArray\("1: login\.csv"/);
  assert.match(script, /const DATA_2 = new SharedArray\("2: orders\.csv"/);
  assert.match(script, /const DATA_2_ROW = DATA_2\[\(__VU - 1\) % DATA_2\.length\];/);
  assert.match(script, /`https:\/\/api\.test\/\$\{DATA_1_ROW\.email\}\/\$\{DATA_2_ROW\.order_number\}`/);
});

// ── CSV edge cases end up as exact values ─────────────────────

test('commas, quotes, newlines, tabs, and U+2028 in fields survive as string literals', () => {
  const content = 'email,note\n"a,b@example.com","say ""hi""\nsecond line\tTab \u2028 end"\n';
  const script = generateScript(configOf([dataSet({ content, columns: ['email', 'note'] })]));
  assertSyntax(script);
  assert.doesNotMatch(script, /\u2028/, 'a raw U+2028 would break older JS engines');
  const declared = script.match(/return (\[\n[\s\S]*?\n  \])\.map/)[1];
  assert.deepEqual(JSON.parse(declared), [['a,b@example.com', 'say "hi"\nsecond line\tTab \u2028 end']]);
});

test('a BOM, CRLF line ends, and empty lines do not leak into names or values', () => {
  const content = '﻿email,password\r\n\r\nu1@example.com,p1\r\n\r\nu2@example.com,p2\r\n';
  const [prepared] = prepareDataSets([dataSet({ content, columns: [] })]);
  assert.deepEqual(prepared.columns, ['email', 'password']);
  assert.deepEqual(prepared.rows, [['u1@example.com', 'p1'], ['u2@example.com', 'p2']]);
});

test('short rows are padded with empty strings and extra fields are dropped', () => {
  const [prepared] = prepareDataSets([dataSet({ content: 'a,b\n1\n2,3,4\n' })]);
  assert.deepEqual(prepared.rows, [['1', ''], ['2', '3']]);
});

test('without a header row every line is data and the columns come from the config', () => {
  const [prepared] = prepareDataSets([dataSet({ skipHeader: false, content: 'x1,y1\nx2,y2\n', columns: ['x', 'y'] })]);
  assert.deepEqual(prepared.rows, [['x1', 'y1'], ['x2', 'y2']]);
});

test('other delimiters and "\\t" from an imported project work', () => {
  const tab = prepareDataSets([dataSet({ delimiter: '\\t', content: 'email\tpassword\nu\tp\n' })])[0];
  assert.deepEqual(tab.rows, [['u', 'p']]);
  const semi = prepareDataSets([dataSet({ delimiter: ';', content: 'email;password\n"u;1";p\n' })])[0];
  assert.deepEqual(semi.rows, [['u;1', 'p']]);
});

test('column order follows the file; blank names skip a file column; invalid names are ignored', () => {
  const [prepared] = prepareDataSets([dataSet({
    content: 'a,b,c,d\n1,2,3,4\n', columns: ['first', '', '3bad', 'fourth'],
  })]);
  assert.deepEqual(prepared.columns, ['first', 'fourth']);
  assert.deepEqual(prepared.rows, [['1', '4']]);
});

test('with a header and no column names the header names the columns', () => {
  const [prepared] = prepareDataSets([dataSet({ columns: [] })]);
  assert.deepEqual(prepared.columns, ['email', 'password']);
});

// ── Ignored data sets ─────────────────────────────────────────

test('a data set without rows, content, or a valid column is ignored and its placeholders stay literal', () => {
  for (const ignored of [
    dataSet({ content: '' }),
    dataSet({ content: 'email,password\n' }),
    dataSet({ content: '\n\n' }),
    dataSet({ columns: ['1bad', 'with space'] }),
    dataSet({ skipHeader: false, columns: [] }),
  ]) {
    const script = generateScript(configOf([ignored]));
    assert.doesNotMatch(script, /SharedArray|DATA_1/);
    assert.match(script, /https:\/\/api\.test\/login\?u=\{\{email\}\}/);
  }
  assert.deepEqual(prepareDataSets('nope'), []);
  assert.deepEqual(prepareDataSets([null, 3, {}]), []);
});

test('numbering skips ignored data sets', () => {
  const script = generateScript(configOf([dataSet({ content: '' }), dataSet({ name: 'second' })]));
  assert.match(script, /const DATA_1 = new SharedArray\("1: second"/);
});

// ── Limits and errors ─────────────────────────────────────────

test('a data set over the size limit is rejected with a 413 that names it', () => {
  const content = `email\n${'x'.repeat(MAX_DATA_SET_BYTES)}`;
  assert.throws(() => generateScript(configOf([dataSet({ name: 'Big users', content })])), error => {
    assert.ok(error instanceof DataSetError);
    assert.equal(error.status, 413);
    assert.match(error.message, /Data file "Big users" is 5\.1 MB; the limit is 5\.0 MB per file/);
    return true;
  });
});

test('the data sets together are limited too', () => {
  const content = `email\n${'x'.repeat(MAX_DATA_SET_BYTES - 100)}`;
  assert.throws(
    () => prepareDataSets([dataSet({ content }), dataSet({ content }), dataSet({ content })]),
    error => error.status === 413 && /add up to/.test(error.message),
  );
});

test('a quoted value that never closes is a 400 naming the file and the line', () => {
  assert.throws(() => generateScript(configOf([dataSet({ content: 'email,password\n"u1,p1\nu2,p2\n' })])), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /Data file "login\.csv": A quoted value that starts on line 2 is never closed/);
    return true;
  });
});

test('a bad delimiter is a 400', () => {
  assert.throws(() => prepareDataSets([dataSet({ delimiter: 'ab' })]), error => error.status === 400 && /single character/.test(error.message));
});

// ── {{column}} precedence ─────────────────────────────────────

test('precedence: extracted > processor > data column > global', () => {
  const ctx = {
    localVars: new Set(['a']),
    processorVars: new Set(['a', 'b']),
    dataVars: new Map([['a', 'DATA_1_ROW'], ['b', 'DATA_1_ROW'], ['c', 'DATA_1_ROW']]),
    globalVars: new Set(['a', 'b', 'c', 'd']),
  };
  assert.equal(interpolate('{{a}}|{{b}}|{{c}}|{{d}}|{{e}}', ctx),
    '`${a}|${vars.b}|${DATA_1_ROW.c}|${GLOBALS.d}|{{e}}`');
});

test('the first data set that has a column wins; a column beats a global variable', () => {
  const script = generateScript(configOf([
    dataSet({ columns: ['email', 'password'] }),
    dataSet({ name: 'other.csv', columns: ['email'], content: 'email\nother@example.com\n' }),
  ], { variables: [{ key: 'email', value: 'global@example.com' }, { key: 'region', value: 'eu' }] }));
  assert.match(script, /u=\$\{DATA_1_ROW\.email\}/);
  assert.doesNotMatch(script, /DATA_2_ROW\.email/);
});

test('a column read before a request extracts the same name uses the file; afterwards the extracted value', () => {
  const script = generateScript({
    load: { mode: 'simple', vus: 1, duration: '1s' },
    dataSets: [dataSet({ columns: ['order_number', 'auth'], content: 'order_number,auth\nO1,t1\n' })],
    scenario: { requests: [
      { method: 'GET', url: 'https://api.test/before/{{order_number}}', checkStatus: false, sleepAfter: '0' },
      {
        method: 'POST', url: 'https://api.test/orders', checkStatus: false, sleepAfter: '0',
        extractions: [{ varName: 'order_number', source: 'json', selector: 'id' }],
      },
      { method: 'GET', url: 'https://api.test/after/{{order_number}}/{{auth}}', checkStatus: false, sleepAfter: '0' },
    ] },
  });
  assertSyntax(script);
  assert.match(script, /`https:\/\/api\.test\/before\/\$\{DATA_1_ROW\.order_number\}`/);
  assert.match(script, /`https:\/\/api\.test\/after\/\$\{order_number\}\/\$\{DATA_1_ROW\.auth\}`/);
});

test('columns work in gRPC requests and in Before/After sub-requests', () => {
  const script = generateScript({
    load: { mode: 'simple', vus: 1, duration: '1s' },
    dataSets: [dataSet()],
    scenario: { requests: [{
      type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.Greeter/SayHello', grpcPlaintext: true,
      body: '{"name":"{{email}}"}', checkStatus: true, sleepAfter: '0',
      pre: { method: 'GET', url: 'https://api.test/pre/{{password}}', headers: [], body: '', extractions: [] },
    }] },
  });
  assertSyntax(script);
  assert.match(script, /JSON\.parse\(`\{"name":"\$\{DATA_1_ROW\.email\}"\}`\)/);
  assert.match(script, /https:\/\/api\.test\/pre\/\$\{DATA_1_ROW\.password\}/);
});

// ── Running the generated script against stubbed k6 modules ───

const userOf = call => /u=([^&]+)/.exec(call.url)?.[1];

test('iterations mode, 5 VUs, next-row, 5 CSV rows: every VU reads a different row', () => {
  const content = `email,password\n${[1, 2, 3, 4, 5].map(n => `user${n}@example.com,pass${n}`).join('\n')}\n`;
  const script = generateScript(configOf([dataSet({ content })], { load: { mode: 'iterations', vus: '5', iterations: '1' } }));
  assertSyntax(script);
  const run = loadScript(script);
  assert.deepEqual(run.options.scenarios.default, { executor: 'per-vu-iterations', vus: 5, iterations: 1, maxDuration: '1h' });

  const seen = [];
  let counter = 0;
  for (let vu = 1; vu <= 5; vu++) {
    const [call] = run.iteration(vu, counter++);
    seen.push(userOf(call));
    assert.equal(JSON.parse(call.body).password, `pass${seen.length}`, 'the password comes from the same row');
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5].map(n => `user${n}@example.com`));
  assert.equal(new Set(seen).size, 5);
});

test('iterations mode, 3 VUs x 2 iterations over 5 rows, recycle: rows wrap around', () => {
  const content = `email,password\n${[1, 2, 3, 4, 5].map(n => `user${n}@example.com,p${n}`).join('\n')}\n`;
  const run = loadScript(generateScript(configOf([dataSet({ content })], { load: { mode: 'iterations', vus: '3', iterations: '2' } })));
  const seen = [];
  let counter = 0;
  for (let iteration = 0; iteration < 2; iteration++) {
    for (let vu = 1; vu <= 3; vu++) seen.push(userOf(run.iteration(vu, counter++)[0]));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 1].map(n => `user${n}@example.com`));
});

test('next-row + stop: iterations past the last row end early, log once, and pause', () => {
  const run = loadScript(generateScript(configOf([dataSet({ onEnd: 'stop' })])));
  assert.equal(run.iteration(1, 0).length, 1);
  assert.equal(run.iteration(1, 2).length, 1);
  assert.equal(run.iteration(1, 3).length, 0, 'row 4 does not exist');
  assert.equal(run.iteration(2, 4).length, 0);
  assert.equal(run.iteration(1, 5).length, 0);
  assert.equal(run.logs.length, 1);
  assert.match(run.logs[0], /Data file "login\.csv" has no more rows \(3\)/);
  assert.deepEqual(run.sleeps, [1, 1, 1]);
});

test('per-vu: VU n reads row n, recycles or stops after the last row', () => {
  const recycle = loadScript(generateScript(configOf([dataSet({ share: 'per-vu' })])));
  assert.deepEqual([1, 2, 3, 4, 5].map(vu => userOf(recycle.iteration(vu, 99)[0])),
    ['user1@example.com', 'user2@example.com', 'user3@example.com', 'user1@example.com', 'user2@example.com']);

  const stop = loadScript(generateScript(configOf([dataSet({ share: 'per-vu', onEnd: 'stop' })])));
  assert.equal(userOf(stop.iteration(3, 0)[0]), 'user3@example.com');
  assert.equal(stop.iteration(4, 0).length, 0);
  assert.equal(stop.iteration(4, 1).length, 0);
  assert.equal(stop.iteration(5, 2).length, 0);
  assert.equal(stop.logs.length, 1, 'the flag is per VU: one VU runs this module, so one log here');
});

test('CSV values are trimmed in generated SharedArray unless trimValues is false', () => {
  const trimmed = prepareDataSets([dataSet({ content: 'email,password\n user1@example.com , pass1 \n' })]);
  assert.deepEqual(trimmed[0].rows, [['user1@example.com', 'pass1']]);

  const raw = prepareDataSets([dataSet({ content: 'email,password\n user1@example.com , pass1 \n', trimValues: false })]);
  assert.deepEqual(raw[0].rows, [[' user1@example.com ', ' pass1 ']]);
});
