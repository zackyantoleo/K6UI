// Build Flow: the "Variables you can use" panel and the variable warnings on the
// request cards. Both come from one reading of the page (readFlowVariables:
// cards, groups, global variables and headers, data files), taken without
// opening any request editor, and from public/js/variables.js, so they say what
// the generated script does. One DOM for Simple and Advanced: the panel sits
// beside the request list (Simple, wide screens), above it (narrow screens) or
// above the selected editor (Advanced); flow.css places it. Names are DOM text.
import { readRequestSettings } from './advanced-notice.js';
import { collectRequestGroups } from './request-groups.js';
import { helpButton } from './help-tips.js';
import { dataFileColumns } from '../data-files.js';
import { hasOutcomeRules } from '../outcomes.js';
import { navigate } from '../nav.js';
import {
  VARIABLE_NAME, describeIssue, globalVariableName, variableCatalog, variableIssues, variableUsage,
} from '../variables.js';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// ── Reading the page ───────────────────────────────────────────
const panelReady = (card, panelId) =>
  card.querySelector(`.req-panel[data-panel="${panelId}"]`)?.dataset.panelReady === 'true';

const headerRows = rows => rows.map(row => ({
  key: row.querySelector('.h-key').value,
  value: row.querySelector('.h-val').value,
}));

// One card as public/js/variables.js reads a request: a filled editor part is the
// live truth, a part never opened falls back to the saved request.
function readRequest(card) {
  const saved = card.requestState || {};
  const settings = readRequestSettings(card);
  const field = selector => card.querySelector(selector);
  return {
    id: card.dataset.requestId,
    name: field('.request-name')?.value || '',
    enabled: settings.enabled,
    groupId: settings.groupId,
    type: settings.type,
    method: field('.method')?.value || 'GET',
    url: field('.url')?.value || '',
    grpcMethod: field('.grpc-method')?.value || '',
    headers: panelReady(card, 'headers')
      ? headerRows([...card.querySelectorAll('.req-card-body .headers-list .header-row')])
      : saved.headers || [],
    body: panelReady(card, 'body') ? field('.req-card-body .body').value : saved.body || '',
    extractions: settings.extractions,
    preScript: settings.preScript,
    postScript: settings.postScript,
    hasOutcomes: hasOutcomeRules(settings.outcomes),
    exportValues: panelReady(card, 'exports')
      ? [...card.querySelectorAll('.req-card-body .exports-list .export-col-value')].map(input => input.value)
      : (saved.exports || []).flatMap(exp => (exp?.columns || []).map(column => column?.value)),
  };
}

// The flow as public/js/variables.js describes it. It never fills a lazy editor part
// and never builds the whole project config, so it is cheap enough per keystroke.
export function readFlowVariables() {
  return {
    variables: [...document.querySelectorAll('#global-vars-list .var-row')].map(row => ({
      key: row.querySelector('.var-key').value,
      value: row.querySelector('.var-val').value,
    })),
    dataFiles: dataFileColumns(),
    groups: collectRequestGroups(),
    globalHeaders: headerRows([...document.querySelectorAll('#global-headers-list .header-row')]),
    requests: [...document.querySelectorAll('#reqs-main > .req-card')].map(readRequest),
  };
}

// "Used in" beside each global variable on the Test data page.
function usageText(key, usage) {
  const name = globalVariableName(key);
  if (!name) return '';
  if (!VARIABLE_NAME.test(name)) return 'Not a usable name';
  const count = usage.get(name) ?? 0;
  return count ? `Used in ${count} request${count === 1 ? '' : 's'}` : 'Not used yet';
}

function renderUsage(flow) {
  const usage = variableUsage(flow);
  for (const row of document.querySelectorAll('#global-vars-list .var-row')) {
    const slot = row.querySelector('.var-used');
    const value = usageText(row.querySelector('.var-key').value, usage);
    if (slot && slot.textContent !== value) slot.textContent = value;
  }
}

// ── Panel ──────────────────────────────────────────────────────
function viewLink(text, view) {
  const link = node('button', 'flow-vars-link', text);
  link.type = 'button';
  link.addEventListener('click', () => navigate(view));
  return link;
}

export function createVariablesPanel() {
  const panel = node('aside', 'flow-vars');
  panel.id = 'flow-vars';
  panel.setAttribute('aria-labelledby', 'flow-vars-label');
  const head = node('div', 'flow-vars-head');
  const title = node('h3', 'flow-vars-title');
  const toggle = node('button', 'flow-vars-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-controls', 'flow-vars-body');
  const label = node('span', 'flow-vars-label', 'Variables you can use');
  label.id = 'flow-vars-label';
  const count = node('span', 'flow-vars-count');
  toggle.append(label, count);
  title.appendChild(toggle);
  head.append(title, helpButton('variable'));

  const body = node('div', 'flow-vars-body');
  body.id = 'flow-vars-body';
  const hint = node('p', 'flow-vars-hint');
  hint.append('Type ', node('code', '', '{{'), ' in a URL, header or body to pick one, drag one into a field, or click one to copy it.');
  const groups = node('div', 'flow-vars-groups');
  const empty = node('p', 'flow-vars-empty',
    'None yet. Add a global variable or a data file, or keep a value from a response with "+ Add to this request" → Take a value from the response.');
  empty.hidden = true;
  const status = node('p', 'flow-vars-status');
  status.setAttribute('role', 'status');
  const foot = node('p', 'flow-vars-foot');
  foot.append('Edit: ', viewLink('Variables', 'vars'), ' · ', viewLink('CSV data files', 'datafiles'));
  body.append(hint, groups, empty, status, foot);
  panel.append(head, body);

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  });
  groups.addEventListener('click', event => {
    const chip = event.target instanceof Element ? event.target.closest('.var-chip') : null;
    if (chip) copyVariable(chip, status);
  });
  groups.addEventListener('keydown', event => moveChipFocus(groups, event));
  groups.addEventListener('focusin', event => {
    if (event.target.matches?.('.var-chip')) setCurrentChip(groups, event.target);
  });
  groups.addEventListener('dragstart', event => {
    const chip = event.target instanceof Element ? event.target.closest('.var-chip') : null;
    if (!chip) return;
    event.dataTransfer.setData('text/plain', `{{${chip.dataset.var}}}`);
    event.dataTransfer.effectAllowed = 'copy';
  });
  return panel;
}

let statusTimer = 0;
function say(status, message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ''; }, 4000);
}

// The clipboard API first; the older copy command where it is not allowed (a page
// served over plain http from another machine).
async function copyText(text, returnFocus) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = node('textarea', 'sr-only');
    area.value = text;
    area.setAttribute('aria-hidden', 'true');
    document.body.appendChild(area);
    area.select();
    let done = false;
    try { done = document.execCommand('copy'); } catch { done = false; }
    area.remove();
    returnFocus?.focus();
    return done;
  }
}

async function copyVariable(chip, status) {
  const text = `{{${chip.dataset.var}}}`;
  const copied = await copyText(text, chip);
  say(status, copied
    ? `Copied ${text}. Paste it into a URL, header or body.`
    : `Could not copy. Drag ${text} into a field, or type {{ there and pick it.`);
}

// The chips are one Tab stop; arrow keys, Home and End move between them.
function setCurrentChip(groups, current) {
  groups.querySelectorAll('.var-chip').forEach(chip => { chip.tabIndex = chip === current ? 0 : -1; });
}

function moveChipFocus(groups, event) {
  const chips = [...groups.querySelectorAll('.var-chip')];
  const index = chips.indexOf(event.target);
  if (index === -1) return;
  const next = {
    ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: chips.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  const target = chips[Math.max(0, Math.min(chips.length - 1, next))];
  setCurrentChip(groups, target);
  target.focus();
}

function chip(name, kind, detail = '') {
  const button = node('button', `var-chip var-chip-${kind}`);
  button.type = 'button';
  button.draggable = true;
  button.dataset.var = name;
  button.title = 'Click to copy, or drag into a field';
  button.append(node('span', 'var-chip-name', `{{${name}}}`));
  if (detail) button.append(' ', node('small', 'var-chip-detail', detail));
  return button;
}

function chipGroup(title, chips, { note = '', help = null } = {}) {
  const section = node('section', 'flow-vars-group');
  const heading = node('h4', 'flow-vars-group-title');
  heading.append(node('span', '', title));
  if (help) heading.append(help);
  section.append(heading);
  if (note) section.append(node('p', 'flow-vars-note', note));
  const list = node('div', 'var-chips');
  list.append(...chips);
  section.append(list);
  return section;
}

function renderPanel(panel, catalog) {
  const key = JSON.stringify(catalog);
  if (panel.dataset.key === key) return;
  panel.dataset.key = key;
  const groups = panel.querySelector('.flow-vars-groups');
  const focused = groups.contains(document.activeElement) ? document.activeElement.dataset.var : null;
  const sections = [];
  if (catalog.globals.length) {
    sections.push(chipGroup('Global variables', catalog.globals.map(name => chip(name, 'global'))));
  }
  for (const file of catalog.files) {
    sections.push(chipGroup(`Each row of ${file.label}`, file.columns.map(name => chip(name, 'column')), {
      note: file.groupName ? `Read when the group ${file.groupName} starts.` : '',
    }));
  }
  if (catalog.extracted.length) {
    sections.push(chipGroup('From responses',
      catalog.extracted.map(item => chip(item.name, 'extracted', `after #${item.number}`))));
  }
  if (catalog.scripts.length) {
    sections.push(chipGroup('Set by custom code',
      catalog.scripts.map(item => chip(item.name, 'script', `${item.when} #${item.number}`))));
  }
  if (catalog.builtIn.length) {
    sections.push(chipGroup('Built in',
      catalog.builtIn.map(item => chip(item.name, 'builtin', `after #${item.number}`)), { help: helpButton('outcomeVariable') }));
  }
  groups.replaceChildren(...sections);
  const chips = [...groups.querySelectorAll('.var-chip')];
  const current = chips.find(item => item.dataset.var === focused) || chips[0];
  if (current) setCurrentChip(groups, current);
  if (focused && current) current.focus();
  panel.querySelector('.flow-vars-empty').hidden = catalog.count > 0;
  panel.querySelector('.flow-vars-count').textContent = String(catalog.count);
}

// ── Warnings on the request cards ──────────────────────────────
// Collapsed card: one chip per name, the reason in its title and for screen
// readers. Open card: the same list with the reason written out (flow.css).
function renderWarnings(issues) {
  for (const card of document.querySelectorAll('#reqs-main > .req-card')) {
    const list = card.querySelector(':scope > .req-var-warnings');
    if (!list) continue;
    const items = (issues.get(card.dataset.requestId) || []).map(issue => ({ kind: issue.kind, ...describeIssue(issue) }));
    const key = items.map(item => `${item.kind}|${item.text}|${item.detail}`).join('\n');
    if (list.dataset.key === key) continue;
    list.dataset.key = key;
    list.replaceChildren(...items.map(item => {
      const entry = node('li', `var-warning var-warning-${item.kind}`);
      entry.title = item.detail;
      const short = node('span', 'var-warning-text', item.text);
      short.dataset.icon = 'alert';
      entry.append(short, ' ', node('span', 'var-warning-detail', item.detail));
      return entry;
    }));
    list.hidden = !items.length;
    card.classList.toggle('has-var-warnings', items.length > 0);
  }
}

// Called once at startup (app.js), after buildFlowView().
export function initVariablesPanel() {
  const panel = document.querySelector('#flow-vars');
  let pending = false;
  function render() {
    pending = false;
    const flow = readFlowVariables();
    if (panel) renderPanel(panel, variableCatalog(flow));
    renderWarnings(variableIssues(flow));
    renderUsage(flow);
  }
  function schedule() {
    if (pending) return;
    pending = true;
    queueMicrotask(render);
  }
  // Clicks cover removed rows and template buttons, which fire no input event.
  for (const selector of ['#view-flow', '#view-data']) {
    const view = document.querySelector(selector);
    for (const type of ['input', 'change', 'click']) view?.addEventListener(type, schedule);
  }
  for (const type of ['k6ui:flow-changed', 'k6ui:project-applied', 'k6ui:request-group-changed', 'k6ui:data-sets-changed']) {
    window.addEventListener(type, schedule);
  }
  schedule();
}
