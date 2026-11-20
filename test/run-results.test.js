// UX stage 7: Run & Results in plain words (public/js/run-summary.js, pure) and the
// markup it writes into: the check before a run, the reading after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateScript } from '../server/generator/index.js';
import { thresholdRequests } from '../public/js/outcome-thresholds.js';
import { flowFromConfig } from '../public/js/variables.js';
import { summaryChecks } from '../public/js/run-report.js';
import { GLOSSARY } from '../public/js/glossary.js';
import {
  checklistHeadline, formatMs, formatRate, goalResults, looksLikeTestHost, metricCards, nextSteps,
  perRequestRows, percentile95, preRunChecks, requestHost, runFigures, verdictText,
} from '../public/js/run-summary.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');

const project = (overrides = {}) => ({
  scenario: {
    groups: [{ id: 'grp_off', name: 'Off', enabled: false }],
    requests: [
      { id: 'req_login', name: 'Log in', method: 'POST', url: '{{base_url}}/login', body: '{}', extractions: [{ varName: 'token', source: 'json', selector: 'token' }] },
      { id: 'req_skip', name: 'Skipped', method: 'GET', url: '{{base_url}}/skip', groupId: 'grp_off' },
      { id: 'req_me', name: 'Profile', method: 'GET', url: '{{base_url}}/me', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] },
      { id: 'req_pay', name: 'Pay', method: 'POST', url: '{{base_url}}/pay', body: '{}', expectedStatuses: '200,4xx' },
    ],
  },
  variables: [{ key: 'base_url', value: 'https://staging.shop.example.com' }],
  load: { mode: 'simple', vus: '10', duration: '30s' },
  thresholds: { p95: '500', errorRate: '1' },
  ...overrides,
});

test('test hosts are told apart from production ones', () => {
  for (const host of ['localhost:3000', '127.0.0.1', 'staging.shop.example.com', 'api-dev.example.com', 'qa2.example.com', 'shop.test', '192.168.1.20:8080', 'uat.bank.co.id']) {
    assert.equal(looksLikeTestHost(host), true, host);
  }
  for (const host of ['api.example.com', 'www.shop.co.id', 'shop.example.com', 'devices.example.com', 'latest.example.com', '']) {
    assert.equal(looksLikeTestHost(host), false, host);
  }
  const variables = [{ key: 'base_url', value: 'https://api.example.com' }];
  assert.equal(requestHost({ url: '{{base_url}}/x' }, variables), 'api.example.com');
  assert.equal(requestHost({ url: '{{token}}/x' }, variables), '', 'a value known only during the run');
  assert.equal(requestHost({ url: '{{base_url}}/me?t={{token}}' }, variables), 'api.example.com', 'a later value in the query');
  assert.equal(requestHost({ type: 'grpc', url: 'grpc.staging.local:50051' }, []), 'grpc.staging.local:50051');
});

test('the checklist before a run: variables, target, goals, each with a way to fix it (no smoke test item)', () => {
  const good = preRunChecks({ flow: flowFromConfig(project()), goals: { p95: '500', errorRate: '1', outcomeTargets: 0 } });
  assert.deepEqual(good.items.map(item => [item.key, item.tone]),
    [['variables', 'ok'], ['target', 'ok'], ['goals', 'ok']]);
  assert.equal(good.facts.requests, 3, 'the request of the turned-off group does not run');
  assert.equal(good.facts.off, 1);
  assert.deepEqual(good.facts.hosts, ['staging.shop.example.com']);
  assert.equal(checklistHeadline(good.items), 'All 3 checks look fine');

  // {{token}} before the request that extracts it, a production-looking target, no goals.
  const config = project({ variables: [{ key: 'base_url', value: 'https://api.example.com' }] });
  config.scenario.requests = [config.scenario.requests[2], config.scenario.requests[0]];
  const bad = preRunChecks({ flow: flowFromConfig(config), goals: { p95: '', errorRate: '', outcomeTargets: 0 } });
  const byKey = Object.fromEntries(bad.items.map(item => [item.key, item]));
  assert.equal(byKey.variables.tone, 'bad');
  assert.match(byKey.variables.text, /\{\{token\}\} not available yet in "Profile"/);
  assert.deepEqual(byKey.variables.action, { label: 'Show the request', kind: 'request', value: 'req_me' });
  assert.equal(byKey.target.tone, 'warn');
  assert.match(byKey.target.text, /api\.example\.com.*not production/);
  assert.deepEqual(byKey.target.action, { label: 'Check the variables', kind: 'view', value: 'vars' }, 'the host comes from a global variable');
  assert.equal(byKey.smoke, undefined, 'no smoke test item');
  assert.deepEqual(byKey.goals.action, { label: 'Set goals', kind: 'view', value: 'sla' });
  assert.equal(checklistHeadline(bad.items), '3 things to look at');

  const targets = preRunChecks({ flow: flowFromConfig(project()), goals: { outcomeTargets: 2 } });
  assert.match(targets.items.find(item => item.key === 'goals').text, /^2 pass\/fail goals are set/);

  const empty = preRunChecks({ flow: flowFromConfig({}), goals: {} });
  assert.deepEqual(empty.items[0], { key: 'requests', tone: 'bad', text: 'No request will run: add one, or turn one on.',
    action: { label: 'Build the flow', kind: 'view', value: 'flow' } });
});

const SUMMARY = {
  metrics: {
    http_req_duration: { avg: 161, min: 41, med: 148, max: 902, 'p(90)': 271, 'p(95)': 312.4, thresholds: { 'p(95)<500': false } },
    http_req_failed: { passes: 6, fails: 1440, value: 6 / 1446, thresholds: { 'rate<0.01': false } },
    http_reqs: { count: 1446, rate: 48.2 },
    vus_max: { value: 10, min: 10, max: 10 },
  },
  root_group: {
    name: '', path: '', groups: {},
    checks: {
      a: { name: 'status 2xx: request 1', passes: 362, fails: 0 },
      b: { name: 'status 2xx: request 2', passes: 362, fails: 0 },
      c: { name: 'status 200,4xx: request 3', passes: 355, fails: 6 },
    },
  },
};

test('figures, goals and cards read the k6 summary (a threshold false = passed) and the live event', () => {
  const figures = runFigures({ summary: SUMMARY });
  assert.deepEqual([figures.p95, figures.failedCount, figures.requests, figures.peak], [312.4, 6, 1446, 10]);
  const goals = goalResults({ thresholds: { p95: '500', errorRate: '1' }, summary: SUMMARY, figures });
  assert.deepEqual(goals.map(goal => [goal.key, goal.met]), [['p95', true], ['errorRate', true]]);
  const failedK6 = { ...SUMMARY, metrics: { ...SUMMARY.metrics, http_req_duration: { ...SUMMARY.metrics.http_req_duration, thresholds: { 'p(95)<300': true } } } };
  assert.equal(goalResults({ thresholds: { p95: '300' }, summary: failedK6, figures })[0].met, false);

  const cards = metricCards({ figures, goals });
  assert.deepEqual(cards.map(card => [card.label, card.value, card.tech]), [
    ['95% of requests finished within', '312 ms', 'http_req_duration p(95)'],
    ['Failed requests', '0.41%', 'http_req_failed'],
    ['Requests per second', '48.2', 'http_reqs rate'],
    ['Most users at once', '10', 'vus_max'],
  ]);
  assert.deepEqual(cards.slice(0, 2).map(card => card.compare), [
    { text: 'Goal: under 500 ms · met', tone: 'ok' }, { text: 'Goal: less than 1% · met', tone: 'ok' }]);
  assert.equal(cards[1].note, '6 of 1,446');
  for (const card of cards) assert.ok(GLOSSARY[card.help], `help key ${card.help}`);

  const live = runFigures({ live: { vus: 4, requests: 120, requestRate: 12, durationP95: 610, failedRate: 0 } });
  const liveGoals = goalResults({ thresholds: { p95: '500' }, figures: live });
  const liveCards = metricCards({ figures: live, goals: liveGoals, live: true });
  assert.deepEqual(liveCards[0].compare, { text: 'Goal: under 500 ms · over the goal so far', tone: 'bad' });
  assert.equal(liveCards[1].compare.text, 'No goal set');
  assert.equal(liveCards[3].label, 'Users now');
  assert.deepEqual([formatMs(1240), formatMs(12.34), formatRate(0), formatRate(0.25)], ['1.24 s', '12.3 ms', '0%', '25%']);
});

test('each request: counts from its status check, times from the records, the slowest marked', () => {
  const requests = thresholdRequests(project());
  assert.deepEqual(requests.map(item => item.rq), [1, null, 2, 3]);
  const records = [
    ...Array.from({ length: 20 }, (_, n) => ({ i: 0, d: 100 + n })),
    ...Array.from({ length: 20 }, (_, n) => ({ i: 2, d: 300 + n })),
    { i: 1, d: 50 },
  ];
  const model = perRequestRows({ requests, checks: summaryChecks(SUMMARY), records });
  assert.deepEqual(model.rows.map(row => [row.rq, row.name, row.sent, row.failed, row.p95, row.slowest]), [
    [1, 'Log in', 362, 0, 118, false],
    [2, 'Profile', 362, 0, 50, false],
    [3, 'Pay', 361, 6, 318, true],
  ]);
  assert.equal(model.slowest.name, 'Pay');
  const unrecorded = perRequestRows({ requests, checks: summaryChecks(SUMMARY), records: [] });
  assert.equal(unrecorded.timed, 0);
  assert.equal(unrecorded.slowest, null);
  assert.equal(percentile95([5, 1, 3]), 5);
});

test('the per-request counts follow the check names and request numbers of the generated script', () => {
  const config = project();
  const script = generateScript(config);
  const labels = [...script.matchAll(/check\(res_main_\d+, \{ "([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(labels, ['status 2xx: request 1', 'status 2xx: request 2', 'status 200,4xx: request 3']);
  const checks = labels.map(name => ({ group: '', name, passes: 1, fails: 0 }));
  const model = perRequestRows({ requests: thresholdRequests(config), checks, records: [] });
  assert.deepEqual(model.rows.map(row => [row.rq, row.name, row.sent]), [[1, 'Log in', 1], [2, 'Profile', 1], [3, 'Pay', 1]]);
});

test('the verdict is a sentence and "What to do next" points somewhere', () => {
  const figures = runFigures({ summary: SUMMARY });
  const goals = goalResults({ thresholds: { p95: '500', errorRate: '1' }, summary: SUMMARY, figures });
  const passed = verdictText({ status: 'passed', goals, figures, durationText: '30s' });
  assert.equal(passed.title, 'Passed: your service handled 10 users and met every goal');
  assert.equal(passed.detail, '✓ 95% within 500 ms · ✓ less than 1% failed · 1,446 requests in 30s');
  assert.match(verdictText({ status: 'passed', goals: [], figures }).title, /^Finished: no goal was set/);
  const missed = goals.map(goal => ({ ...goal, met: false }));
  assert.equal(verdictText({ status: 'threshold-failed', goals: missed, figures }).title, 'Failed: 2 goals were missed');
  assert.equal(verdictText({ status: 'threshold-failed', goals: [], targets: [{ status: 'not-met' }, { status: 'met' }], figures }).title,
    'Failed: a goal was missed');
  assert.equal(verdictText({ status: 'aborted' }).title, 'Stopped: you ended the run early');
  assert.match(verdictText({ status: 'failed', code: 107 }).detail, /code 107/);
  assert.equal(verdictText({ status: 'passed', goals, figures, race: true }).title, 'Passed: every goal was met');

  const requests = thresholdRequests(project());
  const perRequest = perRequestRows({ requests, checks: summaryChecks(SUMMARY), records: [{ i: 0, d: 90 }, { i: 3, d: 400 }, { i: 2, d: 200 }] });
  const failedRequests = perRequest.rows.filter(row => row.failed > 0);
  const smoke = nextSteps({ status: 'passed', goals, figures, perRequest, goal: 'smoke', recorded: true, failedRequests });
  assert.deepEqual(smoke.map(step => step.action?.value ?? null), ['errors', 'load', null]);
  assert.match(smoke[0].text, /^"Pay" failed 6 times/);
  assert.match(smoke[2].text, /"Pay" is the slowest request/);
  const slow = nextSteps({ status: 'threshold-failed', goals: [{ key: 'p95', met: false }], figures: { failedRate: 0 },
    perRequest: perRequestRows({ requests, checks: [], records: [] }), recorded: false });
  assert.deepEqual(slow[0].action, { label: 'Recording options', kind: 'record' });
  assert.deepEqual(nextSteps({ status: 'failed' })[0].action, { label: 'Raw k6 output', kind: 'tab', value: 'live' });
  for (const step of [...smoke, ...slow]) assert.ok(step.text.length < 200);
});

test('markup: Before you run holds the checklist and the recording options; the overview reads the run', () => {
  const prerun = html.slice(html.indexOf('<details id="prerun"'), html.indexOf('</details>', html.indexOf('<details id="prerun"')));
  for (const id of ['prerun-facts', 'prerun-checklist', 'prerun-record', 'log-requests', 'log-filter', 'log-sample-every', 'log-redact', 'prerun-run-btn']) {
    assert.match(prerun, new RegExp(`id="${id}"`), id);
  }
  const requestsTab = html.slice(html.indexOf('id="tab-requests"'), html.indexOf('id="tab-errors"'));
  assert.doesNotMatch(requestsTab, /id="log-requests"/, 'the recording options moved out of the Requests tab');
  assert.match(requestsTab, /id="req-log-options"/);
  const overview = html.slice(html.indexOf('id="tab-overview"'), html.indexOf('id="tab-requests"'));
  const order = ['run-verdict', 'overview-metrics', 'run-per-request', 'run-next', 'run-race', 'run-outcomes', 'run-exports', 'run-all-metrics', 'result-shortcuts'];
  const positions = order.map(id => overview.search(new RegExp(`(id|class)="${id}"`)));
  assert.ok(positions.every(position => position > 0), 'every part is in the overview');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in reading order');
  assert.match(overview, /data-results-tab="live">Raw k6 output</);
  assert.doesNotMatch(overview, /data-results-tab="metrics"/);
  const runner = read('../public/js/runner.js');
  const overviewJs = read('../public/js/result-overview.js');
  const checkJs = read('../public/js/components/run-check.js');
  for (const source of [overviewJs, checkJs]) assert.doesNotMatch(source, /innerHTML/);
  assert.match(overviewJs, /helpButton\(card\.help\)/, '"?" beside each card label, built once');
  assert.match(runner, /\$\('#prerun'\)\.open = false/, 'Before you run folds when a run starts');
});
