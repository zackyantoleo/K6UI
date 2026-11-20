// Addable/removable form rows: headers, variable extractions, and global variables.
import { updateExtCount } from './counts.js';

export function variableRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'var-row';
  row.innerHTML = `
    <input class="var-key" placeholder="variable_name (e.g. base_url)" />
    <input class="var-val" placeholder="Value (e.g. https://api.example.com)" />
    <span class="var-used"></span>
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

// One extraction: variable name, source, selector, and an optional default used
// when nothing matches (also the value left behind by a skipped conditional
// group). Values are set as DOM properties, never parsed as markup.
const SELECTOR_HINTS = { json: 'e.g. data.token  or  items[0].id', header: 'e.g. X-Auth-Token', regex: 'e.g. "token":"(.+?)"' };

export function extractionRow(extraction = {}) {
  const row = document.createElement('div');
  row.className = 'extraction-row';
  const input = (className, placeholder, label) => {
    const field = document.createElement('input');
    field.className = className;
    field.placeholder = placeholder;
    field.setAttribute('aria-label', label);
    return field;
  };
  const name = input('ext-name', 'variable_name', 'Variable name');
  const source = document.createElement('select');
  source.className = 'ext-source';
  source.setAttribute('aria-label', 'Extract from');
  for (const [value, label] of [['json', 'JSON Body'], ['header', 'Header'], ['regex', 'Regex']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    source.appendChild(option);
  }
  const selector = input('ext-selector', 'e.g. data.token', 'JSON path, header name, or regex');
  const fallback = input('ext-default', 'Default', 'Default value when nothing matches');
  fallback.title = 'Used when the response has no match, and when a skipped "Run only if" group never sets this variable. Leave empty for none.';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', 'Remove extraction');
  remove.textContent = '\u00d7';

  name.value = extraction.varName || '';
  source.value = SELECTOR_HINTS[extraction.source] ? extraction.source : 'json';
  selector.value = extraction.selector || '';
  fallback.value = extraction.default == null ? '' : String(extraction.default);
  if (extraction.source) selector.placeholder = SELECTOR_HINTS[source.value];

  source.addEventListener('change', () => {
    selector.placeholder = SELECTOR_HINTS[source.value] || '';
  });
  remove.addEventListener('click', () => {
    const card = row.closest('.req-card');
    row.remove();
    if (card) updateExtCount(card);
  });
  row.append(name, source, selector, fallback, remove);
  return row;
}

// The extraction a row holds. `default` is kept exactly as typed and left out when empty.
export function readExtractionRow(row) {
  const extraction = {
    varName:  row.querySelector('.ext-name').value.trim().replace(/\s+/g, '_'),
    source:   row.querySelector('.ext-source').value,
    selector: row.querySelector('.ext-selector').value.trim(),
  };
  const fallback = row.querySelector('.ext-default')?.value ?? '';
  if (fallback !== '') extraction.default = fallback;
  return extraction;
}
