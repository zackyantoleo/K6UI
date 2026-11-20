// Outcome targets (thresholds.outcomes): the shared module, the generated k6
// thresholds, the importer round trip, the project store, the results and the
// report, and the Thresholds / SLA view wiring. The real k6 run is in
// outcome-thresholds-k6.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';

import {
  normalizeOutcomeThreshold, normalizeOutcomeThresholds, outcomeThresholdText, outcomeThresholdsProblem,
  planOutcomeThresholds, readOutcomeThresholdResults, thresholdRequests,
} from '../public/js/outcome-thresholds.js';
import { generateScript } from '../server/generator/index.js';
import { importK6Script } from '../server/importer/index.js';
import { migrateProject } from '../public/js/project-store.js';
import { buildRunReport, reportThresholds, reportToHtml } from '../public/js/run-report.js';
import { createServer } from '../server/index.js';
import { loadScript } from './helpers/load-script.js';

const RULES = {
  rules: [
    { label: 'success', status: '2xx', source: 'none' },
    { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
  ],
  fallback: 'other',
};

const request = (extra = {}) => ({
  id: 'req_redeem', name: 'Redeem', method: 'POST', url: 'https://api.example.com/redeem', body: '{}',
  checkStatus: false, sleepAfter: '0', outcomes: RULES, ...extra,
});
const config = (outcomes, extra = {}) => ({
  variables: [{ key: 'QUOTA', value: ' 300 ' }, { key: 'NAME', value: 'abc' }],
  scenario: { groups: [], requests: [request({ id: 'req_login', name: 'Login', outcomes: undefined }), request()] },
  load: { mode: 'iterations', vus: '1', iterations: '1' },
  thresholds: { p95: '', errorRate: '', outcomes },
  ...extra,
});
const target = (extra = {}) => ({ request: 'req_redeem', label: 'success', op: '<=', value: '{{QUOTA}}', ...extra });

// ── Shared module ─────────────────────────────────────────────

test('normalize keeps one shape: trimmed text, the default comparison, unknown fields kept', () => {
  assert.deepEqual(normalizeOutcomeThreshold({ request: ' req_a ', label: ' ok ', value: 12, note: 'x' }),
    { request: 'req_a', label: 'ok', op: '<=', value: '12', note: 'x' });
  assert.equal(normalizeOutcomeThreshold('oops'), null);
  assert.deepEqual(normalizeOutcomeThresholds('oops'), []);
  assert.deepEqual(normalizeOutcomeThresholds([null, {}]), [{ request: '', label: '', op: '<=', value: '' }]);
});

test('requests are numbered like the generator: only those that run, with their labels', () => {
  const requests = thresholdRequests({ scenario: {
    groups: [{ id: 'grp_off', enabled: false }],
    requests: [
      request({ id: 'req_a', enabled: false }),
      request({ id: 'req_b', groupId: 'grp_off' }),
      request({ id: 'req_c', url: ' ' }),
      request({ id: 'req_d', outcomes: undefined }),
      request({ id: 'req_e', type: 'grpc' }),
      request({ id: 'req_f' }),
    ],
  } });
  assert.deepEqual(requests.map(({ id, rq, skipped, labels }) => [id, rq, skipped, labels.length]), [
    ['req_a', null, 'the request is turned off', 3],
    ['req_b', null, 'the request is in a turned-off group', 3],
    ['req_c', null, 'the request has no URL', 3],
    ['req_d', 1, '', 0],
    ['req_e', 2, '', 0],
    ['req_f', 3, '', 3],
  ]);
});

test('a target resolves a number or a global variable; blank rows are ignored', () => {
  const { problem, thresholds } = planOutcomeThresholds(config([
    target(), {}, target({ label: 'other', op: '==', value: '0' }), target({ label: 'quota_reached', op: '>', value: '1.5' }),
  ]));
  assert.equal(problem, '');
  assert.deepEqual(thresholds.map(({ number, rq, resolved, expression }) => [number, rq, resolved, expression]), [
    [1, 2, 300, 'count<=300'],
    [3, 2, 0, 'count==0'],
    [4, 2, 1.5, 'count>1.5'],
  ]);
  assert.equal(planOutcomeThresholds(config(undefined)).thresholds.length, 0);
  assert.equal(outcomeThresholdText({ ...thresholds[0] }), 'success <= {{QUOTA}} (300)');
  assert.equal(outcomeThresholdText({ ...thresholds[1] }), 'other == 0');
});

test('a target that cannot work names its number and why', () => {
  const withData = {
    dataSets: [
      { id: 'ds_a', content: 'LIMIT\n5\n', skipHeader: true, columns: [] },
      { id: 'ds_off', groupId: 'grp_off', content: 'OFF\n5\n', skipHeader: true, columns: [] },
    ],
  };
  const cases = [
    [target({ request: '' }), /^Outcome target 1: choose a request\.$/],
    [target({ request: 'req_gone' }), /^Outcome target 1: its request is no longer in the flow/],
    [target({ request: 'req_login' }), /^Outcome target 1: Request 1 · Login has no outcome rules/],
    [target({ label: '' }), /^Outcome target 1: choose a label\.$/],
    [target({ label: 'nope' }), /Request 2 · Redeem has no label "nope" \(its labels: success, quota_reached, other\)/],
    [target({ op: '!=' }), /"!=" is not a comparison; use <, <=, ==, >=, >/],
    [target({ value: '' }), /enter a number, or a global variable like \{\{QUOTA\}\}/],
    [target({ value: '-1' }), /"-1" is not a number/],
    [target({ value: '{{ QUOTA }}' }), /is not a number/],
    [target({ value: '{{MISSING}}' }), /\{\{MISSING\}\} is not a global variable/],
    [target({ value: '{{NAME}}' }), /the global variable NAME is "abc", not a number/],
    [target({ value: '{{LIMIT}}' }), /\{\{LIMIT\}\} is a data file column, which changes per iteration/],
  ];
  for (const [item, message] of cases) {
    const problem = outcomeThresholdsProblem(config([item], withData));
    assert.match(problem, message, JSON.stringify(item));
    assert.throws(() => generateScript(config([item], withData)), err => err.status === 400 && err.message === problem);
  }
  // A column of a data file the run does not read is not one, so it is just unknown.
  const off = config([target({ value: '{{OFF}}' })], {
    ...withData, scenario: { ...config().scenario, groups: [{ id: 'grp_off', enabled: false }] },
  });
  assert.match(outcomeThresholdsProblem(off), /\{\{OFF\}\} is not a global variable/);
  // A name extracted or set by a script during the run, even when it is also global.
  const runtime = (extra) => config([target()], {
    scenario: { groups: [], requests: [request({ id: 'req_login', outcomes: undefined, ...extra }), request()] },
  });
  assert.match(outcomeThresholdsProblem(runtime({ extractions: [{ varName: 'QUOTA', source: 'json', selector: 'q' }] })),
    /\{\{QUOTA\}\} is extracted from a response during the run, but targets are set before the test starts/);
  assert.match(outcomeThresholdsProblem(runtime({ postScript: 'vars.QUOTA = 3;' })), /\{\{QUOTA\}\} is set by a script during the run/);
  assert.equal(outcomeThresholdsProblem(runtime({ enabled: false, postScript: 'vars.QUOTA = 3;' })), '');
});

test('a target whose request does not run is not checked, and not validated further', () => {
  const plan = planOutcomeThresholds(config([target({ label: 'nope', value: 'x' })], {
    scenario: { groups: [], requests: [request({ enabled: false })] },
  }));
  assert.equal(plan.problem, '');
  assert.deepEqual(plan.thresholds.map(({ rq, skipped, expression }) => [rq, skipped, expression]),
    [[null, 'the request is turned off', '']]);
});

// ── Generator ─────────────────────────────────────────────────

test('generated options: each target joins the always-passing count>=0 of its label, once', async () => {
  const source = generateScript(config([
    target(), target({ label: 'other', op: '==', value: '0' }), target({ op: '>=', value: '0' }), target(),
  ]));
  const { options } = await loadScript(source);
  assert.deepEqual(options.thresholds, {
    'k6ui_outcome{rq:2,outcome:success}': ['count>=0', 'count<=300'],
    'k6ui_outcome{rq:2,outcome:quota_reached}': ['count>=0'],
    'k6ui_outcome{rq:2,outcome:other}': ['count>=0', 'count==0'],
  });
  assert.match(source, /const OUTCOME_THRESHOLDS = \[\n {2}\{ rq: 2, label: "success", op: "<=", value: "\{\{QUOTA\}\}" \},\n/);
});

test('p95 and error rate stay next to outcome targets; a skipped target is only a comment', async () => {
  const meta = {};
  const source = generateScript(config([target(), target({ request: 'req_off', op: '>', value: '0' })], {
    thresholds: undefined,
  }), meta);
  assert.deepEqual(meta.outcomeThresholds, [], 'no thresholds key, no targets');
  const withBoth = config([target({ request: 'req_off', op: '>', value: '0' }), target()]);
  withBoth.thresholds.p95 = '500';
  withBoth.scenario.requests.push(request({ id: 'req_off', enabled: false }));
  const script = generateScript(withBoth, meta);
  const { options } = await loadScript(script);
  assert.deepEqual(options.thresholds.http_req_duration, ['p(95)<500']);
  assert.deepEqual(options.thresholds['k6ui_outcome{rq:2,outcome:success}'], ['count>=0', 'count<=300']);
  assert.match(script, /\/\/ Outcome target 1 \(success > 0\) is not checked: the request is turned off\n/);
  assert.deepEqual(meta.outcomeThresholds.map(({ number, rq, skipped }) => [number, rq, skipped]),
    [[1, null, 'the request is turned off'], [2, 2, '']]);
  assert.doesNotMatch(source, /OUTCOME_THRESHOLDS/);
});

test('POST /api/generate answers a target that cannot work with a 400 naming it', async () => {
  const app = createServer({ port: 0, host: '127.0.0.1' });
  await once(app, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config([target({ label: 'nope' })])),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /^Outcome target 1: Request 2 · Redeem has no label "nope"/);
  } finally {
    app.closeAllConnections?.();
    await new Promise(done => app.close(done));
  }
});

// ── Results ───────────────────────────────────────────────────

test('results: false in a k6 summary export means met, true means not met; no summary, no result', () => {
  const { thresholds } = planOutcomeThresholds(config([
    target(), target({ label: 'other', op: '==', value: '0' }), target({ request: 'req_off' }),
  ], { scenario: { groups: [], requests: [request({ id: 'req_login', outcomes: undefined }), request(), request({ id: 'req_off', enabled: false })] } }));
  const summary = { metrics: {
    'k6ui_outcome{rq:2,outcome:success}': { count: 12, thresholds: { 'count>=0': false, 'count<=300': false } },
    'k6ui_outcome{rq:2,outcome:other}': { count: 3, thresholds: { 'count>=0': false, 'count==0': true } },
  } };
  const results = readOutcomeThresholdResults(thresholds, summary);
  assert.deepEqual(results.map(({ number, status, count }) => [number, status, count]),
    [[1, 'met', 12], [2, 'not-met', 3], [3, 'skipped', null]]);
  assert.deepEqual(results[0], {
    number: 1, request: 'req_redeem', name: 'Redeem', method: 'POST', url: 'https://api.example.com/redeem', rq: 2,
    label: 'success', op: '<=', value: '{{QUOTA}}', resolved: 300, expression: 'count<=300', skipped: '', status: 'met', count: 12,
  });
  assert.deepEqual(readOutcomeThresholdResults(thresholds, null).map(item => item.status), ['unknown', 'unknown', 'skipped']);
  assert.deepEqual(readOutcomeThresholdResults(null, summary), []);
});

test('the report Targets table reads outcome targets as typed, with the count, and keeps the rest', () => {
  const summary = { metrics: {
    'k6ui_outcome{rq:2,outcome:success}': { count: 3, thresholds: { 'count>=0': false, 'count<=2': true } },
    http_req_duration: { avg: 1, 'p(95)': 2, thresholds: { 'p(95)<500': false } },
  } };
  const outcomeThresholds = [
    { number: 1, rq: 2, name: 'Redeem <b>', method: 'POST', url: '/r', label: 'success', op: '<=', value: '{{QUOTA}}', resolved: 2, expression: 'count<=2', skipped: '', status: 'not-met', count: 3 },
    { number: 2, rq: null, name: 'Warm', method: 'GET', url: '/w', label: 'success', op: '>', value: '0', resolved: null, expression: '', skipped: 'the request is turned off', status: 'skipped', count: null },
  ];
  const rows = reportThresholds(summary, outcomeThresholds);
  assert.deepEqual(rows.map(({ metric, rule, ok }) => [metric, rule, ok]), [
    ['http_req_duration', 'p(95)<500', true],
    ['k6ui_outcome{rq:2,outcome:success}', 'count<=2', false],
    ['', '', null],
  ]);
  assert.deepEqual(reportThresholds(summary, []).map(row => row.rule), ['p(95)<500', 'count<=2'], 'raw rows without results');
  const html = reportToHtml(buildRunReport({ summary, outcomeThresholds }));
  assert.match(html, /Outcome &quot;success&quot; of Request 2 · Redeem &lt;b&gt;/);
  assert.match(html, /count &lt;= \{\{QUOTA\}\} \(2\)/);
  assert.match(html, /Not met \(counted 3\)/);
  assert.match(html, /<tr class="off">[\s\S]*?Not checked: the request is turned off/);
});

// ── Importer ──────────────────────────────────────────────────

test('a generated script imports back to the same targets, in order, with the variable as typed', () => {
  const targets = [
    target({ label: 'other', op: '==', value: '0' }), target(), target({ op: '>=', value: '0' }), target({ label: 'quota_reached', op: '>', value: '1.5' }),
  ];
  const { config: imported, warnings } = importK6Script(generateScript(config(targets)));
  assert.deepEqual(warnings, []);
  const redeem = imported.scenario.requests[1].id;
  assert.deepEqual(imported.thresholds.outcomes, targets.map(item => ({ ...item, request: redeem })));
  // The imported project generates the same thresholds again.
  assert.deepEqual(planOutcomeThresholds(imported).thresholds.map(item => item.expression),
    ['count==0', 'count<=300', 'count>=0', 'count>1.5']);
});

test('a variable that no longer stands for the number imports the number; foreign thresholds warn', () => {
  const script = generateScript(config([target()])).replace('QUOTA: " 300 "', 'QUOTA: "5"');
  const { config: imported, warnings } = importK6Script(script);
  assert.deepEqual(warnings, []);
  assert.equal(imported.thresholds.outcomes[0].value, '300');

  const { config: handWritten, warnings: notes } = importK6Script(`
import http from 'k6/http';
export const options = { vus: 1, duration: '1s', thresholds: {
  'k6ui_outcome{rq:1,outcome:success}': ['count>=0', 'count<5', 'rate<0.1'],
} };
export default function () { http.get('https://api.example.com/'); }
`);
  assert.equal(handWritten.thresholds.outcomes, undefined);
  assert.ok(notes.some(item => /"count<5" was ignored: request 1 has no outcome rules that K6UI could read/.test(item.message)));
  assert.ok(notes.some(item => /"rate<0\.1" is not supported/.test(item.message)));
  assert.ok(!notes.some(item => /count>=0/.test(item.message)), 'the always-passing threshold is not a target');

  const renamed = generateScript(config([target({ label: 'quota_reached' })]))
    .replace('"k6ui_outcome{rq:2,outcome:quota_reached}": [\n      "count>=0",\n      "count<=300"', '"k6ui_outcome{rq:2,outcome:gone}": [\n      "count>=0",\n      "count<=300"');
  const { warnings: gone } = importK6Script(renamed);
  assert.ok(gone.some(item => /"gone" is not a label of the outcome rules of request 2/.test(item.message)));
});

// ── Store ─────────────────────────────────────────────────────

test('the store keeps one target shape, drops blank rows and follows request ids it had to change', () => {
  const project = migrateProject({
    scenario: { requests: [request({ id: ' REQ_Redeem ' }), request({ id: 'req_twice' }), request({ id: 'req_twice' })] },
    thresholds: { p95: '500', outcomes: [
      { request: ' REQ_Redeem ', label: 'success', value: 3 }, {}, { request: 'req_twice', label: 'other', op: '==', value: '0' }, { request: 'req_gone', label: 'x', value: '1' },
    ] },
  });
  assert.equal(project.scenario.requests[0].id, 'req_redeem');
  assert.notEqual(project.scenario.requests[2].id, 'req_twice');
  assert.deepEqual(project.thresholds, { p95: '500', outcomes: [
    { request: 'req_redeem', label: 'success', op: '<=', value: '3' },
    { request: 'req_twice', label: 'other', op: '==', value: '0' },
    { request: 'req_gone', label: 'x', op: '<=', value: '1' },
  ] });
  assert.deepEqual(migrateProject(project).thresholds, project.thresholds, 'stable');
  assert.equal(Object.hasOwn(migrateProject({ thresholds: { p95: '1' } }).thresholds, 'outcomes'), false);
  assert.equal(Object.hasOwn(migrateProject({ thresholds: { outcomes: 'oops' } }).thresholds, 'outcomes'), false);
});

// ── Thresholds / SLA view and results panel ───────────────────

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');

test('the Thresholds / SLA view has one list of outcome targets, added from "Add goal", for both modes', () => {
  const html = read('../public/index.html');
  const rows = read('../public/js/components/outcome-target-rows.js');
  const card = html.match(/<div class="outcome-targets" id="outcome-targets">[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  assert.ok(card, 'list in the view');
  const goals = html.indexOf('id="load-block-goals" data-block="sla"');
  assert.ok(goals > 0 && goals < html.indexOf('id="outcome-targets"'), 'in the Load & goals page, the Thresholds / SLA block');
  assert.doesNotMatch(card, /data-ui-only/, 'shown in both modes');
  assert.match(card, /id="outcome-targets-list"/);
  const menu = html.match(/<div class="menu add-goal-menu" id="add-goal-menu"[\s\S]*?<\/div>/)?.[0];
  assert.match(menu, /role="menuitem" id="add-outcome-target"/, 'the "Add goal" menu adds a target');
  assert.doesNotMatch(menu, /data-ui-only/, 'shown in both modes');
  for (const cls of ['outcome-target-row', 'outcome-target-request', 'outcome-target-label', 'outcome-target-op', 'outcome-target-value']) {
    assert.match(rows, new RegExp(`'${cls}'`), cls);
  }
  assert.doesNotMatch(stripComments(rows), /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(stripComments(rows), /uiMode|ui-mode|localStorage|sessionStorage|collectConfig|ensureRequestPanel/);
  assert.match(rows, /readRequestSettings\(card\)/, 'reads lazy panels without opening them');
});

test('targets travel with the project: collected, checked before Run, restored after the cards', () => {
  const configSource = read('../public/js/config.js');
  const io = read('../public/js/project-io.js');
  const app = read('../public/js/app.js');
  assert.match(configSource, /const outcomes = readOutcomeTargetRows\(\);/);
  assert.match(configSource, /outcomeThresholdsProblem\(config\)/);
  assert.match(io, /restoreZone\(cfg\.scenario\?\.requests \|\| \[\]\);\n[\s\S]{0,120}restoreOutcomeTargetRows\(cfg\.thresholds\?\.outcomes \|\| \[\]\);/);
  assert.match(app, /initOutcomeTargets\(\);/);
});

test('Run & Results lists each target in Outcomes; a target not met is also an error', () => {
  const html = read('../public/index.html');
  const results = read('../public/js/outcome-results.js');
  const runner = read('../public/js/runner.js');
  const section = html.match(/<section id="run-outcomes"[\s\S]*?<\/section>/)?.[0];
  assert.match(section, /<ul id="run-outcome-targets" class="run-outcome-targets" aria-label="Outcome targets" hidden><\/ul>/);
  assert.match(runner, /renderOutcomeResults\(data\.outcomes, data\.outcomeThresholds\);/);
  assert.match(runner, /lastRun\.outcomeThresholds = /);
  assert.match(runner, /Outcome target \$\{target\.number\} was not met/);
  assert.match(results, /section\.hidden = items\.length === 0 && targets\.length === 0;/);
  assert.doesNotMatch(stripComments(results), /innerHTML|insertAdjacentHTML|outerHTML/);
});
