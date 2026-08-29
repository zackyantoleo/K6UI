// Compact request card with one-at-a-time expansion and lazy feature panels.
import { headerRow, extractionRow } from './rows.js';
import {
  updateExtCount,
  updateAssertCount,
  updateScriptCount,
  renumberMain,
  refreshFlowEmptyState,
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

function button(label, className, text) {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.setAttribute('aria-label', label);
  control.title = label;
  control.textContent = text;
  return control;
}

function buildSubReqSection(position) {
  const isPost = position === 'post';
  const wrapper = document.createElement('div');
  wrapper.className = `subreq-section subreq-${position}`;
  const addButton = button(`Add ${isPost ? 'after' : 'before'} request`, 'add-subreq-btn', `+ ${isPost ? 'After' : 'Before'} request`);
  const form = document.createElement('div');
  form.className = 'subreq-form hidden';

  const mainRow = document.createElement('div');
  mainRow.className = 'subreq-main-row';
  const method = document.createElement('select');
  method.className = 'sr-method';
  for (const value of METHODS) {
    const option = document.createElement('option');
    option.value = option.textContent = value;
    method.appendChild(option);
  }
  const url = document.createElement('input');
  url.className = 'sr-url';
  url.placeholder = isPost ? 'Cleanup / logout URL' : 'Setup / authentication URL';
  const remove = button(`Remove ${isPost ? 'after' : 'before'} request`, 'row-remove', '×');
  mainRow.append(method, url, remove);

  const detailsButton = button(`Show ${isPost ? 'after' : 'before'} request details`, 'subreq-expand', 'Headers, body & extraction');
  detailsButton.setAttribute('aria-expanded', 'false');
  const details = document.createElement('div');
  details.className = 'subreq-details hidden';
  const headers = document.createElement('div');
  headers.className = 'sr-headers-list';
  const addHeader = button('Add sub-request header', 'add-row-btn', '+ Header');
  addHeader.addEventListener('click', () => headers.appendChild(headerRow()));
  const body = document.createElement('textarea');
  body.className = 'sr-body';
  body.placeholder = 'Optional request body';
  const extracts = document.createElement('div');
  extracts.className = 'sr-extractions-list';
  const addExtract = button('Add sub-request extraction', 'add-row-btn', '+ Extract Variable');
  addExtract.addEventListener('click', () => extracts.appendChild(extractionRow()));
  details.append(headers, addHeader, body, extracts, addExtract);
  form.append(mainRow, detailsButton, details);
  wrapper.append(addButton, form);

  addButton.addEventListener('click', () => {
    addButton.classList.add('hidden');
    form.classList.remove('hidden');
    url.focus();
  });
  detailsButton.addEventListener('click', () => {
    const expanded = details.classList.toggle('hidden') === false;
    detailsButton.classList.toggle('active', expanded);
    detailsButton.setAttribute('aria-expanded', String(expanded));
  });
  remove.addEventListener('click', () => {
    method.value = 'GET';
    url.value = '';
    headers.replaceChildren();
    body.value = '';
    extracts.replaceChildren();
    details.classList.add('hidden');
    detailsButton.classList.remove('active');
    detailsButton.setAttribute('aria-expanded', 'false');
    form.classList.add('hidden');
    addButton.classList.remove('hidden');
  });
  return wrapper;
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
        if (!extraction.varName) continue;
        const row = extractionRow();
        row.querySelector('.ext-name').value = extraction.varName;
        row.querySelector('.ext-source').value = extraction.source || 'json';
        row.querySelector('.ext-selector').value = extraction.selector || '';
        row.querySelector('.ext-source').dispatchEvent(new Event('change'));
        list.appendChild(row);
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
  snapshot.extractions = [...card.querySelectorAll('.req-card-body .extraction-row')].map(row => [
    row.querySelector('.ext-name').value,
    row.querySelector('.ext-source').value,
    row.querySelector('.ext-selector').value,
  ]);
  snapshot.assertions = [...card.querySelectorAll('.req-card-body .assertion-row')].map(row => [
    row.querySelector('.assert-type').value,
    row.querySelector('.assert-val').value,
    row.querySelector('.assert-val2').value,
  ]);
  snapshot.subRequests = {};
  for (const position of ['pre', 'post']) {
    const form = card.querySelector(`.subreq-${position} .subreq-form`);
    if (!form || form.classList.contains('hidden')) continue;
    snapshot.subRequests[position] = {
      method: form.querySelector('.sr-method').value,
      url: form.querySelector('.sr-url').value,
      body: form.querySelector('.sr-body').value,
      headers: [...form.querySelectorAll('.header-row')].map(row => [
        row.querySelector('.h-key').value,
        row.querySelector('.h-val').value,
      ]),
      extractions: [...form.querySelectorAll('.extraction-row')].map(row => [
        row.querySelector('.ext-name').value,
        row.querySelector('.ext-source').value,
        row.querySelector('.ext-selector').value,
      ]),
    };
  }
  return snapshot;
}

function applySubRequestSnapshot(card, position, snapshot) {
  if (!snapshot) return;
  const section = card.querySelector(`.subreq-${position}`);
  section.querySelector('.add-subreq-btn').classList.add('hidden');
  const form = section.querySelector('.subreq-form');
  form.classList.remove('hidden');
  form.querySelector('.sr-method').value = snapshot.method;
  form.querySelector('.sr-url').value = snapshot.url;
  form.querySelector('.sr-body').value = snapshot.body;
  const headers = form.querySelector('.sr-headers-list');
  for (const [key, value] of snapshot.headers) headers.appendChild(headerRow(key, value));
  const extracts = form.querySelector('.sr-extractions-list');
  for (const [name, source, selector] of snapshot.extractions) {
    const row = extractionRow();
    row.querySelector('.ext-name').value = name;
    row.querySelector('.ext-source').value = source;
    row.querySelector('.ext-selector').value = selector;
    row.querySelector('.ext-source').dispatchEvent(new Event('change'));
    extracts.appendChild(row);
  }
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
  for (const [name, source, selector] of snapshot.extractions) {
    const row = extractionRow();
    row.querySelector('.ext-name').value = name;
    row.querySelector('.ext-source').value = source;
    row.querySelector('.ext-selector').value = selector;
    row.querySelector('.ext-source').dispatchEvent(new Event('change'));
    ensureRequestPanel(card, 'extractions').querySelector('.extractions-list').appendChild(row);
  }
  for (const [type, value, value2] of snapshot.assertions) {
    ensureRequestPanel(card, 'assertions').querySelector('.assertions-list')
      .appendChild(assertionRow(type, value, value2, () => updateAssertCount(card)));
  }
  applySubRequestSnapshot(card, 'pre', snapshot.subRequests.pre);
  applySubRequestSnapshot(card, 'post', snapshot.subRequests.post);
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
  head.append(num, namePreview, methodPreview, nameInput, protocol, method, url, preview, groupSelect, enabledLabel, actions);

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

  const preSection = buildSubReqSection('pre');
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
  const postSection = buildSubReqSection('post');
  card.append(head, grpcRow, preSection, body, postSection);
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
  head.addEventListener('dblclick', event => {
    if (!event.target.closest('button, input, select, label')) setRequestExpanded(card, !card.classList.contains('expanded'));
  });
  moveUp.addEventListener('click', () => {
    const previous = card.previousElementSibling;
    if (previous) card.parentElement.insertBefore(card, previous);
    renumberMain();
    card.parentElement.querySelectorAll('.req-card').forEach(refreshRequestSummary);
  });
  moveDown.addEventListener('click', () => {
    const next = card.nextElementSibling;
    if (next) card.parentElement.insertBefore(next, card);
    renumberMain();
    card.parentElement.querySelectorAll('.req-card').forEach(refreshRequestSummary);
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
  });
  remove.addEventListener('click', () => {
    card.remove();
    renumberMain();
    refreshFlowEmptyState();
  });
  syncProtocol();
  syncPreview();
  syncEnabled();
  return card;
}
