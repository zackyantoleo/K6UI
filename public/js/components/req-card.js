// Compact request card with one-at-a-time expansion. Its editor is built the
// first time it is needed: Headers and Body are always shown, every other part
// (checks, extraction, Save to CSV, success statuses, outcome rules, scripts)
// only when the request uses it or "+ Add to this request" adds it; "Wait after"
// sits under them. Each part fills itself lazily. One DOM for Simple and Advanced.
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
import { initMenuButton } from './menu-button.js';
import { DEFAULT_OUTCOME_FALLBACK } from '../outcomes.js';
import { createRequestId } from '../project-store.js';

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

// Any text typed in a list (checkboxes left out), e.g. a half-filled extraction row.
const typedIn = (panel, selector) => [...panel.querySelectorAll(`${selector} :is(input:not([type="checkbox"]), textarea)`)]
  .some(field => field.value.trim() !== '');

// The parts "+ Add to this request" offers, in the order they appear. `inUse`
// reads a filled section (`panel`) or, before that, the saved request; `filled`
// (default: `inUse`) says whether removing it deletes something the user typed,
// so it asks first; `start` runs when the user adds the part; `focus` is where
// the cursor goes; `clear` empties it when the user removes it.
const EXTRA_SECTIONS = [
  {
    id: 'assertions', title: 'Check the response', help: () => helpButton('check'),
    about: 'Mark it failed when the status, the body or the speed is wrong.',
    inUse: (panel, saved) => (panel ? !!panel.querySelector('.assertion-row') : (saved.assertions || []).length > 0),
    focus: '.check-template-btn',
    clear: (panel, card) => { panel.querySelector('.assertions-list').replaceChildren(); updateAssertCount(card); },
  },
  {
    id: 'extractions', title: 'Take a value from the response', help: () => helpButton('extraction'),
    about: 'Keep a token or an id, then use it as {{name}} in later requests.',
    inUse: (panel, saved) => (panel ? !!panel.querySelector('.extraction-row') : (saved.extractions || []).some(item => item?.varName)),
    filled: panel => typedIn(panel, '.extractions-list'),
    start: panel => { if (!panel.querySelector('.extraction-row')) panel.querySelector('.add-row-btn').click(); },
    focus: '.extraction-row:last-child .ext-name',
    clear: (panel, card) => { panel.querySelector('.extractions-list').replaceChildren(); updateExtCount(card); },
  },
  {
    id: 'exports', title: 'Save values to a CSV file', help: () => helpButton('saveCsv'),
    about: 'Download them after the run, or use them as test data in a later run.',
    inUse: (panel, saved) => (panel ? !!panel.querySelector('.export-block') : (saved.exports || []).some(item => item && typeof item === 'object')),
    filled: panel => typedIn(panel, '.exports-list'),
    start: panel => { if (!panel.querySelector('.export-block')) panel.querySelector('.add-export').click(); },
    focus: '.export-block:last-child .export-file',
    clear: panel => panel.querySelector('.exports-list').replaceChildren(),
  },
  {
    id: 'statuses', title: 'Success statuses', help: () => helpButton('expectedStatuses'),
    about: 'Count another status, such as 400 "sold out", as a success.',
    inUse: (panel, saved) => (panel
      ? !panel.querySelector('.check-status').checked || panel.querySelector('.expected-statuses').value !== ''
      : saved.checkStatus === false || !!saved.expectedStatuses),
    focus: '.expected-statuses',
    clear: panel => {
      panel.querySelector('.check-status').checked = true;
      panel.querySelector('.expected-statuses').value = '';
      panel.querySelector('.expected-statuses-status').textContent = '';
    },
  },
  {
    id: 'outcomes', title: 'Label each response', advanced: true, help: () => helpButton('outcomes'),
    about: 'Count success, rejected and other answers separately.',
    inUse: (panel, saved) => (panel ? !!panel.querySelector('.outcome-rule-row') : (saved.outcomes?.rules || []).length > 0),
    filled: panel => typedIn(panel, '.outcome-rules-list'),
    focus: '.outcome-template-btn',
    clear: (panel, card) => {
      panel.querySelector('.outcome-rules-list').replaceChildren();
      panel.querySelector('.outcome-fallback').value = DEFAULT_OUTCOME_FALLBACK;
      updateOutcomeCount(card);
    },
  },
  {
    id: 'scripts', title: 'Run custom code', advanced: true, help: () => helpButton('scripts'),
    about: 'JavaScript before or after the request, for what nothing else covers.',
    inUse: (panel, saved) => (panel
      ? !!(panel.querySelector('.pre-script').value || panel.querySelector('.post-script').value)
      : !!(saved.preScript || saved.postScript)),
    focus: '.pre-script',
    clear: (panel, card) => {
      panel.querySelector('.pre-script').value = '';
      panel.querySelector('.post-script').value = '';
      updateScriptCount(card);
    },
  },
];

function sectionInUse(card, definition) {
  const panel = panelOf(card, definition.id);
  return definition.inUse(panel?.dataset.panelReady === 'true' ? panel : null, card.requestState || {});
}

function sectionShell(panelId, title, help, { advanced = false, removable = false } = {}) {
  const section = document.createElement('section');
  section.className = `req-section req-section-${panelId}`;
  const head = document.createElement('div');
  head.className = 'req-section-head';
  const heading = document.createElement('h3');
  heading.className = 'req-section-title';
  heading.tabIndex = -1;
  heading.textContent = title;
  head.append(heading);
  if (help) head.appendChild(help);
  if (advanced) {
    const tag = document.createElement('span');
    tag.className = 'tag-advanced';
    tag.textContent = 'Advanced';
    head.appendChild(tag);
  }
  const count = { assertions: 'assert', extractions: 'ext', outcomes: 'outcome', scripts: 'script' }[panelId];
  if (count) {
    const badge = document.createElement('span');
    badge.className = `section-count section-count-${count}`;
    head.appendChild(badge);
  }
  if (removable) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-remove req-section-remove';
    remove.setAttribute('aria-label', `Remove "${title}" from this request`);
    remove.title = 'Remove from this request';
    head.appendChild(remove);
  }
  const panel = document.createElement('div');
  panel.className = 'req-panel';
  panel.dataset.panel = panelId;
  section.append(head, panel);
  return section;
}

// "+ Add to this request": one item per extra part; an item already shown says
// "Added" and takes the cursor to it.
function addMenu(card) {
  const wrap = document.createElement('div');
  wrap.className = 'menu-wrap req-add';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn ghost sm menu-btn req-add-btn';
  toggle.textContent = '+ Add to this request';
  const menu = document.createElement('div');
  menu.className = 'menu req-add-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Add to this request');
  menu.id = `${card.dataset.requestId}-add-menu`;
  menu.hidden = true;
  toggle.setAttribute('aria-controls', menu.id);
  for (const definition of EXTRA_SECTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item req-add-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.panel = definition.id;
    const title = document.createElement('strong');
    title.className = 'req-add-title';
    title.textContent = definition.title;
    if (definition.advanced) {
      const tag = document.createElement('span');
      tag.className = 'tag-advanced';
      tag.textContent = 'Advanced';
      title.append(' ', tag);
    }
    const added = document.createElement('span');
    added.className = 'req-add-added';
    added.textContent = 'Added';
    added.hidden = true;
    title.append(' ', added);
    const about = document.createElement('span');
    about.className = 'req-add-about';
    about.textContent = definition.about;
    item.append(title, about);
    item.addEventListener('click', () => addSection(card, definition.id));
    menu.appendChild(item);
  }
  wrap.append(toggle, menu);
  // Outside clicks are handled once for every card (initRequestMorePanels).
  card.addMenuControl = initMenuButton(toggle, menu, { closeOnOutsideClick: false });
  return wrap;
}

function syncAddMenu(card) {
  card.querySelectorAll('.req-add-item').forEach(item => {
    item.querySelector('.req-add-added').hidden = sectionOf(card, item.dataset.panel)?.hidden !== false;
  });
}

// Body: shown for a method that sends one (and gRPC, whose body is the message),
// or while it holds text, so nothing typed is ever out of sight. A body a GET
// request would not send says so. Hiding happens only on a method change or when
// the editor opens, never while the user types.
function syncBodySection(card, { allowHide = true } = {}) {
  const section = sectionOf(card, 'body');
  if (!section) return;
  const grpc = card.querySelector('.protocol').value === 'grpc';
  const method = card.querySelector('.method').value;
  const sends = grpc || BODY_METHODS.includes(method);
  const field = card.querySelector('.req-card-body .body');
  const text = field ? field.value : card.requestState?.body || '';
  if (sends || text) section.hidden = false;
  else if (allowHide) section.hidden = true;
  section.querySelector('.req-section-title').textContent = grpc ? 'Message (JSON)' : 'Body';
  const note = section.querySelector('.req-body-note');
  note.hidden = sends || !text;
  note.textContent = `A ${method} request sends no body: this text is kept but not sent.`;
}

function buildEditor(card) {
  const body = card.querySelector('.req-card-body');
  const main = document.createElement('div');
  main.className = 'req-main-sections';
  const headers = sectionShell('headers', 'Headers');
  const bodySection = sectionShell('body', 'Body');
  const note = document.createElement('p');
  note.className = 'ext-hint req-body-note';
  note.hidden = true;
  bodySection.appendChild(note);
  bodySection.addEventListener('input', () => syncBodySection(card, { allowHide: false }));
  main.append(headers, bodySection);

  const extras = document.createElement('div');
  extras.className = 'req-extra-sections';
  for (const definition of EXTRA_SECTIONS) {
    const section = sectionShell(definition.id, definition.title, definition.help(), {
      advanced: definition.advanced, removable: true,
    });
    section.hidden = true;
    section.querySelector('.req-section-remove').addEventListener('click', () => removeSection(card, definition.id));
    extras.appendChild(section);
  }

  const foot = document.createElement('div');
  foot.className = 'req-editor-foot';
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
  wait.append(waitLabel, helpButton('pause'));
  foot.append(addMenu(card), wait);

  body.append(main, extras, foot);
  body.dataset.editorReady = 'true';
}

function ensureEditor(card) {
  if (card.querySelector('.req-card-body')?.dataset.editorReady !== 'true') buildEditor(card);
}

// Headers and Body, then every part the request uses (a part, once shown, stays
// until the user removes it).
function syncSections(card) {
  ensureRequestPanel(card, 'headers');
  ensureRequestPanel(card, 'body');
  for (const definition of EXTRA_SECTIONS) {
    const section = sectionOf(card, definition.id);
    if (section.hidden && sectionInUse(card, definition)) {
      ensureRequestPanel(card, definition.id);
      section.hidden = false;
    }
  }
  syncBodySection(card);
  syncAddMenu(card);
}

function addSection(card, panelId) {
  const definition = EXTRA_SECTIONS.find(item => item.id === panelId);
  const section = sectionOf(card, panelId);
  const panel = ensureRequestPanel(card, panelId);
  if (section.hidden) {
    section.hidden = false;
    definition.start?.(panel);
    syncAddMenu(card);
  }
  (section.querySelector(definition.focus) || section.querySelector('.req-section-title')).focus();
}

function removeSection(card, panelId) {
  const definition = EXTRA_SECTIONS.find(item => item.id === panelId);
  const panel = panelOf(card, panelId);
  if ((definition.filled || definition.inUse)(panel, {})
    && !window.confirm(`Remove "${definition.title}" from this request? What it holds is deleted.`)) return;
  definition.clear(panel, card);
  sectionOf(card, panelId).hidden = true;
  syncAddMenu(card);
  panel.dispatchEvent(new Event('change', { bubbles: true }));
  card.querySelector('.req-add-btn').focus();
}

// A value taken from the Send once response: one more row in "Take a value from the
// response" (shown if it was not), or the empty row a user added and left blank.
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
  sectionOf(card, 'extractions').hidden = false;
  syncAddMenu(card);
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

// Called once at startup (app.js). Also closes an open "+ Add to this request"
// menu on a click outside it: one listener for every card, so cards that are
// replaced (opening a project) leave nothing behind.
export function initRequestMorePanels() {
  const closeOthers = event => {
    document.querySelectorAll('.req-more-panel:not([hidden])').forEach(panel => {
      if (!panel.closest('.req-more').contains(event.target)) setMorePanelOpen(panel.closest('.req-card'), false);
    });
  };
  document.addEventListener('click', closeOthers);
  document.addEventListener('focusin', closeOthers);
  document.addEventListener('click', event => {
    document.querySelectorAll('.req-add-menu:not([hidden])').forEach(menu => {
      if (!menu.closest('.req-add').contains(event.target)) menu.closest('.req-card')?.addMenuControl?.close();
    });
  });
}

export function requestLabel(card) {
  return card.querySelector('.request-name-preview')?.textContent || 'The request';
}

// Screen readers hear where a moved request went (drag and drop, Move up/down).
export function announceFlow(message) {
  const region = document.querySelector('#flow-announcer');
  if (region) region.textContent = message;
}

export function reqCard(index, context, requestId = '') {
  const card = document.createElement('article');
  card.className = 'req-card collapsed';
  card.dataset.context = context;
  card.dataset.requestId = requestId || createRequestId();

  const head = document.createElement('div');
  head.className = 'req-card-head';
  const num = document.createElement('span');
  num.className = 'req-num';
  num.textContent = `#${index + 1}`;
  const { nameInput } = createBasicFields(index);
  const namePreview = document.createElement('strong');
  namePreview.className = 'request-name-preview';
  namePreview.textContent = `Request ${index + 1}`;
  namePreview.setAttribute('aria-hidden', 'true');
  const protocol = document.createElement('select');
  protocol.className = 'protocol';
  protocol.setAttribute('aria-label', `Request ${index + 1} protocol`);
  for (const [value, label] of [['http', 'HTTP'], ['grpc', 'gRPC']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    protocol.appendChild(option);
  }
  const method = document.createElement('select');
  method.className = 'method';
  method.setAttribute('aria-label', `Request ${index + 1} method`);
  for (const value of METHODS) {
    const option = document.createElement('option');
    option.value = option.textContent = value;
    method.appendChild(option);
  }
  const methodPreview = document.createElement('span');
  methodPreview.className = 'method-badge request-method-preview m-GET';
  methodPreview.textContent = 'GET';
  methodPreview.setAttribute('aria-hidden', 'true');
  // One visible method list: the HTTP methods plus gRPC. The protocol and method
  // selects stay (hidden) as the values the rest of the app reads.
  const kind = document.createElement('select');
  kind.className = 'request-kind';
  kind.setAttribute('aria-label', `Request ${index + 1} method`);
  for (const value of METHODS) {
    const option = document.createElement('option');
    option.value = option.textContent = value;
    kind.appendChild(option);
  }
  const otherProtocols = document.createElement('optgroup');
  otherProtocols.label = 'Other protocol';
  const grpcOption = document.createElement('option');
  grpcOption.value = 'grpc';
  grpcOption.textContent = 'gRPC';
  otherProtocols.appendChild(grpcOption);
  kind.appendChild(otherProtocols);
  const handle = document.createElement('span');
  handle.className = 'req-drag-handle';
  handle.draggable = true;
  handle.title = 'Drag to move this request (keyboard: ⋯ → Move up / Move down)';
  handle.setAttribute('aria-hidden', 'true');
  const groupSelect = document.createElement('select');
  groupSelect.className = 'request-group-select';
  groupSelect.setAttribute('aria-label', `Request ${index + 1} group`);
  const ungroupedOption = document.createElement('option');
  ungroupedOption.value = '';
  ungroupedOption.textContent = 'No group';
  groupSelect.appendChild(ungroupedOption);
  const url = document.createElement('input');
  url.className = 'url';
  url.placeholder = 'https://api.example.com/endpoint';
  url.setAttribute('aria-label', `Request ${index + 1} URL`);
  const preview = document.createElement('span');
  preview.className = 'req-url-preview empty';
  preview.textContent = 'No URL yet';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'request-enabled-label';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'request-enabled';
  enabled.checked = true;
  enabled.className = 'request-enabled switch-input';
  const enabledText = document.createElement('span');
  enabledText.className = 'sr-only';
  enabledText.textContent = 'Enabled';
  enabledLabel.append(enabled, enabledText);
  const actions = document.createElement('div');
  actions.className = 'req-card-actions';
  // ⋯ holds the actions a request needs now and then; the row keeps on/off and open/close.
  const more = document.createElement('div');
  more.className = 'req-more';
  const moreButton = button(`More actions for request ${index + 1}`, 'req-action-btn request-more', '⋯');
  const morePanel = document.createElement('div');
  morePanel.className = 'req-more-panel';
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
  const groupLabel = document.createElement('label');
  groupLabel.className = 'request-group-label';
  const groupCaption = document.createElement('span');
  groupCaption.textContent = 'Group';
  groupLabel.append(groupCaption, groupSelect);
  morePanel.append(duplicate, curl, moveUp, moveDown, groupLabel, remove);
  more.append(moreButton, morePanel);
  const expand = button(`Expand request ${index + 1}`, 'req-action-btn request-expand', '▾');
  expand.setAttribute('aria-expanded', 'false');
  actions.append(more, expand);
  // "Send once" (components/send-once.js): sends this request one time and shows the response.
  const send = document.createElement('div');
  send.className = 'req-send';
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'btn ghost sm req-send-once';
  sendButton.dataset.icon = 'play';
  sendButton.textContent = 'Send once';
  send.append(sendButton, helpButton('sendOnce'));
  head.append(handle, num, namePreview, methodPreview, nameInput, protocol, method, kind, url, send, preview, enabledLabel, actions);

  const grpcRow = document.createElement('div');
  grpcRow.className = 'grpc-row hidden';
  const grpcLabel = document.createElement('span');
  grpcLabel.className = 'grpc-label';
  grpcLabel.textContent = 'gRPC';
  const grpcMethod = document.createElement('input');
  grpcMethod.className = 'grpc-method';
  grpcMethod.placeholder = 'package.Service/Method';
  const plaintextLabel = document.createElement('label');
  plaintextLabel.className = 'opt-label';
  const plaintext = document.createElement('input');
  plaintext.type = 'checkbox';
  plaintext.className = 'grpc-plaintext';
  plaintextLabel.append(plaintext, ' Plaintext (no TLS)');
  grpcRow.append(grpcLabel, grpcMethod, plaintextLabel);

  // {{variables}} this request sends but cannot use yet (components/variables-panel.js fills it).
  const varWarnings = document.createElement('ul');
  varWarnings.className = 'req-var-warnings';
  varWarnings.setAttribute('aria-label', 'Variable warnings');
  varWarnings.hidden = true;

  const body = document.createElement('div');
  body.className = 'req-card-body';
  card.append(head, varWarnings, grpcRow, body);
  card.ensureRequestPanel = panelId => ensureRequestPanel(card, panelId);

  function syncProtocol() {
    const grpc = protocol.value === 'grpc';
    method.classList.toggle('hidden', grpc);
    grpcRow.classList.toggle('hidden', !grpc);
    url.placeholder = grpc ? 'host:port — e.g. localhost:50051' : 'https://api.example.com/endpoint';
  }
  function syncKind() {
    kind.value = protocol.value === 'grpc' ? 'grpc' : method.value;
  }
  function syncPreview() {
    syncKind();
    const position = card.parentElement ? [...card.parentElement.children].indexOf(card) + 1 : index + 1;
    namePreview.textContent = nameInput.value.trim() || `Request ${position}`;
    const summaryMethod = protocol.value === 'grpc' ? 'gRPC' : method.value;
    methodPreview.textContent = summaryMethod;
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
  groupSelect.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('k6ui:request-group-changed'));
  });
  kind.addEventListener('change', () => {
    const toGrpc = kind.value === 'grpc';
    if (!toGrpc) method.value = kind.value;
    if (toGrpc !== (protocol.value === 'grpc')) {
      protocol.value = toGrpc ? 'grpc' : 'http';
      protocol.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (!toGrpc) method.dispatchEvent(new Event('change', { bubbles: true }));
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
  syncProtocol();
  syncPreview();
  syncEnabled();
  return card;
}
