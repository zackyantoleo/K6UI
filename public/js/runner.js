// Focused run/results workspace: streams /api/run SSE into bounded, text-safe
// overview, request, metric, error, and live-log panels.
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { collectConfig, validate } from './config.js';
import { addExportRows, exportSummary, resetExports } from './export-results.js';
import { buildRunReport, reportFileName, reportToHtml } from './run-report.js';
import { raceResultText } from './race.js';
import { markOutcomeResultsStopped, renderOutcomeResults, resetOutcomeResults } from './outcome-results.js';
import { outcomeThresholdText } from './outcome-thresholds.js';
import { ariaSortOf, compareRecords, insertIndex, nextSort } from './request-sort.js';
import { curlFromRecord } from './curl-export.js';

export const MAX_REQ_LOGS = 500;
const MAX_LOG_LINES = 1500;
const LOG_FLUSH_MS = 80;

// Request records { entry, seq, row }: reqLogs in arrival order (the oldest is
// dropped past MAX_REQ_LOGS), reqRows the same records in table order (reqSort).
let reqLogs = [];
let reqRows = [];
let reqSeq = 0;
let reqSort = null;
let reqLogReceived = 0;
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
// Set by `done`: a `metrics` event after it (none should come) never replaces the final values.
let runFinished = false;
// The run the report describes: set when a run starts, null after Clear results.
let lastRun = null;
let verdictState = { status: 'idle', title: '', detail: '' };

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

// A JSON body is shown indented; anything else (or a body cut at the size cap) as it came.
function prettyBody(text) {
  const value = String(text ?? '');
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function copyButton(label, text, caption = 'Copy') {
  const button = makeElement('button', 'btn ghost sm', caption);
  button.type = 'button';
  button.setAttribute('aria-label', `Copy ${label}`);
  if (!navigator.clipboard) button.hidden = true;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = caption; }, 1500);
  });
  return button;
}

// One side of a record: "Request" (headers + payload) or "Response" (headers + body).
// `curl` (Request side of an HTTP record): a "Copy as cURL" button and its notes.
function detailSection(title, summary, headers, body, curl = null) {
  const section = makeElement('section', 'req-detail-section');
  section.setAttribute('aria-label', title);
  const head = makeElement('div', 'req-detail-head');
  head.append(makeElement('h4', '', title), makeElement('span', 'req-detail-summary', summary));
  if (curl) {
    const button = copyButton('this request as a cURL command', curl.command, 'Copy as cURL');
    button.classList.add('req-detail-curl');
    head.appendChild(button);
  }
  section.appendChild(head);
  if (curl?.notes.length) section.appendChild(makeElement('p', 'req-detail-note', curl.notes.join(' ')));

  const recorded = headers && typeof headers === 'object';
  const names = recorded ? Object.keys(headers) : [];
  section.appendChild(makeElement('h5', '', `Headers (${names.length})`));
  if (names.length) {
    const list = makeElement('dl', 'req-detail-headers');
    for (const name of names) list.append(makeElement('dt', '', name), makeElement('dd', '', headers[name]));
    section.appendChild(list);
  } else {
    section.appendChild(makeElement('p', 'req-detail-empty', recorded ? 'No headers.' : 'Not recorded.'));
  }

  const bodyHead = makeElement('div', 'req-detail-body-head');
  const bodyText = String(body ?? '');
  bodyHead.appendChild(makeElement('h5', '', 'Body'));
  if (bodyText) bodyHead.appendChild(copyButton(`${title.toLowerCase()} body`, bodyText));
  section.appendChild(bodyHead);
  const pre = makeElement('pre', 'req-detail-body', bodyText ? prettyBody(bodyText) : '(empty)');
  pre.tabIndex = 0;
  section.appendChild(pre);
  return section;
}

function renderRequestDetail(entry) {
  const detail = makeElement('div', 'req-detail');
  if (entry.er) detail.appendChild(makeElement('p', 'req-detail-error', entry.er));
  const grid = makeElement('div', 'req-detail-grid');
  grid.append(
    detailSection('Request', `${entry.m || 'request'} ${entry.url || ''}`, entry.rqh, entry.rq, curlFromRecord(entry)),
    detailSection('Response', `Status ${entry.s ?? 'unknown'} · ${entry.d ?? 0} ms`, entry.rh, entry.rb),
  );
  detail.appendChild(grid);
  return detail;
}

function renderReqLogRow(entry) {
  const row = document.createElement('tr');
  row.className = `req-log-row${entry.ok ? '' : ' req-row-err'}`;
  row.dataset.url = String(entry.url || '');
  row.dataset.ok = entry.ok ? '1' : '0';
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', 'false');
  const outcome = entry.oc == null ? '' : String(entry.oc);
  row.setAttribute('aria-label', `${entry.m || 'request'} ${entry.url || ''}, status ${entry.s ?? 'unknown'}`
    + `${outcome ? `, outcome ${outcome}` : ''}, ${entry.d ?? 0} milliseconds`);

  appendCell(row, entry.vu);
  appendCell(row, entry.it);
  appendCell(row, Number(entry.i) + 1);
  appendCell(row, entry.m, 'method-badge');
  const urlCell = appendCell(row, entry.url, 'req-url-cell');
  urlCell.title = String(entry.url || '');
  const statusCell = appendCell(row, entry.s, `status-code ${statusClass(Number(entry.s))}`);
  statusCell.setAttribute('aria-label', `HTTP status ${entry.s}`);
  appendCell(row, outcome, 'req-outcome-cell');
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
    cell.colSpan = 8;
    cell.appendChild(renderRequestDetail(entry));
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

export function syncRequestLogFields() {
  const field = $('#log-sample-every-field');
  if (field) field.hidden = $('#log-filter')?.value !== 'sample';
}

// A record's row and its open detail row move and go together.
function rowNodes(record) {
  const next = record.row.nextElementSibling;
  return next?.classList.contains('req-detail-row') ? [record.row, next] : [record.row];
}

function renderSortHeadings() {
  $$('.req-log-table th[data-sort-key]').forEach(heading => {
    const state = ariaSortOf(reqSort, heading.dataset.sortKey);
    if (state) heading.setAttribute('aria-sort', state);
    else heading.removeAttribute('aria-sort');
    heading.classList.toggle('sorted', Boolean(state));
    const mark = heading.querySelector('.req-sort-mark');
    if (mark) mark.textContent = state === 'ascending' ? '▲' : state === 'descending' ? '▼' : '';
  });
}

// Column heading clicked: ascending, then descending, then arrival order. The sort
// stays for later runs in this tab, and records that arrive later take their place in it.
export function sortRequestLog(key) {
  reqSort = nextSort(reqSort, key);
  reqRows = [...reqLogs].sort((a, b) => compareRecords(a, b, reqSort));
  const fragment = document.createDocumentFragment();
  reqRows.forEach(record => fragment.append(...rowNodes(record)));
  $('#req-log-tbody').appendChild(fragment);
  renderSortHeadings();
}

function showSkippedRequestLogs(skipped) {
  const notice = $('#req-log-skipped');
  if (!notice) return;
  const count = Number(skipped) || 0;
  notice.hidden = count === 0;
  notice.textContent = count
    ? `At least ${count} request ${count === 1 ? 'record was' : 'records were'} not shown: more than 50 a second arrived. `
      + 'Record failed requests only, or a sample, to keep the ones that matter.'
    : '';
}

function resetReqLog() {
  reqLogs = [];
  reqRows = [];
  reqSeq = 0;
  reqLogReceived = 0;
  showSkippedRequestLogs(0);
  $('#req-log-tbody').replaceChildren();
  setText('#req-log-count', '0');
  setText('#run-request-total', '0');
}

function addRequestLog(entry) {
  const record = { entry, seq: reqSeq++, row: renderReqLogRow(entry) };
  reqLogs.push(record);
  reqLogReceived += 1;
  const index = insertIndex(reqRows, record, reqSort);
  const next = reqRows[index];
  reqRows.splice(index, 0, record);
  $('#req-log-tbody').insertBefore(record.row, next ? next.row : null);
  if (reqLogs.length > MAX_REQ_LOGS) {
    const oldest = reqLogs.shift();
    reqRows.splice(reqRows.indexOf(oldest), 1);
    rowNodes(oldest).forEach(node => node.remove());
  }
  setText('#req-log-count', reqLogs.length);
  setText('#run-request-total', reqLogReceived);
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

// Race burst: how many VUs reached the race request late (the `race` of `done`).
function renderRaceResult(race) {
  const note = $('#run-race');
  const text = raceResultText(race);
  note.hidden = !text;
  note.textContent = text;
  note.classList.toggle('late', Boolean(race?.late));
}

function applySummaryMetadata(summary) {
  const totalRequests = summary?.metrics?.http_reqs?.count;
  if (totalRequests != null) setText('#run-request-total', totalRequests);
}

// A `metrics` event while k6 runs: live outcome counts and target statuses. The other
// live values (requests, response times, VUs) are not shown yet.
function showLiveMetrics(data) {
  if (runFinished) return;
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
  if (data.outcome === 'passed') {
    setVerdict({ status: 'passed', title: 'Test passed', detail: 'The run completed and all configured targets were met.', mark: '✓' });
  } else if (data.outcome === 'threshold-failed') {
    setVerdict({ status: 'threshold-failed', title: 'Targets were not met', detail: 'The run completed, but one or more k6 thresholds failed. Review Metrics and Errors.', mark: '!' });
    addError('One or more configured k6 thresholds were not met.');
    for (const target of (data.outcomeThresholds || []).filter(item => item?.status === 'not-met')) {
      addError(`Outcome target ${target.number} was not met: ${outcomeThresholdText(target)} (counted ${target.count}).`);
    }
  } else {
    const detail = `k6 exited with code ${data.code ?? 'unknown'}. Review Errors and Live Log for the failure details.`;
    setVerdict({ status: 'failed', title: 'Test failed to run', detail, mark: '×' });
    addError(detail);
  }
  if (data.race?.late) addError(raceResultText(data.race));
}

function handleSSE(event, data) {
  if (event === 'log') appendLog(data.line);
  else if (event === 'status') appendLog(`[${data.message}]\n`);
  else if (event === 'error') {
    appendLog(`\n[ERROR] ${data.message}\n`);
    addError(data.message);
    setVerdict({ status: 'failed', title: 'Test failed to run', detail: data.message, mark: '×' });
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
  $('#overview-metrics').replaceChildren();
  setText('#run-started', '—');
  setText('#run-elapsed', '—');
  setVerdict({ status: 'idle', title: 'No test has run yet', detail: 'Run your flow to see whether its targets passed.', mark: '○' });
}

export function clearResults() {
  if (abortCtrl) return;
  resetRunWorkspace();
  lastRun = null;
  syncReportButtons(false);
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
  lastRun = { config, startedAt: started, summary: null, exitCode: null };
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
        setVerdict({ status: 'failed', title: 'Test connection was interrupted', detail: 'K6UI stopped receiving results before the run completed.', mark: '×' });
      }
    } else {
      appendLog(`\n[ERROR] ${error.message}\n`);
      addError(error.message);
      setVerdict({ status: 'failed', title: 'Test failed to run', detail: error.message, mark: '×' });
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
  setVerdict({ status: 'aborted', title: 'Test stopped', detail: 'You stopped this run before it completed.', mark: '■' });
  addError('Run stopped by the user.');
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
    requests: reqLogs.map(record => record.entry),
    requestsReceived: reqLogReceived,
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
