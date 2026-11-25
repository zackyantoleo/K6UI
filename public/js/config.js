// Reads the whole UI form into a single config object + validation.
// This object is sent to POST /api/generate and /api/run, and is also the
// save-file format for projects (see the schema in CLAUDE.md).
import { $, $$ } from './dom.js';
import { createRequestId, projectStore } from './project-store.js';
import { collectRequestGroups, requestGroupProblem } from './components/request-groups.js';
import { collectDataSets, validateDataSets } from './data-files.js';
import { readExtractionRow } from './components/rows.js';
import { readExportBlocks } from './components/export-rows.js';
import { exportsProblem } from './shared/csv-export.js';
import { assertionsProblem } from './shared/assertions.js';
import { normalizeRequestLog } from './shared/request-log.js';
import { outcomesProblem } from './shared/outcomes.js';
import { expectedStatusesListProblem } from './shared/expected-statuses.js';
import { readOutcomesPanel } from './components/request-editor/outcomes.js';
import { outcomeThresholdsProblem } from './shared/outcome-thresholds.js';
import { readOutcomeTargetRows } from './components/outcome-target-rows.js';
import { readRaceSettings } from './components/race-settings.js';
import { raceProblem } from './shared/race.js';
import { readLoadMode } from './components/load-chart.js';
import { readThresholdFields } from './components/pass-fail-goals.js';

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
const LAZY_PANELS = ['headers', 'body', 'assertions', 'extractions', 'exports', 'statuses', 'outcomes', 'scripts'];

const panelReady = (card, panelId) =>
  card.querySelector(`.req-panel[data-panel="${panelId}"]`)?.dataset.panelReady === 'true';

// `hydrate: false` (readProjectDraft): a panel that was never filled is read from
// the request the card was loaded with (`card.requestState`), the same values
// ensureRequestPanel() would put in it, so nothing is built.
function collectReqList(containerId, { hydrate = true } = {}) {
  return $$(`#${containerId} .req-card`).map(card => {
    if (!hydrate) return readCardLazily(card);
    for (const panelId of LAZY_PANELS) card.ensureRequestPanel?.(panelId);
    const body = card.querySelector('.req-card-body');
    if (!card.dataset.requestId) card.dataset.requestId = createRequestId();
    // Outcome rules: saved only when the request has some (no `outcomes` key otherwise).
    const outcomes = readOutcomesPanel(body.querySelector('.outcomes-panel'));
    // Expected statuses: saved only when typed (empty = k6's own rule, no key).
    const expectedStatuses = card.querySelector('.expected-statuses').value.trim();
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
      ...(expectedStatuses ? { expectedStatuses } : {}),
      sleepAfter:  card.querySelector('.sleep').value,
      extractions: readExtractionRows(body.querySelector('.extractions-list')),
      exports:     readExportBlocks(body.querySelector('.exports-list')),
      assertions:  readAssertionRows(body.querySelector('.assertions-list')),
      ...(outcomes ? { outcomes } : {}),
      preScript:   card.querySelector('.pre-script').value,
      postScript:  card.querySelector('.post-script').value,
    };
  });
}

function readCardLazily(card) {
  const saved = card.requestState || {};
  const field = selector => card.querySelector(selector);
  const list = selector => field(`.req-card-body ${selector}`);
  const statuses = panelReady(card, 'statuses');
  const scripts = panelReady(card, 'scripts');
  const outcomes = panelReady(card, 'outcomes') ? readOutcomesPanel(list('.outcomes-panel')) : saved.outcomes;
  const expectedStatuses = statuses ? field('.expected-statuses').value.trim() : String(saved.expectedStatuses || '').trim();
  // "Wait after" exists once the editor was built (it is not a lazy part).
  const sleep = field('.sleep');
  if (!card.dataset.requestId) card.dataset.requestId = createRequestId();
  return {
    id:            card.dataset.requestId,
    name:          field('.request-name')?.value.trim() || '',
    enabled:       field('.request-enabled')?.checked !== false,
    groupId:       field('.request-group-select')?.value || '',
    type:          field('.protocol').value,
    method:        field('.method').value,
    url:           field('.url').value.trim(),
    grpcMethod:    field('.grpc-method').value.trim(),
    grpcPlaintext: field('.grpc-plaintext').checked,
    headers:       panelReady(card, 'headers') ? readHeaderRows(list('.headers-list'))
      : (saved.headers || []).filter(header => header?.key),
    body:          panelReady(card, 'body') ? field('.body').value : saved.body || '',
    checkStatus:   statuses ? field('.check-status').checked : saved.checkStatus !== false,
    ...(expectedStatuses ? { expectedStatuses } : {}),
    sleepAfter:    sleep ? sleep.value : String(saved.sleepAfter ?? 1),
    extractions:   panelReady(card, 'extractions') ? readExtractionRows(list('.extractions-list'))
      : (saved.extractions || []).filter(extraction => extraction?.varName),
    exports:       panelReady(card, 'exports') ? readExportBlocks(list('.exports-list')) : saved.exports || [],
    assertions:    panelReady(card, 'assertions') ? readAssertionRows(list('.assertions-list')) : saved.assertions || [],
    ...(outcomes ? { outcomes } : {}),
    preScript:     scripts ? field('.pre-script').value : saved.preScript || '',
    postScript:    scripts ? field('.post-script').value : saved.postScript || '',
  };
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

// p95 / error rate, plus outcome targets when the view has some (no `outcomes` key otherwise).
function thresholdFields() {
  const outcomes = readOutcomeTargetRows();
  return { ...readThresholdFields(), ...(outcomes.length ? { outcomes } : {}) };
}

function readConfig({ hydrate }) {
  const mode = readLoadMode();
  const load = { mode };
  if (mode === 'simple') {
    load.vus      = $('#vus').value;
    load.duration = $('#duration').value.trim();
  } else if (mode === 'iterations') {
    load.vus         = $('#iter-vus').value;
    load.iterations  = $('#iterations').value;
    load.maxDuration = $('#max-duration').value.trim();
  } else if (mode === 'race') {
    Object.assign(load, readRaceSettings());
  } else {
    load.stages = $$('.stage-row').map(s => ({
      duration: s.querySelector('.stage-dur').value.trim(),
      target:   s.querySelector('.stage-target').value,
    }));
  }
  return {
    scenario:      { groups: collectRequestGroups(), requests: collectReqList('reqs-main', { hydrate }) },
    variables:     readVariableRows(),
    dataSets:      collectDataSets(),
    globalHeaders: readHeaderRows($('#global-headers-list')),
    load,
    thresholds:    thresholdFields(),
    options:       normalizeRequestLog({
      logRequests:    $('#log-requests')?.checked ?? true,
      logFilter:      $('#log-filter')?.value,
      logSampleEvery: $('#log-sample-every')?.value,
      logMaxRecords:  $('#log-max-records')?.value,
      logRedact:      $('#log-redact')?.checked ?? false,
    }),
  };
}

// ── Public API ─────────────────────────────────────────────────
export function collectConfig() {
  return projectStore.replace(readConfig({ hydrate: true }));
}

// The project as typed, for the browser draft (draft.js): same shape as
// collectConfig(), but it never builds a lazy request panel and leaves the store
// alone, so it is cheap enough to run after every change.
export function readProjectDraft() {
  return readConfig({ hydrate: false });
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
  // Checks: a status or time that is a number, text to look for, a regex that can be written.
  const checkError = assertionsProblem(runnable.map((r, i) => ({ label: `Request ${i + 1}`, type: r.type, assertions: r.assertions })));
  if (checkError) return checkError;
  const exportError = exportsProblem(runnable.map((r, i) => ({ label: `Request ${i + 1}`, exports: r.exports })));
  if (exportError) return exportError;
  const outcomeError = outcomesProblem(runnable.map((r, i) => ({ label: `Request ${i + 1}`, type: r.type, outcomes: r.outcomes })));
  if (outcomeError) return outcomeError;
  const statusError = expectedStatusesListProblem(runnable.map((r, i) => ({
    label: `Request ${i + 1}`, type: r.type, expectedStatuses: r.expectedStatuses,
  })));
  if (statusError) return statusError;
  // Outcome targets: the same check as the generator, over the same request numbers.
  const targetError = outcomeThresholdsProblem(config);
  if (targetError) return targetError;
  // Race burst: the same check as the generator (race request, timing, {{globals}}).
  const raceError = raceProblem(config);
  if (raceError) return raceError;
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
