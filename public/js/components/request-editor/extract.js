import { extractionRow } from '../rows.js';
import { exportBlock } from '../export-rows.js';

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

  // "Save to CSV": after this request, add a row to a CSV file of the run.
  const exportsSection = document.createElement('div');
  exportsSection.className = 'exports-section';
  const exportsTitle = document.createElement('p');
  exportsTitle.className = 'exports-title';
  exportsTitle.textContent = 'Save to CSV';
  const exportsHint = document.createElement('p');
  exportsHint.className = 'ext-hint';
  exportsHint.textContent = 'After this request, add a row to a CSV file. Download it from Run & Results, or use it as a data file in a later run.';
  const exportsList = document.createElement('div');
  exportsList.className = 'exports-list';
  const addExport = document.createElement('button');
  addExport.type = 'button';
  addExport.className = 'add-row-btn add-export';
  addExport.textContent = '+ Save to CSV';
  addExport.addEventListener('click', () => {
    const block = exportBlock();
    exportsList.appendChild(block);
    block.querySelector('.export-file').focus();
  });
  exportsSection.append(exportsTitle, exportsHint, exportsList, addExport);

  panel.append(hint, list, addButton, exportsSection);
  return panel;
}
