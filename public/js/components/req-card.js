// Compact request card with one-at-a-time expansion and lazy feature panels.
import { headerRow, extractionRow } from './rows.js';
import { exportBlock, readExportBlock } from './export-rows.js';
import {
  updateExtCount,
  updateAssertCount,
  updateScriptCount,
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
import { createScriptsPanel } from './request-editor/scripts.js';
import { createAdvancedPanel } from './request-editor/advanced.js';
import { createRequestId } from '../project-store.js';

export { assertionRow };
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

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
  if (expanded) ensureRequestPanel(card, card.dataset.activePanel || 'headers');
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

function activateTab(card, panelId, { focus = false } = {}) {
  card.dataset.activePanel = panelId;
  let activeTab = null;
  card.querySelectorAll('.req-tab').forEach(tab => {
    const active = tab.dataset.tab === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) activeTab = tab;
  });
  card.querySelectorAll('.req-tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.panel !== panelId);
  });
  ensureRequestPanel(card, panelId);
  if (focus) activeTab?.focus();
}

function handleTabKeydown(card, event) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...card.querySelectorAll('.req-tab')];
  const current = tabs.indexOf(event.currentTarget);
  if (current === -1) return;
  event.preventDefault();
  let next = current;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  activateTab(card, tabs[next].dataset.tab, { focus: true });
}

function panelContent(factory, card) {
  return factory({
    onExtCount: () => updateExtCount(card),
    onAssertCount: () => updateAssertCount(card),
    onScriptCount: () => updateScriptCount(card),
  });
}

const lazyPanelFactories = {
  headers: () => createHeadersPanel(),
  body: () => createBodyPanel(),
  extractions: ({ onExtCount }) => createExtractPanel(onExtCount),
  assertions: ({ onAssertCount }) => createChecksPanel(onAssertCount),
  scripts: ({ onScriptCount }) => createScriptsPanel(onScriptCount),
  options: () => createAdvancedPanel(),
};

export function ensureRequestPanel(card, panelId) {
  const panel = card.querySelector(`.req-tab-panel[data-panel="${panelId}"]`);
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
      const exportsList = panel.querySelector('.exports-list');
      for (const exp of request.exports || []) {
        if (exp && typeof exp === 'object') exportsList.appendChild(exportBlock(exp));
      }
      updateExtCount(card);
    } else if (panelId === 'assertions') {
      const list = panel.querySelector('.assertions-list');
      for (const check of request.assertions || []) {
        list.appendChild(assertionRow(check.type, check.value, check.value2, () => updateAssertCount(card)));
      }
      updateAssertCount(card);
    } else if (panelId === 'scripts') {
      panel.querySelector('.pre-script').value = request.preScript || '';
      panel.querySelector('.post-script').value = request.postScript || '';
      updateScriptCount(card);
    } else if (panelId === 'options') {
      panel.querySelector('.check-status').checked = request.checkStatus !== false;
      panel.querySelector('.sleep').value = request.sleepAfter ?? 1;
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
    '.body', '.check-status', '.sleep', '.pre-script', '.post-script', '.request-enabled',
    '.request-group-select',
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
  return snapshot;
}

function applySnapshot(card, snapshot) {
  const requiredPanels = {
    '.body': 'body',
    '.check-status': 'options',
    '.sleep': 'options',
    '.pre-script': 'scripts',
    '.post-script': 'scripts',
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
    ensureRequestPanel(card, 'extractions').querySelector('.exports-list').appendChild(exportBlock(exp));
  }
  for (const [type, value, value2] of snapshot.assertions) {
    ensureRequestPanel(card, 'assertions').querySelector('.assertions-list')
      .appendChild(assertionRow(type, value, value2, () => updateAssertCount(card)));
  }
  card.querySelector('.protocol').dispatchEvent(new Event('change'));
  card.querySelector('.url').dispatchEvent(new Event('input'));
  updateExtCount(card);
  updateAssertCount(card);
  updateScriptCount(card);
}

export function reqCard(index, context, requestId = '') {
  const card = document.createElement('article');
  card.className = 'req-card collapsed';
  card.dataset.context = context;
  card.dataset.requestId = requestId || createRequestId();
  card.dataset.activePanel = 'headers';

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
  enabledLabel.append(enabled, ' Enabled');
  const actions = document.createElement('div');
  actions.className = 'req-card-actions';
  const moveUp = button(`Move request ${index + 1} up`, 'req-action-btn request-move-up', '↑');
  const moveDown = button(`Move request ${index + 1} down`, 'req-action-btn request-move-down', '↓');
  const duplicate = button(`Duplicate request ${index + 1}`, 'req-action-btn request-duplicate', 'Duplicate');
  const curl = button(`Import cURL into request ${index + 1}`, 'req-action-btn curl', 'cURL');
  const expand = button(`Expand request ${index + 1}`, 'req-action-btn request-expand', '▾');
  expand.setAttribute('aria-expanded', 'false');
  const remove = button(`Remove request ${index + 1}`, 'req-action-btn del', '✕');
  actions.append(moveUp, moveDown, duplicate, curl, expand, remove);
  // The icon says "group"; the select keeps its own accessible name.
  const groupLabel = document.createElement('label');
  groupLabel.className = 'request-group-label';
  groupLabel.dataset.icon = 'folder';
  groupLabel.title = 'Request group';
  groupLabel.appendChild(groupSelect);
  head.append(num, namePreview, methodPreview, nameInput, protocol, method, url, preview, groupLabel, enabledLabel, actions);

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

  const body = document.createElement('div');
  body.className = 'req-card-body';
  const tabs = document.createElement('div');
  tabs.className = 'req-tabs';
  tabs.setAttribute('role', 'tablist');
  const definitions = [
    ['headers', 'Headers'], ['body', 'Body'], ['extractions', 'Extract'],
    ['assertions', 'Checks'], ['scripts', 'Scripts'], ['options', 'Advanced'],
  ];
  for (const [panelId, label] of definitions) {
    const tab = button(`${label} settings`, `req-tab${panelId === 'headers' ? ' active' : ''}`, label);
    const idBase = `${card.dataset.requestId}-${panelId}`;
    tab.dataset.tab = panelId;
    tab.id = `${idBase}-tab`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(panelId === 'headers'));
    tab.setAttribute('aria-controls', `${idBase}-panel`);
    tab.tabIndex = panelId === 'headers' ? 0 : -1;
    if (panelId === 'extractions' || panelId === 'assertions' || panelId === 'scripts') {
      const count = document.createElement('span');
      count.className = `tab-count tab-count-${panelId === 'extractions' ? 'ext' : panelId === 'assertions' ? 'assert' : 'script'}`;
      tab.append(' ', count);
    }
    tab.addEventListener('click', () => activateTab(card, panelId));
    tab.addEventListener('keydown', event => handleTabKeydown(card, event));
    tabs.appendChild(tab);
    const panel = document.createElement('div');
    panel.className = `req-tab-panel${panelId === 'headers' ? '' : ' hidden'}`;
    panel.dataset.panel = panelId;
    panel.id = `${idBase}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    body.appendChild(panel);
  }
  body.prepend(tabs);
  card.append(head, grpcRow, body);
  card.ensureRequestPanel = panelId => ensureRequestPanel(card, panelId);

  function syncProtocol() {
    const grpc = protocol.value === 'grpc';
    method.classList.toggle('hidden', grpc);
    grpcRow.classList.toggle('hidden', !grpc);
    url.placeholder = grpc ? 'host:port — e.g. localhost:50051' : 'https://api.example.com/endpoint';
  }
  function syncPreview() {
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
  nameInput.addEventListener('input', syncPreview);
  url.addEventListener('input', syncPreview);
  enabled.addEventListener('change', syncEnabled);
  groupSelect.addEventListener('change', () => {
    window.dispatchEvent(new CustomEvent('k6ui:request-group-changed'));
  });
  curl.addEventListener('click', event => { event.stopPropagation(); openCurlImport(card); });
  expand.addEventListener('click', event => {
    event.stopPropagation();
    setRequestExpanded(card, !card.classList.contains('expanded'));
  });
  head.addEventListener('click', event => {
    // Simple: a click on a closed card's summary opens it (the chevron closes it).
    // Advanced always shows the selected request's editor.
    if (document.documentElement.dataset.uiMode === 'advanced' || card.classList.contains('expanded')) return;
    if (!event.target.closest('button, input, select, label')) setRequestExpanded(card, true);
  });
  moveUp.addEventListener('click', () => {
    const previous = card.previousElementSibling;
    if (previous) card.parentElement.insertBefore(card, previous);
    renumberMain();
    card.parentElement.querySelectorAll('.req-card').forEach(refreshRequestSummary);
    notifyFlowChanged();
  });
  moveDown.addEventListener('click', () => {
    const next = card.nextElementSibling;
    if (next) card.parentElement.insertBefore(next, card);
    renumberMain();
    card.parentElement.querySelectorAll('.req-card').forEach(refreshRequestSummary);
    notifyFlowChanged();
  });
  duplicate.addEventListener('click', () => {
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
