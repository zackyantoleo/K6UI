// Save the project as a JSON file (format = collectConfig object) and load
// it back: refill the entire form from a config object.
import { $ } from './dom.js';
import { navigate } from './nav.js';
import { headerRow, variableRow } from './components/rows.js';
import { reqCard, refreshRequestSummary, setRequestExpanded } from './components/req-card.js';
import { renumberMain } from './components/counts.js';
import { stageRow } from './components/flow-view.js';
import { refreshFlowEmptyState } from './components/counts.js';
import { collectConfig } from './config.js';
import { migrateProject, projectStore, serializeProject } from './project-store.js';
import { refreshRequestGroupOptions, restoreGroups } from './components/request-groups.js';
import { restoreDataSets } from './data-files.js';
import { normalizeRequestLog } from './request-log.js';
import { syncRequestLogFields } from './runner.js';
import { restoreOutcomeTargetRows } from './components/outcome-target-rows.js';

// ── Internal helpers ───────────────────────────────────────────
export function hydrateRequestCard(card, req) {
  card.dataset.requestId = req.id || card.dataset.requestId;
  card.requestState = req;
  card.querySelector('.request-name').value = req.name || '';
  refreshRequestGroupOptions(new Map([[card, req.groupId || '']]));
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
}

function restoreZone(requests) {
  const container = $('#reqs-main');
  container.innerHTML = '';
  for (let i = 0; i < requests.length; i++) {
    const card = reqCard(i, 'main', requests[i].id);
    container.appendChild(card);
    hydrateRequestCard(card, requests[i]);
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
  $('#load-iterations').classList.toggle('hidden', mode !== 'iterations');

  if (mode === 'simple') {
    $('#vus').value      = cfg.load?.vus      ?? 10;
    $('#duration').value = cfg.load?.duration ?? '30s';
  } else if (mode === 'iterations') {
    $('#iter-vus').value     = cfg.load?.vus        ?? 1;
    $('#iterations').value   = cfg.load?.iterations ?? 1;
    $('#max-duration').value = cfg.load?.maxDuration ?? '1h';
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

  restoreDataSets(cfg.dataSets || []);

  const gHeadersList = $('#global-headers-list');
  gHeadersList.innerHTML = '';
  for (const h of cfg.globalHeaders || []) {
    if (h && h.key) gHeadersList.appendChild(headerRow(h.key, h.value ?? ''));
  }

  $('#p95').value       = cfg.thresholds?.p95       ?? '';
  $('#errorRate').value = cfg.thresholds?.errorRate ?? '';
  const requestLog = normalizeRequestLog(cfg.options);
  const logReqEl = $('#log-requests');
  if (logReqEl) logReqEl.checked = requestLog.logRequests;
  const logFilterEl = $('#log-filter');
  if (logFilterEl) logFilterEl.value = requestLog.logFilter;
  const logEveryEl = $('#log-sample-every');
  if (logEveryEl) logEveryEl.value = String(requestLog.logSampleEvery);
  const logRedactEl = $('#log-redact');
  if (logRedactEl) logRedactEl.checked = requestLog.logRedact;
  syncRequestLogFields();

  restoreGroups(cfg.scenario?.groups || []);
  restoreZone(cfg.scenario?.requests || []);
  // After the cards: a target's request and label lists come from them.
  restoreOutcomeTargetRows(cfg.thresholds?.outcomes || []);
  window.dispatchEvent(new CustomEvent('k6ui:project-applied'));
  navigate('flow');
}
