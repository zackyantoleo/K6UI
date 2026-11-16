// Advanced-mode flow outline: read-only summaries that select the canonical
// request card / group editor. It never edits, clones, or moves those elements;
// existing handlers announce structural changes with `k6ui:flow-changed`.
import { setRequestExpanded } from './req-card.js';

// Pure summary of the flow in global execution order. Group labels annotate
// requests; they never reorder them.
export function outlineModel(requests, groups) {
  const groupById = new Map(groups.map(group => [group.id, group]));
  const items = requests.map((request, index) => {
    const group = groupById.get(request.groupId);
    return {
      id: request.id,
      number: index + 1,
      label: request.name.trim() || `Request ${index + 1}`,
      method: request.type === 'grpc' ? 'gRPC' : request.method,
      url: request.url.trim(),
      groupId: group ? group.id : '',
      groupName: group ? group.name.trim() || 'Untitled group' : '',
      skipReason: !request.enabled ? 'Disabled' : group && !group.enabled ? 'Group off' : '',
    };
  });
  return {
    requests: items,
    groups: groups.map(group => ({
      id: group.id,
      name: group.name.trim() || 'Untitled group',
      enabled: group.enabled,
      condition: group.condition || '',
      count: items.filter(item => item.groupId === group.id).length,
    })),
  };
}

const listKey = kind => (kind === 'group' ? 'groups' : 'requests');

// Selection is ephemeral UI state keyed by stable ID. When the selected item
// disappears, choose the next survivor from the previous order, else the one
// before it; otherwise fall back to the first request (or nothing).
export function resolveSelection(selection, previous, model) {
  const firstRequest = model.requests[0] ? { kind: 'request', id: model.requests[0].id } : null;
  if (!selection) return firstRequest;
  const key = listKey(selection.kind);
  const current = new Set(model[key].map(item => item.id));
  if (current.has(selection.id)) return selection;
  const before = (previous?.[key] || []).map(item => item.id);
  const index = before.indexOf(selection.id);
  if (index !== -1) {
    const next = before.slice(index + 1).find(id => current.has(id))
      ?? before.slice(0, index).reverse().find(id => current.has(id));
    if (next) return { kind: selection.kind, id: next };
  }
  return firstRequest;
}

// ── DOM adapter ──────────────────────────────────────────────────
// Summary fields live in the always-rendered card/group heads, so reading them
// never hydrates lazy panels or touches the project store.
const SUMMARY_FIELDS = [
  '.request-name', '.url', '.method', '.protocol', '.request-enabled', '.request-group-select',
  '.request-group-name', '.request-group-enabled', '.run-if-variable', '.run-if-operator', '.run-if-values',
].join(', ');

function readRequests() {
  return [...document.querySelectorAll('#reqs-main > .req-card')].map(card => ({
    id: card.dataset.requestId,
    name: card.querySelector('.request-name')?.value || '',
    type: card.querySelector('.protocol')?.value || 'http',
    method: card.querySelector('.method')?.value || 'GET',
    url: card.querySelector('.url')?.value || '',
    enabled: card.querySelector('.request-enabled')?.checked !== false,
    groupId: card.querySelector('.request-group-select')?.value || '',
  }));
}

function readGroups() {
  return [...document.querySelectorAll('#request-groups > .request-group')].map(group => ({
    id: group.dataset.groupId,
    name: group.querySelector('.request-group-name')?.value || '',
    enabled: group.querySelector('.request-group-enabled')?.checked !== false,
    // The head's "Runs only if ..." summary, kept in step by request-groups.js.
    condition: group.querySelector('.request-group-runif:not([hidden])')?.textContent || '',
  }));
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Each summary is an <li><button> whose parts are created once and updated in
// place. Keeping the same elements means a refresh triggered between mousedown
// and mouseup (e.g. a blur `change`) never swallows the click.
function outlineEntry(kind, partClasses) {
  const button = node('button', `outline-item outline-${kind}`);
  button.type = 'button';
  const parts = partClasses.map(className => node('span', className));
  parts.forEach((part, index) => {
    if (index) button.append(' ');
    button.append(part);
  });
  const entry = node('li');
  entry.appendChild(button);
  return { entry, button, parts };
}

const createRequestEntry = () =>
  outlineEntry('request', ['outline-num', 'method-badge', 'outline-name', 'outline-meta', 'outline-url']);
const createGroupEntry = () => outlineEntry('group', ['outline-name', 'outline-off', 'outline-count', 'outline-cond']);

// Write only on change: a keystroke refresh then touches one entry, not all.
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function setAttr(element, name, value) {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function updateRequestEntry({ button, parts: [num, method, name, meta, url] }, item, selected) {
  const metaText = [item.groupName, item.skipReason].filter(Boolean).join(' · ');
  setAttr(button, 'data-id', item.id);
  button.classList.toggle('outline-skipped', Boolean(item.skipReason));
  setAttr(button, 'title', item.url || null);
  setAttr(button, 'aria-current', selected ? 'true' : null);
  setText(num, `#${item.number}`);
  setAttr(method, 'class', `method-badge m-${item.method === 'gRPC' ? 'POST' : item.method}`);
  setText(method, item.method);
  setText(name, item.label);
  setText(meta, metaText);
  meta.hidden = !metaText;
  setText(url, item.url || 'No URL yet');
  url.classList.toggle('empty', !item.url);
}

function updateGroupEntry({ button, parts: [name, off, count, condition] }, item, selected) {
  setAttr(button, 'data-id', item.id);
  button.classList.toggle('outline-skipped', !item.enabled);
  setAttr(button, 'aria-label',
    `${item.name}${item.enabled ? '' : ', off'}, ${item.count} request${item.count === 1 ? '' : 's'}${item.condition ? `, ${item.condition}` : ''}`);
  setAttr(button, 'title', item.condition || null);
  setText(condition, item.condition);
  condition.hidden = !item.condition;
  setAttr(button, 'aria-current', selected ? 'true' : null);
  setText(name, item.name);
  setText(off, item.enabled ? '' : 'Off');
  off.hidden = item.enabled;
  setText(count, String(item.count));
}

// Keyed by stable ID: reuse, update, and reorder existing entries; drop stale ones.
function reconcile(list, cache, items, create, update) {
  const entries = items.map(item => {
    let record = cache.get(item.id);
    if (!record) {
      record = create();
      cache.set(item.id, record);
    }
    update(record, item);
    return record.entry;
  });
  const live = new Set(items.map(item => item.id));
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  entries.forEach((entry, index) => {
    if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] || null);
  });
  while (list.children.length > entries.length) list.lastElementChild.remove();
}

function sectionHead(title, hint, buttonId, buttonText, buttonLabel) {
  const head = node('div', 'outline-head');
  const text = node('div');
  text.append(node('strong', '', title), node('small', '', hint));
  const add = node('button', 'btn ghost sm outline-add', buttonText);
  add.type = 'button';
  add.id = buttonId;
  add.setAttribute('aria-label', buttonLabel);
  head.append(text, add);
  return { head, add };
}

export function createFlowOutline({ view, onAddRequest, onAddGroup }) {
  const outline = node('aside', 'flow-outline');
  outline.id = 'flow-outline';
  outline.setAttribute('aria-label', 'Request flow outline');
  const requests = sectionHead('Requests', 'Execution order', 'outline-add-request', '+ Request', 'Add request');
  const requestList = node('ol', 'outline-list outline-requests');
  const empty = node('p', 'outline-empty', 'No requests yet.');
  const groups = sectionHead('Groups', 'One level · shared headers', 'outline-add-group', '+ Group', 'Add group');
  const groupList = node('ul', 'outline-list outline-groups');
  const note = node('p', 'outline-note', 'Groups organize settings, not order.');
  outline.append(requests.head, requestList, empty, groups.head, groupList, note);

  let selection = null;
  let previous = { requests: [], groups: [] };
  let pending = false;
  const requestEntries = new Map();
  const groupEntries = new Map();

  function present({ reveal = false } = {}) {
    const advanced = document.documentElement.dataset.uiMode === 'advanced';
    view.dataset.flowSelection = selection?.kind || 'none';
    let target = null;
    for (const card of document.querySelectorAll('#reqs-main > .req-card')) {
      const selected = selection?.kind === 'request' && card.dataset.requestId === selection.id;
      card.classList.toggle('advanced-selected', selected);
      if (selected) target = card;
      if (selected && advanced && !card.classList.contains('expanded')) setRequestExpanded(card, true);
    }
    for (const group of document.querySelectorAll('#request-groups > .request-group')) {
      const selected = selection?.kind === 'group' && group.dataset.groupId === selection.id;
      group.classList.toggle('advanced-selected', selected);
      if (selected) target = group;
    }
    // Stacked (narrow) layout: bring the editor below the outline into view.
    if (reveal && advanced && target && matchMedia('(max-width: 960px)').matches) {
      target.scrollIntoView({ block: 'start' });
    }
  }

  function render() {
    pending = false;
    const model = outlineModel(readRequests(), readGroups());
    selection = resolveSelection(selection, previous, model);
    previous = model;
    const focused = document.activeElement?.closest?.('#flow-outline .outline-item');
    const isSelected = (kind, id) => selection?.kind === kind && selection.id === id;
    reconcile(requestList, requestEntries, model.requests, createRequestEntry,
      (record, item) => updateRequestEntry(record, item, isSelected('request', item.id)));
    reconcile(groupList, groupEntries, model.groups, createGroupEntry,
      (record, item) => updateGroupEntry(record, item, isSelected('group', item.id)));
    empty.hidden = model.requests.length > 0;
    // A reordered entry loses focus when moved; give it back.
    if (focused?.isConnected && document.activeElement !== focused) focused.focus();
    present();
  }

  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(render);
  }

  requests.add.addEventListener('click', () => onAddRequest());
  groups.add.addEventListener('click', () => onAddGroup());
  outline.addEventListener('click', event => {
    const item = event.target.closest('.outline-item');
    if (!item) return;
    selection = { kind: item.classList.contains('outline-group') ? 'group' : 'request', id: item.dataset.id };
    render();
    present({ reveal: true });
  });
  const onFieldEdit = event => { if (event.target.matches?.(SUMMARY_FIELDS)) schedule(); };
  view.addEventListener('input', onFieldEdit);
  view.addEventListener('change', onFieldEdit);
  // Structural changes render synchronously so a newly selected card is
  // visible before its handler moves focus into it.
  window.addEventListener('k6ui:flow-changed', event => {
    if (event.detail?.select) selection = event.detail.select;
    render();
  });
  window.addEventListener('k6ui:project-applied', () => {
    selection = null;
    previous = { requests: [], groups: [] };
    schedule();
  });
  window.addEventListener('k6ui:ui-mode-changed', () => present());
  schedule();
  return outline;
}
