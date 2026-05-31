import { $, $$ } from './utils.js';

export function collectHeaders(card) {
  const list = card.querySelector('.req-card-body .headers-list');
  return $$('.header-row', list || card)
    .map(r => ({ key: r.querySelector('.h-key').value.trim(), value: r.querySelector('.h-val').value }))
    .filter(h => h.key);
}

export function collectExtractions(card) {
  const list = card.querySelector('.req-card-body .extractions-list');
  return $$('.extraction-row', list || card)
    .map(r => ({
      varName:  r.querySelector('.ext-name').value.trim().replace(/\s+/g, '_'),
      source:   r.querySelector('.ext-source').value,
      selector: r.querySelector('.ext-selector').value.trim(),
    }))
    .filter(e => e.varName);
}

export function collectAssertions(card) {
  const list = card.querySelector('.assertions-list');
  return $$('.assertion-row', list || card).map(row => ({
    type:   row.querySelector('.assert-type').value,
    value:  row.querySelector('.assert-val').value.trim(),
    value2: row.querySelector('.assert-val2').value.trim(),
  }));
}

export function collectSubReq(card, position) {
  const section = card.querySelector(`.subreq-${position}`);
  if (!section) return null;
  const form = section.querySelector('.subreq-form');
  if (!form || form.classList.contains('hidden')) return null;
  const url = form.querySelector('.sr-url').value.trim();
  if (!url) return null;
  return {
    method: form.querySelector('.sr-method').value,
    url,
    headers: $$('.header-row', form)
      .map(r => ({ key: r.querySelector('.h-key').value.trim(), value: r.querySelector('.h-val').value }))
      .filter(h => h.key),
    body: form.querySelector('.sr-body').value,
    extractions: $$('.extraction-row', form)
      .map(r => ({
        varName:  r.querySelector('.ext-name').value.trim().replace(/\s+/g, '_'),
        source:   r.querySelector('.ext-source').value,
        selector: r.querySelector('.ext-selector').value.trim(),
      }))
      .filter(e => e.varName),
  };
}

export function collectReqList(containerId) {
  return $$(`#${containerId} .req-card`).map(card => ({
    method:      card.querySelector('.method').value,
    url:         card.querySelector('.url').value.trim(),
    headers:     collectHeaders(card),
    body:        card.querySelector('.body').value,
    checkStatus: card.querySelector('.check-status').checked,
    sleepAfter:  card.querySelector('.sleep').value,
    extractions: collectExtractions(card),
    assertions:  collectAssertions(card),
    pre:         collectSubReq(card, 'pre'),
    post:        collectSubReq(card, 'post'),
  }));
}

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
