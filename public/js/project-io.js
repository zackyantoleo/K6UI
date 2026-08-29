// Save the project as a JSON file (format = collectConfig object) and load
// it back: refill the entire form from a config object.
import { $ } from './dom.js';
import { navigate } from './nav.js';
import { headerRow, extractionRow, variableRow } from './components/rows.js';
import { reqCard, refreshRequestSummary, setRequestExpanded } from './components/req-card.js';
import { renumberMain } from './components/counts.js';
import { stageRow } from './components/flow-view.js';
import { refreshFlowEmptyState } from './components/counts.js';
import { collectConfig } from './config.js';
import { migrateProject, projectStore, serializeProject } from './project-store.js';

// ── Internal helpers ───────────────────────────────────────────
function fillSubReq(section, req) {
  if (!section || !req) return;
  section.querySelector('.add-subreq-btn')?.classList.add('hidden');
  const form = section.querySelector('.subreq-form');
  if (!form) return;
  form.classList.remove('hidden');
  form.querySelector('.sr-method').value = req.method || 'GET';
  form.querySelector('.sr-url').value    = req.url    || '';
  form.querySelector('.sr-body').value   = req.body   || '';

  const srHList = form.querySelector('.sr-headers-list');
  for (const h of req.headers || []) { if (h.key) srHList.appendChild(headerRow(h.key, h.value)); }

  const srExtList = form.querySelector('.sr-extractions-list');
  for (const e of req.extractions || []) {
    if (!e.varName) continue;
    const row = extractionRow();
    row.querySelector('.ext-name').value     = e.varName;
    row.querySelector('.ext-source').value   = e.source   || 'json';
    row.querySelector('.ext-selector').value = e.selector || '';
    row.querySelector('.ext-source').dispatchEvent(new Event('change'));
    srExtList.appendChild(row);
  }
}

export function hydrateRequestCard(card, req) {
  card.dataset.requestId = req.id || card.dataset.requestId;
  card.requestState = req;
  card.querySelector('.request-name').value = req.name || '';
  const enabled = card.querySelector('.request-enabled');
  enabled.checked = req.enabled !== false;
  enabled.dispatchEvent(new Event('change'));

  const protoSel = card.querySelector('.protocol');
  protoSel.value = req.type === 'grpc' ? 'grpc' : 'http';
  card.querySelector('.grpc-method').value = req.grpcMethod || '';
  card.querySelector('.grpc-plaintext').checked = !!req.grpcPlaintext;
  protoSel.dispatchEvent(new Event('change'));

  card.querySelector('.method').value = req.method || 'GET';
  const url = card.querySelector('.url');
  url.value = req.url || '';
  url.dispatchEvent(new Event('input'));
  refreshRequestSummary(card);
  if (req.pre) fillSubReq(card.querySelector('.subreq-pre'), req.pre);
  if (req.post) fillSubReq(card.querySelector('.subreq-post'), req.post);
}

function restoreZone(requests) {
  const container = $('#reqs-main');
  container.innerHTML = '';
  for (let i = 0; i < requests.length; i++) {
    const card = reqCard(i, 'main', requests[i].id);
    hydrateRequestCard(card, requests[i]);
    container.appendChild(card);
  }
  if (container.firstElementChild) setRequestExpanded(container.firstElementChild, true);
  renumberMain();
  refreshFlowEmptyState();
}

// ── Public API ─────────────────────────────────────────────────
export function saveProject() {
  const cfg  = collectConfig();
  const blob = new Blob([serializeProject(cfg)], { type: 'application/json' });
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(blob),
    download: 'k6-project.json',
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

export function applyConfig(cfg) {
  cfg = projectStore.replace(migrateProject(cfg));
  const mode = cfg.load?.mode || 'simple';
  const modeRadio = $(`input[name="load-mode"][value="${mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  $('#load-simple').classList.toggle('hidden', mode !== 'simple');
  $('#load-stages').classList.toggle('hidden', mode !== 'stages');

  if (mode === 'simple') {
    $('#vus').value      = cfg.load?.vus      ?? 10;
    $('#duration').value = cfg.load?.duration ?? '30s';
  } else {
    const stagesEl = $('#stages');
    stagesEl.innerHTML = '';
    const saved = cfg.load?.stages || [];
    if (saved.length) saved.forEach(s => stagesEl.appendChild(stageRow(s.duration, s.target)));
    else stagesEl.appendChild(stageRow());
  }

  const varsList = $('#global-vars-list');
  varsList.innerHTML = '';
  for (const v of cfg.variables || []) {
    if (v && v.key) varsList.appendChild(variableRow(v.key, v.value ?? ''));
  }

  const gHeadersList = $('#global-headers-list');
  gHeadersList.innerHTML = '';
  for (const h of cfg.globalHeaders || []) {
    if (h && h.key) gHeadersList.appendChild(headerRow(h.key, h.value ?? ''));
  }

  $('#p95').value       = cfg.thresholds?.p95       ?? '';
  $('#errorRate').value = cfg.thresholds?.errorRate ?? '';
  const logReqEl = $('#log-requests');
  if (logReqEl) logReqEl.checked = cfg.options?.logRequests ?? false;

  restoreZone(cfg.scenario?.requests || []);
  window.dispatchEvent(new CustomEvent('k6ui:project-applied'));
  navigate('flow');
}
