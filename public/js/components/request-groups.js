// One-level request groups: lightweight organization plus optional header
// defaults. Requests keep their global execution order and reference a group by
// ID; groups never contain child groups or nested request arrays.
import { headerRow } from './rows.js';
import { focusAfterRemoval, notifyFlowChanged } from './counts.js';
import { createRequestGroupId } from '../project-store.js';
import { describeRunIf, runIfProblem } from '../run-if.js';
import { refreshDataSetGroups } from '../data-files.js';
import { helpButton } from './help-tips.js';

function button(label, className, text) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.setAttribute('aria-label', label);
  control.title = label;
  control.textContent = text;
  return control;
}

const OPERATOR_LABELS = [['equals', 'is'], ['not-equals', 'is not'], ['one-of', 'is one of']];

// What the "Run only if" row holds right now, or null when it is blank.
// Spaces in the variable become _ (like global variable names); the store
// drops a condition that cannot work, so groupProblem() reports it first.
function readRunIfDraft(group) {
  const variable = group.querySelector('.run-if-variable').value.trim().replace(/\s+/g, '_');
  const values = group.querySelector('.run-if-values').value.split(',').map(value => value.trim()).filter(Boolean);
  if (!variable && !values.length) return null;
  return { variable, operator: group.querySelector('.run-if-operator').value, values };
}

function runIfRow(runIf) {
  const row = document.createElement('div');
  row.className = 'group-run-if';
  const caption = document.createElement('span');
  caption.className = 'group-run-if-label';
  caption.textContent = 'Run only if';
  const variable = document.createElement('input');
  variable.className = 'run-if-variable';
  variable.maxLength = 80;
  variable.placeholder = 'Variable, e.g. EXECUTION_MODE';
  variable.setAttribute('aria-label', 'Condition variable');
  variable.value = runIf?.variable || '';
  const operator = document.createElement('select');
  operator.className = 'run-if-operator';
  operator.setAttribute('aria-label', 'Condition operator');
  for (const [value, label] of OPERATOR_LABELS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    operator.appendChild(option);
  }
  operator.value = runIf?.operator || 'equals';
  const values = document.createElement('input');
  values.className = 'run-if-values';
  values.placeholder = 'Values, comma-separated';
  values.setAttribute('aria-label', 'Condition values');
  values.value = (runIf?.values || []).join(', ');
  const message = document.createElement('p');
  message.className = 'run-if-message';
  message.setAttribute('role', 'status');
  row.append(caption, helpButton('runIf'), variable, operator, values, message);
  return row;
}

// Header badge + inline message for the condition, kept in step with the row.
function updateRunIfSummary(group) {
  const draft = readRunIfDraft(group);
  const problem = draft ? runIfProblem(draft) : '';
  const badge = group.querySelector('.request-group-runif');
  badge.hidden = !draft;
  badge.classList.toggle('run-if-invalid', Boolean(problem));
  badge.textContent = !draft ? '' : problem ? 'Condition needs attention' : `Runs only if ${describeRunIf(draft)}`;
  badge.title = badge.textContent;
  const message = group.querySelector('.run-if-message');
  message.textContent = problem;
  message.hidden = !problem;
  for (const input of group.querySelectorAll('.run-if-variable, .run-if-operator, .run-if-values')) {
    input.toggleAttribute('aria-invalid', Boolean(problem));
  }
  group.classList.toggle('request-group-conditional', Boolean(draft));
}

// The first problem in a "Run only if" row (any group), or ''. A half-typed
// condition would otherwise be dropped silently when the project is read.
export function requestGroupProblem() {
  for (const group of document.querySelectorAll('#request-groups .request-group')) {
    const draft = readRunIfDraft(group);
    const problem = draft ? runIfProblem(draft) : '';
    if (problem) {
      const name = group.querySelector('.request-group-name').value.trim();
      return `${name ? `Group "${name}"` : 'A request group'}, "Run only if": ${problem}`;
    }
  }
  return '';
}

function groupRecords() {
  return [...document.querySelectorAll('#request-groups .request-group')].map(group => ({
    id: group.dataset.groupId,
    name: group.querySelector('.request-group-name').value.trim() || 'Untitled group',
    collapsed: group.classList.contains('collapsed'),
  }));
}

export function applyRequestGroupVisibility() {
  const collapsedIds = new Set(
    groupRecords().filter(group => group.collapsed).map(group => group.id),
  );
  document.querySelectorAll('#reqs-main .req-card').forEach(card => {
    const groupId = card.querySelector('.request-group-select')?.value || '';
    card.classList.toggle('group-collapsed-hidden', collapsedIds.has(groupId));
  });
}

export function refreshRequestGroupOptions(preferredGroups = new Map()) {
  const groups = groupRecords();
  document.querySelectorAll('#reqs-main .request-group-select').forEach(select => {
    const selected = preferredGroups.get(select.closest('.req-card')) ?? select.value;
    select.replaceChildren();
    const ungrouped = document.createElement('option');
    ungrouped.value = '';
    ungrouped.textContent = 'No group';
    select.appendChild(ungrouped);
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      select.appendChild(option);
    }
    select.value = groups.some(group => group.id === selected) ? selected : '';
  });
  applyRequestGroupVisibility();
  refreshDataSetGroups(groups);
}

export function createRequestGroup(group = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = 'request-group';
  wrapper.dataset.groupId = group.id || createRequestGroupId();
  wrapper.classList.toggle('collapsed', group.collapsed === true);

  const head = document.createElement('div');
  head.className = 'request-group-head';
  const collapse = button('Collapse request group', 'request-group-collapse', '▾');
  collapse.setAttribute('aria-expanded', String(group.collapsed !== true));
  const name = document.createElement('input');
  name.className = 'request-group-name';
  name.maxLength = 120;
  name.placeholder = 'Group name — e.g. Checkout flow';
  name.value = group.name || '';
  name.setAttribute('aria-label', 'Request group name');
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'request-group-enabled-label';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'request-group-enabled';
  enabled.checked = group.enabled !== false;
  enabledLabel.append(enabled, ' Run group');
  const runIfBadge = document.createElement('span');
  runIfBadge.className = 'request-group-runif';
  runIfBadge.hidden = true;
  const remove = button('Remove request group', 'request-group-remove', 'Remove');
  head.append(collapse, name, runIfBadge, enabledLabel, remove);

  const body = document.createElement('div');
  body.className = 'request-group-body';
  const hint = document.createElement('p');
  hint.textContent = 'Optional headers apply to requests in this group. Request headers override them.';
  const headerList = document.createElement('div');
  headerList.className = 'group-headers-list';
  for (const header of group.headers || []) {
    if (header?.key) headerList.appendChild(headerRow(header.key, header.value));
  }
  const addHeader = button('Add group header', 'add-row-btn add-group-header', '+ Add header default');
  addHeader.addEventListener('click', () => headerList.appendChild(headerRow()));
  body.append(hint, headerList, addHeader, runIfRow(group.runIf));
  wrapper.append(head, body);
  updateRunIfSummary(wrapper);
  for (const type of ['input', 'change']) {
    body.querySelector('.group-run-if').addEventListener(type, () => updateRunIfSummary(wrapper));
  }

  collapse.addEventListener('click', () => {
    const collapsed = wrapper.classList.toggle('collapsed');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    collapse.setAttribute('aria-label', collapsed ? 'Expand request group' : 'Collapse request group');
    applyRequestGroupVisibility();
  });
  // Wrapped: passing the listener directly would hand the Event in as `preferredGroups`.
  name.addEventListener('input', () => refreshRequestGroupOptions());
  enabled.addEventListener('change', () => wrapper.classList.toggle('request-group-disabled', !enabled.checked));
  remove.addEventListener('click', () => {
    const removedId = wrapper.dataset.groupId;
    document.querySelectorAll('#reqs-main .request-group-select').forEach(select => {
      if (select.value === removedId) select.value = '';
    });
    const hadFocus = wrapper.contains(document.activeElement);
    const neighbours = [wrapper.nextElementSibling, wrapper.previousElementSibling];
    wrapper.remove();
    refreshRequestGroupOptions();
    notifyFlowChanged();
    focusAfterRemoval(hadFocus, neighbours, '.request-group-name', '#view-flow .add-request-group');
  });
  wrapper.classList.toggle('request-group-disabled', !enabled.checked);
  return wrapper;
}

export function collectRequestGroups() {
  return [...document.querySelectorAll('#request-groups .request-group')].map(group => ({
    id: group.dataset.groupId,
    name: group.querySelector('.request-group-name').value.trim(),
    enabled: group.querySelector('.request-group-enabled').checked,
    collapsed: group.classList.contains('collapsed'),
    headers: [...group.querySelectorAll('.group-headers-list .header-row')]
      .map(row => ({
        key: row.querySelector('.h-key').value.trim(),
        value: row.querySelector('.h-val').value,
      }))
      .filter(header => header.key),
    // Only present when set, so a project without conditions saves exactly as before.
    ...(readRunIfDraft(group) ? { runIf: readRunIfDraft(group) } : {}),
  }));
}

export function restoreGroups(groups = []) {
  const container = document.querySelector('#request-groups');
  if (!container) return;
  container.replaceChildren(...groups.map(group => createRequestGroup(group)));
  refreshRequestGroupOptions();
}

window.addEventListener('k6ui:request-group-changed', applyRequestGroupVisibility);
window.addEventListener('k6ui:refresh-request-groups', event =>
  refreshRequestGroupOptions(event.detail?.preferredGroups));
