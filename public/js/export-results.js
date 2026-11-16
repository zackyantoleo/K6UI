// "Saved to CSV" in Run & Results: rows a run saves with "Save to CSV" arrive as
// `export` SSE events (server/export-collector.js) and are kept here, in this
// tab's memory only, until the next run. Each file can be downloaded as CSV or
// used as a data file. One DOM for Simple and Advanced; file names and values
// are rendered as text only. The pure model at the top needs no DOM.
import { $ } from './dom.js';
import { MAX_EXPORT_FILES, downloadName, toCsv } from './csv-export.js';
import { useAsDataFile } from './data-files.js';

// ── Model (pure) ───────────────────────────────────────────────
// file → { columns, rows, truncated }, in the order the files first arrived.
export function createExportStore() {
  const files = new Map();
  return {
    files,
    // One `export` event. → true when it changed something.
    add(data) {
      const { file, columns, rows, truncated } = data || {};
      if (typeof file !== 'string' || !file || !Array.isArray(columns) || !columns.length) return false;
      let entry = files.get(file);
      if (!entry) {
        if (files.size >= MAX_EXPORT_FILES) return false;
        entry = { columns: columns.map(String), rows: [], truncated: false };
        files.set(file, entry);
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (Array.isArray(row) && row.length === entry.columns.length) entry.rows.push(row.map(value => String(value ?? '')));
      }
      entry.truncated ||= truncated === true;
      return true;
    },
    csv(file) {
      const entry = files.get(file);
      return entry ? toCsv(entry.columns, entry.rows) : '';
    },
    clear() { files.clear(); },
  };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// ── DOM ────────────────────────────────────────────────────────
const store = createExportStore();
const items = new Map(); // file → <li>
let renderPending = false;

function download(file) {
  const blob = new Blob([store.csv(file)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = downloadName(file);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function useAsData(file, status) {
  const result = useAsDataFile(file, store.csv(file));
  status.textContent = {
    created: `Added as the data file "${result.name}" (Data & Rules, Data files).`,
    replaced: `The rows of the data file "${result.name}" were replaced (Data & Rules, Data files).`,
    kept: 'The data file was left as it was.',
    'too-big': 'These rows are larger than a data file can hold.',
  }[result.result] || '';
}

function createItem(file) {
  const item = document.createElement('li');
  item.className = 'run-export';
  const name = document.createElement('span');
  name.className = 'run-export-name';
  name.textContent = file;
  const count = document.createElement('span');
  count.className = 'run-export-count';
  const actions = document.createElement('div');
  actions.className = 'run-export-actions';
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'btn ghost sm run-export-download';
  downloadButton.textContent = 'Download CSV';
  downloadButton.setAttribute('aria-label', `Download ${file} as CSV`);
  const useButton = document.createElement('button');
  useButton.type = 'button';
  useButton.className = 'btn ghost sm run-export-use';
  useButton.textContent = 'Use as data file';
  useButton.setAttribute('aria-label', `Use ${file} as a data file`);
  const status = document.createElement('p');
  status.className = 'run-export-status';
  status.setAttribute('role', 'status');
  downloadButton.addEventListener('click', () => download(file));
  useButton.addEventListener('click', () => useAsData(file, status));
  actions.append(downloadButton, useButton);
  item.append(name, count, actions, status);
  return item;
}

function render() {
  renderPending = false;
  const section = $('#run-exports');
  const list = $('#run-exports-list');
  if (!section || !list) return;
  section.hidden = store.files.size === 0;
  for (const [file, entry] of store.files) {
    let item = items.get(file);
    if (!item) {
      item = createItem(file);
      items.set(file, item);
      list.append(item);
    }
    item.querySelector('.run-export-count').textContent =
      `${plural(entry.rows.length, 'row')}${entry.truncated ? ' (size limit reached: later rows were left out)' : ''}`;
    const empty = entry.rows.length === 0;
    item.querySelector('.run-export-download').disabled = empty;
    item.querySelector('.run-export-use').disabled = empty;
  }
}

export function addExportRows(data) {
  if (!store.add(data) || renderPending) return;
  renderPending = true;
  requestAnimationFrame(render);
}

export function resetExports() {
  store.clear();
  items.clear();
  $('#run-exports-list')?.replaceChildren();
  render();
}
