// Advanced-mode flow outline: read-only summaries that select the canonical
// request card / group editor. It never edits, clones, or moves those elements;
// existing handlers announce structural changes with `k6ui:flow-changed`.
// Requests sit inside their group in a tree that folds per group; folding
// presses the group's own collapse button (hidden in Advanced), so the saved
// `collapsed` flag is the one Simple folds its cards with.
import { setRequestExpanded } from './req-card.js';

// Pure summary of the flow in global execution order. Group labels annotate
// requests; they never reorder them.
//
// `sections` is the tree: consecutive requests of one group form a run, as in
// the generated script, so a group split by other requests appears once per
// run (`part` of `parts`). Requests without a (known) group form runs with
// `groupId: ''` that have no head. Groups without requests come last.
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

  const sections = [];
  const runs = new Map();
  for (const item of items) {
    const last = sections[sections.length - 1];
    if (last && last.groupId === item.groupId) {
      last.requestIds.push(item.id);
      continue;
    }
    const part = (runs.get(item.groupId) || 0) + 1;
    runs.set(item.groupId, part);
    sections.push({ key: `${item.groupId}:${part}`, groupId: item.groupId, part, parts: 0, requestIds: [item.id] });
  }
  for (const section of sections) section.parts = runs.get(section.groupId);
  for (const group of groups) {
    if (!runs.has(group.id)) sections.push({ key: `${group.id}:1`, groupId: group.id, part: 1, parts: 1, requestIds: [] });
  }

  return {
    requests: items,
    groups: groups.map(group => ({
      id: group.id,
      name: group.name.trim() || 'Untitled group',
      enabled: group.enabled,
      collapsed: group.collapsed === true,
      condition: group.condition || '',
      count: items.filter(item => item.groupId === group.id).length,
    })),
    sections,
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

const requestCards = () => [...document.querySelectorAll('#reqs-main > .req-card')];
const groupElements = () => [...document.querySelectorAll('#request-groups > .request-group')];
const groupElement = id => groupElements().find(group => group.dataset.groupId === id);

function readRequests() {
  return requestCards().map(card => ({
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
  return groupElements().map(group => ({
    id: group.dataset.groupId,
    name: group.querySelector('.request-group-name')?.value || '',
    enabled: group.querySelector('.request-group-enabled')?.checked !== false,
    collapsed: group.classList.contains('collapsed'),
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

// Each summary is a <button> whose parts are created once and updated in
// place. Keeping the same elements means a refresh triggered between mousedown
// and mouseup (e.g. a blur `change`) never swallows the click.
function outlineButton(kind, partClasses) {
  const button = node('button', `outline-item outline-${kind}`);
  button.type = 'button';
  const parts = partClasses.map(className => node('span', className));
  parts.forEach((part, index) => {
    if (index) button.append(' ');
    button.append(part);
  });
  return { button, parts };
}

function createRequestEntry() {
  const { button, parts } = outlineButton('request', ['outline-num', 'method-badge', 'outline-name', 'outline-meta', 'outline-url']);
  const entry = node('li');
  entry.appendChild(button);
  return { entry, button, parts };
}

// A group run: a head (fold toggle + the group summary that selects its
// editor) above the list of its requests.
let runSerial = 0;
function createSectionEntry() {
  const { button, parts } = outlineButton('group', ['outline-name', 'outline-part', 'outline-off', 'outline-count', 'outline-cond']);
  const toggle = node('button', 'outline-toggle');
  toggle.type = 'button';
  const list = node('ol', 'outline-list outline-run');
  list.id = `outline-run-${++runSerial}`;
  toggle.setAttribute('aria-controls', list.id);
  const head = node('div', 'outline-section-head');
  head.append(toggle, button);
  const entry = node('li', 'outline-section');
  entry.append(head, list);
  return { entry, button, parts, toggle, list };
}

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
  setAttr(button, 'data-id', item.id);
  button.classList.toggle('outline-skipped', Boolean(item.skipReason));
  setAttr(button, 'title', item.url || null);
  setAttr(button, 'aria-current', selected ? 'true' : null);
  setText(num, `#${item.number}`);
  setAttr(method, 'class', `method-badge m-${item.method === 'gRPC' ? 'POST' : item.method}`);
  setText(method, item.method);
  setText(name, item.label);
  setText(meta, item.skipReason);
  meta.hidden = !item.skipReason;
  // Inside a group the head already says Off; screen readers still hear it.
  meta.classList.toggle('sr-only', item.skipReason === 'Group off');
  setText(url, item.url || 'No URL yet');
  url.classList.toggle('empty', !item.url);
}

function updateSectionEntry(record, section, group, { selected, holdsCurrent }) {
  const { entry, button, parts: [name, part, off, count, condition], toggle, list } = record;
  const total = section.requestIds.length;
  const partText = section.parts > 1 ? `Part ${section.part} of ${section.parts}` : '';
  const folded = group.collapsed && total > 0;
  // Only a folded head needs to say the selection is inside it.
  const marked = holdsCurrent && folded;
  setAttr(entry, 'data-group-id', group.id);
  entry.classList.toggle('outline-section-collapsed', folded);

  setAttr(button, 'data-id', group.id);
  button.classList.toggle('outline-skipped', !group.enabled);
  button.classList.toggle('outline-holds-current', marked);
  setAttr(button, 'aria-label', [
    `${group.name}${partText ? `, ${partText.toLowerCase()}` : ''}${group.enabled ? '' : ', off'}`,
    `${total} request${total === 1 ? '' : 's'}`,
    group.condition,
    marked ? 'holds the selected request' : '',
  ].filter(Boolean).join(', '));
  setAttr(button, 'title', group.condition || null);
  setAttr(button, 'aria-current', selected ? 'true' : null);
  setText(name, group.name);
  setText(part, partText);
  part.hidden = !partText;
  setText(off, group.enabled ? '' : 'Off');
  off.hidden = group.enabled;
  setText(count, String(total));
  setText(condition, group.condition);
  condition.hidden = !group.condition;

  // A group without requests has nothing to fold: the toggle keeps its place
  // so names line up, but is out of reach.
  setAttr(toggle, 'data-group-id', group.id);
  toggle.disabled = total === 0;
  setAttr(toggle, 'aria-hidden', total === 0 ? 'true' : null);
  setAttr(toggle, 'aria-expanded', String(!folded));
  setAttr(toggle, 'aria-label', `${folded ? 'Expand' : 'Collapse'} ${group.name}`);
  setAttr(toggle, 'title', folded ? 'Show its requests' : 'Hide its requests');
  list.hidden = folded || total === 0;
}

// Put `entries` in `list` in this order, dropping any other child. An entry
// that sits in another list moves here (insertBefore takes it along).
function syncChildren(list, entries) {
  entries.forEach((entry, index) => {
    if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] || null);
  });
  while (list.children.length > entries.length) list.lastElementChild.remove();
}

function cached(cache, key, create) {
  let record = cache.get(key);
  if (!record) {
    record = create();
    cache.set(key, record);
  }
  return record;
}

function prune(cache, live) {
  for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);
}

export function createFlowOutline({ view, onAddRequest, onAddGroup }) {
  const outline = node('aside', 'flow-outline');
  outline.id = 'flow-outline';
  outline.setAttribute('aria-label', 'Request flow outline');
  const head = node('div', 'outline-head');
  const title = node('div');
  title.append(node('strong', '', 'Requests'), node('small', '', 'Execution order, inside their groups'));
  const actions = node('div', 'outline-actions');
  const addButton = (id, text, label) => {
    const add = node('button', 'btn ghost sm outline-add', text);
    add.type = 'button';
    add.id = id;
    add.setAttribute('aria-label', label);
    actions.append(add);
    return add;
  };
  const addRequest = addButton('outline-add-request', '+ Request', 'Add request');
  const addGroup = addButton('outline-add-group', '+ Group', 'Add group');
  head.append(title, actions);
  const tree = node('ol', 'outline-list outline-tree');
  const empty = node('p', 'outline-empty', 'No requests yet.');
  const note = node('p', 'outline-note', 'Requests run in number order; a group split by other requests shows once per part.');
  outline.append(head, tree, empty, note);

  let selection = null;
  let previous = { requests: [], groups: [] };
  let pending = false;
  const requestEntries = new Map();
  const sectionEntries = new Map();

  function present({ reveal = false } = {}) {
    const advanced = document.documentElement.dataset.uiMode === 'advanced';
    view.dataset.flowSelection = selection?.kind || 'none';
    let target = null;
    for (const card of requestCards()) {
      const selected = selection?.kind === 'request' && card.dataset.requestId === selection.id;
      card.classList.toggle('advanced-selected', selected);
      if (selected) target = card;
      if (selected && advanced && !card.classList.contains('expanded')) setRequestExpanded(card, true);
    }
    for (const group of groupElements()) {
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
    const focused = document.activeElement?.closest?.('#flow-outline :is(.outline-item, .outline-toggle)');
    const isSelected = (kind, id) => selection?.kind === kind && selection.id === id;
    const requestById = new Map(model.requests.map(item => [item.id, item]));
    const groupById = new Map(model.groups.map(group => [group.id, group]));

    const top = [];
    for (const section of model.sections) {
      const entries = section.requestIds.map(id => {
        const record = cached(requestEntries, id, createRequestEntry);
        updateRequestEntry(record, requestById.get(id), isSelected('request', id));
        return record.entry;
      });
      if (!section.groupId) {
        top.push(...entries);
        continue;
      }
      const record = cached(sectionEntries, section.key, createSectionEntry);
      updateSectionEntry(record, section, groupById.get(section.groupId), {
        selected: isSelected('group', section.groupId),
        holdsCurrent: selection?.kind === 'request' && section.requestIds.includes(selection.id),
      });
      syncChildren(record.list, entries);
      top.push(record.entry);
    }
    syncChildren(tree, top);
    prune(requestEntries, new Set(requestById.keys()));
    prune(sectionEntries, new Set(model.sections.filter(section => section.groupId).map(section => section.key)));
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

  // A request chosen by an action (added, duplicated, moved into a group) must
  // be visible in the outline: unfold its group. Opening a project does not
  // pass through here, so a folded group stays folded.
  function unfoldGroupOf(card) {
    if (document.documentElement.dataset.uiMode !== 'advanced' || !card) return;
    const group = groupElement(card.querySelector('.request-group-select')?.value || '');
    if (group?.classList.contains('collapsed')) toggleFold(group);
  }
  function toggleFold(group) {
    group.querySelector('.request-group-collapse')?.click();
  }
  const cardOf = id => requestCards().find(card => card.dataset.requestId === id);

  addRequest.addEventListener('click', () => onAddRequest());
  addGroup.addEventListener('click', () => onAddGroup());
  outline.addEventListener('click', event => {
    const toggle = event.target.closest('.outline-toggle');
    if (toggle) {
      const group = groupElement(toggle.dataset.groupId);
      if (group) toggleFold(group);
      render();
      return;
    }
    const item = event.target.closest('.outline-item');
    if (!item) return;
    selection = { kind: item.classList.contains('outline-group') ? 'group' : 'request', id: item.dataset.id };
    render();
    present({ reveal: true });
  });
  const onFieldEdit = event => {
    if (!event.target.matches?.(SUMMARY_FIELDS)) return;
    if (event.type === 'change' && event.target.matches('.request-group-select')) {
      const card = event.target.closest('.req-card');
      if (selection?.kind === 'request' && card?.dataset.requestId === selection.id) unfoldGroupOf(card);
    }
    schedule();
  };
  view.addEventListener('input', onFieldEdit);
  view.addEventListener('change', onFieldEdit);
  // Simple folds a group from its own head; the outline follows.
  view.addEventListener('click', event => { if (event.target.closest?.('.request-group-collapse')) schedule(); });
  // Structural changes render synchronously so a newly selected card is
  // visible before its handler moves focus into it.
  window.addEventListener('k6ui:flow-changed', event => {
    if (event.detail?.select) {
      selection = event.detail.select;
      if (selection.kind === 'request') unfoldGroupOf(cardOf(selection.id));
    }
    render();
  });
  window.addEventListener('k6ui:project-applied', () => {
    selection = null;
    previous = { requests: [], groups: [] };
    schedule();
  });
  window.addEventListener('k6ui:ui-mode-changed', () => schedule());
  schedule();
  return outline;
}
