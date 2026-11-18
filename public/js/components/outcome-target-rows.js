// Thresholds / SLA → Outcome Targets (config.thresholds.outcomes, see
// public/js/outcome-thresholds.js): one row per target: request, label, comparison
// and count. The request and label lists come from the request cards as they are
// now, read without opening lazy editor panels (readRequestSettings), and are
// refreshed whenever the view is shown or the flow changes. A row keeps a value that
// is no longer offered (a removed request, a label that was renamed) as a marked
// option, so nothing is dropped silently and Run reports it. One DOM for Simple and
// Advanced; names and labels are DOM text, never markup.
import { $, $$ } from '../dom.js';
import { readRequestSettings } from './advanced-notice.js';
import {
  DEFAULT_OUTCOME_THRESHOLD_OP, OUTCOME_THRESHOLD_OPS, isBlankOutcomeThreshold, normalizeOutcomeThreshold,
  requestTitle, thresholdRequests,
} from '../outcome-thresholds.js';

const NOT_RUN = {
  'the request is turned off': 'turned off',
  'the request is in a turned-off group': 'group turned off',
  'the request has no URL': 'no URL',
};

// The flow as targets see it, from the cards and groups on the page.
function flowRequests() {
  const groups = $$('#request-groups > .request-group').map(group => ({
    id: group.dataset.groupId,
    enabled: group.querySelector('.request-group-enabled')?.checked !== false,
  }));
  const requests = $$('#reqs-main .req-card').map(card => ({
    ...readRequestSettings(card),
    id: card.dataset.requestId || '',
    name: card.querySelector('.request-name')?.value || '',
    method: card.querySelector('.method')?.value || 'GET',
    url: card.querySelector('.url')?.value || '',
  }));
  return thresholdRequests({ scenario: { groups, requests } });
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

// Rebuild a select's options and keep its value, adding a marked option for a value
// that is not offered any more.
function setOptions(select, options, value, missingLabel) {
  const list = options.map(item => option(item.value, item.label));
  if (value && !options.some(item => item.value === value)) list.push(option(value, missingLabel(value)));
  select.replaceChildren(...list);
  select.value = value;
}

function requestOptions(requests) {
  return [
    { value: '', label: 'Choose a request' },
    ...requests.filter(request => request.labels.length && request.id).map(request => ({
      value: request.id,
      label: request.skipped ? `${requestTitle(request)} (${NOT_RUN[request.skipped] || 'not run'})` : requestTitle(request),
    })),
  ];
}

function syncRow(row, requests) {
  const requestSelect = row.querySelector('.outcome-target-request');
  const labelSelect = row.querySelector('.outcome-target-label');
  const requestId = requestSelect.value;
  const request = requests.find(entry => entry.id === requestId && entry.rq) || requests.find(entry => entry.id === requestId);
  setOptions(requestSelect, requestOptions(requests), requestId,
    () => (request ? `${requestTitle(request)} (no outcome rules)` : 'Removed request'));
  const labels = request?.labels || [];
  setOptions(labelSelect, [{ value: '', label: 'Choose a label' }, ...labels.map(label => ({ value: label, label }))],
    labelSelect.value, label => `${label} (not a label of this request)`);
}

function renumber() {
  $$('#outcome-targets-list .outcome-target-row').forEach((row, index) => {
    row.querySelector('.row-remove').setAttribute('aria-label', `Remove outcome target ${index + 1}`);
  });
}

function select(className, label) {
  const field = document.createElement('select');
  field.className = className;
  field.setAttribute('aria-label', label);
  return field;
}

export function outcomeTargetRow(rawTarget = {}) {
  const target = normalizeOutcomeThreshold(rawTarget) || normalizeOutcomeThreshold({});
  const row = document.createElement('div');
  row.className = 'outcome-target-row';
  row.setAttribute('role', 'listitem');
  const request = select('outcome-target-request', 'Request');
  const label = select('outcome-target-label', 'Outcome label');
  const op = select('outcome-target-op', 'Comparison');
  for (const item of OUTCOME_THRESHOLD_OPS) op.appendChild(option(item.value, item.label));
  const value = document.createElement('input');
  value.className = 'outcome-target-value';
  value.placeholder = 'Count, e.g. 300 or {{QUOTA}}';
  value.setAttribute('aria-label', 'Count');
  value.autocomplete = 'off';
  value.spellcheck = false;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.title = 'Remove';
  remove.textContent = '×';

  // Values first, as plain options, so syncRow() can keep them.
  request.appendChild(option(target.request, target.request));
  request.value = target.request;
  label.appendChild(option(target.label, target.label));
  label.value = target.label;
  op.value = OUTCOME_THRESHOLD_OPS.some(item => item.value === target.op) ? target.op : DEFAULT_OUTCOME_THRESHOLD_OP;
  if (op.value !== target.op && target.op) {
    op.appendChild(option(target.op, `${target.op} (not a comparison)`));
    op.value = target.op;
  }
  value.value = target.value;

  request.addEventListener('change', () => {
    const requests = flowRequests();
    const chosen = requests.find(entry => entry.id === request.value);
    if (!chosen?.labels.includes(label.value)) label.value = '';
    syncRow(row, requests);
  });
  remove.addEventListener('click', () => {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    renumber();
    refreshEmptyState(flowRequests());
    (next?.querySelector('.outcome-target-request') || $('#add-outcome-target'))?.focus();
  });
  row.append(request, label, op, value, remove);
  return row;
}

function refreshEmptyState(requests) {
  const empty = $('#outcome-targets-empty');
  if (!empty) return;
  const rows = $$('#outcome-targets-list .outcome-target-row').length;
  empty.hidden = rows > 0 || requests.some(request => request.labels.length);
}

// Request and label lists of every row, from the flow as it is now.
export function refreshOutcomeTargetRows() {
  const list = $('#outcome-targets-list');
  if (!list) return;
  const requests = flowRequests();
  for (const row of list.querySelectorAll('.outcome-target-row')) syncRow(row, requests);
  refreshEmptyState(requests);
}

// → the targets of the view (blank rows left out), as typed.
export function readOutcomeTargetRows() {
  return $$('#outcome-targets-list .outcome-target-row')
    .map(row => normalizeOutcomeThreshold({
      request: row.querySelector('.outcome-target-request').value,
      label: row.querySelector('.outcome-target-label').value,
      op: row.querySelector('.outcome-target-op').value,
      value: row.querySelector('.outcome-target-value').value,
    }))
    .filter(target => !isBlankOutcomeThreshold(target));
}

// Fill the view from a saved project (call after the request cards are restored).
export function restoreOutcomeTargetRows(targets) {
  const list = $('#outcome-targets-list');
  if (!list) return;
  list.replaceChildren(...(Array.isArray(targets) ? targets : []).map(target => outcomeTargetRow(target)));
  renumber();
  refreshOutcomeTargetRows();
}

// Called once at startup.
export function initOutcomeTargets() {
  const list = $('#outcome-targets-list');
  const view = $('#view-sla');
  if (!list || !view) return;
  $('#add-outcome-target')?.addEventListener('click', () => {
    const requests = flowRequests();
    // With one request that has rules there is nothing to choose.
    const withRules = requests.filter(request => request.labels.length && request.rq);
    const row = outcomeTargetRow({ request: withRules.length === 1 ? withRules[0].id : '' });
    list.appendChild(row);
    syncRow(row, requests);
    renumber();
    refreshEmptyState(requests);
    row.querySelector(withRules.length === 1 ? '.outcome-target-label' : '.outcome-target-request').focus();
  });
  // The lists follow the flow: refreshed when the view is shown and after structural edits.
  new MutationObserver(() => {
    if (!view.classList.contains('hidden')) refreshOutcomeTargetRows();
  }).observe(view, { attributes: true, attributeFilter: ['class'] });
  for (const name of ['k6ui:flow-changed', 'k6ui:request-group-changed', 'k6ui:project-applied']) {
    window.addEventListener(name, refreshOutcomeTargetRows);
  }
  refreshOutcomeTargetRows();
}
