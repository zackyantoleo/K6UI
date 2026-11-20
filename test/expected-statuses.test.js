// Expected statuses (request.expectedStatuses), {{$outcome}} and the outcome label of a
// request record: the shared module, the generated k6 code (run in Node with stub k6
// modules), the importer round trip, the project store, the Simple notice, the
// Requests table sort and the report. The real k6 run is in expected-statuses-k6.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  expectedStatusesListProblem, expectedStatusesProblem, hasExpectedStatuses, normalizeExpectedStatuses,
  parseExpectedStatuses, statusesFromOutcomeRules,
} from '../public/js/expected-statuses.js';
import { generateScript } from '../server/generator/index.js';
import { importK6Script } from '../server/importer/index.js';
import { migrateProject, serializeProject } from '../public/js/project-store.js';
import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { compareRecords, nextSort } from '../public/js/request-sort.js';
import { buildRunReport, reportToHtml } from '../public/js/run-report.js';
import { loadScript } from './helpers/load-script.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

const RULES = {
  rules: [
    { label: 'success', status: '2xx', source: 'none' },
    { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
  ],
  fallback: 'other',
};
const request = (extra = {}) => ({
  id: 'req_redeem', name: 'Redeem', method: 'POST', url: 'https://api.example.com/redeem', body: '{}',
  checkStatus: true, sleepAfter: '0', ...extra,
});
const config = (requests, extra = {}) => ({
  scenario: { requests },
  load: { mode: 'iterations', vus: '1', iterations: '1' },
  thresholds: { p95: '', errorRate: '' },
  ...extra,
});
// One {__r:1,...} request record per logged request, from the stub's console.log.
const records = run => run.logs.map(line => JSON.parse(line)).filter(item => item.__r === 1);

// ── Shared module ─────────────────────────────────────────────

test('a list is codes and classes, normalized; empty is k6\'s own rule; a bad list is kept to be named', () => {
  assert.equal(normalizeExpectedStatuses(' 200, 4XX ,200,'), '200,4xx');
  assert.equal(normalizeExpectedStatuses(400), '400');
  assert.equal(normalizeExpectedStatuses('  '), '');
  assert.equal(normalizeExpectedStatuses(null), '');
  assert.equal(normalizeExpectedStatuses({ codes: [200] }), '');
  assert.equal(normalizeExpectedStatuses(' 200;400 '), '200;400', 'kept as typed so validation can name it');
  assert.deepEqual(parseExpectedStatuses('200,4xx'), { codes: [200], classes: [4] });
  assert.equal(hasExpectedStatuses(''), false);
  assert.equal(hasExpectedStatuses('200'), true);
  assert.equal(expectedStatusesProblem('200,4xx'), '');
  assert.match(expectedStatusesProblem('600'), /^expected statuses "600" are not valid: use codes like 200 or classes like 4xx/);
});

test('problems name the request; a gRPC request cannot have a list', () => {
  assert.equal(expectedStatusesListProblem([{ label: 'Request 1', type: 'http', expectedStatuses: '' }]), '');
  assert.match(
    expectedStatusesListProblem([{ label: 'Request 1', type: 'http', expectedStatuses: '200' }, { label: 'Request 2', type: 'http', expectedStatuses: 'ok' }]),
    /^Request 2: expected statuses "ok" are not valid/,
  );
  assert.match(
    expectedStatusesListProblem([{ label: 'Request 1', type: 'grpc', expectedStatuses: '200' }]),
    /^Request 1: expected statuses work on HTTP requests only/,
  );
});

test('"Use statuses from outcome rules" takes the statuses the rules name, without 5xx', () => {
  assert.deepEqual(statusesFromOutcomeRules(RULES), { statuses: '2xx,400', skippedServerErrors: false });
  assert.deepEqual(statusesFromOutcomeRules({ rules: [
    { label: 'success', status: '200, 201' },
    { label: 'rejected', status: '4XX' },
    { label: 'server_error', status: '5xx' },
    { label: 'busy', status: '503,429' },
    { label: 'anything', status: '' },
    { label: 'broken', status: 'nope' },
    { label: 'again', status: '200' },
  ] }), { statuses: '200,201,4xx,429', skippedServerErrors: true });
  assert.deepEqual(statusesFromOutcomeRules({ rules: [{ label: 'any', status: '' }] }), { statuses: '', skippedServerErrors: false });
  assert.deepEqual(statusesFromOutcomeRules(undefined), { statuses: '', skippedServerErrors: false });
});

// ── Generator ─────────────────────────────────────────────────

test('generated code: one http.expectedStatuses() per request at the top, its name in the params, the check tests the list', () => {
  const script = generateScript(config([
    request({ name: 'Login', url: 'https://api.example.com/login', headers: [{ key: 'X-A', value: '1' }] }),
    request({ expectedStatuses: '200, 4XX', headers: [{ key: 'X-A', value: '1' }] }),
    request({ url: 'https://api.example.com/status', method: 'GET', expectedStatuses: '204', checkStatus: false }),
  ]));
  assert.match(script, /\/\/ Expected statuses of request 2 \(Request → Advanced\): 200,4xx; any other status counts in http_req_failed\nconst EXPECTED_STATUSES_2 = http\.expectedStatuses\(200, \{ min: 400, max: 499 \}\);\n/);
  assert.match(script, /const EXPECTED_STATUSES_3 = http\.expectedStatuses\(204\);/);
  assert.doesNotMatch(script, /EXPECTED_STATUSES_1\b/);
  assert.ok(script.indexOf('const EXPECTED_STATUSES_2') < script.indexOf('export default function'), 'built once, at init');
  assert.match(script, /http\.request\("POST", "https:\/\/api\.example\.com\/login", body_main_0, \{ headers: \{ "X-A": "1" \} \}\);/, 'no list: params as before');
  assert.match(script, /http\.request\("POST", "https:\/\/api\.example\.com\/redeem", body_main_1, \{ headers: \{ "X-A": "1" \}, responseCallback: EXPECTED_STATUSES_2 \}\);/);
  assert.match(script, /http\.request\("GET", "https:\/\/api\.example\.com\/status", null, \{ responseCallback: EXPECTED_STATUSES_3 \}\);/);
  assert.match(script, /check\(res_main_0, \{ "status 2xx: request 1": \(r\) => r\.status >= 200 && r\.status < 400 \}\);/);
  assert.match(script, /check\(res_main_1, \{ "status 200,4xx: request 2": \(r\) => r\.status === 200 \|\| \(r\.status >= 400 && r\.status < 500\) \}\);/);
  assert.doesNotMatch(script, /request 3": /, 'the status check stays off when it is off');
});

test('a flow without lists gets none of it; a turned-off request\'s list is not built', () => {
  const plain = generateScript(config([request()]));
  assert.doesNotMatch(plain, /expectedStatuses|responseCallback|EXPECTED_STATUSES/);
  const off = generateScript(config([request({ enabled: false, expectedStatuses: 'nope' }), request()]));
  assert.doesNotMatch(off, /EXPECTED_STATUSES/, 'and not validated either');
});

test('a list that cannot work is a 400 naming the request number of the run', () => {
  const cases = [
    [[request({ enabled: false }), request({ expectedStatuses: '2x' })], /^Request 1: expected statuses "2x" are not valid/],
    [[request(), { type: 'grpc', url: 'localhost:50051', grpcMethod: 'a.B/C', expectedStatuses: '200' }], /^Request 2: expected statuses work on HTTP requests only/],
  ];
  for (const [requests, message] of cases) {
    assert.throws(() => generateScript(config(requests)), err => err.status === 400 && message.test(err.message));
  }
});

test('at run time the check, the record\'s ok and its outcome follow the list', () => {
  const statuses = [200, 400, 404, 500];
  let next = 0;
  const run = loadScript(generateScript(config([request({ expectedStatuses: '200,400', outcomes: RULES })], {
    options: { logRequests: true, logFilter: 'all' },
  })), { respond: () => ({ status: statuses[next++], body: '{"error":{"code":"PROM-422001"}}' }) });
  for (let i = 0; i < statuses.length; i++) run.iteration(1, i);
  assert.deepEqual(run.calls[0].params.responseCallback, { expectedStatuses: [200, 400] });
  assert.deepEqual(run.checks.map(item => [item.name, item.ok]), [
    ['status 200,400: request 1', true], ['status 200,400: request 1', true],
    ['status 200,400: request 1', false], ['status 200,400: request 1', false],
  ]);
  assert.deepEqual(records(run).map(item => [item.s, item.ok, item.oc]), [
    [200, true, 'success'], [400, true, 'quota_reached'], [404, false, 'other'], [500, false, 'other'],
  ]);
});

test('a plain request keeps the four-argument logHttpRequest(); rules or a list call logHttpOutcome()', () => {
  const script = generateScript(config([
    request({ url: 'https://api.example.com/plain' }),
    request({ outcomes: RULES }),
    request({ url: 'https://api.example.com/list', expectedStatuses: '400' }),
  ], { options: { logRequests: true } }));
  assert.match(script, /function logHttpRequest\(i, method, url, res\) \{\n {2}const ok = res\.status >= 200 && res\.status < 400;/);
  assert.match(script, /try \{ logHttpRequest\(0, "POST", "https:\/\/api\.example\.com\/plain", res_main_0\); \} catch \(e\) \{\}/);
  assert.match(script, /try \{ logHttpOutcome\(1, "POST", "https:\/\/api\.example\.com\/redeem", res_main_1, outcome_main_1, res_main_1\.status >= 200 && res_main_1\.status < 400\); \} catch \(e\) \{\}/);
  assert.match(script, /try \{ logHttpOutcome\(2, "POST", "https:\/\/api\.example\.com\/list", res_main_2, undefined, res_main_2\.status === 400\); \} catch \(e\) \{\}/);
});

test('the "errors" filter leaves out an expected rejection; a request without rules records no outcome', () => {
  const statuses = [400, 500, 400, 400];
  let next = 0;
  const run = loadScript(generateScript(config([
    request({ expectedStatuses: '2xx,400' }),
    request({ url: 'https://api.example.com/other', expectedStatuses: '', outcomes: RULES }),
  ], { options: { logRequests: true, logFilter: 'errors' } })), { respond: () => ({ status: statuses[next++] }) });
  run.iteration(1, 0);
  run.iteration(1, 1);
  assert.deepEqual(records(run).map(item => [item.i, item.s, item.ok, item.oc]), [[1, 500, false, 'other'], [1, 400, false, 'other']],
    'request 1 expects its 400s; request 2 has no list, so its 400 is an error');
  const all = loadScript(generateScript(config([request()], { options: { logRequests: true } })));
  all.iteration(1, 0);
  assert.equal(Object.hasOwn(records(all)[0], 'oc'), false);
  assert.equal(records(all)[0].ok, true);
});

test('{{$outcome}}: the label of this request in its Save to CSV row and in later requests', () => {
  const statuses = [200, 400];
  let next = 0;
  const script = generateScript(config([
    request({ url: 'https://api.example.com/first?o={{$outcome}}' }),
    request({
      outcomes: RULES,
      exports: [{ file: 'redeems.csv', columns: [{ name: 'outcome', value: '{{$outcome}}' }, { name: 'note', value: 'was {{$outcome}}' }] }],
    }),
    request({ url: 'https://api.example.com/after/{{$outcome}}', headers: [{ key: 'X-Outcome', value: '{{$outcome}}' }], body: '{"o":"{{$outcome}}"}' }),
  ]));
  assert.match(script, /let \$outcome = ""; \/\/ \{\{\$outcome\}\}: the latest outcome label of this iteration/);
  assert.match(script, / {2}\$outcome = outcome_main_1;\n/);
  const run = loadScript(script, { respond: call => (call.url.includes('/redeem') ? { status: statuses[next++], body: '{"error":{"code":"PROM-422001"}}' } : {}) });
  run.iteration(1, 0);
  run.iteration(1, 1);
  assert.deepEqual(run.calls.map(call => call.url), [
    'https://api.example.com/first?o={{$outcome}}', 'https://api.example.com/redeem', 'https://api.example.com/after/success',
    'https://api.example.com/first?o={{$outcome}}', 'https://api.example.com/redeem', 'https://api.example.com/after/quota_reached',
  ], 'before a request with rules it is literal text, as an unknown name');
  assert.equal(run.calls[2].params.headers['X-Outcome'], 'success');
  assert.equal(run.calls[2].body, '{"o":"success"}');
  const rows = run.logs.map(line => JSON.parse(line)).filter(item => item.k6uiExport);
  assert.deepEqual(rows.map(item => item.row), [['success', 'was success'], ['quota_reached', 'was quota_reached']]);
});

test('{{$outcome}} keeps the latest label; a skipped conditional group leaves it empty; other $ names stay literal', () => {
  const script = generateScript({
    ...config([]),
    variables: [{ key: 'MODE', value: 'skip' }],
    scenario: {
      groups: [{ id: 'grp_race', name: 'Race', enabled: true, runIf: { variable: 'MODE', operator: 'equals', values: ['race'] } }],
      requests: [
        request({ groupId: 'grp_race', outcomes: RULES }),
        request({ url: 'https://api.example.com/after/{{$outcome}}/{{$uuid}}/{{$}}' }),
      ],
    },
  });
  const run = loadScript(script);
  run.iteration(1, 0);
  assert.deepEqual(run.calls.map(call => call.url), ['https://api.example.com/after//{{$uuid}}/{{$}}']);
  assert.doesNotMatch(generateScript(config([request({ outcomes: RULES })])), /\$outcome/, 'no use, no variable');
  assert.doesNotMatch(generateScript(config([request({ url: 'https://x/{{$outcome}}' })])), /let \$outcome/, 'no rules, nothing to keep');
});

// ── Importer ──────────────────────────────────────────────────

test('a generated script imports back: expected statuses, the status check, {{$outcome}} and no warning', () => {
  const requests = [
    request({ id: 'req_a', expectedStatuses: '200,4xx', outcomes: RULES,
      exports: [{ file: 'r.csv', columns: [{ name: 'outcome', value: '{{$outcome}}' }], skipMissing: false }] }),
    request({ id: 'req_b', method: 'GET', body: '', url: 'https://api.example.com/after?o={{$outcome}}', expectedStatuses: '204', checkStatus: false,
      headers: [{ key: 'X-Outcome', value: 'is {{$outcome}}' }] }),
    request({ id: 'req_c', method: 'POST', url: 'https://api.example.com/form', body: 'o={{$outcome}}', headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }] }),
    request({ id: 'req_d' }),
  ];
  const { config: imported, warnings } = importK6Script(generateScript(config(requests, { options: { logRequests: true } })));
  assert.deepEqual(warnings, []);
  const [a, b, c, d] = imported.scenario.requests;
  assert.equal(a.expectedStatuses, '200,4xx');
  assert.equal(a.checkStatus, true);
  assert.deepEqual(a.exports, [{ file: 'r.csv', columns: [{ name: 'outcome', value: '{{$outcome}}' }], skipMissing: false }]);
  assert.equal(b.expectedStatuses, '204');
  assert.equal(b.checkStatus, false);
  assert.equal(b.url, 'https://api.example.com/after?o={{$outcome}}');
  assert.deepEqual(b.headers, [{ key: 'X-Outcome', value: 'is {{$outcome}}' }]);
  assert.equal(c.body, 'o={{$outcome}}');
  assert.equal(Object.hasOwn(d, 'expectedStatuses'), false);
  assert.equal(d.checkStatus, true);
  assert.deepEqual(d.assertions, []);
});

test('a hand-written responseCallback is read when it is http.expectedStatuses(); anything else warns', () => {
  const { config: imported, warnings } = importK6Script(`
import http from 'k6/http';
import { check } from 'k6';
const ACCEPTED = http.expectedStatuses(200, { min: 400, max: 499 });
export default function () {
  const a = http.get('https://api.example.com/a', { responseCallback: ACCEPTED });
  check(a, { 'accepted': (r) => r.status === 200 || (r.status >= 400 && r.status < 500) });
  http.get('https://api.example.com/b', { responseCallback: http.expectedStatuses({ min: 200, max: 204 }, 409) });
  http.get('https://api.example.com/c', { responseCallback: http.expectedStatuses({ min: 200, max: 399 }) });
  http.get('https://api.example.com/d', { responseCallback: myCallback });
  const e = http.get('https://api.example.com/e');
  check(e, { 'one of': (r) => r.status === 200 || r.status === 400 });
}
`);
  const [a, b, c, d, e] = imported.scenario.requests;
  assert.equal(a.expectedStatuses, '200,4xx');
  assert.equal(a.checkStatus, true, 'the check tests the same list');
  assert.equal(b.expectedStatuses, '200,201,202,203,204,409');
  for (const req of [c, d, e]) assert.equal(Object.hasOwn(req, 'expectedStatuses'), false);
  assert.equal(e.checkStatus, false);
  const messages = warnings.map(item => item.message);
  assert.ok(messages.some(text => /responseCallback `http\.expectedStatuses\(\{ min: 200, max: 399 \}\)` could not be read/.test(text)));
  assert.ok(messages.some(text => /responseCallback `myCallback` could not be read/.test(text)));
  assert.ok(messages.some(text => /Check "one of": .* has no K6UI equivalent/.test(text)), 'without a list it is not the status check');
});

test('$outcome in a hand-written script is an ordinary name', () => {
  const { config: imported, warnings } = importK6Script(`
import http from 'k6/http';
export default function () { http.get(\`https://api.example.com/\${$outcome}\`); }
`);
  assert.equal(imported.scenario.requests[0].url, 'https://api.example.com/{{$outcome}}');
  assert.ok(warnings.some(item => /`\$outcome` is not defined in the script/.test(item.message)));
});

// ── Store, notice, sort, report, wiring ───────────────────────

test('the project store keeps one list shape, drops an empty one, and round-trips it', () => {
  const project = migrateProject({ scenario: { requests: [
    request({ id: 'req_a', expectedStatuses: ' 200, 4XX ' }),
    request({ id: 'req_b', expectedStatuses: '' }),
    request({ id: 'req_c', expectedStatuses: 400 }),
    request({ id: 'req_d', expectedStatuses: ['200'] }),
    request({ id: 'req_e', expectedStatuses: 'two hundred' }),
    request({ id: 'req_f' }),
  ] } });
  const [a, b, c, d, e, f] = project.scenario.requests;
  assert.equal(a.expectedStatuses, '200,4xx');
  assert.equal(Object.hasOwn(b, 'expectedStatuses'), false);
  assert.equal(c.expectedStatuses, '400');
  assert.equal(Object.hasOwn(d, 'expectedStatuses'), false);
  assert.equal(e.expectedStatuses, 'two hundred', 'kept so Run names it');
  assert.equal(Object.hasOwn(f, 'expectedStatuses'), false);
  const again = migrateProject(JSON.parse(serializeProject(project)));
  assert.deepEqual(again.scenario.requests.map(item => item.expectedStatuses), ['200,4xx', undefined, '400', undefined, 'two hundred', undefined]);
});

test('the Simple notice counts requests that run with expected statuses', () => {
  const base = { enabled: true, groupId: '', type: 'http', extractions: [], assertions: [], checkStatus: true };
  const summary = summarizeAdvancedSettings([
    { ...base, expectedStatuses: '200,400' },
    { ...base, expectedStatuses: '  ' },
    { ...base, enabled: false, expectedStatuses: '400' },
  ], []);
  assert.deepEqual(summary.active.find(item => item.id === 'expectedStatuses'), { id: 'expectedStatuses', label: 'Expected statuses', count: 1, unit: 'request' });
  assert.equal(summary.skipped.requests, 1);
});

test('the Requests table sorts by outcome; a record without one sorts first', () => {
  const list = [{ oc: 'success' }, {}, { oc: 'Other' }, { oc: 'lock_rejected' }].map((entry, seq) => ({ entry, seq }));
  const sort = nextSort(null, 'oc');
  assert.deepEqual([...list].sort((x, y) => compareRecords(x, y, sort)).map(item => item.entry.oc), [undefined, 'lock_rejected', 'Other', 'success']);
  const runner = read('../public/js/runner.js');
  assert.match(runner, /appendCell\(row, outcome, 'req-outcome-cell'\);\n {2}appendCell\(row, `\$\{entry\.d\} ms`\);/);
  assert.match(runner, /cell\.colSpan = 8;/);
  assert.match(runner, /, outcome \$\{outcome\}/);
});

test('the report keeps each record\'s outcome and lists expected statuses with the requests', () => {
  const report = buildRunReport({
    config: { scenario: { requests: [
      { name: 'Redeem', method: 'POST', url: '/redeem', expectedStatuses: '200,400' },
      { name: 'Status', method: 'GET', url: '/status' },
    ] } },
    requests: [
      { vu: 1, it: 0, i: 0, m: 'POST', url: '/redeem', s: 400, d: 3, ok: true, oc: 'quota_<reached>' },
      { vu: 1, it: 0, i: 1, m: 'GET', url: '/status', s: 200, d: 2, ok: true },
    ],
  });
  assert.deepEqual(report.requests.map(item => [item.ok, item.outcome]), [[true, 'quota_<reached>'], [true, '']]);
  assert.deepEqual(report.setup.requests.map(item => item.expectedStatuses), ['200,400', '']);
  const html = reportToHtml(report);
  assert.match(html, /<span class="badge ok">400<\/span> <span class="badge outcome">quota_&lt;reached&gt;<\/span>/);
  assert.match(html, /<th scope="col">Success statuses<\/th>/);
  assert.match(html, /<td>200,400<\/td>/);
  assert.match(html, /<td>200–399<\/td>/);
  const plain = reportToHtml(buildRunReport({ config: { scenario: { requests: [{ name: 'A', method: 'GET', url: '/a' }] } } }));
  assert.doesNotMatch(plain, /Success statuses/, 'no column when no request has a list');
});

test('expected statuses travel with the request: Success statuses section, collected, validated before Run, lazy panel, duplicate, store', () => {
  const advanced = read('../public/js/components/request-editor/statuses.js');
  const reqCard = read('../public/js/components/req-card.js');
  const configSource = read('../public/js/config.js');
  const store = read('../public/js/project-store.js');
  const notice = read('../public/js/components/advanced-notice.js');
  assert.match(advanced, /expected\.className = 'expected-statuses'/);
  assert.match(advanced, /fromRules\.textContent = 'Use statuses from outcome rules'/);
  assert.match(advanced, /statusesFromOutcomeRules\(readOutcomes\(\)\)/);
  assert.doesNotMatch(advanced.replace(/^\s*\/\/.*$/gm, ''), /innerHTML|insertAdjacentHTML|outerHTML|uiMode|localStorage/);
  assert.match(configSource, /const expectedStatuses = card\.querySelector\('\.expected-statuses'\)\.value\.trim\(\);/);
  assert.match(configSource, /\.\.\.\(expectedStatuses \? \{ expectedStatuses \} : \{\}\)/);
  assert.match(configSource, /expectedStatusesListProblem\(runnable\.map/);
  assert.match(reqCard, /panel\.querySelector\('\.expected-statuses'\)\.value = request\.expectedStatuses \|\| '';/, 'lazy Success statuses section');
  assert.match(reqCard, /'\.check-status', '\.expected-statuses', '\.sleep'/, 'duplicate copies it');
  assert.match(reqCard, /'\.expected-statuses': 'statuses',/);
  assert.match(reqCard, /statuses: \(\{ readOutcomes \}\) => createStatusesPanel\(readOutcomes\)/);
  assert.match(store, /request\.expectedStatuses = statuses;/);
  assert.match(notice, /expectedStatuses: statusesReady \? field\('\.expected-statuses'\)\.value : saved\.expectedStatuses,/);
});
