import { $$ } from './utils.js';

export function headerRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `
    <input class="h-key" placeholder="Header (mis. Authorization)" />
    <input class="h-val" placeholder="Nilai (mis. Bearer {{token}})" />
    <button class="row-remove" title="Hapus">&times;</button>`;
  row.querySelector('.h-key').value = key;
  row.querySelector('.h-val').value = val;
  row.querySelector('.row-remove').addEventListener('click', () => row.remove());
  return row;
}

export function extractionRow() {
  const row = document.createElement('div');
  row.className = 'extraction-row';
  row.innerHTML = `
    <input  class="ext-name"     placeholder="nama_variabel" />
    <select class="ext-source">
      <option value="json">Body JSON</option>
      <option value="header">Header</option>
      <option value="regex">Regex</option>
    </select>
    <input class="ext-selector" placeholder="mis. data.token" />
    <button class="row-remove" title="Hapus">&times;</button>`;

  const selInput = row.querySelector('.ext-selector');
  row.querySelector('.ext-source').addEventListener('change', e => {
    const ph = { json: 'mis. data.token  atau  items[0].id', header: 'mis. X-Auth-Token', regex: 'mis. "token":"(.+?)"' };
    selInput.placeholder = ph[e.target.value] || '';
  });
  row.querySelector('.row-remove').addEventListener('click', () => {
    const card = row.closest('.req-card');
    row.remove();
    if (card) updateExtCountOnCard(card);
  });
  return row;
}

// Lazy reference — dipanggil saat event terjadi, bukan saat module di-load
function updateExtCountOnCard(card) {
  const list  = card.querySelector('.req-card-body .extractions-list');
  const n     = $$(`.ext-name`, list || card).filter(i => i.value.trim()).length;
  const badge = card.querySelector('.tab-count-ext');
  if (!badge) return;
  badge.textContent = n || '';
  badge.classList.toggle('visible', n > 0);
}
