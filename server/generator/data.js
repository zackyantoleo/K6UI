// Data files (CSV) → k6 code. Rows are embedded in the script as a
// SharedArray literal, so "View Script" and standalone runs need no extra file.
//
// config.dataSets: [{ id, name, fileName, delimiter, skipHeader, columns,
//                     content, share, onEnd }]
//   share  "next-row" (default): row = exec.scenario.iterationInTest, shared by every VU
//          "per-vu":             row = __VU - 1
//   onEnd  "recycle"  (default): start over after the last row (modulo)
//          "stop":               end the iteration early, with one log line
//   groupId (optional) a request group: the row is chosen, and "stop" applies, only
//          when that group starts (inside its `if` when it has a "run only if"
//          condition); a data set of a turned-off group is not used at all. No
//          groupId = global: the row is chosen at the start of every iteration.
// Column names are variable names ([A-Za-z_]\w*); other columns are ignored.
// {{column}} resolves to the row of the current iteration (see interpolate.js).
//
// The CSV reader lives in public/js/shared/csv-parse.js: the Data files panel uses
// it for its preview, so the UI and the generator always count the same rows.
import { CsvError, MAX_DATA_BYTES, MAX_DATA_SET_BYTES, readDataSet } from "../../public/js/shared/csv-parse.js";
import { oneLine } from "./helpers.js";

export { MAX_DATA_BYTES, MAX_DATA_SET_BYTES };

// status 413 → the payload is too big; 400 → the file content is unusable.
export class DataSetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Rounded up, so a file over the limit never reads as exactly the limit.
const megabytes = (bytes) => `${(Math.ceil(bytes / 104857.6) / 10).toFixed(1)} MB`;

// JSON is almost JavaScript: U+2028/U+2029 are the one difference that older
// engines reject inside a string literal.
const literal = (value) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// Raw config → the data sets the generator will use. A data set without rows
// or without a usable column is dropped (its {{placeholders}} stay literal).
// `groups` (Map id → group) says which groupIds exist and which groups are off.
// → [{ index, ident, row, label, columns: [name], rows: [[value]], share, onEnd, groupId }]
export function prepareDataSets(rawSets, groups = new Map()) {
  if (!Array.isArray(rawSets)) return [];
  const prepared = [];
  let total = 0;

  rawSets.forEach((raw, position) => {
    if (!raw || typeof raw !== "object") return;
    const group = typeof raw.groupId === "string" ? groups.get(raw.groupId) : undefined;
    // Its group never runs, so its rows are never read: it must not count towards the limits either.
    if (group && group.enabled === false) return;
    const content = typeof raw.content === "string" ? raw.content : "";
    if (!content) return;
    const label = oneLine(raw.name || raw.fileName).slice(0, 120) || `Data file ${position + 1}`;

    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_DATA_SET_BYTES) {
      throw new DataSetError(`Data file "${label}" is ${megabytes(bytes)}; the limit is ${megabytes(MAX_DATA_SET_BYTES)} per file.`, 413);
    }
    total += bytes;
    if (total > MAX_DATA_BYTES) {
      throw new DataSetError(`The data files add up to ${megabytes(total)}; the limit is ${megabytes(MAX_DATA_BYTES)} in total.`, 413);
    }

    let read;
    try {
      read = readDataSet(raw);
    } catch (e) {
      if (e instanceof CsvError) throw new DataSetError(`Data file "${label}": ${e.message}`);
      throw e;
    }
    const { rows, columns } = read;
    if (!columns.length || !rows.length) return;

    const index = prepared.length + 1;
    prepared.push({
      index,
      ident: `DATA_${index}`,
      row: `DATA_${index}_ROW`,
      label,
      columns: columns.map((column) => column.name),
      rows: rows.map((row) => columns.map(({ field }) => row[field] ?? "")),
      share: raw.share === "per-vu" ? "per-vu" : "next-row",
      onEnd: raw.onEnd === "stop" ? "stop" : "recycle",
      groupId: group ? group.id : "",
    });
  });
  return prepared;
}

// {{column}} → the variable that holds the current row. The first data set
// that has the column wins.
export function dataColumns(sets) {
  const map = new Map();
  for (const set of sets) for (const name of set.columns) if (!map.has(name)) map.set(name, set.row);
  return map;
}

export function buildDataImports(sets) {
  return sets.length ? `import { SharedArray } from 'k6/data';\nimport exec from 'k6/execution';\n` : "";
}

// Module level: one SharedArray per data set (parsed once, shared by all VUs).
export function buildDataDeclarations(sets) {
  if (!sets.length) return "";
  let out = `\n// Data files — each iteration reads one row; use {{column}} in URLs, headers, and bodies\n`;
  for (const set of sets) {
    const rows = set.rows.map((row) => `    ${literal(row)}`).join(",\n");
    out += `// ${set.label}: ${set.columns.join(", ")} (${set.rows.length} row${set.rows.length === 1 ? "" : "s"})\n`;
    // SharedArray names must be unique: the same name returns the first array.
    out += `const ${set.ident} = new SharedArray(${literal(`${set.index}: ${set.label}`)}, function () {\n`;
    out += `  const columns = ${literal(set.columns)};\n`;
    out += `  return [\n${rows}\n  ].map(function (row) {\n`;
    out += `    const item = {};\n`;
    out += `    columns.forEach(function (name, i) { item[name] = row[i]; });\n`;
    out += `    return item;\n`;
    out += `  });\n`;
    out += `});\n`;
    if (set.share === "per-vu" && set.onEnd === "stop") out += `let ${set.ident}_ENDED = false;\n`;
  }
  return out;
}

// The lines that pick the row of one data set. `declare` = "const " at the start of
// the default function; "" assigns a row hoisted with let (see buildDataHoists).
function rowLines(set, declare) {
  const { ident, row } = set;
  const perVu = set.share === "per-vu";
  const index = perVu ? "__VU - 1" : "exec.scenario.iterationInTest";
  let out = `  // Data file: ${set.label} — ${perVu ? "one row per VU" : "next row for every iteration"}\n`;
  if (set.onEnd === "recycle") {
    return out + `  ${declare}${row} = ${ident}[(${index}) % ${ident}.length];\n`;
  }
  const message = literal(`Data file "${set.label}" has no more rows (${set.rows.length}); ending iterations early.`);
  out += `  ${declare}${row} = ${ident}[${index}];\n`;
  out += `  if (!${row}) {\n`;
  // One log for the whole test: only one iteration number equals the row count.
  out += perVu
    ? `    if (!${ident}_ENDED) { ${ident}_ENDED = true; console.warn(${message}); }\n`
    : `    if (exec.scenario.iterationInTest === ${ident}.length) console.warn(${message});\n`;
  // Without a pause a duration-based test would spin through empty iterations.
  out += `    sleep(1);\n    return;\n  }\n`;
  return out;
}

// Start of the default function: pick this iteration's row of every global data set.
export function buildDataRowCode(sets) {
  return sets.filter((set) => !set.groupId).map((set) => rowLines(set, "const ")).join("");
}

// Data sets that belong to a group: their row variable is declared up front with
// empty columns, so a request outside the group (or in an iteration where the
// group does not run) reads "" instead of failing.
export function buildDataHoists(sets) {
  const scoped = sets.filter((set) => set.groupId);
  if (!scoped.length) return "";
  let out = `  // Data files of request groups: read only when that group starts (empty until then)\n`;
  for (const set of scoped) {
    const empty = Object.fromEntries(set.columns.map((name) => [name, ""]));
    out += `  let ${set.row} = ${literal(empty)};\n`;
  }
  return out;
}

// The rows of the data sets of one group, at the start of that group's run.
export function buildGroupDataRowCode(sets, groupId) {
  return sets.filter((set) => set.groupId === groupId).map((set) => rowLines(set, "")).join("");
}
