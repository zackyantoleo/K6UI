// One-level request groups: lightweight organization plus optional header
// defaults. Requests keep their global execution order and reference a group by
// ID; groups never contain child groups or nested request arrays.
import { headerRow } from './rows.js';
import { createRequestGroupId } from '../project-store.js';

function button(label, className, text) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.setAttribute('aria-label', label);
  control.title = label;
  control.textContent = text;
  return control;
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
  const remove = button('Remove request group', 'request-group-remove', 'Remove');
  head.append(collapse, name, enabledLabel, remove);

  const body = document.createElement('div');
  body.className = 'request-group-body';
  const hint = document.createElement('p');
  hint.textContent = 'Optional headers apply to requests in this group. Request headers override them.';
  const headerList = document.createElement('div');
  headerList.className = 'group-headers-list';
  for (const header of group.headers || []) {
    if (header?.key) headerList.appendChild(headerRow(header.key, header.value));
  }
  const addHeader = button('Add group header', 'btn-add-row add-group-header', '+ Add header default');
  addHeader.addEventListener('click', () => headerList.appendChild(headerRow()));
  body.append(hint, headerList, addHeader);
  wrapper.append(head, body);

  collapse.addEventListener('click', () => {
    const collapsed = wrapper.classList.toggle('collapsed');
    collapse.setAttribute('aria-expanded', String(!collapsed));
    collapse.setAttribute('aria-label', collapsed ? 'Expand request group' : 'Collapse request group');
    applyRequestGroupVisibility();
  });
  name.addEventListener('input', refreshRequestGroupOptions);
  enabled.addEventListener('change', () => wrapper.classList.toggle('request-group-disabled', !enabled.checked));
  remove.addEventListener('click', () => {
    const removedId = wrapper.dataset.groupId;
    document.querySelectorAll('#reqs-main .request-group-select').forEach(select => {
      if (select.value === removedId) select.value = '';
    });
    wrapper.remove();
    refreshRequestGroupOptions();
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
