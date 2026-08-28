// Frontend entry point: wires up all event handlers and does the initial
// render. Per-feature logic lives in each module (see the header comment
// of every file).
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { variableRow, headerRow } from './components/rows.js';
import { addRequest, buildFlowView, stageRow } from './components/flow-view.js';
import { collectConfig, validate } from './config.js';
import { runTest, stopTest, applyReqFilter, checkK6 } from './runner.js';
import { saveProject, applyConfig } from './project-io.js';
import { initCurlImport } from './curl-import.js';

// ── Navigation ─────────────────────────────────────────────────
$$('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', () => navigate(link.dataset.view));
});

$$('.data-rule-card[data-view]').forEach(card =>
  card.addEventListener('click', () => navigate(card.dataset.view)));

// ── Load presets and custom editor ─────────────────────────────
const LOAD_PRESETS = {
  smoke:  { stages: [{ duration: '30s', target: '1' }] },
  load:   { stages: [{ duration: '1m', target: '10' }, { duration: '3m', target: '10' }, { duration: '1m', target: '0' }] },
  stress: { stages: [{ duration: '2m', target: '10' }, { duration: '2m', target: '50' }, { duration: '1m', target: '50' }, { duration: '1m', target: '0' }] },
};

let loadPresetDirty = false;
let applyingLoadPreset = false;

function setLoadMode(mode) {
  const radio = $(`input[name="load-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $('#load-simple').classList.toggle('hidden', mode !== 'simple');
  $('#load-stages').classList.toggle('hidden', mode !== 'stages');
}

function setLoadEditorExpanded(expanded) {
  $('#load-custom-editor').classList.toggle('hidden', !expanded);
  $('#customize-load').setAttribute('aria-expanded', String(expanded));
  $('#customize-load').textContent = expanded ? 'Hide custom values' : 'Customize';
}

function selectPresetButton(selected) {
  $$('.preset-btn[data-preset]').forEach(item => {
    const active = item === selected;
    item.classList.toggle('selected', active);
    item.setAttribute('aria-pressed', String(active));
  });
}

function markLoadCustom() {
  if (applyingLoadPreset) return;
  loadPresetDirty = true;
  selectPresetButton(null);
}

$$('input[name="load-mode"]').forEach(r => r.addEventListener('change', () => {
  setLoadMode($('input[name="load-mode"]:checked').value);
  markLoadCustom();
}));

$('#add-stage').addEventListener('click', () => {
  $('#stages').appendChild(stageRow());
  markLoadCustom();
});

$('#load-custom-editor').addEventListener('input', markLoadCustom);
$('#stages').addEventListener('click', event => {
  if (event.target.closest('.btn-remove-sm')) markLoadCustom();
});
$('#customize-load').addEventListener('click', () =>
  setLoadEditorExpanded($('#customize-load').getAttribute('aria-expanded') !== 'true'));

$$('.preset-btn[data-preset]').forEach(button => {
  button.addEventListener('click', () => {
    if (loadPresetDirty && !confirm('Replace your custom load values with this preset? Cancel to keep your custom load values.')) return;
    const preset = LOAD_PRESETS[button.dataset.preset];
    applyingLoadPreset = true;
    setLoadMode('stages');
    $('#stages').replaceChildren(...preset.stages.map(stage => stageRow(stage.duration, stage.target)));
    applyingLoadPreset = false;
    loadPresetDirty = false;
    selectPresetButton(button);
    setLoadEditorExpanded(false);
  });
});

function protectLoadedLoadValues() {
  loadPresetDirty = true;
  selectPresetButton(null);
}

window.addEventListener('k6ui:project-applied', protectLoadedLoadValues);

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

// ── Results tabs ───────────────────────────────────────────────
$$('.results-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.results-tab[data-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.tab;
    $('#tab-live').classList.toggle('hidden',     id !== 'live');
    $('#tab-requests').classList.toggle('hidden', id !== 'requests');
  });
});

$('#filter-errors-only')?.addEventListener('change', applyReqFilter);
$('#filter-url')?.addEventListener('input', applyReqFilter);

// ── Run / Stop ─────────────────────────────────────────────────
$('#run-btn').addEventListener('click', runTest);
$('#results-run-btn').addEventListener('click', runTest);
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
$('#global-vars-list').appendChild(variableRow());
$('#global-headers-list').appendChild(headerRow());

const stagesEl = $('#stages');
stagesEl.appendChild(stageRow('30s', '10'));
stagesEl.appendChild(stageRow('1m',  '20'));
stagesEl.appendChild(stageRow('30s', '0'));

initCurlImport();
navigate('flow', { focusHeading: false });
checkK6();
