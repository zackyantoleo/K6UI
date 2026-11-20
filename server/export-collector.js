// Rows a run saves with "Save to CSV" (see public/js/shared/csv-export.js). The
// generated script logs each row as {"k6uiExport":"<file>","columns":[...],"row":[...]};
// k6-runner.js hands those lines here instead of the live log. Rows live in
// memory only (never on disk) and go to the browser in batches as `export`
// events, so a run the user stops still delivers what it saved so far:
//   export — { file, columns, rows: [[...], ...], truncated }
// A file stops taking rows at MAX_EXPORT_FILE_BYTES of CSV, all files together at
// MAX_EXPORT_BYTES, and at most MAX_EXPORT_FILES files are kept; `truncated`
// tells the browser that rows were left out.
import {
  EXPORT_MARKER, MAX_EXPORT_BYTES, MAX_EXPORT_FILE_BYTES, MAX_EXPORT_FILE_NAME, MAX_EXPORT_FILES, csvLine,
} from "../public/js/shared/csv-export.js";

export const EXPORT_LINE_PREFIX = `{"${EXPORT_MARKER}":`;

const cell = (value) => {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

export function createExportCollector(emit, {
  flushMs = 250, maxFileBytes = MAX_EXPORT_FILE_BYTES, maxTotalBytes = MAX_EXPORT_BYTES, maxFiles = MAX_EXPORT_FILES,
} = {}) {
  const files = new Map(); // file → { columns, key, bytes, pending, truncated, reported }
  let total = 0;
  let timer = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const [file, state] of files) {
      const truncatedNews = state.truncated && !state.reported;
      if (!state.pending.length && !truncatedNews) continue;
      emit("export", { file, columns: state.columns, rows: state.pending, truncated: state.truncated });
      state.pending = [];
      state.reported = state.truncated;
    }
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, flushMs);
  }

  // One logged line (already unwrapped from k6's log format). → true when it was
  // an export line (handled or dropped), false for any other text.
  function addLine(raw) {
    if (!raw.startsWith(EXPORT_LINE_PREFIX)) return false;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return true; // never show a broken export line in the log: it may hold a token
    }
    const { [EXPORT_MARKER]: file, columns, row } = entry || {};
    if (typeof file !== "string" || !file || file.length > MAX_EXPORT_FILE_NAME) return true;
    if (!Array.isArray(columns) || !columns.length || !columns.every((name) => typeof name === "string")) return true;
    if (!Array.isArray(row) || row.length !== columns.length) return true;

    let state = files.get(file);
    if (!state) {
      if (files.size >= maxFiles) return true;
      state = { columns, key: JSON.stringify(columns), bytes: 0, pending: [], truncated: false, reported: false };
      files.set(file, state);
      state.bytes = Buffer.byteLength(`${csvLine(columns)}\n`);
      total += state.bytes;
    }
    if (JSON.stringify(columns) !== state.key || state.truncated) return true;

    const values = row.map(cell);
    const bytes = Buffer.byteLength(`${csvLine(values)}\n`);
    if (state.bytes + bytes > maxFileBytes || total + bytes > maxTotalBytes) {
      state.truncated = true;
    } else {
      state.bytes += bytes;
      total += bytes;
      state.pending.push(values);
    }
    schedule();
    return true;
  }

  return { addLine, flush };
}
