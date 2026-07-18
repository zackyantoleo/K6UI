// Membaca seluruh form UI menjadi satu objek konfigurasi + validasinya.
// Objek ini dikirim ke POST /api/generate dan /api/run, dan juga menjadi
// format file simpan project (lihat skema di CLAUDE.md).
import { $, $$ } from './dom.js';

// ── Pembaca baris — dipakai kartu utama & sub-request ──────────
function readHeaderRows(scope) {
  return $$('.header-row', scope)
    .map(r => ({ key: r.querySelector('.h-key').value.trim(), value: r.querySelector('.h-val').value }))
    .filter(h => h.key);
}

function readExtractionRows(scope) {
  return $$('.extraction-row', scope)
    .map(r => ({
      varName:  r.querySelector('.ext-name').value.trim().replace(/\s+/g, '_'),
      source:   r.querySelector('.ext-source').value,
      selector: r.querySelector('.ext-selector').value.trim(),
    }))
    .filter(e => e.varName);
}

function readAssertionRows(scope) {
  return $$('.assertion-row', scope).map(row => ({
    type:   row.querySelector('.assert-type').value,
    value:  row.querySelector('.assert-val').value.trim(),
    value2: row.querySelector('.assert-val2').value.trim(),
  }));
}

// ── Per kartu ──────────────────────────────────────────────────
// Scope ke panel di .req-card-body agar baris milik sub-request
// (di .subreq-form) tidak ikut terbaca.
function collectSubReq(card, position) {
  const form = card.querySelector(`.subreq-${position} .subreq-form`);
  if (!form || form.classList.contains('hidden')) return null;
  const url = form.querySelector('.sr-url').value.trim();
  if (!url) return null;
  return {
    method:      form.querySelector('.sr-method').value,
    url,
    headers:     readHeaderRows(form),
    body:        form.querySelector('.sr-body').value,
    extractions: readExtractionRows(form),
  };
}

function collectReqList(containerId) {
  return $$(`#${containerId} .req-card`).map(card => {
    const body = card.querySelector('.req-card-body');
    return {
      method:      card.querySelector('.method').value,
      url:         card.querySelector('.url').value.trim(),
      headers:     readHeaderRows(body.querySelector('.headers-list')),
      body:        card.querySelector('.body').value,
      checkStatus: card.querySelector('.check-status').checked,
      sleepAfter:  card.querySelector('.sleep').value,
      extractions: readExtractionRows(body.querySelector('.extractions-list')),
      assertions:  readAssertionRows(body.querySelector('.assertions-list')),
      pre:         collectSubReq(card, 'pre'),
      post:        collectSubReq(card, 'post'),
    };
  });
}

// ── Public API ─────────────────────────────────────────────────
export function collectConfig() {
  const mode = $('input[name="load-mode"]:checked').value;
  const load = { mode };
  if (mode === 'simple') {
    load.vus      = $('#vus').value;
    load.duration = $('#duration').value.trim();
  } else {
    load.stages = $$('.stage-row').map(s => ({
      duration: s.querySelector('.stage-dur').value.trim(),
      target:   s.querySelector('.stage-target').value,
    }));
  }
  return {
    scenario:   { requests: collectReqList('reqs-main') },
    load,
    thresholds: { p95: $('#p95').value, errorRate: $('#errorRate').value },
    options:    { logRequests: $('#log-requests')?.checked ?? true },
  };
}

export function validate(config) {
  if (!config.scenario.requests.filter(r => r.url).length)
    return 'Tambahkan minimal satu request dengan URL di Skenario Utama.';
  if (config.load.mode === 'stages') {
    if (!(config.load.stages || []).filter(s => s.duration && s.target !== '').length)
      return 'Tambahkan minimal satu stage yang valid di Profil Beban.';
  }
  return null;
}
