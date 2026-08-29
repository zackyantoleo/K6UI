import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/js/app.js');
const runner = read('../public/js/runner.js');
const k6Runner = read('../server/k6-runner.js');
const generator = read('../server/generator/index.js');
const requestGenerator = read('../server/generator/request.js');
const grpcGenerator = read('../server/generator/grpc-request.js');

test('results workspace separates overview, requests, metrics, errors, and optional live log', () => {
  for (const tab of ['overview', 'requests', 'metrics', 'errors', 'live']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(html, new RegExp(`id="tab-${tab}"`));
  }
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
  assert.match(runner, /Test passed/i);
  assert.match(runner, /Targets were not met/i);
  assert.match(runner, /Test stopped/i);
});

test('results provide clear and filter controls with bounded request and live-log retention', () => {
  assert.match(html, /id="clear-results"/);
  assert.match(html, /id="clear-live-log"/);
  assert.match(html, /id="filter-errors-only"/);
  assert.match(html, /id="filter-url"/);
  assert.match(runner, /MAX_REQ_LOGS\s*=\s*500/);
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
  assert.match(requestGenerator, /redactResponseSample/);
  assert.match(grpcGenerator, /redactResponseSample/);
  assert.match(generator, /authorization|token|password/i);
});

test('run lifecycle distinguishes failed, threshold-failed, and aborted states', () => {
  assert.match(runner, /status:\s*'threshold-failed'/);
  assert.match(runner, /status:\s*'failed'/);
  assert.match(runner, /status:\s*'aborted'/);
  assert.match(runner, /data\.outcome === 'passed'/);
  assert.match(runner, /data\.outcome === 'threshold-failed'/);
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
  assert.match(requestGenerator, /url:redactRequestUrl\(String\(/);
  assert.match(grpcGenerator, /url:redactRequestUrl\(String\(/);
  assert.match(generator, /decodeURIComponent/);
});
