// Baris form yang bisa ditambah/dihapus: header dan ekstraksi variabel.
import { updateExtCount } from './counts.js';

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
    if (card) updateExtCount(card);
  });
  return row;
}
