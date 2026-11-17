// "Data files" panel (Data & Rules): CSV files whose rows feed {{column}}
// placeholders, one row per iteration. Each card keeps its data in
// `card.dataSet` (one config.dataSets item); the DOM only shows and edits it.
// Rows are read with csv-parse.js, the same reader the generator uses, so the
// preview and the generated script always agree. File contents are shown with
// textContent only. The pure helpers at the top need no DOM.
import { $, $$ } from './dom.js';
import { createDataSetId } from './project-store.js';
import {
  CsvError, MAX_DATA_BYTES, MAX_DATA_SET_BYTES, parseCsv, readDataSet, toColumnName,
} from './csv-parse.js';

const PREVIEW_ROWS = 5;
const PREVIEW_COLUMNS = 12;
const DELIMITERS = [',', ';', '\t', '|'];

// ── Pure helpers ───────────────────────────────────────────────
const byteLength = text => new TextEncoder().encode(text).length;
// Rounded up, so a file over the limit never reads as exactly the limit.
const megabytes = bytes => `${(Math.ceil(bytes / 104857.6) / 10).toFixed(1)} MB`;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// "email, password" → ['email', 'password']; a blank skips a file column.
export function parseColumnNames(text) {
  const names = String(text ?? '').split(',').map(toColumnName);
  while (names.length && !names.at(-1)) names.pop();
  return names;
}

// The most frequent of , ; tab | in the first line: a guess the user can change.
export function guessDelimiter(text) {
  const firstLine = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  let best = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = firstLine.split(delimiter).length - 1;
    if (count > bestCount) { best = delimiter; bestCount = count; }
  }
  return best;
}

// How a data file will be used: rows, used columns, ignored names, or an error.
// `parsed` is an already parsed file (see card caching below).
export function describeDataSet(set, parsed) {
  try {
    return { ...readDataSet(set, parsed), error: '' };
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    return { header: [], rows: [], columns: [], ignored: [], error: e.message };
  }
}

// The first problem that stops a run or script preview, or null. Data files
// the generator ignores anyway (no content) are fine.
export function validateDataSets(dataSets) {
  let total = 0;
  for (const [index, set] of (Array.isArray(dataSets) ? dataSets : []).entries()) {
    if (!set?.content) continue;
    const label = set.name || set.fileName || `Data file ${index + 1}`;
    const size = byteLength(set.content);
    if (size > MAX_DATA_SET_BYTES) {
      return `Data file "${label}" is ${megabytes(size)}; the limit is ${megabytes(MAX_DATA_SET_BYTES)} per file.`;
    }
    total += size;
    if (total > MAX_DATA_BYTES) {
      return `The data files add up to ${megabytes(total)}; the limit is ${megabytes(MAX_DATA_BYTES)} in total.`;
    }
    const info = describeDataSet(set);
    if (info.error) return `Data file "${label}": ${info.error}`;
    if (info.rows.length && !info.columns.length) {
      return `Data file "${label}": name its columns (letters, digits, and underscores) so {{column}} can use them.`;
    }
  }
  return null;
}

// ── Cards ──────────────────────────────────────────────────────
// The request groups of the flow ([{ id, name }]), for each card's "Read the row" select.
let knownGroups = [];
const list = () => $('#data-files-list');
const cards = () => $$('#data-files-list .data-file-card');
const notify = () => window.dispatchEvent(new CustomEvent('k6ui:data-sets-changed'));

function blankDataSet() {
  return {
    id: createDataSetId(), name: '', fileName: '', delimiter: ',', skipHeader: true,
    columns: [], content: '', share: 'next-row', onEnd: 'recycle',
  };
}

// Parse once per content/delimiter; every other edit reuses the rows.
function parsedRows(card) {
  const { content, delimiter } = card.dataSet;
  const key = `${card.contentVersion}|${delimiter}`;
  if (card.parsedKey !== key) {
    card.parsedKey = key;
    try {
      card.parsed = parseCsv(content, { delimiter });
      card.parseError = '';
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      card.parsed = [];
      card.parseError = e.message;
    }
  }
  return card.parsed;
}

function describeCard(card) {
  const all = parsedRows(card);
  return card.parseError
    ? { header: [], rows: [], columns: [], ignored: [], error: card.parseError }
    : describeDataSet(card.dataSet, all);
}

// Column names from the header row (the text a typed list is compared with).
function headerColumns(card) {
  const header = card.dataSet.skipHeader ? parsedRows(card)[0] || [] : [];
  const names = header.map(toColumnName);
  while (names.length && !names.at(-1)) names.pop();
  return names;
}

// Column names follow the header until the user types their own.
function syncColumns(card) {
  const set = card.dataSet;
  const input = card.querySelector('.df-columns');
  const typed = input.value.trim();
  if (typed && typed !== card.autoColumns) return;
  const names = headerColumns(card);
  card.autoColumns = names.join(', ');
  input.value = card.autoColumns;
  set.columns = names;
}

function renderPreview(card, info) {
  const wrap = card.querySelector('.df-preview-wrap');
  const sample = info.rows.slice(0, PREVIEW_ROWS);
  wrap.classList.toggle('hidden', !sample.length);
  if (!sample.length) return;

  const used = new Map(info.columns.map(column => [column.field, column.name]));
  const width = Math.min(
    PREVIEW_COLUMNS,
    Math.max(...sample.map(row => row.length), ...info.columns.map(column => column.field + 1)),
  );
  const head = document.createElement('tr');
  for (let field = 0; field < width; field++) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = used.get(field) ?? `Column ${field + 1} (not used)`;
    th.classList.toggle('df-unused', !used.has(field));
    head.append(th);
  }
  const body = sample.map(row => {
    const tr = document.createElement('tr');
    for (let field = 0; field < width; field++) {
      const td = document.createElement('td');
      td.textContent = row[field] ?? '';
      td.title = row[field] ?? '';
      td.classList.toggle('df-unused', !used.has(field));
      tr.append(td);
    }
    return tr;
  });
  card.querySelector('.df-preview thead').replaceChildren(head);
  card.querySelector('.df-preview tbody').replaceChildren(...body);
  card.querySelector('.df-preview-caption').textContent =
    `Preview: first ${Math.min(PREVIEW_ROWS, info.rows.length)} of ${plural(info.rows.length, 'row')}`;
}

function statusText(set, info) {
  if (info.error) return info.error;
  if (!set.content) {
    return set.fileName
      ? `Choose "${set.fileName}" (or paste its text) to give this data file its rows. Until then it is ignored.`
      : 'Choose a CSV file or paste its text. Until then this data file is ignored.';
  }
  if (!info.rows.length) return 'This file has no data rows, so it is ignored.';
  const parts = [plural(info.rows.length, 'row')];
  if (info.columns.length) parts.push(`${plural(info.columns.length, 'column')} used: ${info.columns.map(c => `{{${c.name}}}`).join(', ')}`);
  else parts.push('name the columns to use them');
  if (info.ignored.length) parts.push(`ignored (not valid names or repeated): ${info.ignored.join(', ')}`);
  return `${parts.join(' · ')}.`;
}

function renderCard(card) {
  const set = card.dataSet;
  const info = describeCard(card);
  card.usable = !info.error && info.rows.length > 0 && info.columns.length > 0;
  card.querySelector('.df-file-name').textContent = set.content
    ? set.fileName || 'Pasted text'
    : set.fileName ? `${set.fileName} (no data yet)` : 'No file chosen';
  const status = card.querySelector('.df-status');
  status.textContent = card.notice || statusText(set, info);
  status.classList.toggle('df-error', Boolean(card.notice || info.error));
  renderPreview(card, info);
}

function changed(card) {
  card.notice = '';
  renderCard(card);
  notify();
}

// New text for this data file (a chosen file or pasted CSV).
function loadContent(card, text, fileName) {
  const size = byteLength(text);
  if (size > MAX_DATA_SET_BYTES) {
    card.notice = `That text is ${megabytes(size)}; the limit is ${megabytes(MAX_DATA_SET_BYTES)} per data file.`;
    renderCard(card);
    return;
  }
  card.notice = '';
  const set = card.dataSet;
  set.content = text;
  set.fileName = fileName;
  card.contentVersion += 1;
  if (fileName && !set.name) {
    set.name = fileName;
    card.querySelector('.df-name').value = fileName;
  }
  set.delimiter = /\.tsv$/i.test(fileName) ? '\t' : guessDelimiter(text);
  setDelimiterControl(card);
  syncColumns(card);
  changed(card);
}

function setDelimiterControl(card) {
  const select = card.querySelector('.df-delimiter');
  const { delimiter } = card.dataSet;
  if (![...select.options].some(option => option.value === delimiter)) {
    const option = document.createElement('option');
    option.value = delimiter;
    option.textContent = `Custom ( ${delimiter} )`;
    select.append(option);
  }
  select.value = delimiter;
}

const groupOption = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });

// Fills the card's group select from the known groups. `dropMissing`: a group that
// no longer exists means the file goes back to "every iteration" (only safe once
// the groups are final: while a project loads, the old groups are still shown).
function syncGroupSelect(card, dropMissing) {
  const set = card.dataSet;
  const select = card.querySelector('.df-group');
  select.replaceChildren(
    groupOption('', 'At the start of every iteration'),
    ...knownGroups.map(group => groupOption(group.id, `Only when group "${group.name}" starts`)),
  );
  const exists = knownGroups.some(group => group.id === set.groupId);
  if (!exists && dropMissing && set.groupId) set.groupId = '';
  select.value = exists ? set.groupId : '';
}

// Called whenever the flow's group list changes (names included).
export function refreshDataSetGroups(groups) {
  knownGroups = groups;
  for (const card of cards()) syncGroupSelect(card, true);
}

function bindCard(card) {
  const set = card.dataSet;
  const field = selector => card.querySelector(selector);

  field('.df-name').addEventListener('input', event => { set.name = event.target.value; notify(); });
  field('.df-remove').addEventListener('click', () => {
    if (set.content && !confirm('Remove this data file and its rows from the project?')) return;
    card.remove();
    syncEmpty();
    notify();
    $('#add-data-file').focus();
  });

  const fileInput = field('.df-file');
  field('.df-pick').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (file.size > MAX_DATA_SET_BYTES) {
      card.notice = `"${file.name}" is ${megabytes(file.size)}; the limit is ${megabytes(MAX_DATA_SET_BYTES)} per data file.`;
      renderCard(card);
      return;
    }
    const reader = new FileReader();
    reader.onload = event => loadContent(card, String(event.target.result), file.name);
    reader.onerror = () => { card.notice = 'The file could not be read.'; renderCard(card); };
    reader.readAsText(file);
  });

  const pasted = field('.df-paste-text');
  field('.df-paste-apply').addEventListener('click', () => {
    if (!pasted.value.trim()) {
      card.notice = 'Paste some CSV text first.';
      renderCard(card);
      return;
    }
    loadContent(card, pasted.value, '');
    pasted.value = '';
    field('.df-paste').open = false;
  });

  field('.df-delimiter').addEventListener('change', event => {
    set.delimiter = event.target.value;
    syncColumns(card);
    changed(card);
  });
  field('.df-skip-header').addEventListener('change', event => {
    set.skipHeader = event.target.checked;
    syncColumns(card);
    changed(card);
  });
  field('.df-trim').addEventListener('change', event => {
    set.trimValues = event.target.checked;
    changed(card);
  });
  field('.df-columns').addEventListener('input', event => {
    set.columns = parseColumnNames(event.target.value);
    changed(card);
  });
  field('.df-share').addEventListener('change', event => { set.share = event.target.value; notify(); });
  field('.df-end').addEventListener('change', event => { set.onEnd = event.target.value; notify(); });
  field('.df-group').addEventListener('change', event => { set.groupId = event.target.value; notify(); });
}

function createCard(dataSet) {
  const card = $('#data-file-template').content.firstElementChild.cloneNode(true);
  card.dataSet = { ...blankDataSet(), ...dataSet, columns: [...(dataSet.columns || [])] };
  card.contentVersion = 0;
  card.autoColumns = null;
  card.notice = '';
  const set = card.dataSet;
  card.querySelector('.df-name').value = set.name;
  card.querySelector('.df-skip-header').checked = set.skipHeader;
  card.querySelector('.df-trim').checked = set.trimValues !== false;
  card.querySelector('.df-columns').value = set.columns.join(', ');
  card.querySelector('.df-share').value = set.share;
  card.querySelector('.df-end').value = set.onEnd;
  syncGroupSelect(card, false);
  setDelimiterControl(card);
  bindCard(card);
  renderCard(card);
  // Saved column names that are just the header stay in step with it.
  const fromHeader = headerColumns(card).join(', ');
  if (set.columns.length && fromHeader === set.columns.join(', ')) card.autoColumns = fromHeader;
  return card;
}

function syncEmpty() {
  $('#data-files-empty').classList.toggle('hidden', cards().length > 0);
}

// ── Public API ─────────────────────────────────────────────────
export function collectDataSets() {
  return cards().map(({ dataSet }) => ({ ...dataSet, name: dataSet.name.trim(), columns: [...dataSet.columns] }));
}

export function restoreDataSets(dataSets) {
  list().replaceChildren(...(dataSets || []).map(createCard));
  syncEmpty();
}

// Rows a run saved with "Save to CSV" (CSV text with a header row) → the data file
// with that file name, its rows replaced (after a confirm when it has other rows),
// or a new one. A data file imported from a .jmx without rows is filled this way.
// → { result: 'created' | 'replaced' | 'kept' | 'too-big', name }
export function useAsDataFile(fileName, text) {
  if (byteLength(text) > MAX_DATA_SET_BYTES) return { result: 'too-big', name: fileName };
  let card = cards().find(({ dataSet }) => dataSet.fileName === fileName)
    || cards().find(({ dataSet }) => !dataSet.content && dataSet.name === fileName);
  const label = card ? card.dataSet.name || card.dataSet.fileName : fileName;
  if (card?.dataSet.content && card.dataSet.content !== text
      && !confirm(`Replace the rows of the data file "${label}" with the rows saved by this run?`)) {
    return { result: 'kept', name: label };
  }
  const created = !card;
  if (!card) {
    card = createCard({ ...blankDataSet(), name: fileName, fileName });
    list().append(card);
    syncEmpty();
  }
  // The saved rows always start with a header row.
  card.dataSet.skipHeader = true;
  card.querySelector('.df-skip-header').checked = true;
  loadContent(card, text, fileName);
  return { result: created ? 'created' : 'replaced', name: card.dataSet.name || fileName };
}

// Data files the generator will use: rows and at least one valid column.
export const usableDataFileCount = () => cards().filter(card => card.usable).length;

export function initDataFiles() {
  $('#add-data-file').addEventListener('click', () => {
    const card = createCard(blankDataSet());
    list().append(card);
    syncEmpty();
    card.querySelector('.df-name').focus();
    notify();
  });
  syncEmpty();
}
