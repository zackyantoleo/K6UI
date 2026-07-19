// "Import from cURL" modal: parse a pasted cURL command and fill a request
// card's method, URL, headers, and body with the result (extractions,
// assertions, scripts, and sub-requests are left untouched).
import { $ } from './dom.js';
import { headerRow } from './components/rows.js';
import { parseCurl } from './curl-parse.js';

let targetCard = null;

function modal() { return $('#curl-modal'); }

export function openCurlImport(card) {
  targetCard = card;
  $('#curl-input').value = '';
  $('#curl-error').classList.add('hidden');
  modal().classList.remove('hidden');
  $('#curl-input').focus();
}

function closeModal() {
  modal().classList.add('hidden');
  targetCard = null;
}

function fillCard(card, req) {
  const methodSel = card.querySelector('.method');
  methodSel.value = [...methodSel.options].some(o => o.value === req.method) ? req.method : 'GET';
  card.querySelector('.url').value  = req.url;
  card.querySelector('.body').value = req.body || '';
  const hList = card.querySelector('.req-card-body .headers-list');
  hList.innerHTML = '';
  for (const h of req.headers) hList.appendChild(headerRow(h.key, h.value));
}

function applyImport() {
  try {
    const req = parseCurl($('#curl-input').value);
    fillCard(targetCard, req);
    closeModal();
  } catch (e) {
    const el = $('#curl-error');
    el.textContent = e.message;
    el.classList.remove('hidden');
  }
}

export function initCurlImport() {
  $('#curl-apply').addEventListener('click', applyImport);
  $('#curl-cancel').addEventListener('click', closeModal);
  modal().addEventListener('click', e => { if (e.target === modal()) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal().classList.contains('hidden')) closeModal();
  });
}
