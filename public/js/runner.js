// Focused run/results workspace: streams /api/run SSE into bounded, text-safe
// overview (verdict sentence, key figures compared with the goals, each request,
// what to do next, all k6 metrics), request, error, and raw k6 output panels.
import { $, $$, setText } from './dom.js';
import {
  addRequestRecord, receivedRequestCount, requestRecords, resetReqLog, showSkippedRequestLogs,
} from './request-table.js';
import { appendLog, flushLog, resetLiveLog } from './live-log.js';
import { navigate } from './nav.js';
import { collectConfig, validate } from './config.js';
import { addExportRows, exportSummary, resetExports } from './export-results.js';
import { buildRunReport, reportFileName, reportToHtml } from './run-report.js';
import { raceErrors } from './shared/race.js';
import { renderRaceResult } from './race-results.js';
import { markOutcomeResultsStopped, renderOutcomeResults, resetOutcomeResults } from './outcome-results.js';
import { outcomeThresholdText } from './shared/outcome-thresholds.js';
import { summaryChecks } from './run-report.js';
import { thresholdRequests } from './shared/outcome-thresholds.js';
import { chosenGoal } from './components/load-chart.js';
import { goalResults, metricCards, nextSteps, perRequestRows, runFigures, verdictText } from './run-summary.js';
import { renderNextSteps, renderPerRequest, renderResultCards, resetOverview } from './result-overview.js';
import { renderRunCheck, runAction } from './components/run-check.js';

// The Errors tab keeps this many entries (the most recent).
const MAX_ERRORS = 500;

let errors = [];
let abortCtrl = null;
let runStartedAt = null;
let elapsedTimer = null;
let lastElapsedMs = 0;
let stopRequested = false;
// Set by `done`: a `metrics` event after it (none should come) never replaces the final values.
let runFinished = false;
// The latest live `metrics` event: the figures of a run that was stopped before `done`.
let lastLiveMetrics = null;
// The run the report describes: set when a run starts, null after Clear results.
let lastRun = null;
let verdictState = { status: 'idle', title: '', detail: '' };

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function tickElapsed() {
  if (!runStartedAt) return;
  lastElapsedMs = performance.now() - runStartedAt;
  setText('#run-elapsed', formatElapsed(lastElapsedMs));
}

function startElapsedTimer() {
  stopElapsedTimer();
  runStartedAt = performance.now();
  lastElapsedMs = 0;
  tickElapsed();
  elapsedTimer = setInterval(tickElapsed, 250);
}

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  tickElapsed();
}

// A run is in progress (its stream is open): leaving the page now would stop it.
export const isTestRunning = () => Boolean(abortCtrl);

export function setRunning(running) {
  $('#run-btn').classList.toggle('hidden', running);
  $('#stop-btn').classList.toggle('hidden', !running);
  $('#results-run-btn').disabled = running;
  $('#prerun-run-btn').disabled = running;
  // "New" reloads the page, which would stop the run.
  const newProject = $('#new-project-btn');
  if (newProject) newProject.disabled = running;
  syncReportButtons(running);
  const dot = $('#nav-run-dot');
  if (running) {
    dot.className = 'run-dot running';
    dot.classList.remove('hidden');
  } else if (!dot.classList.contains('done')) {
    dot.classList.add('hidden');
  }
}

function setVerdict({ status, title, detail, mark }) {
  verdictState = { status, title, detail };
  const verdict = $('#run-verdict');
  verdict.className = `run-verdict ${status}`;
  setText('#run-verdict-title', title);
  setText('#run-verdict-detail', detail);
  setText('#run-verdict .verdict-mark', mark);
  const stateLabel = {
    idle: '', running: 'RUNNING', passed: 'PASSED',
    'threshold-failed': 'TARGETS NOT MET', failed: 'FAILED', aborted: 'STOPPED',
  }[status] ?? status.toUpperCase();
  setText('#run-state', stateLabel);
  $('#run-state').className = `run-state-badge ${status}`;
}

export function activateResultsTab(tabId, { focus = false } = {}) {
  const tabs = $$('.results-tab[data-tab]');
  const target = tabs.find(tab => tab.dataset.tab === tabId) || tabs[0];
  if (!target) return;
  tabs.forEach(tab => {
    const active = tab === target;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`#tab-${tab.dataset.tab}`).classList.toggle('hidden', !active);
  });
  if (focus) target.focus();
}

function addRequestLog(entry) {
  addRequestRecord(entry);
  if (!entry.ok) addError(`${entry.m || 'Request'} ${entry.url || ''} returned status ${entry.s}.`);
}

function resetErrors() {
  errors = [];
  $('#run-errors').replaceChildren();
  setText('#error-count', '0');
  setText('#run-error-total', '0');
  $('#errors-empty').classList.remove('hidden');
}

function addError(message) {
  const text = String(message || 'Unknown error');
  errors.push(text);
  if (errors.length > MAX_ERRORS) errors.shift();
  const list = $('#run-errors');
  if (list.children.length >= MAX_ERRORS) list.firstElementChild?.remove();
  const item = document.createElement('li');
  item.textContent = text;
  list.appendChild(item);
  setText('#error-count', errors.length);
  setText('#run-error-total', errors.length);
  $('#errors-empty').classList.add('hidden');
}

function fmt(value, digits = 2) {
  return value == null || Number.isNaN(Number(value)) ? '—' : Number(value).toFixed(digits);
}

// "All k6 metrics" (folded under the Overview): k6's own figures with k6's names.
function allMetricCards(summary) {
  const metrics = summary?.metrics || {};
  const requests = metrics.http_reqs;
  const duration = metrics.http_req_duration;
  const failures = metrics.http_req_failed;
  const cards = [];
  if (requests) cards.push({ label: 'Total Requests (http_reqs)', value: requests.count ?? '—' });
  if (requests?.rate != null) cards.push({ label: 'Requests/sec (http_reqs rate)', value: fmt(requests.rate, 1) });
  if (duration) {
    cards.push({ label: 'Fastest response (min)', value: `${fmt(duration.min)} ms` });
    cards.push({ label: 'Median response (med)', value: `${fmt(duration.med)} ms` });
    cards.push({ label: 'Average response (avg)', value: `${fmt(duration.avg)} ms` });
    cards.push({ label: 'p90 response', value: `${fmt(duration['p(90)'])} ms` });
    cards.push({ label: 'p95 response', value: `${fmt(duration['p(95)'])} ms` });
    cards.push({ label: 'Slowest response (max)', value: `${fmt(duration.max)} ms` });
  }
  if (failures?.value != null) {
    const percentage = failures.value * 100;
    cards.push({ label: 'Error rate (http_req_failed)', value: `${fmt(percentage)} %`, tone: percentage === 0 ? 'ok' : 'bad' });
  }
  if (metrics.iterations?.count != null) cards.push({ label: 'Iterations', value: metrics.iterations.count });
  if (metrics.vus_max?.value != null) cards.push({ label: 'Max VUs (vus_max)', value: metrics.vus_max.value });
  return cards;
}

function renderCard(container, card) {
  const element = document.createElement('div');
  element.className = 'metric-card';
  const label = document.createElement('div');
  label.className = 'mc-label';
  label.textContent = card.label;
  const value = document.createElement('div');
  value.className = `mc-value${card.tone ? ` ${card.tone}` : ''}`;
  value.textContent = String(card.value);
  element.append(label, value);
  container.appendChild(element);
}

function renderMetrics(summary) {
  const cards = allMetricCards(summary);
  const detailed = $('#run-metrics');
  detailed.replaceChildren();
  cards.forEach(card => renderCard(detailed, card));
  $('#run-all-metrics').hidden = !cards.length;
}

// The key figures as cards, compared with the run's goals (live: the figures so far).
function renderFigures({ summary = null, live = null } = {}) {
  const figures = runFigures({ summary, live });
  const goals = goalResults({ thresholds: lastRun?.config?.thresholds, summary, figures });
  renderResultCards(metricCards({ figures, goals, live: Boolean(live) }));
  return { figures, goals };
}

// Results tab buttons in "What to do next"; the rest is shared with "Before you run".
function nextStepAction(action) {
  if (action.kind === 'tab') activateResultsTab(action.value, { focus: true });
  else runAction(action);
}

// The overview after `done` or a stop: verdict sentence, cards, each request and what
// to do next. `status` = the run state. Returns the verdict's { title, detail }.
function renderReading(status, { summary = null, code = null, targets = [] } = {}) {
  const { figures, goals } = renderFigures(summary ? { summary } : { live: lastLiveMetrics });
  const config = lastRun?.config || {};
  const records = requestRecords();
  const perRequest = perRequestRows({ requests: thresholdRequests(config), checks: summaryChecks(summary), records });
  const recorded = config.options?.logRequests === true;
  const filter = String(config.options?.logFilter || 'all');
  const hints = ['Sent and failed come from the status check of each request (— when it is off).'];
  if (perRequest.timed) {
    hints.push(`Times come from the ${receivedRequestCount().toLocaleString('en-US')} recorded requests`
      + `${filter === 'errors' ? ', failed ones only' : filter === 'sample' ? ', a sample' : ''}, not every request.`);
  } else hints.push('Turn on "Record request details" before the next run to see the time of each request.');
  renderPerRequest(summary || records.length ? perRequest : null, hints.join(' '));
  const failedRequests = perRequest.rows.filter(row => row.failed > 0).sort((a, b) => b.failed - a.failed);
  renderNextSteps(nextSteps({
    status, goals, figures, perRequest, goal: lastRun?.goal, recorded, errors: errors.length, failedRequests,
  }), nextStepAction);
  return verdictText({
    status, goals, targets, figures, code, race: config.load?.mode === 'race',
    durationText: lastElapsedMs >= 1000 ? formatElapsed(lastElapsedMs) : '',
  });
}

function applySummaryMetadata(summary) {
  const totalRequests = summary?.metrics?.http_reqs?.count;
  if (totalRequests != null) setText('#run-request-total', totalRequests);
}

// A `metrics` event while k6 runs: live outcome counts and target statuses. The other
// live values (requests, response times, VUs) are not shown yet.
function showLiveMetrics(data) {
  if (runFinished) return;
  lastLiveMetrics = data;
  renderFigures({ live: data });
  const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
  const targets = Array.isArray(data?.outcomeThresholds) ? data.outcomeThresholds : [];
  if (outcomes.length || targets.length) renderOutcomeResults(outcomes, targets, { live: true });
}

function finishRun(data) {
  runFinished = true;
  stopElapsedTimer();
  flushLog();
  const dot = $('#nav-run-dot');
  dot.className = 'run-dot done';
  dot.classList.remove('hidden');
  if (lastRun) {
    lastRun.summary = data.summary || null;
    lastRun.exitCode = data.code ?? null;
    lastRun.outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
    lastRun.outcomeThresholds = Array.isArray(data.outcomeThresholds) ? data.outcomeThresholds : [];
    lastRun.race = data.race || null;
  }
  renderOutcomeResults(data.outcomes, data.outcomeThresholds);
  renderRaceResult(data.race);
  if (data.summary) {
    renderMetrics(data.summary);
    applySummaryMetadata(data.summary);
  }
  const targets = Array.isArray(data.outcomeThresholds) ? data.outcomeThresholds : [];
  if (data.outcome === 'threshold-failed') {
    addError('One or more pass/fail goals were not met.');
    for (const target of targets.filter(item => item?.status === 'not-met')) {
      addError(`Outcome target ${target.number} was not met: ${outcomeThresholdText(target)} (counted ${target.count}).`);
    }
  } else if (data.outcome !== 'passed') {
    addError(`k6 exited with code ${data.code ?? 'unknown'}. See Raw k6 output for its message.`);
  }
  for (const message of raceErrors(data.race)) addError(message);
  const status = data.outcome === 'passed' || data.outcome === 'threshold-failed' ? data.outcome : 'failed';
  const words = renderReading(status, { summary: data.summary || null, code: data.code ?? null, targets });
  const mark = { passed: '✓', 'threshold-failed': '!', failed: '×' }[status];
  setVerdict({ status, ...words, mark });
}

function handleSSE(event, data) {
  if (event === 'log') appendLog(data.line);
  else if (event === 'status') appendLog(`[${data.message}]\n`);
  else if (event === 'error') {
    appendLog(`\n[ERROR] ${data.message}\n`);
    addError(data.message);
    setVerdict({ status: 'failed', title: 'The test could not run', detail: data.message, mark: '×' });
  } else if (event === 'req-log') addRequestLog(data);
  else if (event === 'req-log-skipped') showSkippedRequestLogs(data.skipped);
  else if (event === 'export') addExportRows(data);
  else if (event === 'metrics') showLiveMetrics(data);
  else if (event === 'done') finishRun(data);
}

function parseSSEChunk(raw) {
  if (!raw.trim()) return;
  const eventMatch = raw.match(/^event: (.+)$/m);
  const dataLines = [...raw.matchAll(/^data: ?(.*)$/gm)].map(match => match[1]);
  if (!dataLines.length) return;
  handleSSE(eventMatch?.[1] || 'message', JSON.parse(dataLines.join('\n')));
}

function resetRunWorkspace() {
  stopElapsedTimer();
  resetReqLog();
  resetLiveLog();
  resetErrors();
  resetExports();
  resetOutcomeResults();
  renderRaceResult(null);
  $('#run-metrics').replaceChildren();
  resetOverview();
  lastLiveMetrics = null;
  setText('#run-started', '—');
  setText('#run-elapsed', '—');
  setVerdict({ status: 'idle', title: 'No test has run yet', detail: 'Look through the checks above, then run the test.', mark: '○' });
}

export function clearResults() {
  if (abortCtrl) return;
  resetRunWorkspace();
  lastRun = null;
  syncReportButtons(false);
  $('#prerun').open = true;
  renderRunCheck();
  activateResultsTab('overview');
  const dot = $('#nav-run-dot');
  dot.classList.add('hidden');
  dot.className = 'run-dot';
}

export function clearLiveLog() {
  resetLiveLog();
}

export function clearErrors() {
  resetErrors();
}

export async function runTest() {
  const config = collectConfig();
  const validationError = validate(config);
  if (validationError) {
    alert(validationError);
    return;
  }

  const goal = chosenGoal();
  navigate('results');
  resetRunWorkspace();
  $('#prerun').open = false;
  activateResultsTab('overview');
  setVerdict({ status: 'running', ...verdictText({ status: 'running' }), mark: '…' });
  const started = new Date();
  lastRun = { config, goal, startedAt: started, summary: null, exitCode: null };
  setText('#run-started', started.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }));
  startElapsedTimer();
  setRunning(true);
  stopRequested = false;
  runFinished = false;
  abortCtrl = new AbortController();

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: abortCtrl.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Server error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || '';
      chunks.forEach(parseSSEChunk);
      if (done) {
        parseSSEChunk(buffer);
        break;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!stopRequested) {
        addError('The connection to the running test was interrupted.');
        setVerdict({ status: 'failed', title: 'The connection to the test was lost', detail: 'K6UI stopped receiving results before the run completed.', mark: '×' });
      }
    } else {
      appendLog(`\n[ERROR] ${error.message}\n`);
      addError(error.message);
      setVerdict({ status: 'failed', title: 'The test could not run', detail: error.message, mark: '×' });
    }
  } finally {
    // Stopped, interrupted, or a stream that ended without `done`: live counts stay, marked as such.
    if (!runFinished) markOutcomeResultsStopped();
    stopElapsedTimer();
    setRunning(false);
    abortCtrl = null;
  }
}

export function stopTest() {
  if (!abortCtrl) return;
  stopRequested = true;
  abortCtrl.abort();
  stopElapsedTimer();
  addError('Run stopped by the user.');
  setVerdict({ status: 'aborted', ...renderReading('aborted'), mark: '■' });
  setRunning(false);
}

// ── Run report ─────────────────────────────────────────────────
// Available once a run has started and is no longer running (a stopped run too).
function syncReportButtons(running = Boolean(abortCtrl)) {
  const unavailable = running || !lastRun;
  $$('[data-report-format]').forEach(button => { button.disabled = unavailable; });
}

export function runReport(now = new Date()) {
  if (!lastRun) return null;
  return buildRunReport({
    ...lastRun,
    verdict: verdictState,
    elapsedMs: lastElapsedMs,
    errors,
    requests: requestRecords(),
    requestsReceived: receivedRequestCount(),
    exports: exportSummary(),
  }, now);
}

export function downloadRunReport(format) {
  const report = runReport();
  if (!report) return;
  const html = format !== 'json';
  const blob = html
    ? new Blob([reportToHtml(report)], { type: 'text/html;charset=utf-8' })
    : new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = reportFileName(lastRun.startedAt, html ? 'html' : 'json');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function checkK6() {
  const element = $('#k6-status');
  try {
    const { installed } = await (await fetch('/api/k6-status')).json();
    element.textContent = installed ? 'k6 installed ✓' : 'k6 not installed';
    element.className = `k6-pill ${installed ? 'ok' : 'bad'}`;
  } catch {
    element.textContent = 'k6 not installed';
    element.className = 'k6-pill bad';
  }
}
