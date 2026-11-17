// "Save to CSV": the shared rules (public/js/csv-export.js), the generator, the
// server-side collector and runner, both importers, the store, and the results model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'acorn';

import {
  downloadName, exportProblem, exportsProblem, normalizeExport, normalizeExports, toCsv,
} from '../public/js/csv-export.js';
import { parseCsv } from '../public/js/csv-parse.js';
import { migrateProject } from '../public/js/project-store.js';
import { createExportStore } from '../public/js/export-results.js';
import { generateScript } from '../server/generator/index.js';
import { createExportCollector } from '../server/export-collector.js';
import { startK6Run } from '../server/k6-runner.js';
import { createServer } from '../server/index.js';
import { importK6Script } from '../server/importer/index.js';
import { importJmx } from '../server/importer/jmx/index.js';
import { loadScript } from './helpers/load-script.js';

const assertSyntax = script => assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
const request = (overrides = {}) => ({ method: 'GET', url: 'https://api.test/x', checkStatus: false, sleepAfter: '0', ...overrides });
const json = (varName, selector, extra = {}) => ({ varName, source: 'json', selector, ...extra });
const column = (name, value) => ({ name, value });
const generated = config => {
  const script = generateScript(config);
  assertSyntax(script);
  return script;
};
const rowsOf = logs => logs.map(line => JSON.parse(line)).filter(entry => entry.k6uiExport);

// The eratech shape: login → (group "Orders", runs when MODE is ON) create order → save it.
const LOGIN = request({ url: 'https://api.test/login', extractions: [json('token', 'data.token', { default: 'TOKEN_NOT_FOUND' })] });
const ORDER_EXPORT = {
  file: 'orders_created.csv', skipMissing: true,
  columns: [column('order_number', '{{order_number}}'), column('auth', 'Bearer {{token}}')],
};
const ORDER = request({
  url: 'https://api.test/order', groupId: 'grp_orders',
  extractions: [json('order_number', 'data.order_number', { default: 'ORDER_NOT_FOUND' })],
  exports: [ORDER_EXPORT],
});
const flow = (mode, requests = [LOGIN, ORDER]) => ({
  load: { mode: 'iterations', vus: '1', iterations: '1' },
  variables: [{ key: 'MODE', value: mode }],
  scenario: {
    groups: [{ id: 'grp_orders', name: 'Orders', enabled: true, runIf: { variable: 'MODE', operator: 'equals', values: ['ON'] } }],
    requests,
  },
});

// ── Shared rules ──────────────────────────────────────────────

test('an export is normalized to one shape; unknown fields pass through', () => {
  assert.deepEqual(normalizeExport({ file: ' a.csv ', columns: [{ name: ' x ', value: 1, note: 'kept' }, 'bad'], skipMissing: 'yes', extra: 1 }), {
    file: 'a.csv', columns: [{ name: 'x', value: '1', note: 'kept' }], skipMissing: false, extra: 1,
  });
  assert.equal(normalizeExport(null), null);
  assert.equal(normalizeExport(['a.csv']), null);
  assert.deepEqual(normalizeExports([null, { file: 'a.csv' }, 3]), [{ file: 'a.csv', columns: [], skipMissing: false }]);
  assert.deepEqual(normalizeExports('a.csv'), []);
});

test('an export needs a safe file name and valid, unique column names; a blank one is ignored', () => {
  const ok = { file: 'orders.csv', columns: [column('a', '{{a}}'), column('', '')] };
  assert.equal(exportProblem(ok), '');
  assert.equal(exportProblem({ file: '', columns: [column('', '')] }), '', 'blank');
  assert.match(exportProblem('x'), /must be an object/);
  assert.match(exportProblem({ columns: [column('a', '1')] }), /Enter the name of the CSV file/);
  assert.match(exportProblem({ file: 'dir/a.csv', columns: [column('a', '1')] }), /cannot contain \/ or \\/);
  assert.match(exportProblem({ file: `a${String.fromCharCode(10)}b.csv`, columns: [column('a', '1')] }), /control characters/);
  assert.match(exportProblem({ file: 'x'.repeat(121), columns: [column('a', '1')] }), /longer than 120/);
  assert.match(exportProblem({ file: 'a.csv', columns: [] }), /Add at least one column/);
  assert.match(exportProblem({ file: 'a.csv', columns: [column('', '{{a}}')] }), /Name column 1/);
  assert.match(exportProblem({ file: 'a.csv', columns: [column('order-no', '1')] }), /"order-no" is not a valid name/);
  assert.match(exportProblem({ file: 'a.csv', columns: [column('a', '1'), column('a', '2')] }), /"a" appears twice/);
});

test('across requests: one file keeps one set of columns, and at most 10 files', () => {
  const save = (file, ...names) => ({ file, columns: names.map(name => column(name, `{{${name}}}`)) });
  assert.equal(exportsProblem([{ label: 'Request 1', exports: [save('a.csv', 'x')] }, { label: 'Request 2', exports: [save('a.csv', 'x')] }]), '');
  assert.equal(exportsProblem([
    { label: 'Request 1', exports: [save('a.csv', 'x', 'y')] }, { label: 'Request 2', exports: [save('a.csv', 'y', 'x')] },
  ]), '"a.csv" is saved by Request 1 with columns x, y and by Request 2 with columns y, x; use the same columns, or another file name.');
  assert.match(exportsProblem([{ label: 'Request 3', exports: [save('', 'x')] }]), /^Request 3, Save to CSV 1: Enter the name/);
  const many = Array.from({ length: 11 }, (_, i) => save(`f${i}.csv`, 'x'));
  assert.match(exportsProblem([{ label: 'Request 1', exports: many }]), /at most 10 CSV files \(this one saves to 11\)/);
});

test('CSV text: quoted only when needed, read back to the same rows by the data file reader', () => {
  const rows = [['a,b', 'say "hi"'], ['line\nbreak', '  spaced  '], ['', ''], ['plain', 'ünïcode']];
  const csv = toCsv(['first', 'second'], rows);
  assert.equal(csv.split('\n')[0], 'first,second');
  assert.equal(csv.split('\n')[1], '"a,b","say ""hi"""');
  assert.deepEqual(parseCsv(csv), [['first', 'second'], ...rows]);
  assert.equal(toCsv(['only'], [[''], ['v']]), 'only\n""\nv\n', 'a lone empty field is not an empty line');
  assert.deepEqual(parseCsv(toCsv(['only'], [[''], ['v']])), [['only'], [''], ['v']]);
});

test('a download name has no path or reserved characters and ends in .csv', () => {
  assert.equal(downloadName('orders_created.csv'), 'orders_created.csv');
  assert.equal(downloadName('../../etc/passwd'), '_.._etc_passwd.csv');
  assert.equal(downloadName('a:b*c?.csv'), 'a_b_c_.csv');
  assert.equal(downloadName('report'), 'report.csv');
  assert.equal(downloadName('data.tsv'), 'data.tsv');
  assert.equal(downloadName(' .. '), 'export.csv');
});

// ── Generator ─────────────────────────────────────────────────

test('golden output: a row after the request, guarded by "only when found" inside a conditional group', () => {
  const script = generated(flow('ON'));
  const body = script.slice(script.indexOf('  // Request 2:'));
  assert.equal(body, `  // Request 2: GET https://api.test/order
  const res_main_1 = http.request("GET", "https://api.test/order", null, {});
  order_number = extractOr(() => JSON.parse(res_main_1.body)?.["data"]?.["order_number"], "ORDER_NOT_FOUND");

  // Save a row to CSV "orders_created.csv" (only when the extracted values it uses were found)
  if (![undefined, null, "", "ORDER_NOT_FOUND"].includes(order_number) && ![undefined, null, "", "TOKEN_NOT_FOUND"].includes(token)) {
    console.log(JSON.stringify({ k6uiExport: "orders_created.csv", columns: ["order_number", "auth"], row: [\`\${order_number}\`, \`Bearer \${token}\`] }));
  }
  }
}
`);
});

test('without "only when found", or with no extracted value to check, the row is always logged', () => {
  const plain = request({ exports: [{ file: 'plain.csv', columns: [column('mode', '{{MODE}}'), column('fixed', 'a, "b"')], skipMissing: true }] });
  const script = generated(flow('OFF', [plain]));
  assert.match(script, /\n {2}\/\/ Save a row to CSV "plain\.csv"\n {2}console\.log\(JSON\.stringify\(\{ k6uiExport: "plain\.csv", columns: \["mode", "fixed"\], row: \[`\$\{GLOBALS\.MODE\}`, "a, \\"b\\""\] \}\)\);\n/);
  const k6 = loadScript(script);
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs), [{ k6uiExport: 'plain.csv', columns: ['mode', 'fixed'], row: ['OFF', 'a, "b"'] }]);
});

test('execution: a found order is saved; a missing one (default) or a skipped group saves nothing', () => {
  const respond = orderBody => call => ({ body: call.url.endsWith('/login') ? '{"data":{"token":"T1"}}' : orderBody });
  let k6 = loadScript(generated(flow('ON')), { respond: respond('{"data":{"order_number":"ORD-7"}}') });
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs).map(entry => entry.row), [['ORD-7', 'Bearer T1']]);

  k6 = loadScript(generated(flow('ON')), { respond: respond('{"data":{}}') });
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs), [], 'order_number is still ORDER_NOT_FOUND');

  k6 = loadScript(generated(flow('ON')), { respond: call => ({ body: call.url.endsWith('/login') ? '{}' : '{"data":{"order_number":"ORD-8"}}' }) });
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs), [], 'token is still TOKEN_NOT_FOUND');

  k6 = loadScript(generated(flow('OFF')));
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs), [], 'the group did not run');
});

test('an older After request becomes its own request and takes the row, so values it extracts are still saved', () => {
  const script = generated(flow('OFF', [request({
    post: { method: 'GET', url: 'https://api.test/after', extractions: [json('receipt', 'id')] },
    exports: [{ file: 'r.csv', columns: [column('receipt', '{{receipt}}')] }],
  })]));
  assert.ok(script.indexOf('https://api.test/after') !== -1 && script.indexOf('https://api.test/after') < script.indexOf('// Save a row to CSV "r.csv"'));
  const k6 = loadScript(script, { respond: call => ({ body: call.url.endsWith('/after') ? '{"id":"R1"}' : '{}' }) });
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs).map(entry => entry.row), [['R1']]);
});

test('turned-off requests and groups save nothing; blank export blocks are ignored', () => {
  const off = request({ enabled: false, exports: [ORDER_EXPORT] });
  const script = generated({ ...flow('ON', [off, request({ exports: [{ file: '', columns: [column('', '')] }] })]) });
  assert.doesNotMatch(script, /k6uiExport/);
  const offGroup = flow('ON');
  offGroup.scenario.groups[0].enabled = false;
  assert.doesNotMatch(generated(offGroup), /k6uiExport/);
});

test('an export that cannot work is a 400 naming the request', async () => {
  assert.throws(() => generateScript(flow('ON', [request({ exports: [{ file: 'a.csv', columns: [column('bad name', '1')] }] })])),
    /Request 1, Save to CSV 1: Column "bad name" is not a valid name/);
  assert.throws(() => generateScript(flow('ON', [
    request({ exports: [{ file: 'a.csv', columns: [column('x', '1')] }] }),
    request({ exports: [{ file: 'a.csv', columns: [column('y', '1')] }] }),
  ])), /"a\.csv" is saved by Request 1 with columns x and by Request 2 with columns y/);

  const server = createServer({ port: 0, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flow('ON', [request({ exports: [{ columns: [column('x', '1')] }] })])),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Enter the name of the CSV file/);
  } finally {
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
  }
});

test('file and column names with quotes or line separators stay valid script', () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const script = generated(flow('OFF', [request({ exports: [{ file: `we"ird${lineSeparator}.csv`, columns: [column('a', `x${lineSeparator}y`)] }] })]));
  assert.ok(!script.split('// Save a row')[1].split('\n')[0].includes(lineSeparator), 'the comment stays on one line');
  const k6 = loadScript(script);
  k6.iteration(1, 0);
  assert.deepEqual(rowsOf(k6.logs), [{ k6uiExport: `we"ird${lineSeparator}.csv`, columns: ['a'], row: [`x${lineSeparator}y`] }]);
});

// ── Server: collector and runner ──────────────────────────────

const line = (file, columns, row) => JSON.stringify({ k6uiExport: file, columns, row });

test('collector: rows are batched per file; values become text; other lines are not its business', () => {
  const events = [];
  const collector = createExportCollector((event, data) => events.push({ event, data }), { flushMs: 60_000 });
  assert.equal(collector.addLine('{"__r":1,"i":0}'), false);
  assert.equal(collector.addLine('plain text'), false);
  assert.equal(collector.addLine(line('a.csv', ['n', 'o'], [1, null])), true);
  assert.equal(collector.addLine(line('a.csv', ['n', 'o'], [true, { id: 2 }])), true);
  assert.equal(collector.addLine(line('b.csv', ['x'], ['y'])), true);
  assert.equal(collector.addLine('{"k6uiExport":"broken'), true, 'a broken export line is dropped, never logged');
  assert.equal(collector.addLine(line('a.csv', ['other'], ['z'])), true, 'other columns for a known file: dropped');
  assert.equal(collector.addLine(line('a.csv', ['n', 'o'], ['too few'])), true);
  assert.deepEqual(events, [], 'nothing before a flush');
  collector.flush();
  assert.deepEqual(events, [
    { event: 'export', data: { file: 'a.csv', columns: ['n', 'o'], rows: [['1', ''], ['true', '{"id":2}']], truncated: false } },
    { event: 'export', data: { file: 'b.csv', columns: ['x'], rows: [['y']], truncated: false } },
  ]);
  collector.flush();
  assert.equal(events.length, 2, 'an empty flush sends nothing');
});

test('collector: flushes on its own timer', async () => {
  const events = [];
  const collector = createExportCollector((event, data) => events.push(data), { flushMs: 5 });
  collector.addLine(line('a.csv', ['x'], ['1']));
  await new Promise(done => setTimeout(done, 40));
  assert.deepEqual(events.map(data => data.rows), [[['1']]]);
});

test('collector: size and file limits mark the file truncated once and drop later rows', () => {
  const events = [];
  const collector = createExportCollector((event, data) => events.push(data), { flushMs: 60_000, maxFileBytes: 20, maxFiles: 1 });
  collector.addLine(line('a.csv', ['x'], ['12345']));   // header "x\n" 2 + 6 = 8 bytes
  collector.addLine(line('a.csv', ['x'], ['67890']));   // 14
  collector.addLine(line('a.csv', ['x'], ['abcdef']));  // would be 21 → truncated
  collector.addLine(line('a.csv', ['x'], ['1']));       // dropped too
  collector.addLine(line('b.csv', ['x'], ['1']));       // a second file: over maxFiles
  collector.flush();
  collector.flush();
  assert.deepEqual(events, [{ file: 'a.csv', columns: ['x'], rows: [['12345'], ['67890']], truncated: true }]);
});

// A fake k6 that prints the given lines the way k6 prints console.log (logrus text format).
async function runFakeK6(lines) {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  const logrus = text => `time="2026-11-16T00:00:00Z" level=info msg=${JSON.stringify(text)} source=console`;
  await writeFile(join(binDir, 'k6'), [
    '#!/bin/sh',
    ...lines.map(text => `printf '%s\\n' '${logrus(text).replace(/'/g, "'\\''")}' >&2`),
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    return await new Promise(resolve => {
      const events = [];
      startK6Run('export default function() {}', { onEvent: (event, data) => events.push({ event, data }), onEnd: () => resolve(events) });
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(binDir, { recursive: true, force: true });
  }
}

test('runner: export lines become `export` events before `done` and never reach the live log', async () => {
  const events = await runFakeK6([
    'hello from the script',
    line('orders_created.csv', ['order_number', 'auth'], ['ORD-1', 'Bearer secret-token-1']),
    line('orders_created.csv', ['order_number', 'auth'], ['ORD-2', "Bearer it's-secret"]),
    '{"k6uiExport":"broken secret-token-3',
  ]);
  const kinds = events.map(item => item.event);
  assert.ok(kinds.indexOf('export') < kinds.indexOf('done'));
  assert.deepEqual(events.filter(item => item.event === 'export').map(item => item.data), [{
    file: 'orders_created.csv', columns: ['order_number', 'auth'],
    rows: [['ORD-1', 'Bearer secret-token-1'], ['ORD-2', "Bearer it's-secret"]], truncated: false,
  }]);
  const logs = events.filter(item => item.event === 'log').map(item => item.data.line).join('');
  assert.match(logs, /hello from the script/);
  assert.doesNotMatch(logs, /secret|k6uiExport/);
});

// ── Importers ─────────────────────────────────────────────────

test('k6 import: K6UI rows come back as the same exports (also inside a conditional group)', () => {
  const plain = request({ url: 'https://api.test/plain', exports: [{ file: 'plain.csv', columns: [column('mode', '{{MODE}}'), column('fixed', 'a, "b"')], skipMissing: false }] });
  const { config, warnings } = importK6Script(generateScript(flow('ON', [LOGIN, ORDER, plain])));
  assert.deepEqual(warnings, []);
  const [, order, last] = config.scenario.requests;
  assert.deepEqual(order.exports, [ORDER_EXPORT]);
  assert.deepEqual(order.extractions, ORDER.extractions);
  assert.deepEqual(last.exports, plain.exports);
  assert.equal(Object.hasOwn(config.scenario.requests[0], 'exports'), false, 'requests without a row get no field');
});

test('k6 import: other console.log calls and other `if`s are not exports', () => {
  const { config, warnings } = importK6Script(`import http from 'k6/http';
export const options = { vus: 1, duration: '1s' };
export default function () {
  console.log(JSON.stringify({ k6uiExport: 'early.csv', columns: ['a'], row: ['1'] }));
  const res = http.get('https://api.test/a');
  console.log(JSON.stringify({ file: 'x.csv', row: [res.status] }));
  if (res.status === 200) { console.log(JSON.stringify({ k6uiExport: 'a.csv', columns: ['a'], row: ['1'] })); }
}
`);
  assert.equal(Object.hasOwn(config.scenario.requests[0], 'exports'), false);
  const text = warnings.map(w => w.message).join('\n');
  assert.match(text, /"Save to CSV" for "early\.csv" before the first request was skipped/);
  assert.match(text, /Skipped `if \(res\.status === 200\)/);
});

test('JMeter import: a JSR223 post-processor that writes a file points to "Save to CSV"', () => {
  const plan = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2"><hashTree><TestPlan testname="Plan"/><hashTree>
  <ThreadGroup testname="Users"><stringProp name="ThreadGroup.num_threads">1</stringProp></ThreadGroup>
  <hashTree>
    <HTTPSamplerProxy testname="07 - Create Order">
      <stringProp name="HTTPSampler.domain">api.test</stringProp>
      <stringProp name="HTTPSampler.path">/orders</stringProp>
      <stringProp name="HTTPSampler.method">POST</stringProp>
    </HTTPSamplerProxy>
    <hashTree>
      <JSR223PostProcessor testname="Save order_number to CSV">
        <stringProp name="scriptLanguage">groovy</stringProp>
        <stringProp name="script">def file = new File(&quot;orders_created.csv&quot;)
file.withWriterAppend(&quot;UTF-8&quot;) { w -&gt; w.writeLine(&quot;\${vars.get('order_number')}&quot;) }</stringProp>
      </JSR223PostProcessor><hashTree/>
    </hashTree>
  </hashTree>
</hashTree></hashTree></jmeterTestPlan>`;
  const { config, warnings } = importJmx(plan);
  assert.equal(Object.hasOwn(config.scenario.requests[0], 'exports'), false, 'Groovy is never translated');
  assert.match(warnings.map(w => w.message).join('\n'),
    /JSR223PostProcessor "Save order_number to CSV" runs groovy code, which K6UI cannot import, so it was skipped\. It writes a file: to collect rows during a run, add "Save to CSV" to the request \(Extract tab\), then download the rows or use them as a data file from Run & Results\./);
});

// ── Store and results model ───────────────────────────────────

test('store: exports are normalized when present and left alone when absent', () => {
  const project = migrateProject({
    scenario: {
      requests: [
        { id: 'req_a', url: 'https://api.test/a', exports: [{ file: ' o.csv ', columns: [{ name: ' n ', value: 7 }], skipMissing: true }, null] },
        { id: 'req_b', url: 'https://api.test/b' },
        { id: 'req_c', url: 'https://api.test/c', exports: 'nope' },
      ],
    },
  });
  const [a, b, c] = project.scenario.requests;
  assert.deepEqual(a.exports, [{ file: 'o.csv', columns: [{ name: 'n', value: '7' }], skipMissing: true }]);
  assert.equal(Object.hasOwn(b, 'exports'), false);
  assert.deepEqual(c.exports, []);
  assert.deepEqual(migrateProject(project), project, 'stable');
});

test('results model: batches add up per file; bad rows and an 11th file are ignored', () => {
  const store = createExportStore();
  assert.equal(store.add({ file: 'o.csv', columns: ['a', 'b'], rows: [['1', '2'], ['bad']], truncated: false }), true);
  store.add({ file: 'o.csv', columns: ['a', 'b'], rows: [['3', null]], truncated: true });
  assert.deepEqual(store.files.get('o.csv'), { columns: ['a', 'b'], rows: [['1', '2'], ['3', '']], truncated: true });
  assert.equal(store.csv('o.csv'), 'a,b\n1,2\n3,\n');
  assert.equal(store.add({ file: '', columns: ['a'] }), false);
  assert.equal(store.add(null), false);
  for (let i = 0; i < 9; i++) store.add({ file: `f${i}.csv`, columns: ['a'], rows: [] });
  assert.equal(store.add({ file: 'eleventh.csv', columns: ['a'], rows: [['x']] }), false);
  store.clear();
  assert.equal(store.files.size, 0);
});
