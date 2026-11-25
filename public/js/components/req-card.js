// Compact request card with one-at-a-time expansion. Its editor is built the
// first time it is needed: a Postman-style tab bar (Headers, Body, Checks with
// success statuses, Extract, Save CSV, Outcomes, Scripts, Settings with "Wait after"),
// one part shown at a time. A tab shows a count or a dot when its part is in use.
// Each part fills itself lazily. One DOM for Simple and Advanced.
import { headerRow, extractionRow } from './rows.js';
import { exportBlock, readExportBlock } from './export-rows.js';
import {
  updateExtCount,
  updateAssertCount,
  updateScriptCount,
  updateOutcomeCount,
  renumberMain,
  refreshFlowEmptyState,
  notifyFlowChanged,
  focusAfterRemoval,
} from './counts.js';
import { openCurlImport } from '../curl-import.js';
import { createBasicFields } from './request-editor/basic.js';
import { createHeadersPanel } from './request-editor/headers.js';
import { createBodyPanel } from './request-editor/body.js';
import { assertionRow, createChecksPanel } from './request-editor/checks.js';
import { createExtractPanel } from './request-editor/extract.js';
import { createExportsPanel } from './request-editor/exports.js';
import { createScriptsPanel } from './request-editor/scripts.js';
import {
  createOutcomesPanel, fillOutcomesPanel, outcomeRuleRow, readOutcomeRuleRow, readOutcomesPanel,
} from './request-editor/outcomes.js';
import { createStatusesPanel } from './request-editor/statuses.js';
import { helpButton } from './help-tips.js';
import { createRequestId } from '../project-store.js';
import { el } from '../dom.js';

export { assertionRow };
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// Methods whose body is sent (server/generator/request.js); a gRPC request sends its message.
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Following cards first, then earlier ones, nearest first.
function siblingsByDistance(card) {
  const after = [], before = [];
  for (let node = card.nextElementSibling; node; node = node.nextElementSibling) after.push(node);
  for (let node = card.previousElementSibling; node; node = node.previousElementSibling) before.push(node);
  return [...after, ...before];
}

function button(label, className, text) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.setAttribute('aria-label', label);
  control.title = label;
  control.textContent = text;
  return control;
}

function updateExpandedState(card, expanded) {
  card.classList.toggle('collapsed', !expanded);
  card.classList.toggle('expanded', expanded);
  const toggle = card.querySelector('.request-expand');
  toggle?.setAttribute('aria-expanded', String(expanded));
  if (expanded) syncSections(card);
}

export function setRequestExpanded(card, expanded, { exclusive = true } = {}) {
  const container = card.parentElement;
  const keepOpen = container?.closest('.flow-zone')?.querySelector('.keep-request-editors-open')?.checked;
  if (expanded && exclusive && !keepOpen) {
    container?.querySelectorAll('.req-card.expanded').forEach(other => {
      if (other !== card) updateExpandedState(other, false);
    });
  }
  updateExpandedState(card, expanded);
}

export function refreshRequestSummary(card) {
  card.querySelector('.request-name')?.dispatchEvent(new Event('input'));
}

const panelOf = (card, panelId) => card.querySelector(`.req-panel[data-panel="${panelId}"]`);
const sectionOf = (card, panelId) => panelOf(card, panelId)?.closest('.req-section');

// The outcome rules as they stand: the live section once it was filled, else the saved ones.
function outcomesOf(card) {
  const panel = panelOf(card, 'outcomes');
  return panel?.dataset.panelReady === 'true'
    ? readOutcomesPanel(panel.querySelector('.outcomes-panel'))
    : card.requestState?.outcomes;
}

function panelContent(factory, card) {
  return factory({
    onExtCount: () => updateExtCount(card),
    onAssertCount: () => updateAssertCount(card),
    onScriptCount: () => updateScriptCount(card),
    onOutcomeCount: () => updateOutcomeCount(card),
    readOutcomes: () => outcomesOf(card),
  });
}

const lazyPanelFactories = {
  headers: () => createHeadersPanel(),
  body: () => createBodyPanel(),
  assertions: ({ onAssertCount }) => createChecksPanel(onAssertCount),
  extractions: ({ onExtCount }) => createExtractPanel(onExtCount),
  exports: () => createExportsPanel(),
  statuses: ({ readOutcomes }) => createStatusesPanel(readOutcomes),
  outcomes: ({ onOutcomeCount }) => createOutcomesPanel(onOutcomeCount),
  scripts: ({ onScriptCount }) => createScriptsPanel(onScriptCount),
};

// The editor tabs, in order. `label` is the tab text; `about` / `help` / `advanced`
// head the panel of an extra part; `parts` (default: one part, the tab's id) are
// the lazy panels the tab holds, each under its own title when there are several;
// `inUse` reads the filled panel `dotPart` (default: the tab's id) or, before that,
// the saved request, and marks the tab with a dot.
const partsOf = definition => definition.parts || [{ id: definition.id }];
const TABS = [
  {
    id: 'headers', label: 'Headers',
    inUse: (panel, saved) => (panel
      ? [...panel.querySelectorAll('.h-key')].some(field => field.value.trim())
      : (saved.headers || []).some(item => item?.key)),
  },
  {
    id: 'body', label: 'Body',
    inUse: (panel, saved) => !!(panel ? panel.querySelector('.body').value : saved.body),
  },
  {
    // Success statuses and the response checks answer one question: was this
    // response right? So they share a tab.
    id: 'checks', label: 'Checks', count: 'assert',
    about: 'Mark it failed when the status, the body or the speed is wrong.',
    parts: [
      { id: 'statuses', title: 'Success statuses', help: () => helpButton('expectedStatuses') },
      { id: 'assertions', title: 'Response checks', help: () => helpButton('check') },
    ],
    dotPart: 'statuses',
    inUse: (panel, saved) => (panel
      ? !panel.querySelector('.check-status').checked || panel.querySelector('.expected-statuses').value !== ''
      : saved.checkStatus === false || !!saved.expectedStatuses),
  },
  {
    id: 'extractions', label: 'Extract', count: 'ext', help: () => helpButton('extraction'),
    about: 'Keep a token or an id, then use it as {{name}} in later requests.',
  },
  {
    id: 'exports', label: 'Save CSV', help: () => helpButton('saveCsv'),
    about: 'Save values to a CSV file: download them after the run, or use them as test data in a later run.',
    inUse: (panel, saved) => (panel ? !!panel.querySelector('.export-block') : (saved.exports || []).some(item => item && typeof item === 'object')),
  },
  {
    id: 'outcomes', label: 'Outcomes', count: 'outcome', advanced: true, help: () => helpButton('outcomes'),
    about: 'Label each response: count success, rejected and other answers separately.',
  },
  {
    id: 'scripts', label: 'Scripts', count: 'script', advanced: true, help: () => helpButton('scripts'),
    about: 'JavaScript before or after the request, for what nothing else covers.',
  },
  {
    id: 'settings', label: 'Settings', help: () => helpButton('pause'),
    about: 'How long this virtual user waits after the request before the next one.',
  },
];

function tabPanelShell(card, definition) {
  const idBase = `${card.dataset.requestId}-${definition.id}`;
  const section = document.createElement('section');
  section.className = `req-section req-section-${definition.id}`;
  section.id = `${idBase}-panel`;
  section.setAttribute('role', 'tabpanel');
  section.setAttribute('aria-labelledby', `${idBase}-tab`);
  section.dataset.tab = definition.id;
  section.hidden = true;
  if (definition.about) {
    const head = document.createElement('div');
    head.className = 'req-section-head';
    const about = document.createElement('p');
    about.className = 'req-section-about';
    about.textContent = definition.about;
    head.appendChild(about);
    if (definition.advanced) {
      const tag = document.createElement('span');
      tag.className = 'tag-advanced';
      tag.textContent = 'Advanced';
      head.appendChild(tag);
    }
    if (definition.help) head.appendChild(definition.help());
    section.appendChild(head);
  }
  const parts = partsOf(definition);
  for (const part of parts) {
    if (parts.length > 1) {
      const partHead = document.createElement('div');
      partHead.className = 'req-part-head';
      const title = document.createElement('h3');
      title.className = 'req-part-title';
      title.textContent = part.title;
      partHead.append(title, part.help());
      section.appendChild(partHead);
    }
    const panel = document.createElement('div');
    panel.className = 'req-panel';
    panel.dataset.panel = part.id;
    section.appendChild(panel);
  }
  return section;
}

function tabButton(card, definition) {
  const idBase = `${card.dataset.requestId}-${definition.id}`;
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'req-tab';
  tab.id = `${idBase}-tab`;
  tab.dataset.tab = definition.id;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', `${idBase}-panel`);
  tab.tabIndex = -1;
  const label = document.createElement('span');
  label.className = 'req-tab-label';
  label.textContent = definition.label;
  tab.appendChild(label);
  if (definition.count) {
    const badge = document.createElement('span');
    badge.className = `section-count section-count-${definition.count}`;
    tab.appendChild(badge);
  }
  if (definition.inUse) {
    const dot = document.createElement('span');
    dot.className = 'req-tab-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.hidden = true;
    tab.appendChild(dot);
  }
  tab.addEventListener('click', () => activateTab(card, definition.id));
  tab.addEventListener('keydown', event => handleTabKeydown(card, event));
  return tab;
}

export function activateTab(card, tabId, { focus = false } = {}) {
  ensureEditor(card);
  const definition = TABS.find(item => item.id === tabId) || TABS[0];
  card.dataset.activePanel = definition.id;
  for (const part of partsOf(definition)) ensureRequestPanel(card, part.id);
  card.querySelectorAll('.req-tab').forEach(tab => {
    const active = tab.dataset.tab === definition.id;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  card.querySelectorAll('.req-card-body .req-section').forEach(section => {
    section.hidden = section.dataset.tab !== definition.id;
  });
}

function handleTabKeydown(card, event) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...card.querySelectorAll('.req-tab')];
  const current = tabs.indexOf(event.currentTarget);
  if (current === -1) return;
  event.preventDefault();
  const next = {
    ArrowRight: (current + 1) % tabs.length,
    ArrowLeft: (current - 1 + tabs.length) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[event.key];
  activateTab(card, tabs[next].dataset.tab, { focus: true });
}

// A dot on a tab whose part holds something (Checks: changed success statuses).
function syncTabDots(card) {
  for (const definition of TABS) {
    if (!definition.inUse) continue;
    const dot = card.querySelector(`.req-tab[data-tab="${definition.id}"] .req-tab-dot`);
    if (!dot) continue;
    const panel = panelOf(card, definition.dotPart || definition.id);
    dot.hidden = !definition.inUse(panel?.dataset.panelReady === 'true' ? panel : null, card.requestState || {});
  }
}

// Body: a request whose method sends none says so (the text is kept, not sent);
// gRPC calls it the message.
function syncBodySection(card) {
  const section = sectionOf(card, 'body');
  if (!section) return;
  const grpc = card.querySelector('.protocol').value === 'grpc';
  const method = card.querySelector('.method').value;
  const sends = grpc || BODY_METHODS.includes(method);
  card.querySelector('.req-tab[data-tab="body"] .req-tab-label').textContent = grpc ? 'Message' : 'Body';
  const note = section.querySelector('.req-body-note');
  note.hidden = sends;
  note.textContent = `A ${method} request sends no body: text typed here is kept but not sent.`;
}

function buildEditor(card) {
  const body = card.querySelector('.req-card-body');
  const bar = document.createElement('div');
  bar.className = 'req-tabbar';
  const tabs = document.createElement('div');
  tabs.className = 'req-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Request settings');
  const panels = document.createElement('div');
  panels.className = 'req-tab-panels';
  for (const definition of TABS) {
    tabs.appendChild(tabButton(card, definition));
    panels.appendChild(tabPanelShell(card, definition));
  }
  const note = document.createElement('p');
  note.className = 'ext-hint req-body-note';
  note.hidden = true;
  panels.querySelector('.req-section-body').prepend(note);

  const wait = document.createElement('div');
  wait.className = 'req-wait';
  const waitLabel = document.createElement('label');
  waitLabel.className = 'opt-label';
  const sleep = document.createElement('input');
  sleep.type = 'number';
  sleep.className = 'sleep';
  sleep.min = '0';
  sleep.step = '0.5';
  sleep.value = card.requestState ? card.requestState.sleepAfter ?? 1 : '1';
  sleep.setAttribute('aria-label', 'Wait after this request, in seconds');
  const unit = document.createElement('span');
  unit.textContent = 's';
  unit.setAttribute('aria-hidden', 'true');
  waitLabel.append('Wait after ', sleep, unit);
  wait.append(waitLabel);
  const settings = document.createElement('div');
  settings.appendChild(wait);
  panels.querySelector('.req-panel[data-panel="settings"]').appendChild(settings);
  bar.appendChild(tabs);

  // Dots follow what is typed; the badges have their own counters.
  const refresh = () => syncTabDots(card);
  panels.addEventListener('input', refresh);
  panels.addEventListener('change', refresh);
  panels.addEventListener('click', event => { if (event.target.closest('button')) queueMicrotask(refresh); });

  body.append(bar, panels);
  body.dataset.editorReady = 'true';
}

function ensureEditor(card) {
  if (card.querySelector('.req-card-body')?.dataset.editorReady !== 'true') buildEditor(card);
}

// On open: the tab last shown (first time: Body for a method that sends one,
// else Headers), the badges of saved parts, the dots and the Body note.
function syncSections(card) {
  ensureEditor(card);
  const sends = card.querySelector('.protocol').value === 'grpc' || BODY_METHODS.includes(card.querySelector('.method').value);
  activateTab(card, card.dataset.activePanel || (sends ? 'body' : 'headers'));
  for (const definition of TABS) {
    if (!definition.count || !card.requestState) continue;
    for (const part of partsOf(definition)) ensureRequestPanel(card, part.id);
  }
  syncTabDots(card);
  syncBodySection(card);
}

// A value taken from the Send once response: one more row in the Extract tab (its
// count badge shows it), or the empty row a user added and left blank.
// A row that already reads the same place is kept as it is. Returns the row, its
// name, and whether it was there already.
export function takeExtraction(card, extraction) {
  const panel = ensureRequestPanel(card, 'extractions');
  const list = panel.querySelector('.extractions-list');
  const rows = [...list.querySelectorAll('.extraction-row')];
  const field = (row, selector) => row.querySelector(selector).value.trim();
  let row = rows.find(item => item.querySelector('.ext-source').value === extraction.source
    && field(item, '.ext-selector') === extraction.selector);
  const existing = Boolean(row);
  if (!row) {
    row = rows.find(item => !field(item, '.ext-name') && !field(item, '.ext-selector') && !field(item, '.ext-default'));
    if (row) {
      row.querySelector('.ext-name').value = extraction.varName;
      const source = row.querySelector('.ext-source');
      source.value = extraction.source;
      source.dispatchEvent(new Event('change'));
      row.querySelector('.ext-selector').value = extraction.selector;
    } else {
      row = extractionRow(extraction);
      list.appendChild(row);
    }
  }
  updateExtCount(card);
  // The variables panel and the warnings read the cards on input.
  row.querySelector('.ext-name').dispatchEvent(new Event('input', { bubbles: true }));
  return { row, name: field(row, '.ext-name'), existing };
}

export function ensureRequestPanel(card, panelId) {
  ensureEditor(card);
  const panel = panelOf(card, panelId);
  if (!panel || panel.dataset.panelReady === 'true') return panel;
  const factory = lazyPanelFactories[panelId];
  if (!factory) return panel;
  panel.appendChild(panelContent(factory, card));
  panel.dataset.panelReady = 'true';
  const request = card.requestState;
  if (request) {
    if (panelId === 'headers') {
      const list = panel.querySelector('.headers-list');
      for (const header of request.headers || []) {
        if (header.key) list.appendChild(headerRow(header.key, header.value));
      }
    } else if (panelId === 'body') {
      panel.querySelector('.body').value = request.body || '';
    } else if (panelId === 'extractions') {
      const list = panel.querySelector('.extractions-list');
      for (const extraction of request.extractions || []) {
        if (extraction?.varName) list.appendChild(extractionRow(extraction));
      }
      updateExtCount(card);
    } else if (panelId === 'exports') {
      const exportsList = panel.querySelector('.exports-list');
      for (const exp of request.exports || []) {
        if (exp && typeof exp === 'object') exportsList.appendChild(exportBlock(exp));
      }
    } else if (panelId === 'assertions') {
      const list = panel.querySelector('.assertions-list');
      for (const check of request.assertions || []) {
        list.appendChild(assertionRow(check.type, check.value, check.value2, () => updateAssertCount(card)));
      }
      updateAssertCount(card);
    } else if (panelId === 'outcomes') {
      fillOutcomesPanel(panel, request.outcomes, () => updateOutcomeCount(card));
      updateOutcomeCount(card);
    } else if (panelId === 'scripts') {
      panel.querySelector('.pre-script').value = request.preScript || '';
      panel.querySelector('.post-script').value = request.postScript || '';
      updateScriptCount(card);
    } else if (panelId === 'statuses') {
      panel.querySelector('.check-status').checked = request.checkStatus !== false;
      panel.querySelector('.expected-statuses').value = request.expectedStatuses || '';
    }
  }
  return panel;
}

// A duplicate keeps every field as typed (untrimmed), including an empty default.
const extractionSnapshot = row => ({
  varName: row.querySelector('.ext-name').value,
  source: row.querySelector('.ext-source').value,
  selector: row.querySelector('.ext-selector').value,
  default: row.querySelector('.ext-default').value,
});

function requestSnapshot(card) {
  const snapshot = {};
  const selectors = [
    '.request-name', '.protocol', '.method', '.url', '.grpc-method', '.grpc-plaintext',
    '.body', '.check-status', '.expected-statuses', '.sleep', '.pre-script', '.post-script', '.request-enabled',
    '.request-group-select', '.outcome-fallback',
  ];
  for (const selector of selectors) {
    const field = card.querySelector(selector);
    if (field) snapshot[selector] = field.type === 'checkbox' ? field.checked : field.value;
  }
  snapshot.headers = [...card.querySelectorAll('.req-card-body .header-row')].map(row => [
    row.querySelector('.h-key').value,
    row.querySelector('.h-val').value,
  ]);
  snapshot.extractions = [...card.querySelectorAll('.req-card-body .extraction-row')].map(extractionSnapshot);
  snapshot.exports = [...card.querySelectorAll('.req-card-body .exports-list .export-block')]
    .map(block => readExportBlock(block, { asTyped: true }));
  snapshot.assertions = [...card.querySelectorAll('.req-card-body .assertion-row')].map(row => [
    row.querySelector('.assert-type').value,
    row.querySelector('.assert-val').value,
    row.querySelector('.assert-val2').value,
  ]);
  snapshot.outcomeRules = [...card.querySelectorAll('.req-card-body .outcome-rule-row')].map(readOutcomeRuleRow);
  return snapshot;
}

function applySnapshot(card, snapshot) {
  ensureEditor(card);
  const requiredPanels = {
    '.body': 'body',
    '.check-status': 'statuses',
    '.expected-statuses': 'statuses',
    '.pre-script': 'scripts',
    '.post-script': 'scripts',
    '.outcome-fallback': 'outcomes',
  };
  for (const [selector, panelId] of Object.entries(requiredPanels)) {
    if (Object.hasOwn(snapshot, selector)) ensureRequestPanel(card, panelId);
  }
  for (const [selector, value] of Object.entries(snapshot)) {
    if (!selector.startsWith('.')) continue;
    const field = card.querySelector(selector);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  }
  for (const [key, value] of snapshot.headers) {
    ensureRequestPanel(card, 'headers').querySelector('.headers-list').appendChild(headerRow(key, value));
  }
  for (const extraction of snapshot.extractions) {
    ensureRequestPanel(card, 'extractions').querySelector('.extractions-list').appendChild(extractionRow(extraction));
  }
  for (const exp of snapshot.exports) {
    ensureRequestPanel(card, 'exports').querySelector('.exports-list').appendChild(exportBlock(exp));
  }
  for (const [type, value, value2] of snapshot.assertions) {
    ensureRequestPanel(card, 'assertions').querySelector('.assertions-list')
      .appendChild(assertionRow(type, value, value2, () => updateAssertCount(card)));
  }
  for (const rule of snapshot.outcomeRules) {
    ensureRequestPanel(card, 'outcomes').querySelector('.outcome-rules-list')
      .appendChild(outcomeRuleRow(rule, () => updateOutcomeCount(card)));
  }
  card.querySelector('.protocol').dispatchEvent(new Event('change'));
  card.querySelector('.url').dispatchEvent(new Event('input'));
  updateExtCount(card);
  updateAssertCount(card);
  updateScriptCount(card);
  updateOutcomeCount(card);
}

// ── ⋯ panel of a request: one open at a time; Escape, a click outside or focus
// leaving it closes it. ─────────────────────────────────────────
export function setMorePanelOpen(card, open, { focusFirst = false, focusButton = false } = {}) {
  const panel = card.querySelector('.req-more-panel');
  const toggle = card.querySelector('.request-more');
  if (!panel || !toggle) return;
  if (open) document.querySelectorAll('.req-more-panel:not([hidden])').forEach(other => {
    if (other !== panel) setMorePanelOpen(other.closest('.req-card'), false);
  });
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  card.classList.toggle('more-open', open);
  if (open && focusFirst) panel.querySelector('button, select')?.focus();
  if (!open && focusButton) toggle.focus();
}

function handleMoreKeydown(card, event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    setMorePanelOpen(card, false, { focusButton: true });
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.matches('select')) return;
  const items = [...card.querySelectorAll('.req-more-panel button, .req-more-panel select')];
  const current = items.indexOf(event.target);
  if (current === -1) return;
  event.preventDefault();
  items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
}

// Called once at startup (app.js): one listener for every card, so cards that are
// replaced (opening a project) leave nothing behind.
export function initRequestMorePanels() {
  const closeOthers = event => {
    document.querySelectorAll('.req-more-panel:not([hidden])').forEach(panel => {
      if (!panel.closest('.req-more').contains(event.target)) setMorePanelOpen(panel.closest('.req-card'), false);
    });
  };
  document.addEventListener('click', closeOthers);
  document.addEventListener('focusin', closeOthers);
}

export function requestLabel(card) {
  return card.querySelector('.request-name-preview')?.textContent || 'The request';
}

// Screen readers hear where a moved request went (drag and drop, Move up/down).
export function announceFlow(message) {
  const region = document.querySelector('#flow-announcer');
  if (region) region.textContent = message;
}

// A <select> with these [value, text] options.
function selectField(className, ariaLabel, options) {
  const field = el('select', className);
  field.setAttribute('aria-label', ariaLabel);
  for (const [value, text] of options) {
    const option = el('option', '', text);
    option.value = value;
    field.appendChild(option);
  }
  return field;
}

// ⋯ holds the actions a request needs now and then; the row keeps on/off and open/close.
function buildMoreMenu(card, index) {
  const more = el('div', 'req-more');
  const moreButton = button(`More actions for request ${index + 1}`, 'req-action-btn request-more', '⋯');
  const morePanel = el('div', 'req-more-panel');
  morePanel.id = `${card.dataset.requestId}-more`;
  morePanel.hidden = true;
  moreButton.setAttribute('aria-expanded', 'false');
  moreButton.setAttribute('aria-controls', morePanel.id);
  const item = (label, className, text) => {
    const control = button(label, `req-more-item ${className}`, text);
    control.removeAttribute('title');
    return control;
  };
  const duplicate = item(`Duplicate request ${index + 1}`, 'request-duplicate', 'Duplicate');
  const curl = item(`Import cURL into request ${index + 1}`, 'curl', 'Replace from a cURL command');
  const moveUp = item(`Move request ${index + 1} up`, 'request-move-up', 'Move up');
  const moveDown = item(`Move request ${index + 1} down`, 'request-move-down', 'Move down');
  const remove = item(`Remove request ${index + 1}`, 'del', 'Delete request');
  const groupSelect = selectField('request-group-select', `Request ${index + 1} group`, [['', 'No group']]);
  const groupLabel = el('label', 'request-group-label');
  groupLabel.append(el('span', '', 'Group'), groupSelect);
  morePanel.append(duplicate, curl, moveUp, moveDown, groupLabel, remove);
  more.append(moreButton, morePanel);
  return { more, moreButton, morePanel, duplicate, curl, moveUp, moveDown, remove, groupSelect };
}

// The summary row of a closed card, which is also the head of an open one: drag handle,
// number, name, method, URL, Send once, on/off switch, ⋯ menu and expand.
function buildCardHead(card, index) {
  const head = el('div', 'req-card-head');
  const handle = el('span', 'req-drag-handle');
  handle.draggable = true;
  handle.title = 'Drag to move this request (keyboard: ⋯ → Move up / Move down)';
  handle.setAttribute('aria-hidden', 'true');
  const num = el('span', 'req-num', `#${index + 1}`);
  const { nameInput } = createBasicFields(index);
  const namePreview = el('strong', 'request-name-preview', `Request ${index + 1}`);
  namePreview.setAttribute('aria-hidden', 'true');
  const methodPreview = el('span', 'method-badge request-method-preview m-GET', 'GET');
  methodPreview.setAttribute('aria-hidden', 'true');
  const protocol = selectField('protocol', `Request ${index + 1} protocol`, [['http', 'HTTP'], ['grpc', 'gRPC']]);
  const method = selectField('method', `Request ${index + 1} method`, METHODS.map(value => [value, value]));
  // One visible method list: the HTTP methods plus gRPC. The protocol and method
  // selects stay (hidden) as the values the rest of the app reads.
  const kind = selectField('request-kind', `Request ${index + 1} method`, METHODS.map(value => [value, value]));
  const otherProtocols = el('optgroup');
  otherProtocols.label = 'Other protocol';
  const grpcOption = el('option', '', 'gRPC');
  grpcOption.value = 'grpc';
  otherProtocols.appendChild(grpcOption);
  kind.appendChild(otherProtocols);
  const url = el('input', 'url');
  url.placeholder = 'https://api.example.com/endpoint';
  url.setAttribute('aria-label', `Request ${index + 1} URL`);
  // "Send once" (components/send-once.js): sends this request one time and shows the response.
  const send = el('div', 'req-send');
  const sendButton = el('button', 'btn ghost sm req-send-once', 'Send once');
  sendButton.type = 'button';
  sendButton.dataset.icon = 'play';
  send.append(sendButton, helpButton('sendOnce'));
  const preview = el('span', 'req-url-preview empty', 'No URL yet');
  const enabledLabel = el('label', 'request-enabled-label');
  const enabled = el('input', 'request-enabled switch-input');
  enabled.type = 'checkbox';
  enabled.checked = true;
  enabledLabel.append(enabled, el('span', 'sr-only', 'Enabled'));
  const menu = buildMoreMenu(card, index);
  const expand = button(`Expand request ${index + 1}`, 'req-action-btn request-expand', '▾');
  expand.setAttribute('aria-expanded', 'false');
  const actions = el('div', 'req-card-actions');
  actions.append(menu.more, expand);
  head.append(handle, num, namePreview, methodPreview, nameInput, protocol, method, kind, url, send, preview, enabledLabel, actions);
  return { head, nameInput, namePreview, methodPreview, protocol, method, kind, url, preview, enabled, enabledLabel, expand, menu };
}

function buildGrpcRow() {
  const grpcRow = el('div', 'grpc-row hidden');
  const grpcMethod = el('input', 'grpc-method');
  grpcMethod.placeholder = 'package.Service/Method';
  const plaintextLabel = el('label', 'opt-label');
  const plaintext = el('input', 'grpc-plaintext');
  plaintext.type = 'checkbox';
  plaintextLabel.append(plaintext, ' Plaintext (no TLS)');
  grpcRow.append(el('span', 'grpc-label', 'gRPC'), grpcMethod, plaintextLabel);
  return grpcRow;
}

// The head's fields keep the summary (name, method badge, URL preview, on/off) and
// the hidden protocol / method selects in step with what is typed.
function wireCardHead(card, fields, grpcRow, index) {
  const { head, nameInput, namePreview, methodPreview, protocol, method, kind, url, preview, enabled, enabledLabel, expand } = fields;
  function syncProtocol() {
    const grpc = protocol.value === 'grpc';
    method.classList.toggle('hidden', grpc);
    grpcRow.classList.toggle('hidden', !grpc);
    url.placeholder = grpc ? 'host:port — e.g. localhost:50051' : 'https://api.example.com/endpoint';
  }
  function syncPreview() {
    kind.value = protocol.value === 'grpc' ? 'grpc' : method.value;
    const position = card.parentElement ? [...card.parentElement.children].indexOf(card) + 1 : index + 1;
    namePreview.textContent = nameInput.value.trim() || `Request ${position}`;
    methodPreview.textContent = protocol.value === 'grpc' ? 'gRPC' : method.value;
    methodPreview.className = `method-badge request-method-preview m-${protocol.value === 'grpc' ? 'POST' : method.value}`;
    preview.textContent = url.value.trim() || 'No URL yet';
    preview.classList.toggle('empty', !url.value.trim());
  }
  function syncEnabled() {
    card.classList.toggle('request-disabled', !enabled.checked);
    enabledLabel.title = enabled.checked ? 'Included when the test runs' : 'Saved but skipped when the test runs';
  }
  protocol.addEventListener('change', syncProtocol);
  protocol.addEventListener('change', syncPreview);
  method.addEventListener('change', syncPreview);
  for (const field of [protocol, method]) field.addEventListener('change', () => syncBodySection(card));
  nameInput.addEventListener('input', syncPreview);
  url.addEventListener('input', syncPreview);
  enabled.addEventListener('change', syncEnabled);
  kind.addEventListener('change', () => {
    const toGrpc = kind.value === 'grpc';
    if (!toGrpc) method.value = kind.value;
    if (toGrpc !== (protocol.value === 'grpc')) {
      protocol.value = toGrpc ? 'grpc' : 'http';
      protocol.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (!toGrpc) method.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expand.addEventListener('click', event => {
    event.stopPropagation();
    setRequestExpanded(card, !card.classList.contains('expanded'));
  });
  head.addEventListener('click', event => {
    // Simple: a click on a closed card's summary opens it (the chevron closes it).
    // Advanced always shows the selected request's editor.
    if (document.documentElement.dataset.uiMode === 'advanced' || card.classList.contains('expanded')) return;
    if (!event.target.closest('button, input, select, label, .req-drag-handle, .req-more')) setRequestExpanded(card, true);
  });
  syncProtocol();
  syncPreview();
  syncEnabled();
}

// The ⋯ menu: Replace from cURL, Move up / down, Group, Duplicate, Delete.
function wireMoreMenu(card, menu, context) {
  const { moreButton, morePanel, duplicate, curl, moveUp, moveDown, remove, groupSelect } = menu;
  groupSelect.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('k6ui:request-group-changed'));
  });
  moreButton.addEventListener('click', event => {
    event.stopPropagation();
    setMorePanelOpen(card, morePanel.hidden, { focusFirst: true });
  });
  morePanel.addEventListener('keydown', event => handleMoreKeydown(card, event));
  curl.addEventListener('click', event => {
    event.stopPropagation();
    setMorePanelOpen(card, false, { focusButton: true });
    openCurlImport(card);
  });
  // Moving keeps the panel open and focus on the same item, so a keyboard user can
  // press it again.
  function afterMove(control) {
    renumberMain();
    card.parentElement.querySelectorAll('.req-card').forEach(refreshRequestSummary);
    notifyFlowChanged();
    control.focus();
    announceFlow(`${requestLabel(card)} is now request ${[...card.parentElement.children].indexOf(card) + 1}.`);
  }
  moveUp.addEventListener('click', () => {
    const previous = card.previousElementSibling;
    if (previous) card.parentElement.insertBefore(card, previous);
    afterMove(moveUp);
  });
  moveDown.addEventListener('click', () => {
    const next = card.nextElementSibling;
    if (next) card.parentElement.insertBefore(next, card);
    afterMove(moveDown);
  });
  duplicate.addEventListener('click', () => {
    setMorePanelOpen(card, false);
    const clone = reqCard([...card.parentElement.children].indexOf(card) + 1, context, '');
    for (const panelId of Object.keys(lazyPanelFactories)) ensureRequestPanel(card, panelId);
    for (const panelId of Object.keys(lazyPanelFactories)) ensureRequestPanel(clone, panelId);
    const snapshot = requestSnapshot(card);
    applySnapshot(clone, snapshot);
    card.after(clone);
    window.dispatchEvent(new CustomEvent('k6ui:refresh-request-groups', {
      detail: { preferredGroups: new Map([[clone, snapshot['.request-group-select'] || '']]) },
    }));
    renumberMain();
    refreshFlowEmptyState();
    setRequestExpanded(clone, true);
    notifyFlowChanged({ kind: 'request', id: clone.dataset.requestId });
  });
  remove.addEventListener('click', () => {
    const hadFocus = card.contains(document.activeElement);
    setMorePanelOpen(card, false);
    const neighbours = siblingsByDistance(card);
    card.remove();
    renumberMain();
    refreshFlowEmptyState();
    notifyFlowChanged();
    focusAfterRemoval(hadFocus, neighbours, '.request-expand', '#view-flow .add-req-btn');
  });
}

export function reqCard(index, context, requestId = '') {
  const card = el('article', 'req-card collapsed');
  card.dataset.context = context;
  card.dataset.requestId = requestId || createRequestId();

  const fields = buildCardHead(card, index);
  const grpcRow = buildGrpcRow();
  // {{variables}} this request sends but cannot use yet (components/variables-panel.js fills it).
  const varWarnings = el('ul', 'req-var-warnings');
  varWarnings.setAttribute('aria-label', 'Variable warnings');
  varWarnings.hidden = true;
  card.append(fields.head, varWarnings, grpcRow, el('div', 'req-card-body'));
  card.ensureRequestPanel = panelId => ensureRequestPanel(card, panelId);

  wireCardHead(card, fields, grpcRow, index);
  wireMoreMenu(card, fields.menu, context);
  return card;
}
