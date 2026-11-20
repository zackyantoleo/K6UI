// "Save to CSV" exports of a request (config.scenario.requests[].exports):
//   { file: "orders_created.csv",
//     columns: [{ name: "order_number", value: "{{order_number}}" }, { name: "auth", value: "Bearer {{token}}" }],
//     skipMissing: true }
// After the request, the generated script logs one row as a JSON line; the
// server (server/export-collector.js) collects the rows of a run in memory and
// streams them to the browser, which builds the CSV for a download or a data
// file. Nothing is written to disk. Pure and DOM-free: shared by the store, the
// request editor, the results panel and server/generator/csv-export.js.
import { MAX_DATA_BYTES, MAX_DATA_SET_BYTES, VALID_COLUMN_NAME } from './csv-parse.js';
import { isObject, text } from './basics.js';

// One exported file always fits in a data file, and all of them in a project.
export const MAX_EXPORT_FILE_BYTES = MAX_DATA_SET_BYTES;
export const MAX_EXPORT_BYTES = MAX_DATA_BYTES;
export const MAX_EXPORT_FILES = 10;
export const MAX_EXPORT_FILE_NAME = 120;
// The marker the generated script puts first in each logged row.
export const EXPORT_MARKER = 'k6uiExport';


// The canonical shape (unknown fields pass through), or null for a value that is not an export.
export function normalizeExport(raw) {
  if (!isObject(raw)) return null;
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter(isObject).map(column => ({ ...column, name: text(column.name).trim(), value: text(column.value) }))
    : [];
  return { ...raw, file: text(raw.file).trim(), columns, skipMissing: raw.skipMissing === true };
}

export function normalizeExports(raw) {
  return Array.isArray(raw) ? raw.map(normalizeExport).filter(Boolean) : [];
}

// Columns with a name or a value (a row left completely empty is ignored).
export const exportColumns = exp => (exp?.columns || []).filter(column => column.name || column.value);

// No file name and no column: an empty editor block, ignored everywhere.
export const isBlankExport = exp => !exp?.file && !exportColumns(exp).length;

// → the first reason this export cannot be used, or '' (also for a blank one).
export function exportProblem(raw) {
  const exp = normalizeExport(raw);
  if (!exp) return 'A CSV export must be an object with a file name and columns.';
  if (isBlankExport(exp)) return '';
  if (!exp.file) return 'Enter the name of the CSV file.';
  if (exp.file.length > MAX_EXPORT_FILE_NAME) return `The file name is longer than ${MAX_EXPORT_FILE_NAME} characters.`;
  if (/[\\/]|[\u0000-\u001f\u007f]/.test(exp.file)) return 'The file name cannot contain / or \\ or control characters.';
  const columns = exportColumns(exp);
  if (!columns.length) return 'Add at least one column.';
  const seen = new Set();
  for (const [index, column] of columns.entries()) {
    if (!column.name) return `Name column ${index + 1}.`;
    if (!VALID_COLUMN_NAME.test(column.name)) {
      return `Column "${column.name}" is not a valid name: use letters, digits and _, and do not start with a digit (it becomes {{${column.name}}} when the file is used as a data file).`;
    }
    if (seen.has(column.name)) return `Column "${column.name}" appears twice.`;
    seen.add(column.name);
  }
  return '';
}

// Requests that will run, in order, as [{ label, exports }] → the first problem
// across them ('' when there is none): a broken export, two requests saving to
// one file with different columns, or too many files.
export function exportsProblem(requests) {
  const files = new Map(); // file → { label, names }
  for (const { label, exports } of requests) {
    for (const [index, raw] of (Array.isArray(exports) ? exports : []).entries()) {
      const problem = exportProblem(raw);
      if (problem) return `${label}, Save to CSV ${index + 1}: ${problem}`;
      const exp = normalizeExport(raw);
      if (isBlankExport(exp)) continue;
      const names = exportColumns(exp).map(column => column.name).join(', ');
      const first = files.get(exp.file);
      if (first && first.names !== names) {
        return `"${exp.file}" is saved by ${first.label} with columns ${first.names} and by ${label} with columns ${names}; use the same columns, or another file name.`;
      }
      if (!first) files.set(exp.file, { label, names });
    }
  }
  if (files.size > MAX_EXPORT_FILES) return `A flow can save to at most ${MAX_EXPORT_FILES} CSV files (this one saves to ${files.size}).`;
  return '';
}

// ── CSV text ───────────────────────────────────────────────────
// Quoted when it holds a comma, a quote or a line break (the reader in
// csv-parse.js does not trim, so spaces stay as they are).
export function csvField(value) {
  const field = text(value);
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

// One line; a single empty field is written as "" so the reader does not skip it.
export function csvLine(fields) {
  const line = fields.map(csvField).join(',');
  return line === '' ? '""' : line;
}

// Header + rows, one line each, ending with a line break.
export function toCsv(columns, rows) {
  return [csvLine(columns), ...rows.map(csvLine)].map(line => `${line}\n`).join('');
}

// A name that is safe to offer as a download: no path, no reserved characters, a .csv end.
export function downloadName(file) {
  const name = text(file).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/^[.\s]+|\s+$/g, '').slice(0, MAX_EXPORT_FILE_NAME);
  if (!name) return 'export.csv';
  return /\.(csv|tsv|txt)$/i.test(name) ? name : `${name}.csv`;
}
