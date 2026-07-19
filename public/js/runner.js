// Runs the test: sends the config to POST /api/run, parses the SSE stream
// (status/log/req-log/error/done), then renders the live log, request
// detail table, and summary metric cards.
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { collectConfig, validate } from './config.js';

let reqLogs  = [];
let abortCtrl = null;

// ── UI state ───────────────────────────────────────────────────
export function setRunning(running) {
  $('#run-btn').classList.toggle('hidden',  running);
  $('#stop-btn').classList.toggle('hidden', !running);
  const dot = $('#nav-run-dot');
  if (running) {
    dot.className = 'run-dot running';
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

// ── Request log ────────────────────────────────────────────────
function statusClass(s) {
  if (s >= 500) return 's-5xx';
  if (s >= 400) return 's-4xx';
  if (s >= 300) return 's-3xx';
  if (s >= 200) return 's-2xx';
  return 's-other';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderReqLogRow(entry) {
  const tr = document.createElement('tr');
  tr.className = 'req-log-row' + (entry.ok ? '' : ' req-row-err');
  tr.dataset.url = entry.url;
  tr.dataset.ok  = entry.ok ? '1' : '0';
  tr.innerHTML = `
    <td>${entry.vu}</td>
    <td>${entry.it}</td>
    <td>${entry.i + 1}</td>
    <td><span class="method-badge">${entry.m}</span></td>
    <td class="req-url-cell" title="${entry.url}">${entry.url}</td>
    <td><span class="status-code ${statusClass(entry.s)}">${entry.s}</span></td>
    <td>${entry.d} ms</td>`;

  tr.addEventListener('click', () => {
    const existing = tr.nextElementSibling;
    if (existing?.classList.contains('req-detail-row')) {
      existing.remove(); tr.classList.remove('expanded'); return;
    }
    tr.classList.add('expanded');
    const detail = document.createElement('tr');
    detail.className = 'req-detail-row';
    detail.innerHTML = `<td colspan="7"><pre class="req-detail-body">${escHtml(entry.rb || '(empty)')}</pre></td>`;
    tr.after(detail);
  });

  return tr;
}

export function applyReqFilter() {
  const errOnly = $('#filter-errors-only')?.checked;
  const urlTerm = ($('#filter-url')?.value || '').toLowerCase();
  $$('#req-log-tbody .req-log-row').forEach(tr => {
    const ok   = tr.dataset.ok === '1';
    const url  = (tr.dataset.url || '').toLowerCase();
    const show = (!errOnly || !ok) && (!urlTerm || url.includes(urlTerm));
    tr.classList.toggle('hidden', !show);
    const next = tr.nextElementSibling;
    if (next?.classList.contains('req-detail-row')) next.classList.toggle('hidden', !show);
  });
}

function resetReqLog() {
  reqLogs = [];
  $('#req-log-tbody').innerHTML = '';
  $('#req-log-count').textContent = '0';
}

// ── Live log (buffered + capped) ───────────────────────────────
// Appending every SSE line straight to textContent re-serializes the whole
// log, getting quadratically slower as it grows — a script that errors on
// each iteration could freeze the tab. Lines are buffered and flushed on a
// short timer, and only the newest MAX_LOG_LINES lines are kept.
const MAX_LOG_LINES  = 1500;
const LOG_TRIM_SLACK = 500;  // rebuild the DOM only once per this many extra lines
const LOG_FLUSH_MS   = 80;

let logLines   = [];   // capped history for the current run
let pendingLog = [];   // lines received since the last flush
let logTimer   = null;

function resetLiveLog() {
  logLines = []; pendingLog = [];
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  $('#log-output').textContent = '';
}

function appendLog(text) {
  logLines.push(text);
  pendingLog.push(text);
  if (!logTimer) logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
}

function flushLog() {
  logTimer = null;
  const logEl = $('#log-output');
  if (logLines.length > MAX_LOG_LINES + LOG_TRIM_SLACK) {
    logLines = logLines.slice(-MAX_LOG_LINES);
    logEl.textContent = `… older lines hidden — showing the most recent ones …\n` + logLines.join('');
  } else if (pendingLog.length) {
    logEl.append(pendingLog.join(''));
  }
  pendingLog = [];
  logEl.scrollTop = logEl.scrollHeight;
}

// ── SSE handler ────────────────────────────────────────────────
function handleSSE(event, data) {
  const stateEl = $('#run-state');
  const dot     = $('#nav-run-dot');

  if (event === 'log') {
    appendLog(data.line);
  } else if (event === 'status') {
    appendLog(`[${data.message}]\n`);
  } else if (event === 'error') {
    appendLog(`\n[ERROR] ${data.message}\n`);
    stateEl.textContent = 'FAILED'; stateEl.className = 'run-state-badge fail';
  } else if (event === 'req-log') {
    reqLogs.push(data);
    $('#req-log-count').textContent = reqLogs.length;
    const row = renderReqLogRow(data);
    const errOnly = $('#filter-errors-only')?.checked;
    const urlTerm = ($('#filter-url')?.value || '').toLowerCase();
    if ((errOnly && data.ok) || (urlTerm && !data.url.toLowerCase().includes(urlTerm))) {
      row.classList.add('hidden');
    }
    $('#req-log-tbody').appendChild(row);
  } else if (event === 'done') {
    const ok = data.code === 0;
    stateEl.textContent = ok ? 'DONE ✓' : 'THRESHOLDS NOT MET';
    stateEl.className   = 'run-state-badge ' + (ok ? 'ok' : 'fail');
    dot.className = 'run-dot done'; dot.classList.remove('hidden');
    if (data.summary) renderMetrics(data.summary);
  }
}

// ── Metrics ────────────────────────────────────────────────────
function fmt(n, d = 2) {
  return n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d);
}

function renderMetrics(summary) {
  const m     = summary.metrics || {};
  const cards = [];
  const reqs  = m.http_reqs;
  const dur   = m.http_req_duration;
  const fail  = m.http_req_failed;

  if (reqs)       cards.push({ label: 'Total Requests', val: reqs.count ?? '-' });
  if (reqs?.rate) cards.push({ label: 'Requests/sec', val: fmt(reqs.rate, 1) });
  if (dur) {
    cards.push({ label: 'Avg response',  val: fmt(dur.avg)       + ' ms' });
    cards.push({ label: 'p95 response',  val: fmt(dur['p(95)'])  + ' ms' });
    cards.push({ label: 'Max response',  val: fmt(dur.max)       + ' ms' });
  }
  if (fail?.value != null) {
    const pct = fail.value * 100;
    cards.push({ label: 'Error rate', val: fmt(pct, 2) + ' %', good: pct === 0 });
  }
  if (m.vus_max?.value != null) cards.push({ label: 'Max VUs', val: m.vus_max.value });

  const el = $('#run-metrics');
  el.innerHTML = cards.map(c => `
    <div class="metric-card">
      <div class="mc-label">${c.label}</div>
      <div class="mc-value ${c.good === true ? 'ok' : c.good === false ? 'bad' : ''}">${c.val}</div>
    </div>`).join('');
  el.classList.remove('hidden');
}

// ── Run test ───────────────────────────────────────────────────
export async function runTest() {
  const config = collectConfig();
  const err    = validate(config);
  if (err) { alert(err); return; }

  navigate('results');
  const stateEl = $('#run-state');

  resetLiveLog();
  $('#run-metrics').classList.add('hidden');
  $('#run-metrics').innerHTML = '';
  stateEl.textContent = 'RUNNING';
  stateEl.className   = 'run-state-badge running';
  resetReqLog();
  $$('.results-tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'live'));
  $('#tab-live').classList.remove('hidden');
  $('#tab-requests').classList.add('hidden');
  setRunning(true);

  abortCtrl = new AbortController();

  try {
    const res = await fetch('/api/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(config),
      signal:  abortCtrl.signal,
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Server error ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const raw of chunks) {
        if (!raw.trim()) continue;
        const em = raw.match(/^event: (.+)$/m);
        const dm = raw.match(/^data: (.+)$/m);
        if (dm) handleSSE(em ? em[1] : 'message', JSON.parse(dm[1]));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      appendLog(`\n[ERROR] ${e.message}\n`);
      stateEl.textContent = 'FAILED';
      stateEl.className   = 'run-state-badge fail';
    }
  } finally {
    setRunning(false);
    abortCtrl = null;
  }
}

export function stopTest() {
  if (abortCtrl) abortCtrl.abort();
  $('#run-state').textContent = 'STOPPED';
  $('#run-state').className   = 'run-state-badge fail';
  setRunning(false);
}

// ── k6 status ──────────────────────────────────────────────────
export async function checkK6() {
  const el = $('#k6-status');
  try {
    const { installed } = await (await fetch('/api/k6-status')).json();
    el.textContent = installed ? 'k6 installed ✓' : 'k6 not installed';
    el.className   = 'k6-pill ' + (installed ? 'ok' : 'bad');
  } catch {
    el.textContent = 'k6 not installed';
    el.className   = 'k6-pill bad';
  }
}
