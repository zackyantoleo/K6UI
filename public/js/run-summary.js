// Run & Results in plain words (pure, no DOM): the check before a run (what will
// happen + a checklist, each item with the place that fixes it) and the reading of
// a run (a verdict sentence, metric cards compared with the goals, one row per
// request with the slowest one marked, and what to do next). Everything here reads
// data the page already has: the forms as typed, the k6 summary of `done`, the live
// `metrics` events and the recorded request records. Nothing is sent to the server.
import { describeIssue, globalVariableName, requestLabel, skipReason, variableIssues } from './variables.js';
import { text } from './shared/basics.js';

const plural = (count, noun, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`;
const number = value => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const grouped = value => Math.round(value).toLocaleString('en-US');

// "312 ms", "1.24 s"
export function formatMs(ms) {
  const value = number(ms);
  if (value == null) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ms`;
}

// 0.0041 → "0.41%"
export function formatRate(rate) {
  const value = number(rate);
  if (value == null) return '—';
  const percent = value * 100;
  return `${percent === 0 || percent >= 10 ? Math.round(percent) : Number(percent.toFixed(2))}%`;
}

// ── Before the run ──────────────────────────────────────────────

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/i;
const LOCAL_SUFFIX = /\.(localhost|local|test|internal)$/i;
// A label of the host name that names a test environment: staging.example.com, api-dev.example.com, qa2.example.com.
const TEST_LABEL = /(^|[.-])(staging|stage|stg|dev|develop|test|testing|qa|uat|sandbox|preview|preprod|perf|load|local)\d*([.-]|$)/i;

// Does a host name look like a test environment (not production)?
export function looksLikeTestHost(host) {
  const name = text(host).replace(/:\d+$/, '').trim();
  if (!name) return false;
  return LOCAL_HOST.test(name) || LOCAL_SUFFIX.test(name) || TEST_LABEL.test(name);
}

// {{name}} of a global variable → its value (other names stay as written).
function resolveGlobals(value, variables) {
  const globals = new Map();
  for (const row of variables || []) {
    const name = globalVariableName(row?.key);
    if (name && !globals.has(name)) globals.set(name, text(row?.value));
  }
  return text(value).replace(/\{\{(\w+)\}\}/g, (match, name) => (globals.has(name) ? globals.get(name) : match));
}

// The host a request is sent to, or '' when it is not known before the run.
export function requestHost(request, variables) {
  const url = resolveGlobals(request?.url, variables).trim();
  // Only the scheme and host matter: a {{value}} in the path or query is fine.
  const origin = /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*/i.exec(url)[0];
  if (!url || origin.includes('{{')) return '';
  if (request?.type === 'grpc') return origin.replace(/^[a-z]+:\/\//i, '');
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// The requests that will run, numbered like the generator (1, 2, …).
export function runningRequests(flow) {
  const groups = new Map((flow?.groups || []).map(group => [group.id, group]));
  const all = flow?.requests || [];
  return all.filter(request => !skipReason(request, groups));
}

// { requests, off, hosts: [host], unknownHosts, issues: [{ request, label, issue }] }
export function flowFacts(flow) {
  const running = runningRequests(flow);
  const hosts = [];
  let unknownHosts = 0;
  for (const request of running) {
    const host = requestHost(request, flow?.variables);
    if (!host) unknownHosts += 1;
    else if (!hosts.includes(host)) hosts.push(host);
  }
  const issues = [];
  const byId = variableIssues(flow || {});
  (flow?.requests || []).forEach((request, index) => {
    for (const issue of byId.get(request.id) || []) issues.push({ request, label: requestLabel(request, index), issue });
  });
  return { requests: running.length, off: (flow?.requests || []).length - running.length, hosts, unknownHosts, issues };
}

// Goals as sentences: "95% within 500 ms", "less than 1% fail", "1 outcome target".
export function goalTexts({ p95 = '', errorRate = '', outcomeTargets = 0 } = {}) {
  const goals = [];
  if (number(p95) != null && text(p95).trim()) goals.push(`95% within ${Number(p95)} ms`);
  if (number(errorRate) != null && text(errorRate).trim()) goals.push(`less than ${Number(errorRate)}% fail`);
  if (outcomeTargets) goals.push(plural(outcomeTargets, 'outcome target'));
  return goals;
}

// The checklist before a run. state: { flow, goals: { p95, errorRate, outcomeTargets } }
// → [{ key, tone: 'ok' | 'warn' | 'bad', text, action? { label, kind, value } }]
// action.kind: 'view' (navigate), 'request' (show that request), 'goal' (pick a load goal).
export function preRunChecks({ flow, goals = {} } = {}) {
  const facts = flowFacts(flow);
  const items = [];

  if (!facts.requests) {
    items.push({ key: 'requests', tone: 'bad', text: 'No request will run: add one, or turn one on.',
      action: { label: 'Build the flow', kind: 'view', value: 'flow' } });
  }

  if (facts.issues.length) {
    const [first] = facts.issues;
    const more = facts.issues.length - 1;
    items.push({
      key: 'variables', tone: 'bad',
      text: `${describeIssue(first.issue).text} in "${first.label}": it would be sent as plain text.`
        + (more ? ` ${plural(more, 'other variable')} ${more === 1 ? 'has' : 'have'} a problem too.` : ''),
      action: { label: 'Show the request', kind: 'request', value: text(first.request.id) },
    });
  } else if (facts.requests) {
    items.push({ key: 'variables', tone: 'ok', text: 'Every {{variable}} has a value when it is used.' });
  }

  if (facts.requests) {
    const risky = facts.hosts.filter(host => !looksLikeTestHost(host));
    const shown = list => list.slice(0, 3).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
    const fromGlobal = (flow?.requests || []).some(request => /^\s*\{\{\w+\}\}/.test(text(request.url)));
    const fix = fromGlobal
      ? { label: 'Check the variables', kind: 'view', value: 'vars' }
      : { label: 'Check the URLs', kind: 'view', value: 'flow' };
    if (risky.length) {
      items.push({ key: 'target', tone: 'warn',
        text: `The target is ${shown(risky)}. Make sure this is not production: a load test can slow it down for real users.`,
        action: fix });
    } else if (facts.hosts.length) {
      items.push({ key: 'target', tone: 'ok', text: `The target is ${shown(facts.hosts)} (looks like a test environment).` });
    }
    if (facts.unknownHosts && !risky.length) {
      items.push({ key: 'target-unknown', tone: 'warn',
        text: `${plural(facts.unknownHosts, 'request')} ${facts.unknownHosts === 1 ? 'gets its' : 'get their'} server only during the run. Make sure it is not production.`,
        action: fix });
    }
  }

  const goalCount = goalTexts({ p95: goals.p95 }).length + goalTexts({ errorRate: goals.errorRate }).length
    + (Number(goals.outcomeTargets) || 0);
  if (!goalCount) {
    items.push({ key: 'goals', tone: 'warn', text: 'No pass/fail goal is on, so this test passes however slow the responses are.',
      action: { label: 'Set goals', kind: 'view', value: 'sla' } });
  } else {
    items.push({ key: 'goals', tone: 'ok', text: `${plural(goalCount, 'pass/fail goal')} ${goalCount === 1 ? 'is' : 'are'} set.` });
  }
  return { facts, items };
}

// "All 4 checks look fine" / "2 things to look at"
export function checklistHeadline(items) {
  const open = items.filter(item => item.tone !== 'ok').length;
  if (!open) return `All ${items.length} checks look fine`;
  return `${plural(open, 'thing')} to look at`;
}

// ── After the run ───────────────────────────────────────────────

// k6 summary export: in `thresholds`, false means the threshold PASSED.
function thresholdMet(metric) {
  const values = Object.values(metric?.thresholds || {});
  if (!values.length) return null;
  return values.every(failed => failed === false);
}

// The figures of a run, from the k6 summary of `done` or a live `metrics` event.
// → { p95, failedRate, failedCount, requests, rate, peak, avg, max }
export function runFigures({ summary = null, live = null } = {}) {
  if (summary) {
    const metrics = summary.metrics || {};
    const duration = metrics.http_req_duration || {};
    const failed = metrics.http_req_failed || {};
    const requests = metrics.http_reqs || {};
    return {
      p95: number(duration['p(95)']),
      avg: number(duration.avg),
      max: number(duration.max),
      failedRate: number(failed.value),
      failedCount: number(failed.passes),
      requests: number(requests.count),
      rate: number(requests.rate),
      peak: number(metrics.vus_max?.value ?? metrics.vus_max?.max),
    };
  }
  if (live) {
    return {
      p95: number(live.durationP95), avg: number(live.durationAvg), max: null,
      failedRate: number(live.failedRate), failedCount: null,
      requests: number(live.requests), rate: number(live.requestRate), peak: number(live.vus),
    };
  }
  return { p95: null, avg: null, max: null, failedRate: null, failedCount: null, requests: null, rate: null, peak: null };
}

// Each p95 / error-rate goal of the run with whether it was met (null = not known yet).
// thresholds = the run's config.thresholds; `live` compares the figures so far.
export function goalResults({ thresholds = {}, summary = null, figures }) {
  const results = [];
  const p95 = text(thresholds?.p95).trim();
  if (p95 && number(p95) != null) {
    const fromK6 = thresholdMet(summary?.metrics?.http_req_duration);
    const met = fromK6 ?? (figures.p95 == null ? null : figures.p95 < Number(p95));
    results.push({ key: 'p95', text: `95% within ${Number(p95)} ms`, limit: Number(p95), met });
  }
  const rate = text(thresholds?.errorRate).trim();
  if (rate && number(rate) != null) {
    const fromK6 = thresholdMet(summary?.metrics?.http_req_failed);
    const met = fromK6 ?? (figures.failedRate == null ? null : figures.failedRate * 100 < Number(rate));
    results.push({ key: 'errorRate', text: `less than ${Number(rate)}% failed`, limit: Number(rate), met });
  }
  return results;
}

// The metric cards: plain name, the "?" key, the value, the comparison with the goal
// and k6's own name. `live` = values so far (cumulative).
export function metricCards({ figures, goals = [], live = false }) {
  const goal = key => goals.find(item => item.key === key);
  const compare = (key, sentence) => {
    const item = goal(key);
    if (!item) return { text: 'No goal set', tone: 'none' };
    if (item.met == null) return { text: `Goal: ${sentence(item)}`, tone: 'none' };
    if (live) return item.met ? { text: `Goal: ${sentence(item)} · on track so far`, tone: 'ok' }
      : { text: `Goal: ${sentence(item)} · over the goal so far`, tone: 'bad' };
    return item.met ? { text: `Goal: ${sentence(item)} · met`, tone: 'ok' } : { text: `Goal: ${sentence(item)} · missed`, tone: 'bad' };
  };
  const failedNote = figures.failedCount != null && figures.requests != null
    ? `${grouped(figures.failedCount)} of ${grouped(figures.requests)}` : '';
  return [
    { key: 'p95', label: '95% of requests finished within', help: 'p95', value: formatMs(figures.p95),
      compare: compare('p95', item => `under ${item.limit} ms`), tech: 'http_req_duration p(95)' },
    { key: 'failed', label: 'Failed requests', help: 'errorRate', value: formatRate(figures.failedRate),
      note: failedNote, compare: compare('errorRate', item => `less than ${item.limit}%`), tech: 'http_req_failed' },
    { key: 'rate', label: 'Requests per second', help: 'throughput',
      value: figures.rate == null ? '—' : String(Number(figures.rate.toFixed(figures.rate >= 100 ? 0 : 1))),
      compare: { text: live ? 'Average so far' : 'Average over the run', tone: 'none' }, tech: 'http_reqs rate' },
    { key: 'users', label: live ? 'Users now' : 'Most users at once', help: 'vu',
      value: figures.peak == null ? '—' : grouped(figures.peak),
      compare: { text: figures.requests == null ? '' : `${grouped(figures.requests)} requests ${live ? 'so far' : 'in total'}`, tone: 'none' },
      tech: live ? 'vus' : 'vus_max' },
  ];
}

// "status 2xx: request 3" / "status 200,4xx: request 3" / "grpc status OK: request 3" → 3
const STATUS_CHECK = /^(?:status [^:]+|grpc status OK): request (\d+)$/;

// 95th percentile of a list of numbers (nearest rank).
export function percentile95(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

// One row per request that ran. requests = thresholdRequests(config) (rq = run number);
// checks = summaryChecks(summary); records = recorded request records ({ i, d, ok }).
// Sent and failed come from the automatic status check (none when it is off), times
// from the recorded records (none when nothing was recorded).
// → { rows: [{ rq, name, method, url, sent, failed, recorded, p95, slowest }], timed, slowest }
export function perRequestRows({ requests = [], checks = [], records = [] }) {
  const counts = new Map();
  for (const check of checks) {
    const match = STATUS_CHECK.exec(text(check.name));
    if (!match) continue;
    const rq = Number(match[1]);
    const entry = counts.get(rq) || { passes: 0, fails: 0 };
    entry.passes += Number(check.passes) || 0;
    entry.fails += Number(check.fails) || 0;
    counts.set(rq, entry);
  }
  const times = new Map();
  for (const record of records) {
    const rq = Number(record?.i) + 1;
    const duration = number(record?.d);
    if (!Number.isFinite(rq) || duration == null) continue;
    if (!times.has(rq)) times.set(rq, []);
    times.get(rq).push(duration);
  }
  const rows = requests.filter(request => request.rq).map(request => {
    const count = counts.get(request.rq);
    const recorded = times.get(request.rq) || [];
    return {
      rq: request.rq,
      name: text(request.name).trim() || `${text(request.method)} ${text(request.url)}`.trim(),
      method: request.method,
      url: request.url,
      sent: count ? count.passes + count.fails : null,
      failed: count ? count.fails : null,
      recorded: recorded.length,
      p95: percentile95(recorded),
      slowest: false,
    };
  });
  const timed = rows.filter(row => row.p95 != null);
  let slowest = null;
  if (timed.length > 1) {
    slowest = timed.reduce((a, b) => (b.p95 > a.p95 ? b : a));
    slowest.slowest = true;
  }
  return { rows, timed: timed.length, slowest };
}

// The verdict sentence. status: passed | threshold-failed | failed | aborted;
// goals = goalResults(); targets = outcome targets of `done` ({ status }).
export function verdictText({ status, goals = [], targets = [], figures, race = false, code = null, durationText = '' }) {
  const missed = goals.filter(goal => goal.met === false).length
    + targets.filter(target => target?.status === 'not-met').length;
  const setGoals = goals.length + targets.filter(target => target?.status !== 'skipped').length;
  const parts = goals.map(goal => `${goal.met === false ? '✕' : goal.met ? '✓' : '·'} ${goal.text}`);
  const metTargets = targets.filter(target => target?.status === 'met').length;
  if (targets.length) parts.push(`${metTargets} of ${plural(targets.length, 'outcome target')} met`);
  if (figures?.requests != null) parts.push(`${grouped(figures.requests)} requests${durationText ? ` in ${durationText}` : ''}`);
  const detail = parts.join(' · ');
  const users = figures?.peak != null ? plural(figures.peak, 'user') : 'the users';

  if (status === 'passed') {
    if (!setGoals) {
      return { title: 'Finished: no goal was set, so nothing could fail',
        detail: `${detail ? `${detail}. ` : ''}Set a pass/fail goal to get a real verdict.` };
    }
    return { title: race ? 'Passed: every goal was met' : `Passed: your service handled ${users} and met every goal`, detail };
  }
  if (status === 'threshold-failed') {
    const count = Math.max(1, missed);
    return { title: `Failed: ${count === 1 ? 'a goal was' : `${count} goals were`} missed`, detail };
  }
  if (status === 'aborted') {
    return { title: 'Stopped: you ended the run early', detail: 'The figures below cover the part that ran; there is no verdict.' };
  }
  if (status === 'running') return { title: 'Running: figures update every second', detail: 'You can stop at any time; the results so far are kept.' };
  return { title: 'The test could not run',
    detail: code == null ? 'K6UI did not get a result. See Errors for the reason.' : `k6 stopped with code ${code}. See Errors and Raw k6 output for the reason.` };
}

// "What to do next": [{ text, action? { label, kind: 'tab' | 'view' | 'goal', value } }], at most four.
export function nextSteps({ status, goals = [], figures, perRequest, goal = 'custom', recorded = false, errors = 0, failedRequests = [] }) {
  const steps = [];
  if (status === 'failed') {
    steps.push({ text: 'k6 could not finish the run. Its own message says why.', action: { label: 'Raw k6 output', kind: 'tab', value: 'live' } });
    return steps;
  }
  if (status === 'aborted') {
    steps.push({ text: 'Run it again to the end to get a verdict.' });
  }
  const slowGoal = goals.find(item => item.key === 'p95' && item.met === false);
  const failGoal = goals.find(item => item.key === 'errorRate' && item.met === false);
  const slowest = perRequest?.slowest;
  if (slowGoal) {
    steps.push(slowest
      ? { text: `Responses were slower than your goal. Start with the slowest request, "${slowest.name}" (95% within ${formatMs(slowest.p95)}).` }
      : { text: 'Responses were slower than your goal. Keep a copy of requests on the next run to see which one is slow.', action: { label: 'Recording options', kind: 'record' } });
  }
  const worst = failedRequests[0];
  if (worst) {
    steps.push({ text: `"${worst.name}" failed ${plural(worst.failed, 'time')}${failGoal ? ', more than your goal allows' : ''}. Errors lists what came back.`,
      action: { label: 'Errors', kind: 'tab', value: 'errors' } });
  } else if (failGoal || (figures?.failedRate ?? 0) > 0) {
    steps.push({ text: `${formatRate(figures?.failedRate)} of requests failed. Errors lists what came back.`, action: { label: 'Errors', kind: 'tab', value: 'errors' } });
  } else if (errors) {
    steps.push({ text: `${plural(errors, 'error was', 'errors were')} recorded.`, action: { label: 'Errors', kind: 'tab', value: 'errors' } });
  }
  if (status === 'passed') {
    if (!goals.length) steps.push({ text: 'Add a pass/fail goal so the next run fails when the service is too slow.', action: { label: 'Set goals', kind: 'view', value: 'sla' } });
    if (goal === 'smoke') steps.push({ text: 'The flow works. Try a load test with your normal traffic next.', action: { label: 'Choose Load test', kind: 'goal', value: 'load' } });
    else if (goal === 'load') steps.push({ text: 'Normal traffic is fine. A stress test shows where the limit is.', action: { label: 'Choose Stress test', kind: 'goal', value: 'stress' } });
  }
  if (slowest && !slowGoal) steps.push({ text: `"${slowest.name}" is the slowest request (95% within ${formatMs(slowest.p95)}). Share this with its owner.` });
  if (!recorded && !slowest && status !== 'aborted' && (perRequest?.rows.length || 0) > 1) {
    steps.push({ text: 'To see the time of each request, keep a copy of requests on the next run.', action: { label: 'Recording options', kind: 'record' } });
  }
  if (!steps.length) steps.push({ text: 'Download the report to compare this run with the next one.' });
  return steps.slice(0, 4);
}
