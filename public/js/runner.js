// Focused run/results workspace: streams /api/run SSE into bounded, text-safe
// overview, request, metric, error, and live-log panels.
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { collectConfig, validate } from './config.js';

export const MAX_REQ_LOGS = 500;
const MAX_LOG_LINES = 1500;
const LOG_FLUSH_MS = 80;

let reqLogs = [];
let errors = [];
let abortCtrl = null;
let logLines = [];
let pendingLog = [];
let logTimer = null;
let logWasTrimmed = false;
let runStartedAt = null;
let elapsedTimer = null;
let lastElapsedMs = 0;
let stopRequested = false;

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = String(value);
}

function appendCell(row, value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = String(value ?? '');
  row.appendChild(cell);
  return cell;
}

function statusClass(status) {
  if (status >= 500) return 's-5xx';
  if (status >= 400) return 's-4xx';
  if (status >= 300) return 's-3xx';
  if (status >= 200) return 's-2xx';
  return 's-other';
}

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

export function setRunning(running) {
  $('#run-btn').classList.toggle('hidden', running);
  $('#stop-btn').classList.toggle('hidden', !running);
  $('#results-run-btn').disabled = running;
  $('#results-empty-run-btn').disabled = running;
  const dot = $('#nav-run-dot');
  if (running) {
    dot.className = 'run-dot running';
    dot.classList.remove('hidden');
  } else if (!dot.classList.contains('done')) {
    dot.classList.add('hidden');
  }
}

function setVerdict({ status, title, detail, mark }) {
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

function renderReqLogRow(entry) {
  const row = document.createElement('tr');
  row.className = `req-log-row${entry.ok ? '' : ' req-row-err'}`;
  row.dataset.url = String(entry.url || '');
  row.dataset.ok = entry.ok ? '1' : '0';
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', 'false');
  row.setAttribute('aria-label', `${entry.m || 'request'} ${entry.url || ''}, status ${entry.s ?? 'unknown'}, ${entry.d ?? 0} milliseconds`);

  appendCell(row, entry.vu);
  appendCell(row, entry.it);
  appendCell(row, Number(entry.i) + 1);
  appendCell(row, entry.m, 'method-badge');
  const urlCell = appendCell(row, entry.url, 'req-url-cell');
  urlCell.title = String(entry.url || '');
  const statusCell = appendCell(row, entry.s, `status-code ${statusClass(Number(entry.s))}`);
  statusCell.setAttribute('aria-label', `HTTP status ${entry.s}`);
  appendCell(row, `${entry.d} ms`);

  const toggleDetail = () => {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains('req-detail-row')) {
      existing.remove();
      row.classList.remove('expanded');
      row.setAttribute('aria-expanded', 'false');
      return;
    }
    row.classList.add('expanded');
    row.setAttribute('aria-expanded', 'true');
    const detail = document.createElement('tr');
    detail.className = 'req-detail-row';
    const cell = appendCell(detail, '');
    cell.colSpan = 7;
    const pre = document.createElement('pre');
    pre.className = 'req-detail-body';
    pre.textContent = entry.rb || '(empty response sample)';
    cell.appendChild(pre);
    row.after(detail);
  };
  row.addEventListener('click', toggleDetail);
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleDetail();
    }
  });
  return row;
}

export function applyReqFilter() {
  const errorsOnly = $('#filter-errors-only')?.checked;
  const urlTerm = ($('#filter-url')?.value || '').toLowerCase();
  $$('#req-log-tbody .req-log-row').forEach(row => {
    const visible = (!errorsOnly || row.dataset.ok !== '1')
      && (!urlTerm || (row.dataset.url || '').toLowerCase().includes(urlTerm));
    row.classList.toggle('hidden', !visible);
    const detail = row.nextElementSibling;
    if (detail?.classList.contains('req-detail-row')) detail.classList.toggle('hidden', !visible);
  });
}

function resetReqLog() {
  reqLogs = [];
  $('#req-log-tbody').replaceChildren();
  setText('#req-log-count', '0');
  setText('#run-request-total', '0');
}

function addRequestLog(entry) {
  reqLogs.push(entry);
  const tbody = $('#req-log-tbody');
  tbody.appendChild(renderReqLogRow(entry));
  if (reqLogs.length > MAX_REQ_LOGS) {
    reqLogs.shift();
    const first = tbody.querySelector('.req-log-row');
    if (first) {
      const detail = first.nextElementSibling;
      if (detail?.classList.contains('req-detail-row')) detail.remove();
      first.remove();
    }
  }
  setText('#req-log-count', reqLogs.length);
  setText('#run-request-total', reqLogs.length);
  applyReqFilter();
  if (!entry.ok) addError(`${entry.m || 'Request'} ${entry.url || ''} returned status ${entry.s}.`);
}

function resetLiveLog() {
  logLines = [];
  pendingLog = [];
  logWasTrimmed = false;
  if (logTimer) clearTimeout(logTimer);
  logTimer = null;
  $('#log-output').textContent = '';
}

function appendLog(text) {
  logLines.push(String(text));
  pendingLog.push(String(text));
  if (logLines.length > MAX_LOG_LINES) {
    logLines = logLines.slice(-MAX_LOG_LINES);
    logWasTrimmed = true;
  }
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

function flushLog() {
  logTimer = null;
  const logEl = $('#log-output');
  if (logWasTrimmed) {
    logEl.textContent = `… older lines hidden — showing the ${MAX_LOG_LINES} most recent lines …\n${logLines.join('')}`;
  } else if (pendingLog.length) {
    logEl.append(pendingLog.join(''));
  }
  pendingLog = [];
  logEl.scrollTop = logEl.scrollHeight;
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
  if (errors.length > MAX_REQ_LOGS) errors.shift();
  const list = $('#run-errors');
  if (list.children.length >= MAX_REQ_LOGS) list.firstElementChild?.remove();
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

function metricCards(summary) {
  const metrics = summary?.metrics || {};
  const requests = metrics.http_reqs;
  const duration = metrics.http_req_duration;
  const failures = metrics.http_req_failed;
  const cards = [];
  if (requests) cards.push({ label: 'Total Requests', value: requests.count ?? '—' });
  if (requests?.rate != null) cards.push({ label: 'Requests/sec', value: fmt(requests.rate, 1) });
  if (duration) {
    cards.push({ label: 'Average response', value: `${fmt(duration.avg)} ms` });
    cards.push({ label: 'p95 response', value: `${fmt(duration['p(95)'])} ms` });
    cards.push({ label: 'Slowest response', value: `${fmt(duration.max)} ms` });
  }
  if (failures?.value != null) {
    const percentage = failures.value * 100;
    cards.push({ label: 'Error rate', value: `${fmt(percentage)} %`, tone: percentage === 0 ? 'ok' : 'bad' });
  }
  if (metrics.vus_max?.value != null) cards.push({ label: 'Max VUs', value: metrics.vus_max.value });
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
  const cards = metricCards(summary);
  const detailed = $('#run-metrics');
  const overview = $('#overview-metrics');
  detailed.replaceChildren();
  overview.replaceChildren();
  cards.forEach(card => renderCard(detailed, card));
  cards.slice(0, 4).forEach(card => renderCard(overview, card));
}

function applySummaryMetadata(summary) {
  const totalRequests = summary?.metrics?.http_reqs?.count;
  if (totalRequests != null) setText('#run-request-total', totalRequests);
}

function finishRun(data) {
  stopElapsedTimer();
  flushLog();
  const dot = $('#nav-run-dot');
  dot.className = 'run-dot done';
  dot.classList.remove('hidden');
  if (data.summary) {
    renderMetrics(data.summary);
    applySummaryMetadata(data.summary);
  }
  if (data.outcome === 'passed') {
    setVerdict({ status: 'passed', title: 'Test passed', detail: 'The run completed and all configured targets were met.', mark: '✓' });
  } else if (data.outcome === 'threshold-failed') {
    setVerdict({ status: 'threshold-failed', title: 'Targets were not met', detail: 'The run completed, but one or more k6 thresholds failed. Review Metrics and Errors.', mark: '!' });
    addError('One or more configured k6 thresholds were not met.');
  } else {
    const detail = `k6 exited with code ${data.code ?? 'unknown'}. Review Errors and Live Log for the failure details.`;
    setVerdict({ status: 'failed', title: 'Test failed to run', detail, mark: '×' });
    addError(detail);
  }
}

function handleSSE(event, data) {
  if (event === 'log') appendLog(data.line);
  else if (event === 'status') appendLog(`[${data.message}]\n`);
  else if (event === 'error') {
    appendLog(`\n[ERROR] ${data.message}\n`);
    addError(data.message);
    setVerdict({ status: 'failed', title: 'Test failed to run', detail: data.message, mark: '×' });
  } else if (event === 'req-log') addRequestLog(data);
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
  $('#run-metrics').replaceChildren();
  $('#overview-metrics').replaceChildren();
  setText('#run-started', '—');
  setText('#run-elapsed', '—');
  setVerdict({ status: 'idle', title: 'No test has run yet', detail: 'Run your flow to see whether its targets passed.', mark: '○' });
}

export function clearResults() {
  if (abortCtrl) return;
  resetRunWorkspace();
  $('#results-empty-state').classList.remove('hidden');
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

  navigate('results');
  $('#results-empty-state').classList.add('hidden');
  resetRunWorkspace();
  activateResultsTab('overview');
  setVerdict({ status: 'running', title: 'Test is running', detail: 'Live results will update while k6 executes your flow.', mark: '…' });
  const started = new Date();
  setText('#run-started', started.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }));
  startElapsedTimer();
  setRunning(true);
  stopRequested = false;
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
        setVerdict({ status: 'failed', title: 'Test connection was interrupted', detail: 'K6UI stopped receiving results before the run completed.', mark: '×' });
      }
    } else {
      appendLog(`\n[ERROR] ${error.message}\n`);
      addError(error.message);
      setVerdict({ status: 'failed', title: 'Test failed to run', detail: error.message, mark: '×' });
    }
  } finally {
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
  setVerdict({ status: 'aborted', title: 'Test stopped', detail: 'You stopped this run before it completed.', mark: '■' });
  addError('Run stopped by the user.');
  setRunning(false);
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
