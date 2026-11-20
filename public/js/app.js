// Frontend entry point: wires up all event handlers and does the initial
// render. Per-feature logic lives in each module (see the header comment
// of every file).
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { initUiMode } from './ui-mode.js';
import { variableRow, headerRow } from './components/rows.js';
import { addRequest, buildFlowView, defaultStageRows } from './components/flow-view.js';
import { collectConfig, validate } from './config.js';
import {
  runTest, stopTest, applyReqFilter, checkK6, activateResultsTab,
  clearResults, clearLiveLog, clearErrors, syncRequestLogFields, sortRequestLog,
  downloadRunReport,
} from './runner.js';
import { saveProject, applyConfig } from './project-io.js';
import { initCurlImport } from './curl-import.js';
import { initScriptImport } from './script-import.js';
import { initAdvancedNotice } from './components/advanced-notice.js';
import { initDataFiles } from './data-files.js';
import { initLoadChart } from './components/load-chart.js';
import { initOutcomeTargets } from './components/outcome-target-rows.js';
import { initRaceSettings } from './components/race-settings.js';
import { initHelpTips, initGlossary } from './components/help-tips.js';
import { initMenuButton } from './components/menu-button.js';
import { initRequestMorePanels } from './components/req-card.js';
import { initVariablesPanel } from './components/variables-panel.js';
import { initVariableSuggest } from './components/var-suggest.js';
import { initViewBlocks } from './components/view-blocks.js';
import { initStepSummaries } from './components/step-summary.js';
import { initLoadGoals } from './components/load-goals.js';
import { initPassFailGoals } from './components/pass-fail-goals.js';

// ── Navigation ─────────────────────────────────────────────────
$$('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', () => {
    if (link.dataset.view === 'script') loadScript();
    else navigate(link.dataset.view);
  });
});

// ── Global variables & headers ─────────────────────────────────
$('#add-global-var').addEventListener('click', () =>
  $('#global-vars-list').appendChild(variableRow()));

$('#add-global-header').addEventListener('click', () =>
  $('#global-headers-list').appendChild(headerRow()));

// ── Script preview ─────────────────────────────────────────────
async function loadScript() {
  const config = collectConfig();
  const err    = validate(config);
  if (err) { alert(err); return; }
  try {
    const res  = await fetch('/api/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(config),
    });
    const data = await res.json();
    $('#script-preview').textContent = data.script || data.error || '// (empty)';
  } catch (e) {
    $('#script-preview').textContent = `// Error: ${e.message}`;
  }
  navigate('script');
}

$('#preview-btn').addEventListener('click', loadScript);
$('#refresh-script').addEventListener('click', loadScript);

$('#copy-script').addEventListener('click', () => {
  navigator.clipboard.writeText($('#script-preview').textContent);
  $('#copy-script').textContent = 'Copied!';
  setTimeout(() => ($('#copy-script').textContent = 'Copy'), 1600);
});

// ── Results workspace ──────────────────────────────────────────
const resultsTabs = $$('.results-tab[data-tab]');
resultsTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateResultsTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowLeft') next = (index - 1 + resultsTabs.length) % resultsTabs.length;
    if (event.key === 'ArrowRight') next = (index + 1) % resultsTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = resultsTabs.length - 1;
    activateResultsTab(resultsTabs[next].dataset.tab, { focus: true });
  });
});

// Advanced Overview shortcuts open the same shared tabs (no second panel set).
$$('.result-shortcuts [data-results-tab]').forEach(button =>
  button.addEventListener('click', () => activateResultsTab(button.dataset.resultsTab, { focus: true })));

$('#filter-errors-only')?.addEventListener('change', applyReqFilter);
$('#filter-url')?.addEventListener('input', applyReqFilter);
$$('.req-sort-btn').forEach(button =>
  button.addEventListener('click', () => sortRequestLog(button.dataset.sort)));
$('#log-filter')?.addEventListener('change', syncRequestLogFields);
syncRequestLogFields();
$('#clear-results')?.addEventListener('click', clearResults);
$$('[data-report-format]').forEach(button =>
  button.addEventListener('click', () => downloadRunReport(button.dataset.reportFormat)));
$('#clear-live-log')?.addEventListener('click', clearLiveLog);
$('#clear-errors')?.addEventListener('click', clearErrors);

// ── Run / Stop ─────────────────────────────────────────────────
$('#run-btn').addEventListener('click', runTest);
$('#results-run-btn').addEventListener('click', runTest);
$('#results-empty-run-btn').addEventListener('click', runTest);
$('#stop-btn').addEventListener('click', stopTest);

// ── Save / Open project ────────────────────────────────────────
$('#save-project-btn').addEventListener('click', e => { e.preventDefault(); saveProject(); });

$('#open-project-btn').addEventListener('click', e => {
  e.preventDefault();
  $('#project-file-input').value = '';
  $('#project-file-input').click();
});

$('#project-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      applyConfig(JSON.parse(ev.target.result));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Invalid project file.');
    }
  };
  reader.readAsText(file);
});

// ── Init ───────────────────────────────────────────────────────
buildFlowView();
$('#empty-add-request').addEventListener('click', () => addRequest());
$('#empty-import-curl').addEventListener('click', () => addRequest({ openCurl: true }));
// Top bar Import menu: a cURL command adds one request; a k6 script or .jmx
// replaces the project (script-import.js owns #import-k6-btn).
initMenuButton($('#import-menu-btn'), $('#import-menu'));
$('#import-curl-btn').addEventListener('click', () => {
  navigate('flow');
  addRequest({ openCurl: true });
});
$('#global-vars-list').appendChild(variableRow());
$('#global-headers-list').appendChild(headerRow());

$('#stages').replaceChildren(...defaultStageRows());

initDataFiles();
initLoadGoals();
initPassFailGoals();
initLoadChart();
initCurlImport();
initScriptImport();
initAdvancedNotice();
initOutcomeTargets();
initRaceSettings();
initHelpTips();
initRequestMorePanels();
initVariablesPanel();
initVariableSuggest();
initGlossary();
initViewBlocks();
initStepSummaries();
initUiMode();
navigate('flow', { focusHeading: false });
checkK6();
