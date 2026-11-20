// Outcome rules (request.outcomes): the shared rules module, the generated k6 code
// (run in Node with stub k6 modules), the importer round trip, the project store
// and the Simple notice. The real k6 run is in outcomes-k6.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeOutcomeRules, normalizeOutcomes, outcomeLabels, outcomeMetricKey, outcomeProblem, outcomesProblem,
  parseOutcomeStatus, readOutcomeResults,
} from '../public/js/shared/outcomes.js';
import { generateScript } from '../server/generator/index.js';
import { importK6Script } from '../server/importer/index.js';
import { migrateProject } from '../public/js/project-store.js';
import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { buildRunReport, reportToHtml, summaryThresholds } from '../public/js/run-report.js';
import { loadScript } from './helpers/load-script.js';

const RACE_RULES = {
  rules: [
    { label: 'success', status: '200', source: 'none' },
    { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
    { label: 'lock_rejected', status: '4xx', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-429001' },
    { label: 'maintenance', status: '503', source: 'header', selector: 'x-reason', operator: 'contains', value: 'maint' },
    { label: 'high_traffic', status: '', source: 'body', operator: 'matches', value: '/high traffic/i' },
  ],
  fallback: 'other',
};

const request = (extra = {}) => ({
  id: 'req_redeem', name: 'Redeem', method: 'POST', url: 'https://api.example.com/redeem', body: '{}',
  checkStatus: false, sleepAfter: '0', ...extra,
});
const config = (requests, extra = {}) => ({
  scenario: { requests },
  load: { mode: 'iterations', vus: '1', iterations: '1' },
  thresholds: { p95: '', errorRate: '' },
  ...extra,
});

// ── Shared module ─────────────────────────────────────────────

test('status text: codes, classes and lists; empty means any; anything else is invalid', () => {
  assert.deepEqual(parseOutcomeStatus(''), { codes: [], classes: [] });
  assert.deepEqual(parseOutcomeStatus(' 200, 201 ,4XX'), { codes: [200, 201], classes: [4] });
  for (const bad of ['2x', '600', '20', 'ok', '200;201', '0']) assert.equal(parseOutcomeStatus(bad), null, bad);
});

test('normalize keeps one shape: unknown source/operator fall back, the value stays as typed, fallback defaults', () => {
  const outcomes = normalizeOutcomes({ rules: [{ label: ' ok ', source: 'xml', operator: 'like', value: ' a ' }, null], extra: 1 });
  assert.deepEqual(outcomes.rules, [{ label: 'ok', status: '', source: 'none', selector: '', operator: 'equals', value: ' a ' }]);
  assert.equal(outcomes.fallback, 'other');
  assert.equal(outcomes.extra, 1);
  assert.equal(normalizeOutcomes('rules'), null);
  assert.deepEqual(activeOutcomeRules({ rules: [{}, { label: '' }] }), []);
});

test('labels come in rule order, unique, with the fallback last', () => {
  assert.deepEqual(outcomeLabels(RACE_RULES), ['success', 'quota_reached', 'lock_rejected', 'maintenance', 'high_traffic', 'other']);
  assert.deepEqual(outcomeLabels({ rules: [{ label: 'a', status: '200' }, { label: 'a', status: '201' }], fallback: 'a' }), ['a']);
  assert.deepEqual(outcomeLabels({ rules: [] }), []);
});

test('problems name the rule and why it cannot work', () => {
  const problem = rule => outcomeProblem({ rules: [rule] });
  assert.equal(problem({ label: 'ok', status: '200' }), '');
  assert.match(problem({ status: '200' }), /Rule 1: enter a label/);
  assert.match(problem({ label: 'has space' }), /not a valid label/);
  assert.match(problem({ label: 'ok', status: '2x' }), /status "2x" is not valid/);
  assert.match(problem({ label: 'ok', source: 'header' }), /enter the header name/);
  assert.match(problem({ label: 'ok', source: 'body', operator: 'exists' }), /"exists" needs a JSON path or a header/);
  assert.match(problem({ label: 'ok', source: 'body', operator: 'matches', value: '(' }), /the regex is not valid/);
  assert.match(problem({ label: 'ok', source: 'body', operator: 'matches', value: '/a/x' }), /flags "x" are not supported/);
  assert.match(outcomeProblem({ rules: [{ label: 'ok' }], fallback: 'not ok' }), /any other response/);
  const many = { rules: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`, status: '200' })) };
  assert.match(outcomeProblem(many), /at most 10 labels \(this one has 11/);
  assert.equal(outcomeProblem(undefined), '');
  assert.match(outcomeProblem([]), /must be an object/);
});

test('a gRPC request with rules is refused; blank rules on any request are fine', () => {
  assert.match(outcomesProblem([{ label: 'Request 2', type: 'grpc', outcomes: RACE_RULES }]), /^Request 2: outcome rules work on HTTP requests only/);
  assert.equal(outcomesProblem([{ label: 'Request 1', type: 'grpc', outcomes: { rules: [{}] } }]), '');
  assert.match(outcomesProblem([{ label: 'Request 3', type: 'http', outcomes: { rules: [{ status: '200' }] } }]), /^Request 3, Outcomes: Rule 1: enter a label/);
});

test('results read each label from its submetric in the summary', () => {
  const summary = { metrics: {
    [outcomeMetricKey(2, 'success')]: { count: 3 },
    [outcomeMetricKey(2, 'other')]: { count: 1 },
  } };
  const [result] = readOutcomeResults([{ rq: 2, name: 'Redeem', method: 'POST', url: '/r', labels: ['success', 'sold_out', 'other'], fallback: 'other' }], summary);
  assert.equal(result.total, 4);
  assert.deepEqual(result.outcomes, [
    { label: 'success', count: 3, share: 0.75 }, { label: 'sold_out', count: 0, share: 0 }, { label: 'other', count: 1, share: 0.25 },
  ]);
  assert.equal(result.fallback, 'other');
  assert.deepEqual(readOutcomeResults([], summary), []);
  assert.equal(readOutcomeResults([{ rq: 1, labels: ['a'] }], null)[0].total, 0);
});

// ── Generator ─────────────────────────────────────────────────

test('generated code: Counter import, one always-passing threshold per label, rules as data, a plain function per request', () => {
  const meta = {};
  const script = generateScript(config([request({ name: 'Login', url: 'https://api.example.com/login' }), request({ outcomes: RACE_RULES })]), meta);
  assert.match(script, /^import \{ Counter \} from 'k6\/metrics';$/m);
  assert.match(script, /"k6ui_outcome\{rq:2,outcome:success\}": \[\s*"count>=0"\s*\]/);
  assert.match(script, /"k6ui_outcome\{rq:2,outcome:other\}"/);
  assert.match(script, /const OUTCOME_RULES_2 = \{\n  rules: \[/);
  assert.match(script, /\{ label: "quota_reached", status: "400", source: "json", selector: "error\.code", operator: "equals", value: "PROM-422001" \}/);
  assert.match(script, /\{ label: "high_traffic", source: "body", operator: "matches", value: "\/high traffic\/i" \}/);
  assert.match(script, /^  fallback: "other",$/m);
  assert.match(script, /"lock_rejected": \{ rq: "2", outcome: "lock_rejected" \}/);
  assert.match(script, /^const OUTCOME_PATTERNS_2 = \[new RegExp\("high traffic", "i"\)\];$/m);
  // One if per rule; the JSON path both error-code rules use is read once.
  assert.match(script, /^function outcomeOf_2\(res\) \{\n  const status = res\.status;\n  let json_0 = OUTCOME_UNREAD; \/\/ "error\.code"\n  if \(status === 200\) return "success"; \/\/ rule 1$/m);
  assert.match(script, /if \(\(status >= 400 && status < 500\) && outcomeText\(json_0 === OUTCOME_UNREAD \? \(json_0 = outcomeJson\(res, "error\.code"\)\) : json_0\) === "PROM-429001"\) return "lock_rejected"; \/\/ rule 3/);
  assert.match(script, /if \(status === 503 && outcomeContains\(outcomeHeader\(res\.headers, "x-reason"\), "maint"\)\) return "maintenance"; \/\/ rule 4/);
  assert.match(script, /if \(outcomeMatches\(res\.body, OUTCOME_PATTERNS_2\[0\]\)\) return "high_traffic"; \/\/ rule 5\n  return "other";\n\}/);
  assert.equal(script.match(/let json_\d/g).length, 1);
  assert.match(script, /const outcome_main_1 = outcomeOf_2\(res_main_1\);\n  OUTCOME\.add\(1, OUTCOME_TAGS_2\[outcome_main_1\]\);/);
  assert.doesNotMatch(script, /OUTCOME_RULES_1\b|outcomeOf_1\b/);
  assert.deepEqual(meta.outcomes, [{
    rq: 2, index: 1, name: 'Redeem', method: 'POST', url: 'https://api.example.com/redeem',
    labels: ['success', 'quota_reached', 'lock_rejected', 'maintenance', 'high_traffic', 'other'], fallback: 'other',
  }]);
});

test('a flow without rules gets none of it, and the thresholds the user set stay', () => {
  const script = generateScript(config([request(), request({ outcomes: { rules: [{}], fallback: 'other' } })], { thresholds: { p95: '500', errorRate: '' } }));
  assert.doesNotMatch(script, /k6\/metrics|outcomeOf_|k6ui_outcome/);
  const withRules = loadScript(generateScript(config([request({ outcomes: RACE_RULES })], { thresholds: { p95: '500', errorRate: '1' } })));
  assert.deepEqual(withRules.options.thresholds.http_req_duration, ['p(95)<500']);
  assert.deepEqual(withRules.options.thresholds.http_req_failed, ['rate<0.01']);
});

test('the first rule that matches labels the response; nothing matching gives the fallback', () => {
  const responses = [
    { status: 200, body: '{"ok":true}' },
    { status: 400, body: '{"error":{"code":"PROM-422001"}}' },
    { status: 409, body: '{"error":{"code":"PROM-429001"}}' },
    { status: 503, body: '', headers: { 'X-Reason': 'Maintenance window' } },
    { status: 503, body: '', headers: { 'X-Reason': 'planned maint' } },
    { status: 429, body: 'HIGH TRAFFIC, retry' },
    { status: 400, body: 'not json at all' },
    { status: 0, body: null },
  ];
  let next = 0;
  const run = loadScript(generateScript(config([request({ outcomes: RACE_RULES })])), { respond: () => responses[next++] });
  for (let i = 0; i < responses.length; i++) run.iteration(1, i);
  assert.deepEqual(run.metrics.map(item => item.tags.outcome), [
    'success', 'quota_reached', 'lock_rejected', 'other', 'maintenance', 'high_traffic', 'other', 'other',
  ]);
  assert.ok(run.metrics.every(item => item.name === 'k6ui_outcome' && item.value === 1 && item.tags.rq === '1'));
});

test('exists, an empty JSON path and a whole-body equals', () => {
  const outcomes = { rules: [
    { label: 'has_id', source: 'json', selector: 'data.id', operator: 'exists' },
    { label: 'empty_list', source: 'json', selector: '', operator: 'equals', value: '[]' },
    { label: 'zero', source: 'json', selector: 'count', operator: 'equals', value: '0' },
  ], fallback: 'none_of_them' };
  const responses = [{ body: '{"data":{"id":0}}' }, { body: '[]' }, { body: '{"count":0}' }, { body: '{"data":{"id":null}}' }];
  let next = 0;
  const run = loadScript(generateScript(config([request({ outcomes })])), { respond: () => responses[next++] });
  for (let i = 0; i < responses.length; i++) run.iteration(1, i);
  assert.deepEqual(run.metrics.map(item => item.tags.outcome), ['has_id', 'empty_list', 'zero', 'none_of_them']);
});

test('the label is counted inside a conditional group, and not when the group is skipped', () => {
  const runWith = mode => {
    const run = loadScript(generateScript({
      ...config([]),
      variables: [{ key: 'MODE', value: mode }],
      scenario: {
        groups: [{ id: 'grp_race', name: 'Race', enabled: true, runIf: { variable: 'MODE', operator: 'equals', values: ['race'] } }],
        requests: [request({ groupId: 'grp_race', outcomes: { rules: [{ label: 'ok', status: '2xx' }] } })],
      },
    }));
    run.iteration(1, 0);
    return run.metrics.map(item => item.tags.outcome);
  };
  assert.deepEqual(runWith('race'), ['ok']);
  assert.deepEqual(runWith('skip'), []);
});

test('rules that cannot work are a 400 naming the request number of the run', () => {
  const cases = [
    [[request({ enabled: false, outcomes: RACE_RULES }), request({ outcomes: { rules: [{ label: 'bad label' }] } })], /^Request 1, Outcomes: Rule 1: "bad label"|^Request 1, Outcomes: Rule 1:/],
    [[request(), { type: 'grpc', url: 'localhost:50051', grpcMethod: 'a.B/C', outcomes: RACE_RULES }], /^Request 2: outcome rules work on HTTP requests only/],
  ];
  for (const [requests, message] of cases) {
    assert.throws(() => generateScript(config(requests)), err => err.status === 400 && message.test(err.message));
  }
});

// ── Importer ──────────────────────────────────────────────────

test('a generated script imports back to the same rules, with no warning about k6/metrics or thresholds', () => {
  const rules = {
    rules: [
      ...RACE_RULES.rules,
      { label: 'first_item', status: '200', source: 'json', selector: 'items[0].state', operator: 'equals', value: 'sold' },
    ],
    fallback: 'unknown',
  };
  const { config: imported, warnings } = importK6Script(generateScript(config([request({ name: 'Login' }), request({ outcomes: rules })])));
  assert.deepEqual(warnings, []);
  assert.equal(imported.scenario.requests[0].outcomes, undefined);
  assert.deepEqual(imported.scenario.requests[1].outcomes, {
    rules: rules.rules.map(rule => ({ selector: '', operator: 'equals', value: '', status: '', ...rule })),
    fallback: 'unknown',
  });
  assert.deepEqual(imported.thresholds, { p95: '', errorRate: '' });
});

test('k6/metrics in a hand-written script is still reported as ignored', () => {
  const { warnings } = importK6Script(`
import http from 'k6/http';
import { Counter } from 'k6/metrics';
const hits = new Counter('hits');
export default function () { http.get('https://api.example.com/'); }
`);
  assert.ok(warnings.some(item => /import "k6\/metrics" was ignored/.test(item.message)));
});

// ── Store, notice, report ─────────────────────────────────────

test('the project store keeps one outcome shape and drops a value that is not one', () => {
  const project = migrateProject({ scenario: { requests: [
    request({ id: 'req_a', outcomes: { rules: [{ label: 'ok', status: 200 }] } }),
    request({ id: 'req_b', outcomes: 'oops' }),
    request({ id: 'req_c' }),
  ] } });
  const [a, b, c] = project.scenario.requests;
  assert.deepEqual(a.outcomes, { rules: [{ label: 'ok', status: '200', source: 'none', selector: '', operator: 'equals', value: '' }], fallback: 'other' });
  assert.equal(Object.hasOwn(b, 'outcomes'), false);
  assert.equal(Object.hasOwn(c, 'outcomes'), false);
});

test('the Simple notice counts requests that run with outcome rules', () => {
  const base = { enabled: true, groupId: '', type: 'http', extractions: [], assertions: [], checkStatus: true };
  const summary = summarizeAdvancedSettings([
    { ...base, outcomes: RACE_RULES },
    { ...base, outcomes: { rules: [{}] } },
    { ...base, enabled: false, outcomes: RACE_RULES },
  ], []);
  assert.deepEqual(summary.active.find(item => item.id === 'outcomes'), { id: 'outcomes', label: 'Outcome rules', count: 1, unit: 'request' });
  assert.equal(summary.skipped.requests, 1);
});

test('the report lists outcomes and leaves the always-passing count thresholds out of its targets', () => {
  const summary = { metrics: {
    'k6ui_outcome{rq:1,outcome:success}': { count: 2, thresholds: { 'count>=0': false } },
    http_req_duration: { avg: 1, 'p(95)': 2, thresholds: { 'p(95)<500': false } },
  } };
  assert.deepEqual(summaryThresholds(summary), [{ metric: 'http_req_duration', rule: 'p(95)<500', ok: true }]);
  const report = buildRunReport({
    summary,
    outcomes: [{ rq: 1, name: 'Redeem <1>', method: 'POST', url: '/r', fallback: 'other', total: 2, outcomes: [{ label: 'success', count: 2, share: 1 }] }],
  });
  assert.deepEqual(report.outcomes, [{
    request: 1, name: 'Redeem <1>', method: 'POST', url: '/r', fallback: 'other', total: 2, outcomes: [{ label: 'success', count: 2, share: 1 }],
  }]);
  const html = reportToHtml(report);
  assert.match(html, /<h2>Outcomes<\/h2>/);
  assert.match(html, /Request 1 · Redeem &lt;1&gt;/);
  assert.deepEqual(buildRunReport({}).outcomes, []);
});
