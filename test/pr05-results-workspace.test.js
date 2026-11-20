import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readStyles } from './helpers/styles.js';
import { runnerSource } from './helpers/runner-source.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/js/app.js');
const runner = runnerSource();
const k6Runner = read('../server/k6-runner.js');
const requestLogHelpers = read('../server/generator/request-log.js');
const requestGenerator = read('../server/generator/request.js');
const grpcGenerator = read('../server/generator/grpc-request.js');
const css = readStyles();

test('results workspace separates overview, requests, errors, and raw k6 output (metrics folded into the overview)', () => {
  for (const tab of ['overview', 'requests', 'errors', 'live']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(html, new RegExp(`id="tab-${tab}"`));
  }
  assert.doesNotMatch(html, /data-tab="metrics"|id="tab-metrics"/);
  assert.match(html, /data-tab="live">Raw k6 output</);
  assert.match(html, /<details id="run-all-metrics"[^>]*>\s*<summary>All k6 metrics<\/summary>\s*<div id="run-metrics"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-controls="tab-overview"/);
  assert.match(app, /activateResultsTab/);
  assert.match(app, /ArrowLeft|ArrowRight/);
});

test('overview leads with a plain-language verdict and explicit run metadata', () => {
  assert.match(html, /id="run-verdict"[^>]*role="status"/);
  assert.match(html, /id="run-verdict-title"/);
  assert.match(html, /id="run-verdict-detail"/);
  for (const id of ['run-started', 'run-elapsed', 'run-request-total', 'run-error-total']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(runner, /verdictText\(/);
  assert.match(runner, /renderReading\('aborted'\)/);
});

test('results provide clear and filter controls with bounded request and live-log retention', () => {
  assert.match(html, /id="clear-results"/);
  assert.match(html, /id="clear-live-log"/);
  assert.match(html, /id="filter-errors-only"/);
  assert.match(html, /id="filter-url"/);
  assert.match(runner, /MAX_REQ_LOGS = MAX_REQUEST_RECORDS/);
  assert.match(read('../public/js/shared/request-log.js'), /MAX_REQUEST_RECORDS = 500/);
  assert.match(runner, /MAX_LOG_LINES\s*=\s*1500/);
  assert.match(runner, /reqLogs\.shift\(\)/);
});

test('request result rows and metrics are built with text-safe DOM APIs', () => {
  assert.doesNotMatch(runner, /tr\.innerHTML\s*=/);
  assert.doesNotMatch(runner, /run-metrics[^\n]*innerHTML/);
  assert.match(runner, /textContent/);
  assert.match(runner, /createElement\(['"]td['"]\)/);
  assert.match(html, /<table[^>]*aria-label="Recorded request results"/);
  assert.match(html, /<caption/);
});

test('request logging is opt-in and warns that response samples may contain sensitive data', () => {
  assert.match(html, /id="log-requests"(?![^>]*checked)/);
  assert.match(html, /response samples may contain sensitive data/i);
  assert.match(requestGenerator, /logHttpRequest\(/);
  assert.match(grpcGenerator, /logGrpcRequest\(/);
  assert.match(requestLogHelpers, /rq: redactResponseSample\(request\.body/);
  assert.match(requestLogHelpers, /rb: redactResponseSample\(res\.body/);
  assert.match(requestLogHelpers, /authorization|token|password/i);
});

test('run lifecycle distinguishes failed, threshold-failed, and aborted states', () => {
  assert.match(runner, /data\.outcome === 'passed' \|\| data\.outcome === 'threshold-failed' \? data\.outcome : 'failed'/);
  assert.match(runner, /status:\s*'failed'/);
  assert.match(runner, /status:\s*'aborted'/);
  assert.match(k6Runner, /code === 99 \? "threshold-failed"/);
  assert.match(runner, /setInterval/);
  assert.match(runner, /performance\.now/);
});

test('completed-run metadata uses k6 summary totals instead of the optional request log count', () => {
  assert.match(runner, /summary\?\.metrics\?\.http_reqs\?\.count/);
  assert.match(runner, /setText\('#run-request-total'/);
});

test('live-log memory retention never exceeds the advertised cap', () => {
  assert.doesNotMatch(runner, /MAX_LOG_LINES\s*\+/);
  assert.match(runner, /logLines\.length > MAX_LOG_LINES/);
  assert.match(runner, /logLines = logLines\.slice\(-MAX_LOG_LINES\)/);
});

test('request logging redacts sensitive values from URLs as well as response samples', () => {
  assert.equal(requestLogHelpers.match(/url: redactRequestUrl\(/g)?.length, 2, 'HTTP and gRPC request logs');
  assert.match(requestLogHelpers, /decodeURIComponent/);
});

test('expanded request editor gives the endpoint a full-width row', () => {
  // Same open-card head in both UI modes: the URL owns its row (after the
  // one method list — HTTP methods + gRPC — and before "Send once" on wide screens,
  // alone on phones). Browser width check: scripts/verify-ui-modes.mjs ("URL field squeezed").
  assert.match(css, /#reqs-main > \.req-card\.expanded \.req-card-head\s*\{[^}]*display:\s*grid/s);
  const head = /#reqs-main > \.req-card\.expanded \.req-card-head\s*\{[^}]*grid-template-areas:([^}]*)\}/gs;
  const layouts = [...css.matchAll(head)].map(match => match[1]);
  assert.ok(layouts.some(areas => /"kind url send send"/.test(areas)), 'wide: URL between the method list and Send once');
  assert.ok(layouts.some(areas => /"url url" "send send"/.test(areas)), 'narrow: Send once on its own row under the URL');
  assert.ok(layouts.some(areas => /"url url"/.test(areas)), 'narrow: URL alone on a full row');
  assert.match(css, /#reqs-main > \.req-card\.expanded \.req-card-head \.url\s*\{[^}]*grid-area:\s*url;[^}]*width:\s*100%/s);
  assert.doesNotMatch(css, /html\[data-ui-mode="advanced"\] #reqs-main > \.req-card\.expanded \.req-card-head\s*\{[^}]*grid-template/s,
    'the layout is not Advanced-only');
});
