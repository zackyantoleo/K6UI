// Codegen for extracting variables from a response (JSON path / header / regex).
import { buildJsonAccessor, buildRegex, jsLiteral } from "./helpers.js";

const SOURCES = new Set(["json", "header", "regex"]);

// An extraction that produces a variable (the others are skipped silently).
export const isExtractable = (e) => Boolean(e && e.varName && SOURCES.has(e.source));

// The fixed value an extraction falls back to, or null when it has none. "" (or
// no field at all) means none, which keeps the behaviour from before defaults:
// a regex with no match gives "", a missing JSON path or header gives undefined.
export function extractionDefault(e) {
  const value = e && e.default;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

// Emitted once (index.js) when an extraction has a default: `read` throws for a
// body that is not JSON (or no body for a regex), and returns undefined for a
// missing path, header or match; both give the default.
export const EXTRACT_OR_SOURCE = `// Value read from a response, or the extraction's default when nothing matched
// (a missing JSON path or header, no regex match, a body that is not JSON)
function extractOr(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}`;

// mode = 'http' → JSON source parses res.body; regex matches res.body.
// mode = 'grpc' → JSON source reads the already-decoded res.message; regex
//                 matches JSON.stringify(res.message).
// targetPrefix = 'data' → data.varName = ...  (for setup, stored on the return value)
// targetPrefix = null   → let varName = ...   (for the main function/teardown)
// localVarSet prevents a double `let` for the same variable name.
// hoisted = names already declared with `let` above a conditional block (see
// index.js): they are assigned, never declared again.
export function buildExtractionLines(extractions, resVar, targetPrefix, localVarSet, mode = "http", hoisted = null) {
  if (!Array.isArray(extractions)) return "";
  const lines = [];

  for (const e of extractions) {
    if (!e || !e.varName || !e.source) continue;

    // `read` is undefined when nothing matched; `rhs` is what is assigned.
    let read;
    let rhs;
    const sel = e.selector || "";
    if (e.source === "json") {
      read = mode === "grpc"
        ? `${resVar}.message${buildJsonAccessor(sel)}`
        : `JSON.parse(${resVar}.body)${buildJsonAccessor(sel)}`;
      rhs = read;
    } else if (e.source === "header") {
      read = `${resVar}.headers[${JSON.stringify(sel)}]`;
      rhs = read;
    } else if (e.source === "regex") {
      const subject = mode === "grpc" ? `JSON.stringify(${resVar}.message || {})` : `${resVar}.body`;
      read = `(${subject}.match(${buildRegex(sel)}) || [])[1]`;
      rhs = `${read} || ""`;
    } else {
      continue;
    }
    const fallback = extractionDefault(e);
    if (fallback !== null) rhs = `extractOr(() => ${read}, ${jsLiteral(fallback)})`;

    if (targetPrefix) {
      lines.push(`  ${targetPrefix}.${e.varName} = ${rhs};`);
    } else {
      const declared = (localVarSet && localVarSet.has(e.varName)) || (hoisted && hoisted.has(e.varName));
      lines.push(`  ${declared ? '' : 'let '}${e.varName} = ${rhs};`);
      if (localVarSet) localVarSet.add(e.varName);
    }
  }

  return lines.join("\n");
}
