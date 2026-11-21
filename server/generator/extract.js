// Codegen for extracting variables from a response (JSON path / header / regex).
import { buildGjsonPath, buildJsonAccessor, buildRegex, canonicalHeaderName, jsLiteral, oneLine, regexProblem } from "./helpers.js";
import { NAME_PATTERN } from "../../public/js/shared/basics.js";

const SOURCES = new Set(["json", "header", "regex"]);

// An extraction that produces a variable (the others are skipped silently).
export const isExtractable = (e) => Boolean(e && e.varName && SOURCES.has(e.source));

// The name becomes a `let` in the script, so it must be a plain identifier (the
// [A-Za-z_]\w* rule of the UI and the importers) that strict-mode JavaScript accepts
// as a variable: not `class`, `let`, `eval`, ... `await` is reserved in a module.

function isUsableName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name) || name === "await") return false;
  try {
    new Function(`"use strict"; let ${name};`); // compiled, never run; `name` is \w only
    return true;
  } catch {
    return false;
  }
}

// Names the default function of the script uses itself. An extraction's `let` with one
// of them would declare it twice (a SyntaxError: res_main_0, DATA_1_ROW, ...) or hide
// the module's, k6's or JavaScript's one in the whole function, so the first request
// already fails with "Cannot access a variable before initialization" (http, check,
// JSON, ...). Kept in step with the generator by test/generator-script-safety.test.js,
// which collects every name a full-featured script uses there. Names at the top of the
// module only (options, RACE, Counter, ...) are never read inside it, so they are free.
const SCRIPT_NAMES = new Set([
  "http", "check", "sleep", "grpc", "crypto", "encoding", "exec",
  "GLOBALS", "OUTCOME", "extractOr", "logHttpRequest", "logHttpOutcome", "logGrpcRequest",
  "k6uiRaceWait", "k6uiRaceWarmup", "k6uiRaceRecord",
  "JSON", "String", "Date", "console", "undefined", "__VU", "__ITER", "__ENV",
]);
const SCRIPT_NAME_PATTERN = /^(?:(?:res|body|d|msg|t|outcome)_main_\d+|race_(?:at|sent)_\d+|DATA_\d+(?:_ROW|_ENDED)?|EXPECTED_STATUSES_\d+|OUTCOME_(?:TAGS|RULES|PATTERNS)_\d+|outcomeOf_\d+|grpc_client_\d+)$/;

// True for a name the script always uses itself (also read by the JMeter importer,
// which renames such variables). `vars` (with processor scripts) and `data` (race
// burst) are only taken when the script has them: see validateExtractionNames.
export const isScriptName = (name) => SCRIPT_NAMES.has(name) || SCRIPT_NAME_PATTERN.test(name);

// 400 naming the request when an extraction's name cannot be a variable of the
// script. `processors` = a request that runs has a pre/post-processor (`const vars`),
// `race` = race burst mode (`export default function(data)`).
export function validateExtractionNames(requests, { processors = false, race = false } = {}) {
  requests.forEach((req, i) => {
    for (const e of req.extractions || []) {
      if (!isExtractable(e)) continue;
      const name = e.varName;
      if (!isUsableName(name)) {
        throw new Error(`Request ${i + 1}: "${oneLine(name)}" cannot be the name of an extracted value. Use letters, digits and _ (not starting with a digit), and not a JavaScript word such as "class".`);
      }
      const taken = isScriptName(name)
        || (name === "vars" && processors && "the pre/post-processor scripts keep their values in it")
        || (name === "data" && race && "a race burst passes its start time in it");
      if (taken) {
        throw new Error(`Request ${i + 1}: the script already uses the name "${name}"${typeof taken === "string" ? ` (${taken})` : ""}, so an extracted value cannot have it. Choose another name, such as "${name}_value".`);
      }
    }
  });
}

// 400 naming the request when a regex extraction cannot be written into the script
// (see helpers.js regexProblem).
export function validateExtractionRegexes(requests) {
  requests.forEach((req, i) => {
    for (const e of req.extractions || []) {
      if (!isExtractable(e) || e.source !== "regex") continue;
      const problem = regexProblem(e.selector);
      if (problem) throw new Error(`Request ${i + 1}: extraction "${oneLine(e.varName)}": "${oneLine(String(e.selector))}" is not a regular expression: ${problem}.`);
    }
  });
}

// The fixed value an extraction falls back to, or null when it has none. "" (or
// no field at all) means none: a regex with no match gives "", a missing JSON path
// or header gives undefined (so does a JSON path on a body that is not JSON).
export function extractionDefault(e) {
  const value = e && e.default;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

// Emitted once (index.js) when an extraction has a default: `read` throws for no
// body (regex) or a whole-body JSON read of a body that is not JSON, and returns
// undefined for a missing path, header or match; both give the default.
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

// mode = 'http' → JSON source reads res.json(<gjson path>); regex matches res.body
//                 ("" when there is none); a header name is written as k6 keys it.
// mode = 'grpc' → JSON source reads the already-decoded res.message; regex
//                 matches JSON.stringify(res.message).
// declared = names already declared with `let` (each new one is added), so a name is
// never declared twice; hoisted = names declared above a conditional block (see
// flow.js): they are assigned, never declared again.
export function buildExtractionLines(extractions, resVar, { mode = "http", declared = null, hoisted = null } = {}) {
  if (!Array.isArray(extractions)) return "";
  const lines = [];

  for (const e of extractions) {
    if (!e || !e.varName || !e.source) continue;

    // `read` is undefined when nothing matched; `rhs` is what is assigned.
    let read;
    let rhs;
    const sel = e.selector || "";
    if (e.source === "json") {
      // HTTP: k6 reads the path in Go (gjson), so the body is never parsed in JavaScript.
      // A missing path, an empty body and a body that is not JSON all give undefined.
      const path = mode === "grpc" ? "" : buildGjsonPath(sel);
      read = mode === "grpc"
        ? `${resVar}.message${buildJsonAccessor(sel)}`
        : `${resVar}.json(${path ? jsLiteral(path) : ""})`;
      rhs = read;
    } else if (e.source === "header") {
      // HTTP: k6 keys headers in Go's canonical form (X-Request-Id), whatever was typed.
      read = `${resVar}.headers[${JSON.stringify(mode === "grpc" ? sel : canonicalHeaderName(sel))}]`;
      rhs = read;
    } else if (e.source === "regex") {
      // HTTP: a response without a body (timeout, refused connection) has body null.
      const subject = mode === "grpc" ? `JSON.stringify(${resVar}.message || {})` : `(${resVar}.body ?? "")`;
      read = `(${subject}.match(${buildRegex(sel)}) || [])[1]`;
      rhs = `${read} || ""`;
    } else {
      continue;
    }
    const fallback = extractionDefault(e);
    if (fallback !== null) rhs = `extractOr(() => ${read}, ${jsLiteral(fallback)})`;

    const known = declared?.has(e.varName) || hoisted?.has(e.varName);
    lines.push(`  ${known ? '' : 'let '}${e.varName} = ${rhs};`);
    declared?.add(e.varName);
  }

  return lines.join("\n");
}
