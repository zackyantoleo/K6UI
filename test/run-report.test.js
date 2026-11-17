import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REPORT_FORMAT, buildRunReport, escapeHtml, metricKind, reportFileName, reportToHtml,
  summaryChecks, summaryMetrics, summaryThresholds,
} from '../public/js/run-report.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

// Shape written by `k6 run --summary-export` (checked with k6 v2.4.0).
const summary = {
  root_group: {
    name: '', path: '', groups: {
      Checkout: { name: 'Checkout', groups: {}, checks: { pay: { name: 'paid', passes: 3, fails: 1 } } },
    },
    checks: { 'status is 2xx': { name: 'status is 2xx', passes: 10, fails: 0 } },
  },
  metrics: {
    http_reqs: { count: 10, rate: 2.5 },
    http_req_duration: { avg: 12.5, min: 1, med: 10, max: 40, 'p(90)': 30, 'p(95)': 35, thresholds: { 'p(95)<500': false } },
    http_req_failed: { passes: 0, fails: 10, value: 0, thresholds: { 'rate<0.01': true } },
    data_received: { count: 2048, rate: 512 },
    vus_max: { value: 2, min: 2, max: 2 },
  },
};

const config = {
  scenario: {
    groups: [{ id: 'g1', name: 'Checkout', enabled: false }],
    requests: [
      { name: 'Login', method: 'POST', url: '{{base_url}}/login', body: '{"password":"hunter2"}', headers: [{ key: 'Authorization', value: 'Bearer SECRET' }] },
      { name: 'Pay', method: 'GET', url: '{{base_url}}/pay', groupId: 'g1' },
    ],
  },
  variables: [{ key: 'api_key', value: 'TOP-SECRET-VAR' }],
  dataSets: [{ name: 'Users', fileName: 'users.csv', content: 'email\nsecret-row@example.com\n' }],
  load: { mode: 'simple', vus: '2', duration: '4s' },
  thresholds: { p95: '500', errorRate: '1' },
  options: { logRequests: true, logFilter: 'all' },
};

function state(overrides = {}) {
  return {
    config,
    startedAt: new Date(2026, 10, 17, 9, 5, 7),
    summary,
    exitCode: 99,
    verdict: { status: 'threshold-failed', title: 'Targets were not met', detail: 'One failed.' },
    elapsedMs: 4321,
    errors: ['GET https://x/<script>alert(1)</script> returned status 500.'],
    requests: [{
      vu: 1, it: 0, i: 0, m: 'POST', url: 'https://x/a', s: 500, d: 12, ok: false, er: 'boom <script>alert(1)</script>',
      rqh: { 'Content-Type': 'application/json' }, rq: '{"order":"A<1>"}',
      rh: { 'Set-Cookie': 'sid=abc' }, rb: '{"error":"out of stock"}',
    }],
    requestsReceived: 3,
    exports: [{ file: 'orders.csv', rows: 4, truncated: false }],
    log: ['K6-OUTPUT-LINE\n'],
    ...overrides,
  };
}

test('metric kinds follow the keys k6 writes', () => {
  assert.equal(metricKind(summary.metrics.http_req_duration), 'trend');
  assert.equal(metricKind(summary.metrics.http_req_failed), 'rate');
  assert.equal(metricKind(summary.metrics.http_reqs), 'counter');
  assert.equal(metricKind(summary.metrics.vus_max), 'gauge');
  const duration = summaryMetrics(summary).find(metric => metric.name === 'http_req_duration');
  assert.equal(duration.unit, 'ms');
  assert.equal('thresholds' in duration.values, false);
});

test('a threshold marked true in the summary export is one that failed', () => {
  assert.deepEqual(summaryThresholds(summary), [
    { metric: 'http_req_duration', rule: 'p(95)<500', ok: true },
    { metric: 'http_req_failed', rule: 'rate<0.01', ok: false },
  ]);
});

test('checks of nested groups are listed with their group path', () => {
  assert.deepEqual(summaryChecks(summary), [
    { group: '', name: 'status is 2xx', passes: 10, fails: 0 },
    { group: 'Checkout', name: 'paid', passes: 3, fails: 1 },
  ]);
});

test('the JSON report carries the run, setup, results and raw summary', () => {
  const report = buildRunReport(state(), new Date('2026-11-17T10:00:00Z'));
  assert.equal(report.format, REPORT_FORMAT);
  assert.equal(report.generatedAt, '2026-11-17T10:00:00.000Z');
  assert.equal(report.run.status, 'threshold-failed');
  assert.equal(report.run.exitCode, 99);
  assert.equal(report.run.requestTotal, 10);
  assert.equal(report.run.errorTotal, 1);
  assert.equal(report.setup.requests[1].group, 'Checkout');
  assert.equal(report.setup.requests[1].enabled, false, 'a request of a turned-off group is off');
  assert.deepEqual(report.requests[0], {
    vu: 1, iteration: 0, request: 1, method: 'POST', url: 'https://x/a', status: 500, durationMs: 12, ok: false, error: 'boom <script>alert(1)</script>',
    requestHeaders: { 'Content-Type': 'application/json' }, requestBody: '{"order":"A<1>"}',
    responseHeaders: { 'Set-Cookie': 'sid=abc' }, responseBody: '{"error":"out of stock"}',
  });
  assert.equal('log' in report, false, 'the raw k6 output is not part of a report');
  assert.equal(report.summary, summary);
});

test('a record without recorded headers says so instead of showing an empty list', () => {
  const report = buildRunReport(state({ requests: [{ vu: 1, it: 0, i: 0, m: 'GET', url: 'https://x/b', s: 200, d: 3, ok: true }] }));
  assert.equal(report.requests[0].requestHeaders, null);
  assert.equal(report.requests[0].responseBody, '');
  const html = reportToHtml(report);
  assert.match(html, /Not recorded\./);
  assert.match(html, /\(empty\)/);
});

test('every request record shows its payload and response, JSON indented and escaped', () => {
  const html = reportToHtml(buildRunReport(state()));
  assert.match(html, /<details class="record bad">/);
  assert.match(html, /<dt>Content-Type<\/dt><dd>application\/json<\/dd>/);
  assert.match(html, /\{\n  &quot;order&quot;: &quot;A&lt;1&gt;&quot;\n\}/);
  assert.match(html, /<dt>Set-Cookie<\/dt><dd>sid=abc<\/dd>/);
  assert.match(html, /&quot;error&quot;: &quot;out of stock&quot;/);
  assert.match(html, /Status 500 · 12 ms/);
  assert.match(html, /"Hide secrets" off/);
  assert.doesNotMatch(html, /K6-OUTPUT-LINE/, 'no k6 output');
});

test('the report leaves out variables, the flow\'s headers and bodies, and data rows', () => {
  const report = buildRunReport(state());
  const text = JSON.stringify(report) + reportToHtml(report);
  for (const secret of ['TOP-SECRET-VAR', 'Bearer SECRET', 'hunter2', 'secret-row@example.com', 'K6-OUTPUT-LINE']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('a stopped run with no summary still makes a report', () => {
  const report = buildRunReport(state({ summary: null, exitCode: null, verdict: { status: 'aborted', title: 'Test stopped', detail: '' } }));
  assert.equal(report.run.requestTotal, 3, 'falls back to the records that reached the page');
  assert.deepEqual(report.metrics, []);
  const html = reportToHtml(report);
  assert.match(html, /STOPPED/);
  assert.match(html, /did not write a summary/);
});

test('the HTML report is self-contained and escapes everything from the run', () => {
  const html = reportToHtml(buildRunReport(state()));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.doesNotMatch(html, /<script/i, 'no script tag, not even one from a request record');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /returned status 500|<h2>Errors/, 'no Errors section: the request records show status and response');
  assert.equal('errors' in buildRunReport(state()), false);
  assert.doesNotMatch(html, /https?:\/\/(?!x\/)/, 'no network assets');
  assert.match(html, /TARGETS NOT MET/);
  assert.match(html, /Not met/);
  assert.match(html, /p\(95\)&lt;500/);
  assert.match(html, /Checkout/);
  assert.match(html, /2 KB/);
  assert.match(html, /The 1 most recent of 3 records/);
  assert.match(html, /orders\.csv/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /@media print/);
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('report file names use the local start time of the run', () => {
  assert.equal(reportFileName(new Date(2026, 10, 17, 9, 5, 7), 'html'), 'k6ui-report-2026-11-17-090507.html');
  assert.match(reportFileName(null, 'json'), /^k6ui-report-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
});

test('Run & Results offers the report download once a run has finished', () => {
  const html = read('../public/index.html');
  const runner = read('../public/js/runner.js');
  const app = read('../public/js/app.js');
  assert.match(html, /id="download-report-html"[^>]*data-report-format="html"[^>]*disabled/);
  assert.match(html, /id="download-report-json"[^>]*data-report-format="json"[^>]*disabled/);
  assert.match(app, /downloadRunReport\(button\.dataset\.reportFormat\)/);
  assert.match(runner, /syncReportButtons\(running\)/);
  assert.match(runner, /lastRun = null;/);
});
