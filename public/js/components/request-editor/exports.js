// "Save values to a CSV file" section of a request: after the request, add a row
// to a CSV file of the run (see public/js/csv-export.js). One DOM for Simple and
// Advanced; values are DOM properties, never markup.
import { exportBlock } from '../export-rows.js';
import { OUTCOME_VARIABLE } from '../../outcomes.js';

export function createExportsPanel() {
  const exportsSection = document.createElement('div');
  exportsSection.className = 'exports-section';
  const exportsHint = document.createElement('p');
  exportsHint.className = 'ext-hint';
  exportsHint.append('After this request, add a row to a CSV file. Download it from Run & Results, or use it as a data file in a later run. ');
  const outcomeCode = document.createElement('code');
  outcomeCode.textContent = `{{${OUTCOME_VARIABLE}}}`;
  exportsHint.append(outcomeCode, ' is the outcome label of this request (Label each response).');
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
  exportsSection.append(exportsHint, exportsList, addExport);
  return exportsSection;
}
