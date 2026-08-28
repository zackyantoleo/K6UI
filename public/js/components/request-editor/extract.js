import { extractionRow } from '../rows.js';

export function createExtractPanel(onCountChange = () => {}) {
  const panel = document.createElement('div');
  const hint = document.createElement('p');
  hint.className = 'ext-hint';
  hint.append('Extract values from the response, then use ');
  const code = document.createElement('code');
  code.textContent = '{{variable_name}}';
  hint.append(code, ' in later requests.');
  const list = document.createElement('div');
  list.className = 'extractions-list';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-row-btn';
  addButton.setAttribute('aria-label', 'Add extraction');
  addButton.textContent = '+ Extract Variable';
  addButton.addEventListener('click', () => {
    list.appendChild(extractionRow());
    onCountChange();
  });
  list.addEventListener('input', event => {
    if (event.target.classList.contains('ext-name')) onCountChange();
  });
  list.addEventListener('click', event => {
    if (event.target.closest('.btn-remove-sm')) queueMicrotask(onCountChange);
  });
  panel.append(hint, list, addButton);
  return panel;
}
