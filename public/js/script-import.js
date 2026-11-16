// "Import k6 script / JMeter .jmx" modal: send a pasted/chosen k6 script to
// POST /api/import-script, or a JMeter test plan (XML) to POST /api/import-jmx
// (the server only parses it), and load the resulting configuration like Open
// does. Anything K6UI cannot represent comes back as warnings and is listed here.
import { $ } from './dom.js';
import { collectConfig } from './config.js';
import { applyConfig } from './project-io.js';

let returnFocus = null;

function modal() { return $('#k6-import-modal'); }
const isOpen = () => !modal().classList.contains('hidden');

function showError(message) {
  const el = $('#k6-import-error');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function renderWarnings(warnings) {
  const list = $('#k6-import-warnings');
  list.replaceChildren(...warnings.map(w => {
    const li = document.createElement('li');
    if (w.line) {
      const line = document.createElement('span');
      line.className = 'import-line';
      line.textContent = `Line ${w.line}`;
      li.append(line);
    }
    li.append(' ', w.message);
    return li;
  }));
}

function resetModal() {
  $('#k6-import-input').value = '';
  $('#k6-import-form').classList.remove('hidden');
  $('#k6-import-result').classList.add('hidden');
  $('#k6-import-apply').classList.remove('hidden');
  $('#k6-import-apply').disabled = false;
  $('#k6-import-cancel').textContent = 'Cancel';
  renderWarnings([]);
  showError('');
}

function openModal() {
  returnFocus = document.activeElement;
  resetModal();
  modal().classList.remove('hidden');
  $('#k6-import-input').focus();
}

function closeModal() {
  modal().classList.add('hidden');
  returnFocus?.focus();
  returnFocus = null;
}

// A k6 script is JavaScript; a .jmx test plan is XML and starts with "<".
const isJmx = (text) => /^\uFEFF?\s*</.test(text);

function importRequest(text) {
  return isJmx(text)
    ? fetch('/api/import-jmx', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: text })
    : fetch('/api/import-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: text }),
    });
}

function hasCurrentWork() {
  return collectConfig().scenario.requests.some(r => r.url);
}

// The import replaced the project: show what was read and what was left out.
function showResult(config, warnings) {
  const count = config.scenario.requests.length;
  $('#k6-import-summary').textContent =
    `Imported ${count} request${count === 1 ? '' : 's'}. `
    + `${warnings.length} part${warnings.length === 1 ? ' was' : 's were'} not imported — `
    + 'review them below and fix the flow if needed.';
  renderWarnings(warnings);
  $('#k6-import-form').classList.add('hidden');
  $('#k6-import-result').classList.remove('hidden');
  $('#k6-import-apply').classList.add('hidden');
  $('#k6-import-cancel').textContent = 'Close';
  $('#k6-import-cancel').focus();
}

async function applyImport() {
  const script = $('#k6-import-input').value;
  if (!script.trim()) { showError('Paste a k6 script or JMeter test plan, or choose a file first.'); return; }
  if (hasCurrentWork() && !confirm('Importing replaces the current project. Continue?')) return;

  const apply = $('#k6-import-apply');
  apply.disabled = true;
  showError('');
  try {
    const res = await importRequest(script);
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'The file could not be imported.');
      renderWarnings(data.warnings || []);
      $('#k6-import-result').classList.toggle('hidden', !(data.warnings || []).length);
      $('#k6-import-summary').textContent = 'These parts were skipped:';
      return;
    }
    applyConfig(data.config);
    if (data.warnings.length) showResult(data.config, data.warnings);
    else closeModal();
  } catch (e) {
    showError(e instanceof Error ? e.message : 'The file could not be imported.');
  } finally {
    apply.disabled = false;
  }
}

export function initScriptImport() {
  $('#import-k6-btn').addEventListener('click', openModal);
  $('#k6-import-apply').addEventListener('click', applyImport);
  $('#k6-import-cancel').addEventListener('click', closeModal);
  modal().addEventListener('click', e => { if (e.target === modal()) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) closeModal(); });

  $('#k6-import-pick').addEventListener('click', () => {
    $('#k6-import-file').value = '';
    $('#k6-import-file').click();
  });
  $('#k6-import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { $('#k6-import-input').value = String(ev.target.result); showError(''); };
    reader.onerror = () => showError('The file could not be read.');
    reader.readAsText(file);
  });
}
