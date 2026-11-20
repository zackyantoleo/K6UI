// Small CSV reader shared by the "Data files" panel (preview, row count) and
// the generator (server/generator/data.js), so both always agree on the rows.
// Handles double-quoted fields ("" escapes a quote, newlines allowed inside),
// a single-character delimiter, CRLF / LF / CR line ends, a leading BOM, and
// skips empty lines. Pure: no DOM, no Node APIs.
import { NAME_PATTERN } from './basics.js';

export class CsvError extends Error {}

// Size limits for the text of a data file (the generator enforces them with a 413).
export const MAX_DATA_SET_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_BYTES = 10 * 1024 * 1024;

const TAB = '\t';

// "\t", "tab" and a real tab → tab; empty → comma; otherwise exactly one
// character that is not a quote or a line break.
export function normalizeDelimiter(value) {
  const text = value == null ? '' : String(value);
  if (text === '') return ',';
  if (text === '\\t' || text === TAB || text.toLowerCase() === 'tab') return TAB;
  if (text.length !== 1 || /["\r\n]/.test(text)) {
    throw new CsvError(`The delimiter must be a single character other than a quote or a line break (got "${text}").`);
  }
  return text;
}

// → string[][] (one array of fields per non-empty line). Throws CsvError when
// a quoted value is never closed, instead of swallowing the rest of the file.
export function parseCsv(input, { delimiter = ',' } = {}) {
  const sep = normalizeDelimiter(delimiter);
  let text = input == null ? '' : String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Plain text between these characters is copied in one slice, which keeps
  // a multi-megabyte file fast.
  const special = new RegExp(`["\r\n${sep.replace(/[\\\]^-]/g, '\\$&')}]`, 'g');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;       // the current field started with a quote
  let fieldStart = true;    // nothing of the current field has been read yet
  let line = 1;
  let quoteLine = 1;

  const endRow = () => {
    // An empty line has no fields; `""` alone is a real (empty) value.
    if (row.length || field !== '' || quoted) {
      row.push(field);
      rows.push(row);
    }
    row = [];
    field = '';
    quoted = false;
    fieldStart = true;
  };

  let i = 0;
  while (i < text.length) {
    if (inQuotes) {
      const close = text.indexOf('"', i);
      if (close < 0) break;
      const chunk = text.slice(i, close);
      field += chunk;
      line += chunk.split('\n').length - 1;
      if (text[close + 1] === '"') { field += '"'; i = close + 2; } else { inQuotes = false; i = close + 1; }
      continue;
    }
    special.lastIndex = i;
    const match = special.exec(text);
    const at = match ? match.index : text.length;
    if (at > i) {
      field += text.slice(i, at);
      fieldStart = false;
    }
    if (!match) break;
    const ch = text[at];
    i = at + 1;
    if (ch === '"') {
      if (fieldStart) {
        inQuotes = true;
        quoted = true;
        fieldStart = false;
        quoteLine = line;
      } else {
        field += '"';
      }
    } else if (ch === sep) {
      row.push(field);
      field = '';
      quoted = false;
      fieldStart = true;
    } else {
      if (ch === '\r' && text[i] === '\n') i++;
      line++;
      endRow();
    }
  }
  if (inQuotes) throw new CsvError(`A quoted value that starts on line ${quoteLine} is never closed.`);
  endRow();
  return rows;
}

// Column names are K6UI variable names, so they follow the same rule as
// global variables. "First Name" → "First_Name"; anything else stays as typed
// (and is ignored later if it is still not a valid name).
export const VALID_COLUMN_NAME = NAME_PATTERN;
export const toColumnName = (value) => String(value ?? '').trim().replace(/\s+/g, '_');

// One data file (config.dataSets item) → its rows and the columns that will be
// used. Column i of the file is columns[i] of the data set; blank names skip a
// file column, and invalid, repeated or "__proto__" names are ignored (listed
// in `ignored`). With no names at all, a header row supplies them.
// `all` is the already parsed file, for callers that parse once and read often.
// → { header, rows, columns: [{ name, field }], ignored: [name] }; throws CsvError.
export function readDataSet(raw, all = parseCsv(typeof raw?.content === 'string' ? raw.content : '', { delimiter: raw?.delimiter })) {
  const skipHeader = raw?.skipHeader === true;
  const header = skipHeader ? all[0] || [] : [];

  let names = Array.isArray(raw?.columns) ? raw.columns : typeof raw?.columns === 'string' ? raw.columns.split(',') : [];
  names = names.map(name => String(name ?? '').trim());
  if (!names.some(Boolean) && skipHeader) names = header.map(toColumnName);

  const seen = new Set();
  const columns = [];
  const ignored = [];
  names.forEach((name, field) => {
    if (!name) return;
    if (name === '__proto__' || !VALID_COLUMN_NAME.test(name) || seen.has(name)) ignored.push(name);
    else { seen.add(name); columns.push({ name, field }); }
  });
  const trim = raw?.trimValues !== false;
  const rows = (skipHeader ? all.slice(1) : all)
    .map(row => (trim ? row.map(cell => String(cell ?? '').trim()) : row));
  return { header, rows, columns, ignored };
}
