// "Save to CSV" exports (see public/js/shared/csv-export.js) → after the request, one
// console.log line per row: {"k6uiExport":"<file>","columns":[...],"row":[...]}.
// k6-runner.js hands those lines to server/export-collector.js instead of the
// live log. Column values are {{var}} templates, interpolated like a URL.
import {
  EXPORT_MARKER, exportColumns, exportsProblem, isBlankExport, normalizeExport,
} from "../../public/js/shared/csv-export.js";
import { extractionDefault, isExtractable } from "./extract.js";
import { interpolate, resolveVariable } from "./interpolate.js";
import { jsLiteral } from "./helpers.js";

// Throws (a 400) for an export that cannot work; `requests` = the requests that run.
export function validateExports(requests) {
  const problem = exportsProblem(requests.map((req, i) => ({ label: `Request ${i + 1}`, exports: req.exports })));
  if (problem) throw new Error(problem);
}

// Every default given to an extraction of a name, anywhere in the flow: with
// "skip missing", a row is not saved while an extracted value is still one of them.
export function extractionDefaultsByName(requests) {
  const byName = new Map();
  for (const req of requests) {
    for (const e of req.extractions || []) {
      if (!isExtractable(e)) continue;
      if (!byName.has(e.varName)) byName.set(e.varName, new Set());
      const fallback = extractionDefault(e);
      if (fallback !== null) byName.get(e.varName).add(fallback);
    }
  }
  return byName;
}

// The code that saves this request's rows, read with the variables known right now.
export function buildExportCode(exports, ctx, defaultsByName) {
  let out = "";
  for (const raw of Array.isArray(exports) ? exports : []) {
    const exp = normalizeExport(raw);
    if (!exp || isBlankExport(exp)) continue;
    const columns = exportColumns(exp);
    const line = `console.log(JSON.stringify({ ${EXPORT_MARKER}: ${jsLiteral(exp.file)}, `
      + `columns: [${columns.map((column) => jsLiteral(column.name)).join(", ")}], `
      + `row: [${columns.map((column) => interpolate(column.value, ctx)).join(", ")}] }));`;

    // Extracted values the row uses; "skip missing" leaves the row out while one
    // of them is empty or still its default.
    const checks = [];
    if (exp.skipMissing) {
      const names = new Set();
      for (const column of columns) {
        for (const [, name] of column.value.matchAll(/\{\{(\w+)\}\}/g)) {
          if (resolveVariable(name, ctx) === name) names.add(name);
        }
      }
      for (const name of names) {
        const missing = ["undefined", "null", '""', ...[...(defaultsByName.get(name) || [])].map(jsLiteral)];
        checks.push(`![${missing.join(", ")}].includes(${name})`);
      }
    }

    out += `\n  // Save a row to CSV ${jsLiteral(exp.file)}${checks.length ? " (only when the extracted values it uses were found)" : ""}\n`;
    out += checks.length ? `  if (${checks.join(" && ")}) {\n    ${line}\n  }\n` : `  ${line}\n`;
  }
  return out;
}
