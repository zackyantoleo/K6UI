// "Save to CSV" blocks of the "Save values to a CSV file" part of a request (see public/js/csv-export.js): a file
// name, "only when found", and columns of name + value ({{var}} or text). One
// DOM for Simple and Advanced; values are set as DOM properties, never markup.

function input(className, placeholder, label, value = '') {
  const field = document.createElement('input');
  field.className = className;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', label);
  field.value = value;
  return field;
}

function removeButton(className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `row-remove ${className}`;
  button.title = 'Remove';
  button.setAttribute('aria-label', label);
  button.textContent = '×';
  return button;
}

export function exportColumnRow(column = {}) {
  const row = document.createElement('div');
  row.className = 'export-column-row';
  const name = input('export-col-name', 'column_name', 'Column name', column.name || '');
  const value = input('export-col-value', '{{variable}} or text', 'Column value', column.value || '');
  // A value that is just {{name}} (or {{$outcome}}) names an unnamed column after it.
  value.addEventListener('change', () => {
    const only = /^\{\{\$?(\w+)\}\}$/.exec(value.value.trim());
    if (only && !name.value.trim()) name.value = only[1];
  });
  const remove = removeButton('export-col-remove', 'Remove column');
  remove.addEventListener('click', () => row.remove());
  row.append(name, value, remove);
  return row;
}

// A new block starts with one empty column and "only when found" on.
export function exportBlock(exp = { skipMissing: true }) {
  const block = document.createElement('div');
  block.className = 'export-block';

  const head = document.createElement('div');
  head.className = 'export-head';
  const file = input('export-file', 'File name, e.g. orders_created.csv', 'CSV file name', exp.file || '');
  const skip = document.createElement('label');
  skip.className = 'export-skip';
  const skipBox = document.createElement('input');
  skipBox.type = 'checkbox';
  skipBox.className = 'export-skip-missing';
  skipBox.checked = exp.skipMissing === true;
  skip.append(skipBox, ' Only when its extracted values were found');
  skip.title = 'Skip the row while a value it uses from an extraction is empty or still its default.';
  const remove = removeButton('export-remove', 'Remove this CSV export');
  remove.addEventListener('click', () => block.remove());
  head.append(file, skip, remove);

  const columns = document.createElement('div');
  columns.className = 'export-columns';
  const saved = Array.isArray(exp.columns) ? exp.columns : [];
  for (const column of saved.length ? saved : [{}]) columns.appendChild(exportColumnRow(column));

  const addColumn = document.createElement('button');
  addColumn.type = 'button';
  addColumn.className = 'add-row-btn export-add-column';
  addColumn.textContent = '+ Column';
  addColumn.addEventListener('click', () => {
    const row = exportColumnRow();
    columns.appendChild(row);
    row.querySelector('.export-col-name').focus();
  });

  block.append(head, columns, addColumn);
  return block;
}

// The export a block holds. `asTyped` keeps every text untrimmed (for Duplicate).
// Columns left empty are dropped; a block with no file and no column reads as null.
export function readExportBlock(block, { asTyped = false } = {}) {
  const trim = value => (asTyped ? value : value.trim());
  const columns = [...block.querySelectorAll('.export-column-row')]
    .map(row => ({ name: trim(row.querySelector('.export-col-name').value), value: row.querySelector('.export-col-value').value }))
    .filter(column => asTyped || column.name || column.value);
  const exp = {
    file: trim(block.querySelector('.export-file').value),
    columns,
    skipMissing: block.querySelector('.export-skip-missing').checked,
  };
  return asTyped || exp.file || columns.length ? exp : null;
}

export function readExportBlocks(list) {
  return list ? [...list.querySelectorAll('.export-block')].map(block => readExportBlock(block)).filter(Boolean) : [];
}
