// Run & Results → Requests: one row per request record of the run (req-log events),
// newest kept up to the run's record limit (logMaxRecords, default 500), sortable by every column, filterable by errors and
// URL, and a detail row with the request and response (headers, body, "Copy as cURL").
// Also the request details fields of "Before you run" (syncRequestLogFields).
// Every value is set as text, never as markup.
import { $, $$, el, setText } from './dom.js';
import { DEFAULT_MAX_RECORDS, normalizeMaxRecords } from './shared/request-log.js';
import { ariaSortOf, compareRecords, insertIndex, nextSort } from './request-sort.js';
import { curlFromRecord } from './curl-export.js';

// Request records { entry, seq, row }: reqLogs in arrival order (the oldest is
// dropped past maxReqLogs, set when a run starts), reqRows the same records in
// table order (reqSort).
let maxReqLogs = DEFAULT_MAX_RECORDS;
let reqLogs = [];
let reqRows = [];
let reqSeq = 0;
let reqSort = null;
let reqLogReceived = 0;

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

function copyButton(label, text, caption = 'Copy') {
  const button = el('button', 'btn ghost sm', caption);
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
  const section = el('section', 'req-detail-section');
  section.setAttribute('aria-label', title);
  const head = el('div', 'req-detail-head');
  head.append(el('h4', '', title), el('span', 'req-detail-summary', summary));
  if (curl) {
    const button = copyButton('this request as a cURL command', curl.command, 'Copy as cURL');
    button.classList.add('req-detail-curl');
    head.appendChild(button);
  }
  section.appendChild(head);
  if (curl?.notes.length) section.appendChild(el('p', 'req-detail-note', curl.notes.join(' ')));

  const recorded = headers && typeof headers === 'object';
  const names = recorded ? Object.keys(headers) : [];
  section.appendChild(el('h5', '', `Headers (${names.length})`));
  if (names.length) {
    const list = el('dl', 'req-detail-headers');
    for (const name of names) list.append(el('dt', '', name), el('dd', '', headers[name]));
    section.appendChild(list);
  } else {
    section.appendChild(el('p', 'req-detail-empty', recorded ? 'No headers.' : 'Not recorded.'));
  }

  const bodyHead = el('div', 'req-detail-body-head');
  const bodyText = String(body ?? '');
  bodyHead.appendChild(el('h5', '', 'Body'));
  if (bodyText) bodyHead.appendChild(copyButton(`${title.toLowerCase()} body`, bodyText));
  section.appendChild(bodyHead);
  const pre = el('pre', 'req-detail-body', bodyText ? prettyBody(bodyText) : '(empty)');
  pre.tabIndex = 0;
  section.appendChild(pre);
  return section;
}

function renderRequestDetail(entry) {
  const detail = el('div', 'req-detail');
  if (entry.er) detail.appendChild(el('p', 'req-detail-error', entry.er));
  const grid = el('div', 'req-detail-grid');
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

// The filter as typed: errors only, and a piece of the URL.
const reqFilter = () => ({
  errorsOnly: Boolean($('#filter-errors-only')?.checked),
  urlTerm: ($('#filter-url')?.value || '').toLowerCase(),
});

function filterRow(row, { errorsOnly, urlTerm }) {
  const visible = (!errorsOnly || row.dataset.ok !== '1')
    && (!urlTerm || (row.dataset.url || '').toLowerCase().includes(urlTerm));
  row.classList.toggle('hidden', !visible);
  const detail = row.nextElementSibling;
  if (detail?.classList.contains('req-detail-row')) detail.classList.toggle('hidden', !visible);
}

// Every row, when the filter changes. A record that arrives is filtered on its own
// (addRequestRecord), not the whole table again for each of up to 100 a second.
export function applyReqFilter() {
  const filter = reqFilter();
  $$('#req-log-tbody .req-log-row').forEach(row => filterRow(row, filter));
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

export function showSkippedRequestLogs(skipped) {
  const notice = $('#req-log-skipped');
  if (!notice) return;
  const count = Number(skipped) || 0;
  notice.hidden = count === 0;
  notice.textContent = count
    ? `At least ${count} request ${count === 1 ? 'record was' : 'records were'} not shown: more than 50 a second arrived. `
      + 'Record failed requests only, or a sample, to keep the ones that matter.'
    : '';
}

// `limit`: the run's logMaxRecords (a run keeps the limit it started with).
export function resetReqLog(limit = DEFAULT_MAX_RECORDS) {
  maxReqLogs = normalizeMaxRecords(limit);
  setText('#req-log-limit', maxReqLogs.toLocaleString('en-US'));
  reqLogs = [];
  reqRows = [];
  reqSeq = 0;
  reqLogReceived = 0;
  showSkippedRequestLogs(0);
  $('#req-log-tbody').replaceChildren();
  setText('#req-log-count', '0');
  setText('#run-request-total', '0');
}

export function addRequestRecord(entry) {
  const record = { entry, seq: reqSeq++, row: renderReqLogRow(entry) };
  reqLogs.push(record);
  reqLogReceived += 1;
  const index = insertIndex(reqRows, record, reqSort);
  const next = reqRows[index];
  reqRows.splice(index, 0, record);
  $('#req-log-tbody').insertBefore(record.row, next ? next.row : null);
  if (reqLogs.length > maxReqLogs) {
    const oldest = reqLogs.shift();
    reqRows.splice(reqRows.indexOf(oldest), 1);
    rowNodes(oldest).forEach(node => node.remove());
  }
  setText('#req-log-count', reqLogs.length);
  setText('#run-request-total', reqLogReceived);
  filterRow(record.row, reqFilter());
}

// The records in arrival order (the report lists them), and how many arrived in all.
export const requestRecords = () => reqLogs.map(record => record.entry);
export const receivedRequestCount = () => reqLogReceived;
