// Reads the whole UI form into a single config object + validation.
// This object is sent to POST /api/generate and /api/run, and is also the
// save-file format for projects (see the schema in CLAUDE.md).
import { $, $$ } from './dom.js';
import { createRequestId, projectStore } from './project-store.js';
import { collectRequestGroups, requestGroupProblem } from './components/request-groups.js';
import { collectDataSets, validateDataSets } from './data-files.js';
import { readExtractionRow } from './components/rows.js';
import { readExportBlocks } from './components/export-rows.js';
import { exportsProblem } from './csv-export.js';
import { normalizeRequestLog } from './request-log.js';

// ── Row readers ────────────────────────────────────────────────
function readHeaderRows(scope) {
  return $$('.header-row', scope)
    .map(r => ({ key: r.querySelector('.h-key').value.trim(), value: r.querySelector('.h-val').value }))
    .filter(h => h.key);
}

function readExtractionRows(scope) {
  return $$('.extraction-row', scope)
    .map(readExtractionRow)
    .filter(e => e.varName);
}

function readAssertionRows(scope) {
  return $$('.assertion-row', scope).map(row => ({
    type:   row.querySelector('.assert-type').value,
    value:  row.querySelector('.assert-val').value.trim(),
    value2: row.querySelector('.assert-val2').value.trim(),
  }));
}

// ── Per card ───────────────────────────────────────────────────
function collectReqList(containerId) {
  return $$(`#${containerId} .req-card`).map(card => {
    for (const panelId of ['headers', 'body', 'extractions', 'assertions', 'scripts', 'options']) {
      card.ensureRequestPanel?.(panelId);
    }
    const body = card.querySelector('.req-card-body');
    if (!card.dataset.requestId) card.dataset.requestId = createRequestId();
    return {
      id:          card.dataset.requestId,
      name:        card.querySelector('.request-name')?.value.trim() || '',
      enabled:     card.querySelector('.request-enabled')?.checked !== false,
      groupId:     card.querySelector('.request-group-select')?.value || '',
      type:        card.querySelector('.protocol').value,   // 'http' | 'grpc'
      method:      card.querySelector('.method').value,
      url:         card.querySelector('.url').value.trim(),
      grpcMethod:    card.querySelector('.grpc-method').value.trim(),
      grpcPlaintext: card.querySelector('.grpc-plaintext').checked,
      headers:     readHeaderRows(body.querySelector('.headers-list')),
      body:        card.querySelector('.body').value,
      checkStatus: card.querySelector('.check-status').checked,
      sleepAfter:  card.querySelector('.sleep').value,
      extractions: readExtractionRows(body.querySelector('.extractions-list')),
      exports:     readExportBlocks(body.querySelector('.exports-list')),
      assertions:  readAssertionRows(body.querySelector('.assertions-list')),
      preScript:   card.querySelector('.pre-script').value,
      postScript:  card.querySelector('.post-script').value,
    };
  });
}

// ── Global variables ───────────────────────────────────────────
function readVariableRows() {
  return $$('#global-vars-list .var-row')
    .map(r => ({
      key:   r.querySelector('.var-key').value.trim().replace(/\s+/g, '_'),
      value: r.querySelector('.var-val').value,
    }))
    .filter(v => v.key);
}

// ── Public API ─────────────────────────────────────────────────
export function collectConfig() {
  const mode = $('input[name="load-mode"]:checked').value;
  const load = { mode };
  if (mode === 'simple') {
    load.vus      = $('#vus').value;
    load.duration = $('#duration').value.trim();
  } else if (mode === 'iterations') {
    load.vus         = $('#iter-vus').value;
    load.iterations  = $('#iterations').value;
    load.maxDuration = $('#max-duration').value.trim();
  } else {
    load.stages = $$('.stage-row').map(s => ({
      duration: s.querySelector('.stage-dur').value.trim(),
      target:   s.querySelector('.stage-target').value,
    }));
  }
  const config = {
    scenario:      { groups: collectRequestGroups(), requests: collectReqList('reqs-main') },
    variables:     readVariableRows(),
    dataSets:      collectDataSets(),
    globalHeaders: readHeaderRows($('#global-headers-list')),
    load,
    thresholds:    { p95: $('#p95').value, errorRate: $('#errorRate').value },
    options:       normalizeRequestLog({
      logRequests:    $('#log-requests')?.checked ?? true,
      logFilter:      $('#log-filter')?.value,
      logSampleEvery: $('#log-sample-every')?.value,
      logRedact:      $('#log-redact')?.checked ?? false,
    }),
  };
  return projectStore.replace(config);
}

export function validate(config) {
  if (!config.scenario.requests.filter(r => r.enabled !== false && r.url).length)
    return 'Add at least one request with a URL in the Main Scenario.';
  const reqs = config.scenario.requests.filter(r => r.enabled !== false);
  for (let i = 0; i < reqs.length; i++) {
    if (reqs[i].url && reqs[i].type === 'grpc' && !reqs[i].grpcMethod)
      return `Request ${i + 1}: enter the gRPC method (package.Service/Method).`;
  }
  // The store drops a "Run only if" row that cannot work, so read it from the editor.
  const groupError = requestGroupProblem();
  if (groupError) return groupError;
  const dataError = validateDataSets(config.dataSets);
  if (dataError) return dataError;
  // "Save to CSV": numbered like the generator, over the requests that will run.
  const offGroups = new Set((config.scenario.groups || []).filter(group => group.enabled === false).map(group => group.id));
  const runnable = config.scenario.requests.filter(r => r.enabled !== false && !offGroups.has(r.groupId) && String(r.url || '').trim());
  const exportError = exportsProblem(runnable.map((r, i) => ({ label: `Request ${i + 1}`, exports: r.exports })));
  if (exportError) return exportError;
  if (config.load.mode === 'stages') {
    if (!(config.load.stages || []).filter(s => s.duration && s.target !== '').length)
      return 'Add at least one valid stage in the Load Profile.';
  }
  if (config.load.mode === 'iterations') {
    const whole = value => /^[1-9]\d*$/.test(String(value ?? '').trim());
    if (!whole(config.load.vus) || !whole(config.load.iterations))
      return 'Enter whole numbers of at least 1 for VUs and iterations in the Load Profile.';
  }
  return null;
}
