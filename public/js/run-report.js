// Run & Results "Download report": one run of this tab as a file to keep or share.
// buildRunReport() turns the runner's state into a plain JSON object (format
// "k6ui-run-report", version 1); reportToHtml() renders that object as one
// self-contained HTML page (inline styles, no scripts, no network assets, prints
// well). Pure, no DOM: runner.js gathers the state and starts the download.
//
// Each request record keeps its payload and response (headers and bodies, as
// recorded: redacted only when "Hide secrets" was on), so a report can hold
// secrets. Left out: global variables (except the number an outcome target written
// as {{variable}} stood for), the flow's own headers and bodies, data file rows,
// Save to CSV values, and the raw k6 output.
import { loadShape } from './components/load-chart.js';
import { OUTCOME_METRIC, outcomeMetricKey } from './shared/outcomes.js';
import { THRESHOLD_VARIABLE, requestTitle } from './shared/outcome-thresholds.js';
import { DEFAULT_EXPECTED_STATUSES, normalizeExpectedStatuses } from './shared/expected-statuses.js';
import { RACE_RECORD_COLUMNS, raceFigures, raceRecordCells, raceResultText, raceResultWarns } from './shared/race.js';
import { raceGantt } from './race-gantt.js';
import { curlFromRecord } from './curl-export.js';

export const REPORT_FORMAT = 'k6ui-run-report';
export const REPORT_VERSION = 1;

const STATUS_LABELS = {
  idle: 'Not run', running: 'Running', passed: 'Passed',
  'threshold-failed': 'Targets not met', failed: 'Failed', aborted: 'Stopped',
};

const TREND_KEYS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// k6 --summary-export metric → its kind, from the keys it carries.
export function metricKind(values) {
  if (!isObject(values)) return 'other';
  if ('avg' in values || 'med' in values) return 'trend';
  if ('passes' in values || 'fails' in values) return 'rate';
  if ('count' in values) return 'counter';
  if ('value' in values) return 'gauge';
  return 'other';
}

// Trend metrics that k6 reports in milliseconds.
function isTimeMetric(name) {
  return /(^|_)duration$|^http_req_|^grpc_req_duration|^iteration_duration$|^group_duration$/.test(name);
}

export function summaryMetrics(summary) {
  const metrics = isObject(summary?.metrics) ? summary.metrics : {};
  return Object.keys(metrics).sort().map(name => {
    const values = metrics[name];
    const kind = metricKind(values);
    const clean = {};
    for (const [key, value] of Object.entries(isObject(values) ? values : {})) {
      if (key !== 'thresholds' && numberOrNull(value) != null) clean[key] = value;
    }
    return { name, kind, unit: kind === 'trend' && isTimeMetric(name) ? 'ms' : '', values: clean };
  });
}

// In a k6 summary export a threshold maps to `true` when it FAILED (was crossed).
export function summaryThresholds(summary) {
  const metrics = isObject(summary?.metrics) ? summary.metrics : {};
  const rows = [];
  for (const name of Object.keys(metrics).sort()) {
    const thresholds = metrics[name]?.thresholds;
    if (!isObject(thresholds)) continue;
    for (const [rule, failed] of Object.entries(thresholds)) {
      if (isOutcomeCountThreshold(name, rule)) continue;
      rows.push({ metric: name, rule, ok: failed !== true });
    }
  }
  return rows;
}

// Outcome rules give every label a threshold that always passes, only so k6 reports
// its count (server/generator/outcomes.js): not a target, so not listed.
const isOutcomeCountThreshold = (name, rule) => name.startsWith(`${OUTCOME_METRIC}{`) && /^count\s*>=\s*0$/.test(rule);

const TARGET_OK = { met: true, 'not-met': false };

// The Targets table: the summary's thresholds, where the run's outcome targets (the
// `outcomeThresholds` of `done`, see outcome-thresholds.js readOutcomeThresholdResults)
// replace the raw k6ui_outcome rows with one row each, as typed, with what the label
// counted; a target whose request did not run is listed as not checked (ok: null).
export function reportThresholds(summary, outcomeThresholds) {
  const targets = Array.isArray(outcomeThresholds) ? outcomeThresholds.filter(isObject) : [];
  if (!targets.length) return summaryThresholds(summary);
  const rows = summaryThresholds(summary).filter(row => !row.metric.startsWith(`${OUTCOME_METRIC}{`));
  for (const target of targets) {
    const status = String(target.status || 'unknown');
    const rq = numberOrNull(target.rq);
    rows.push({
      metric: rq && !target.skipped ? outcomeMetricKey(rq, String(target.label ?? '')) : '',
      rule: String(target.expression ?? ''),
      ok: Object.hasOwn(TARGET_OK, status) ? TARGET_OK[status] : null,
      outcome: {
        number: numberOrNull(target.number),
        request: rq,
        name: String(target.name ?? ''),
        method: String(target.method ?? ''),
        url: String(target.url ?? ''),
        label: String(target.label ?? ''),
        op: String(target.op ?? ''),
        value: String(target.value ?? ''),
        resolved: numberOrNull(target.resolved),
        count: numberOrNull(target.count),
        status,
        skipped: String(target.skipped ?? ''),
      },
    });
  }
  return rows;
}

// Requests with outcome rules: what each label counted (the `outcomes` of the run's
// `done` event, see outcomes.js readOutcomeResults).
export function reportOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) return [];
  return outcomes.filter(isObject).map(item => ({
    request: numberOrNull(item.rq),
    name: String(item.name ?? ''),
    method: String(item.method ?? ''),
    url: String(item.url ?? ''),
    fallback: String(item.fallback ?? ''),
    total: numberOrNull(item.total) ?? 0,
    outcomes: (Array.isArray(item.outcomes) ? item.outcomes : []).filter(isObject).map(entry => ({
      label: String(entry.label ?? ''),
      count: numberOrNull(entry.count) ?? 0,
      share: numberOrNull(entry.share) ?? 0,
    })),
  }));
}

// Checks of the root group and every nested group, in the order k6 wrote them.
export function summaryChecks(summary) {
  const rows = [];
  const walk = (group, path) => {
    if (!isObject(group)) return;
    for (const check of Object.values(isObject(group.checks) ? group.checks : {})) {
      if (!isObject(check)) continue;
      rows.push({
        group: path.join(' › '),
        name: String(check.name ?? ''),
        passes: numberOrNull(check.passes) ?? 0,
        fails: numberOrNull(check.fails) ?? 0,
      });
    }
    for (const child of Object.values(isObject(group.groups) ? group.groups : {})) {
      walk(child, [...path, String(child?.name ?? '')]);
    }
  };
  walk(summary?.root_group, []);
  return rows;
}

function setupOf(config) {
  const scenario = config?.scenario || {};
  const groups = new Map((scenario.groups || []).map(group => [group.id, group]));
  const load = isObject(config?.load) ? { ...config.load } : {};
  let loadSummary = '';
  try {
    loadSummary = loadShape(load)?.summary || '';
  } catch {
    loadSummary = '';
  }
  return {
    load,
    loadSummary,
    thresholds: {
      p95: String(config?.thresholds?.p95 ?? ''),
      errorRate: String(config?.thresholds?.errorRate ?? ''),
    },
    requests: (scenario.requests || []).map((request, index) => {
      const group = groups.get(request.groupId);
      return {
        number: index + 1,
        name: String(request.name || ''),
        type: request.type === 'grpc' ? 'grpc' : 'http',
        method: request.type === 'grpc' ? 'gRPC' : String(request.method || 'GET'),
        url: String(request.type === 'grpc' ? `${request.url || ''} ${request.grpcMethod || ''}`.trim() : request.url || ''),
        group: group ? String(group.name || '') : '',
        enabled: request.enabled !== false && group?.enabled !== false,
        // The statuses that counted as a success ('' = k6's own rule, 200–399).
        expectedStatuses: request.type === 'grpc' ? '' : normalizeExpectedStatuses(request.expectedStatuses),
      };
    }),
    dataFiles: (config?.dataSets || []).map(set => ({ name: String(set.name || ''), fileName: String(set.fileName || '') })),
    requestDetails: {
      recorded: config?.options?.logRequests === true,
      filter: String(config?.options?.logFilter || 'all'),
      hideSecrets: config?.options?.logRedact === true,
    },
  };
}

// Recorded headers as { name: "value" }; null when the record has none (not recorded).
function headersOf(headers) {
  if (!isObject(headers)) return null;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value ?? '')]));
}

// A JSON body is shown indented; anything else (or a body cut at the size cap) as it came.
export function prettyBody(text) {
  const value = String(text ?? '');
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

// Everything the report shows, as plain JSON. `state` comes from runner.js.
export function buildRunReport(state, now = new Date()) {
  const verdict = state?.verdict || {};
  const summary = isObject(state?.summary) ? state.summary : null;
  const records = Array.isArray(state?.requests) ? state.requests : [];
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    generatedAt: now.toISOString(),
    run: {
      status: String(verdict.status || 'idle'),
      title: String(verdict.title || ''),
      detail: String(verdict.detail || ''),
      startedAt: state?.startedAt instanceof Date ? state.startedAt.toISOString() : null,
      elapsedMs: Math.max(0, Math.round(Number(state?.elapsedMs) || 0)),
      exitCode: numberOrNull(state?.exitCode),
      requestTotal: numberOrNull(summary?.metrics?.http_reqs?.count) ?? (Number(state?.requestsReceived) || 0),
      errorTotal: Array.isArray(state?.errors) ? state.errors.length : 0,
    },
    setup: setupOf(state?.config),
    thresholds: reportThresholds(summary, state?.outcomeThresholds),
    outcomes: reportOutcomes(state?.outcomes),
    race: isObject(state?.race) ? state.race : null,
    checks: summaryChecks(summary),
    metrics: summaryMetrics(summary),
    requests: records.map(entry => ({
      vu: entry.vu ?? null,
      iteration: entry.it ?? null,
      request: Number.isFinite(Number(entry.i)) ? Number(entry.i) + 1 : null,
      method: String(entry.m ?? ''),
      url: String(entry.url ?? ''),
      status: entry.s ?? null,
      durationMs: numberOrNull(Number(entry.d)),
      ok: entry.ok === true,
      outcome: entry.oc == null ? '' : String(entry.oc),
      error: entry.er ? String(entry.er) : '',
      requestHeaders: headersOf(entry.rqh),
      requestBody: entry.rq == null ? '' : String(entry.rq),
      responseHeaders: headersOf(entry.rh),
      responseBody: entry.rb == null ? '' : String(entry.rb),
    })),
    requestsReceived: Number(state?.requestsReceived) || 0,
    exports: (state?.exports || []).map(item => ({ file: String(item.file), rows: Number(item.rows) || 0, truncated: item.truncated === true })),
    summary,
  };
}

// "k6ui-report-2026-11-17-153012.html", from the run's local start time.
export function reportFileName(startedAt, extension) {
  const date = startedAt instanceof Date && !Number.isNaN(startedAt.getTime()) ? startedAt : new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `k6ui-report-${stamp}.${extension}`;
}

// ── HTML ───────────────────────────────────────────────────────
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

function formatNumber(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  return Number.isInteger(number) ? number.toLocaleString('en-US') : number.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatElapsed(milliseconds) {
  if (milliseconds > 0 && milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}h ${minutes}m ${seconds}s` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
}

function table(headings, rows, { numeric = [] } = {}) {
  const head = headings.map((heading, index) =>
    `<th scope="col"${numeric.includes(index) ? ' class="num"' : ''}>${escapeHtml(heading)}</th>`).join('');
  const body = rows.map(row => `<tr${row.className ? ` class="${row.className}"` : ''}>${row.cells.map((cell, index) =>
    `<td${numeric.includes(index) ? ' class="num"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function keyFigures(report) {
  const byName = Object.fromEntries(report.metrics.map(metric => [metric.name, metric.values]));
  const figures = [];
  const reqs = byName.http_reqs;
  const duration = byName.http_req_duration;
  const failed = byName.http_req_failed;
  if (reqs?.count != null) figures.push(['Total requests', formatNumber(reqs.count)]);
  if (reqs?.rate != null) figures.push(['Requests/sec', formatNumber(reqs.rate, 1)]);
  if (duration?.avg != null) figures.push(['Average response', `${formatNumber(duration.avg)} ms`]);
  if (duration?.['p(95)'] != null) figures.push(['p95 response', `${formatNumber(duration['p(95)'])} ms`]);
  if (duration?.max != null) figures.push(['Slowest response', `${formatNumber(duration.max)} ms`]);
  if (failed?.value != null) figures.push(['Error rate', `${formatNumber(failed.value * 100)} %`]);
  if (byName.iterations?.count != null) figures.push(['Iterations', formatNumber(byName.iterations.count)]);
  if (byName.vus_max?.value != null) figures.push(['Max VUs', formatNumber(byName.vus_max.value)]);
  if (!figures.length) return '<p class="muted">k6 did not write a summary for this run (it was stopped, or failed before it started).</p>';
  return `<div class="figures">${figures.map(([label, value]) =>
    `<div class="figure"><div class="figure-label">${escapeHtml(label)}</div><div class="figure-value">${escapeHtml(value)}</div></div>`).join('')}</div>`;
}

function loadText(setup) {
  const load = setup.load || {};
  if (load.mode === 'race') return `Race burst: ${load.vus || '?'} VUs, ${load.race?.timing || 'together'} (max ${load.maxDuration || '1h'})`;
  if (load.mode === 'stages') {
    const stages = (load.stages || []).map(stage => `${stage.duration || '?'} → ${stage.target ?? '?'} VUs`).join(', ');
    return `Staged: ${stages || 'no stages'}`;
  }
  if (load.mode === 'iterations') return `Iterations: ${load.vus || '?'} VUs × ${load.iterations || '?'} each (max ${load.maxDuration || '1h'})`;
  if (load.mode === 'simple') return `Fixed: ${load.vus || '?'} VUs for ${load.duration || '?'}`;
  return '—';
}

function metricRows(metrics) {
  return metrics.map(metric => {
    const { values, kind, unit } = metric;
    const suffix = unit ? ` ${unit}` : '';
    let text;
    if (kind === 'trend') {
      text = TREND_KEYS.filter(key => values[key] != null).map(key => `${key} ${formatNumber(values[key])}${suffix}`).join(' · ');
    } else if (kind === 'rate') {
      text = `${formatNumber((values.value ?? 0) * 100)} % (${formatNumber(values.passes ?? 0)} true, ${formatNumber(values.fails ?? 0)} false)`;
    } else if (kind === 'counter') {
      const bytes = /^data_(sent|received)$/.test(metric.name);
      text = `${bytes ? formatBytes(values.count) : formatNumber(values.count)} · ${bytes ? `${formatBytes(values.rate)}/s` : `${formatNumber(values.rate)}/s`}`;
    } else {
      text = Object.entries(values).map(([key, value]) => `${key} ${formatNumber(value)}`).join(' · ');
    }
    return { cells: [metric.name, kind, text || '—'] };
  });
}

function headersHtml(headers) {
  if (!headers) return '<p class="muted">Not recorded.</p>';
  const names = Object.keys(headers);
  if (!names.length) return '<p class="muted">No headers.</p>';
  return `<dl class="headers">${names.map(name => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(headers[name])}</dd>`).join('')}</dl>`;
}

// The report runs no scripts, so the command is text to select and copy.
function curlHtml(row) {
  const curl = curlFromRecord({ m: row.method, url: row.url, rqh: row.requestHeaders, rq: row.requestBody });
  if (!curl) return '';
  const notes = curl.notes.length ? `<p class="muted">${escapeHtml(curl.notes.join(' '))}</p>` : '';
  return `<details class="curl"><summary>cURL</summary>${notes}<pre>${escapeHtml(curl.command)}</pre></details>`;
}

function sideHtml(title, summary, headers, body, extra = '') {
  const count = headers ? Object.keys(headers).length : 0;
  return `<section class="side"><h3>${escapeHtml(title)} <span class="muted">${escapeHtml(summary)}</span></h3>
<h4>Headers (${count})</h4>${headersHtml(headers)}
<h4>Body</h4><pre>${body ? escapeHtml(prettyBody(body)) : '<span class="muted">(empty)</span>'}</pre>${extra}</section>`;
}

// One request record: a summary line that opens to its payload and response.
function recordHtml(row) {
  const duration = row.durationMs == null ? '' : `${formatNumber(row.durationMs)} ms`;
  const where = [row.vu != null ? `VU ${row.vu}` : '', row.iteration != null ? `iter ${row.iteration}` : '', row.request != null ? `#${row.request}` : '']
    .filter(Boolean).join(' · ');
  return `<details class="record${row.ok ? '' : ' bad'}"><summary>
<span class="badge ${row.ok ? 'ok' : 'bad'}">${escapeHtml(row.status ?? '—')}</span>${row.outcome ? ` <span class="badge outcome">${escapeHtml(row.outcome)}</span>` : ''}
<span class="method">${escapeHtml(row.method)}</span> <span class="url">${escapeHtml(row.url)}</span>
<span class="muted rec-meta">${escapeHtml([where, duration].filter(Boolean).join(' · '))}</span></summary>
${row.error ? `<p class="rec-error">${escapeHtml(row.error)}</p>` : ''}<div class="sides">
${sideHtml('Request', `${row.method} ${row.url}`, row.requestHeaders, row.requestBody, curlHtml(row))}
${sideHtml('Response', `Status ${row.status ?? 'unknown'}${duration ? ` · ${duration}` : ''}`, row.responseHeaders, row.responseBody)}
</div></details>`;
}

const REPORT_CSS = `
:root { color-scheme: light dark; --bg: #f7f8fa; --surface: #ffffff; --text: #1b1f24; --muted: #5b6470; --line: #d9dee5;
  --ok: #17663a; --ok-bg: #e5f4ea; --bad: #a3221b; --bad-bg: #fbe9e7; --warn: #8a5300; --warn-bg: #fdf1dc; --code: #f0f2f5;
  --tone-1: #2a78d6; --tone-2: #eb6834; --tone-3: #1baf7a; --tone-4: #eda100; --tone-5: #e87ba4; --tone-6: #008300;
  --tone-7: #6250d6; --tone-8: #e34948; --tone-other: #7a828f; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14171b; --surface: #1c2026; --text: #e7eaee; --muted: #a2abb6; --line: #343b44;
    --ok: #7fd79f; --ok-bg: #173323; --bad: #ff9c94; --bad-bg: #3a1c1a; --warn: #f3c06b; --warn-bg: #3a2c12; --code: #252a31;
    --tone-1: #3987e5; --tone-2: #d95926; --tone-3: #199e70; --tone-4: #c98500; --tone-5: #d55181; --tone-6: #0ca30c;
    --tone-7: #9085e9; --tone-8: #e66767; --tone-other: #7d8597; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
p { margin: 0 0 8px; }
.muted { color: var(--muted); }
.verdict { display: flex; gap: 14px; align-items: flex-start; margin: 20px 0; padding: 16px; border-radius: 10px; background: var(--surface); border: 1px solid var(--line); border-left-width: 6px; }
.verdict.passed { border-left-color: var(--ok); }
.verdict.threshold-failed { border-left-color: var(--warn); }
.verdict.failed, .verdict.aborted { border-left-color: var(--bad); }
.verdict h2 { border: 0; margin: 0 0 4px; padding: 0; font-size: 19px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.badge.ok, .badge.passed { color: var(--ok); background: var(--ok-bg); }
.badge.bad, .badge.failed, .badge.aborted { color: var(--bad); background: var(--bad-bg); }
.badge.threshold-failed { color: var(--warn); background: var(--warn-bg); }
.badge.outcome { color: var(--text); background: var(--code); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; }
dl.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 0; }
dl.meta div { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
dl.meta dt { color: var(--muted); font-size: 12px; }
dl.meta dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.figure { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.figure-label { color: var(--muted); font-size: 12px; }
.figure-value { font-size: 20px; font-weight: 650; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; background: var(--code); }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; white-space: nowrap; }
tr.bad td { color: var(--bad); }
tr.off td { color: var(--muted); }
details { margin-top: 8px; }
summary { cursor: pointer; font-weight: 600; }
pre { margin: 8px 0 0; padding: 12px; background: var(--code); border-radius: 8px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.records { display: grid; gap: 6px; }
.record { margin: 0; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: 8px; padding: 8px 12px; }
.record.bad { border-left-color: var(--bad); }
.record > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-weight: 400; }
.record .method { font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.record .url { flex: 1 1 280px; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.rec-meta { font-size: 12px; white-space: nowrap; }
.rec-error { color: var(--bad); margin: 8px 0 0; overflow-wrap: anywhere; }
.sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-top: 10px; }
.side { min-width: 0; }
.side h3 { font-size: 14px; margin: 0 0 6px; overflow-wrap: anywhere; }
.side h3 .muted { font-weight: 400; font-size: 12px; }
.side h4 { font-size: 12px; color: var(--muted); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
dl.headers { display: grid; grid-template-columns: minmax(90px, max-content) 1fr; gap: 2px 10px; margin: 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
dl.headers dt { color: var(--muted); overflow-wrap: anywhere; }
dl.headers dd { margin: 0; overflow-wrap: anywhere; }
.side pre { max-height: 420px; overflow: auto; }
.curl > summary { font-size: 12px; color: var(--muted); }
.curl p { margin: 6px 0 0; font-size: 12px; }
.note { padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--text); font-size: 13px; }
.note.ok { background: var(--ok-bg); }
.figure-value.small { font-size: 16px; }
.race-chart { margin: 12px 0; padding: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; break-inside: avoid; }
.race-chart figcaption { font-size: 12px; margin-top: 6px; }
svg.gantt { display: block; width: 100%; height: auto; }
.gantt .grid { stroke: var(--line); stroke-width: 1; }
.gantt .zero { stroke: var(--muted); stroke-width: 1; }
.gantt .tick, .gantt .vu, .gantt .peak-label { fill: var(--muted); font-size: 11px; font-family: system-ui, sans-serif; }
.gantt .plan { stroke: var(--text); stroke-width: 2; }
.gantt .late .bar { stroke: var(--warn); stroke-width: 1.5; }
.gantt .peak { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
.tone-1 { fill: var(--tone-1); background: var(--tone-1); } .tone-2 { fill: var(--tone-2); background: var(--tone-2); }
.tone-3 { fill: var(--tone-3); background: var(--tone-3); } .tone-4 { fill: var(--tone-4); background: var(--tone-4); }
.tone-5 { fill: var(--tone-5); background: var(--tone-5); } .tone-6 { fill: var(--tone-6); background: var(--tone-6); }
.tone-7 { fill: var(--tone-7); background: var(--tone-7); } .tone-8 { fill: var(--tone-8); background: var(--tone-8); }
.tone-other { fill: var(--tone-other); background: var(--tone-other); }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; padding: 0; font-size: 12px; }
.legend .key { display: inline-block; width: 14px; height: 4px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media print {
  body { background: #fff; color: #000; }
  main { padding: 0; max-width: none; }
  details { display: block; }
  .verdict, dl.meta div, .figure, .table-wrap { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`;

// The race burst Gantt (race-gantt.js layout) as inline SVG: no scripts, a <title> per row.
const REPORT_RACE_ROWS = 2000;
function ganttSvg(layout) {
  const parts = [];
  for (const tick of layout.ticks) {
    parts.push(`<line class="${tick.label === 'T0' ? 'zero' : 'grid'}" x1="${tick.x}" x2="${tick.x}" y1="${layout.top - 6}" y2="${layout.bottom}"/>`);
    parts.push(`<text class="tick" x="${tick.x}" y="${layout.top - 10}" text-anchor="${tick.anchor}">${escapeHtml(tick.label)}</text>`);
  }
  for (const row of layout.rows) {
    parts.push(`<g class="row${row.late ? ' late' : ''}"><title>${escapeHtml(row.title)}</title>`
      + (row.label ? `<text class="vu" x="${layout.left - 8}" y="${row.mid}" dominant-baseline="central" text-anchor="end">${escapeHtml(row.label)}</text>` : '')
      + `<rect class="bar ${row.tone}" x="${row.x}" y="${row.barY}" width="${row.w}" height="${row.barH}" rx="2"/>`
      + `<line class="plan" x1="${row.planX}" x2="${row.planX}" y1="${row.y + 1}" y2="${row.y + row.h - 1}"/></g>`);
  }
  let height = layout.height;
  if (layout.peak) {
    parts.push(`<line class="peak" x1="${layout.peak.x}" x2="${layout.peak.x}" y1="${layout.top - 4}" y2="${layout.bottom}"/>`);
    parts.push(`<text class="peak-label" x="${layout.peak.labelX}" y="${layout.bottom + 6}" dominant-baseline="hanging" text-anchor="${layout.peak.anchor}">${escapeHtml(layout.peak.label)}</text>`);
    height += 14;
  }
  return `<svg class="gantt" viewBox="0 0 ${layout.width} ${height}" role="img" aria-label="One row per VU: send time to response, with a tick at the planned send time">${parts.join('')}</svg>`;
}

function raceHtml(race) {
  const parts = ['<h2>Race burst</h2>'];
  const note = raceResultText(race);
  if (note) parts.push(`<p class="${raceResultWarns(race) ? 'note' : 'note ok'}" role="note">${escapeHtml(note)}</p>`);
  const figures = raceFigures(race);
  if (figures.length) {
    parts.push(`<div class="figures">${figures.map(figure =>
      `<div class="figure" title="${escapeHtml(figure.hint)}"><div class="figure-label">${escapeHtml(figure.label)}</div><div class="figure-value small">${escapeHtml(figure.value)}</div></div>`).join('')}</div>`);
  }
  const layout = raceGantt(race);
  if (!layout) {
    parts.push('<p class="muted">No VU sent the race request, so there is nothing to chart.</p>');
    return parts.join('\n');
  }
  const shown = layout.shown < layout.total ? `The first ${layout.shown} of ${layout.total} VUs by planned time. ` : '';
  const legend = layout.legend.length
    ? `<ul class="legend">${layout.legend.map(item => `<li><span class="key ${item.tone}"></span>${escapeHtml(item.label)} <span class="muted">${escapeHtml(formatNumber(item.count))}</span></li>`).join('')}</ul>`
    : '';
  parts.push(`<figure class="race-chart">${ganttSvg(layout)}<figcaption class="muted">${escapeHtml(`${shown}Each row is one VU: the bar runs from the moment it sent Request ${race.rq} to its response, the tick marks its planned send time. Times are the k6 clock (1 ms resolution), not arrival at the server.`)}</figcaption>${legend}</figure>`);
  const rows = race.records.slice(0, REPORT_RACE_ROWS);
  if (rows.length < race.records.length) parts.push(`<p class="muted">The first ${formatNumber(rows.length)} of ${formatNumber(race.records.length)} VUs by planned time.</p>`);
  parts.push(table(RACE_RECORD_COLUMNS, rows.map(entry => ({ className: entry.late ? 'bad' : '', cells: raceRecordCells(entry) })), { numeric: [0, 1, 2, 3, 4, 5] }));
  return parts.join('\n');
}

// One row of the Targets table; an outcome target reads as its label, request and count.
function thresholdRow(row) {
  const target = row.outcome;
  if (!isObject(target)) {
    return { className: row.ok ? '' : 'bad', cells: [row.metric, row.rule, row.ok ? 'Met' : 'Not met'] };
  }
  const where = requestTitle({ rq: target.request, name: target.name, method: target.method, url: target.url });
  const typed = `count ${target.op} ${target.value}`;
  const rule = THRESHOLD_VARIABLE.test(target.value) && target.resolved != null ? `${typed} (${target.resolved})` : typed;
  const counted = target.count == null ? '' : ` (counted ${formatNumber(target.count)})`;
  let result = 'No result';
  if (target.status === 'skipped') result = `Not checked: ${target.skipped}`;
  else if (row.ok === true) result = `Met${counted}`;
  else if (row.ok === false) result = `Not met${counted}`;
  return {
    className: row.ok === false ? 'bad' : row.ok === true ? '' : 'off',
    cells: [`Outcome "${target.label}" of ${where}`, rule, result],
  };
}

export function reportToHtml(report) {
  const { run, setup } = report;
  const statusLabel = STATUS_LABELS[run.status] || run.status;
  const title = `K6UI test report — ${formatDate(run.startedAt)}`;
  const parts = [];

  parts.push(`<header><h1>K6UI test report</h1><p class="muted">Generated ${escapeHtml(formatDate(report.generatedAt))}</p></header>`);
  parts.push(`<section class="verdict ${escapeHtml(run.status)}" aria-label="Verdict"><div>
<span class="badge ${escapeHtml(run.status)}">${escapeHtml(statusLabel.toUpperCase())}</span>
<h2>${escapeHtml(run.title || statusLabel)}</h2><p>${escapeHtml(run.detail)}</p></div></section>`);
  parts.push(`<dl class="meta">
<div><dt>Started</dt><dd>${escapeHtml(formatDate(run.startedAt))}</dd></div>
<div><dt>Elapsed</dt><dd>${escapeHtml(formatElapsed(run.elapsedMs))}</dd></div>
<div><dt>Requests</dt><dd>${escapeHtml(formatNumber(run.requestTotal))}</dd></div>
<div><dt>Errors</dt><dd>${escapeHtml(formatNumber(run.errorTotal))}</dd></div>
<div><dt>k6 exit code</dt><dd>${escapeHtml(run.exitCode ?? '—')}</dd></div>
</dl>`);

  parts.push('<h2>Key figures</h2>', keyFigures(report));

  parts.push('<h2>Targets (thresholds)</h2>');
  parts.push(report.thresholds.length
    ? table(['Metric', 'Target', 'Result'], report.thresholds.map(thresholdRow))
    : '<p class="muted">No targets were set for this run.</p>');

  if (report.outcomes?.length) {
    parts.push('<h2>Outcomes</h2>');
    for (const item of report.outcomes) {
      const name = item.name || `${item.method} ${item.url}`.trim();
      parts.push(`<p><strong>${escapeHtml(`Request ${item.request ?? '?'}${name ? ` · ${name}` : ''}`)}</strong> <span class="muted">${escapeHtml(formatNumber(item.total))} responses</span></p>`);
      parts.push(table(['Label', 'Responses', 'Share'], item.outcomes.map(entry => ({
        cells: [entry.label, formatNumber(entry.count), `${formatNumber(entry.share * 100, 1)} %`],
      })), { numeric: [1, 2] }));
    }
  }

  if (report.race) parts.push(raceHtml(report.race));

  parts.push('<h2>Checks</h2>');
  parts.push(report.checks.length
    ? table(['Check', 'Group', 'Passed', 'Failed', 'Pass rate'], report.checks.map(row => {
      const total = row.passes + row.fails;
      return {
        className: row.fails ? 'bad' : '',
        cells: [row.name, row.group || '—', formatNumber(row.passes), formatNumber(row.fails), total ? `${formatNumber((row.passes / total) * 100)} %` : '—'],
      };
    }), { numeric: [2, 3, 4] })
    : '<p class="muted">No checks ran.</p>');

  parts.push('<h2>Test setup</h2>');
  parts.push(`<dl class="meta">
<div><dt>Load</dt><dd>${escapeHtml(loadText(setup))}</dd></div>
<div><dt>p95 target</dt><dd>${escapeHtml(setup.thresholds.p95 ? `< ${setup.thresholds.p95} ms` : 'Not set')}</dd></div>
<div><dt>Error rate target</dt><dd>${escapeHtml(setup.thresholds.errorRate ? `< ${setup.thresholds.errorRate} %` : 'Not set')}</dd></div>
<div><dt>Data files</dt><dd>${escapeHtml(setup.dataFiles.length ? setup.dataFiles.map(file => file.name || file.fileName).join(', ') : 'None')}</dd></div>
</dl>`);
  if (setup.loadSummary) parts.push(`<p class="muted">${escapeHtml(setup.loadSummary)}</p>`);
  // "Success statuses" only when a request has expected statuses; the others use 200–399.
  const withStatuses = setup.requests.some(request => request.expectedStatuses);
  parts.push(table(['#', 'Name', 'Method', 'URL', 'Group', ...(withStatuses ? ['Success statuses'] : []), 'On'], setup.requests.map(request => ({
    className: request.enabled ? '' : 'off',
    cells: [request.number, request.name || '—', request.method, request.url, request.group || '—',
      ...(withStatuses ? [request.expectedStatuses || (request.type === 'grpc' ? '—' : DEFAULT_EXPECTED_STATUSES)] : []),
      request.enabled ? 'Yes' : 'No'],
  })), { numeric: [0] }));

  parts.push('<h2>All metrics</h2>');
  parts.push(report.metrics.length
    ? table(['Metric', 'Type', 'Values'], metricRows(report.metrics))
    : '<p class="muted">No k6 summary for this run.</p>');

  parts.push(`<h2>Request records (${formatNumber(report.requests.length)})</h2>`);
  if (report.requests.length) {
    const shown = report.requests.length < report.requestsReceived
      ? `<p class="muted">The ${formatNumber(report.requests.length)} most recent of ${formatNumber(report.requestsReceived)} records that reached the page.</p>` : '';
    const failed = report.requests.filter(row => !row.ok).length;
    parts.push(`${shown}<p class="muted">${formatNumber(failed)} failed. Open a record to see its payload and response.
${setup.requestDetails.hideSecrets ? 'Recorded with "Hide secrets" on: secret values show as [REDACTED].' : 'Recorded with "Hide secrets" off: values are shown exactly as sent and received.'}</p>`);
    parts.push(`<div class="records">${report.requests.map(recordHtml).join('\n')}</div>`);
  } else {
    parts.push(`<p class="muted">${setup.requestDetails.recorded ? 'No request records reached the page.' : 'Request details were not recorded for this run (Run & Results › Requests).'}</p>`);
  }

  if (report.exports.length) {
    parts.push('<h2>Saved to CSV</h2>');
    parts.push(table(['File', 'Rows'], report.exports.map(item => ({
      cells: [item.file, `${formatNumber(item.rows)}${item.truncated ? ' (size limit reached)' : ''}`],
    })), { numeric: [1] }));
    parts.push('<p class="muted">Only the file names are in this report. Download the rows from Run &amp; Results.</p>');
  }

  parts.push(`<p class="note" role="note">This report holds the payload and response of every request record (headers and bodies), URLs, and
error messages, which can contain tokens, passwords, or personal data. Global variables, data file rows, and saved CSV values are left out.
Share it with the same care as a password.</p>`);
  parts.push(`<footer>${escapeHtml(REPORT_FORMAT)} v${REPORT_VERSION} · made by K6UI</footer>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
${parts.join('\n')}
</main>
</body>
</html>
`;
}
