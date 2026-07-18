// Addable/removable form rows: headers, variable extractions, and global variables.
import { updateExtCount } from './counts.js';

export function variableRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'var-row';
  row.innerHTML = `
    <input class="var-key" placeholder="variable_name (e.g. base_url)" />
    <input class="var-val" placeholder="Value (e.g. https://api.example.com)" />
    <button class="row-remove" title="Remove">&times;</button>`;
  row.querySelector('.var-key').value = key;
  row.querySelector('.var-val').value = val;
  row.querySelector('.row-remove').addEventListener('click', () => row.remove());
  return row;
}

export function headerRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `
    <input class="h-key" placeholder="Header (e.g. Authorization)" />
    <input class="h-val" placeholder="Value (e.g. Bearer {{token}})" />
    <button class="row-remove" title="Remove">&times;</button>`;
  row.querySelector('.h-key').value = key;
  row.querySelector('.h-val').value = val;
  row.querySelector('.row-remove').addEventListener('click', () => row.remove());
  return row;
}

export function extractionRow() {
  const row = document.createElement('div');
  row.className = 'extraction-row';
  row.innerHTML = `
    <input  class="ext-name"     placeholder="variable_name" />
    <select class="ext-source">
      <option value="json">JSON Body</option>
      <option value="header">Header</option>
      <option value="regex">Regex</option>
    </select>
    <input class="ext-selector" placeholder="e.g. data.token" />
    <button class="row-remove" title="Remove">&times;</button>`;

  const selInput = row.querySelector('.ext-selector');
  row.querySelector('.ext-source').addEventListener('change', e => {
    const ph = { json: 'e.g. data.token  or  items[0].id', header: 'e.g. X-Auth-Token', regex: 'e.g. "token":"(.+?)"' };
    selInput.placeholder = ph[e.target.value] || '';
  });
  row.querySelector('.row-remove').addEventListener('click', () => {
    const card = row.closest('.req-card');
    row.remove();
    if (card) updateExtCount(card);
  });
  return row;
}
