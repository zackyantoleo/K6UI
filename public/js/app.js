// Titik masuk frontend: pasang seluruh event handler dan render awal.
// Logika per fitur ada di modul masing-masing (lihat komentar header tiap file).
import { $, $$ } from './dom.js';
import { navigate } from './nav.js';
import { reqCard } from './components/req-card.js';
import { buildFlowView, stageRow } from './components/flow-view.js';
import { collectConfig, validate } from './config.js';
import { runTest, stopTest, applyReqFilter, checkK6 } from './runner.js';
import { saveProject, applyConfig } from './project-io.js';

// ── Navigation ─────────────────────────────────────────────────
$$('.nav-link[data-view]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); navigate(link.dataset.view); });
});

$$('.nav-link.soon').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    link.classList.remove('shake');
    void link.offsetWidth;
    link.classList.add('shake');
    setTimeout(() => link.classList.remove('shake'), 350);
  });
});

// ── Load mode toggle ───────────────────────────────────────────
$$('input[name="load-mode"]').forEach(r =>
  r.addEventListener('change', () => {
    const m = $('input[name="load-mode"]:checked').value;
    $('#load-simple').classList.toggle('hidden', m !== 'simple');
    $('#load-stages').classList.toggle('hidden', m !== 'stages');
  }));

$('#add-stage').addEventListener('click', () => $('#stages').appendChild(stageRow()));

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
    $('#script-preview').textContent = data.script || data.error || '// (kosong)';
  } catch (e) {
    $('#script-preview').textContent = `// Error: ${e.message}`;
  }
  navigate('script');
}

$('#preview-btn').addEventListener('click', loadScript);
$('#refresh-script').addEventListener('click', loadScript);

$('#copy-script').addEventListener('click', () => {
  navigator.clipboard.writeText($('#script-preview').textContent);
  $('#copy-script').textContent = 'Tersalin!';
  setTimeout(() => ($('#copy-script').textContent = 'Salin'), 1600);
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
    } catch {
      alert('File tidak valid. Pastikan file adalah hasil simpan dari K6UI.');
    }
  };
  reader.readAsText(file);
});

// ── Init ───────────────────────────────────────────────────────
buildFlowView();
$('#reqs-main').appendChild(reqCard(0, 'main'));

const stagesEl = $('#stages');
stagesEl.appendChild(stageRow('30s', '10'));
stagesEl.appendChild(stageRow('1m',  '20'));
stagesEl.appendChild(stageRow('30s', '0'));

navigate('flow');
checkK6();
