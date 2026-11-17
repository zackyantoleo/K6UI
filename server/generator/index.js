// Turns the UI configuration into a ready-to-run k6 script.
// Main orchestration — codegen details live in sibling modules:
//   options.js     → k6 options object (load + thresholds)
//   request.js     → code block for one HTTP request
//   assertions.js  → check() block for per-request assertions
//   extract.js     → variable extraction from responses
//   interpolate.js → {{varName}} interpolation
//   data.js        → data files (CSV) → SharedArray + the row of each iteration
//   run-if.js      → "run only if" condition of a request group → if (...) { ... }
//   csv-export.js  → "Save to CSV" exports → one logged row after the request
import { buildOptions } from "./options.js";
import { buildRequestCode } from "./request.js";
import { buildGrpcRequestCode, validateGrpcRequest } from "./grpc-request.js";
import { buildAssertionsCode } from "./assertions.js";
import { EXTRACT_OR_SOURCE, extractionDefault, isExtractable } from "./extract.js";
import { jsLiteral } from "./helpers.js";
import {
  buildDataDeclarations, buildDataHoists, buildDataImports, buildDataRowCode, buildGroupDataRowCode,
  dataColumns, prepareDataSets,
} from "./data.js";
import { buildRunIfCondition, runIfComment } from "./run-if.js";
import { buildExportCode, extractionDefaultsByName, validateExports } from "./csv-export.js";
import { expandSubRequests } from "../../public/js/sub-requests.js";

// Request logging is opt-in because URLs and response samples can contain
// credentials or personal data. This helper runs inside the generated k6
// script before a response sample is emitted to K6UI.
const RESPONSE_REDACTOR_SOURCE = `
function redactResponseSample(value) {
  let text = String(value == null ? '' : value).slice(0, 500);
  text = text.replace(/(["']?(?:authorization|proxy-authorization|token|access_token|refresh_token|api[_-]?key|password|passwd|secret)["']?\\s*[:=]\\s*)["']?[^,"'&\\s}]+/gi, '$1[REDACTED]');
  text = text.replace(/(Bearer\\s+)[A-Za-z0-9._~+\\/-]+=*/gi, '$1[REDACTED]');
  return text;
}

function redactRequestUrl(value) {
  const text = redactResponseSample(value);
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return text;
  return text.slice(0, queryStart + 1) + text.slice(queryStart + 1)
    .split('&')
    .map(function (part) {
      const separator = part.indexOf('=');
      if (separator < 0) return part;
      const key = part.slice(0, separator);
      const decodedKey = decodeURIComponent(key.replace(/\\+/g, ' '));
      return /(?:authorization|token|api[_-]?key|password|passwd|secret)/i.test(decodedKey)
        ? key + '=[REDACTED]'
        : part;
    })
    .join('&');
}`;

// Global variables must be valid JS identifiers: they are emitted as object
// keys on GLOBALS and referenced via dot access ({{name}} → GLOBALS.name).
const VALID_VAR_NAME = /^[A-Za-z_]\w*$/;

function collectGlobalVars(variables) {
  const map = new Map();
  if (!Array.isArray(variables)) return map;
  for (const v of variables) {
    if (!v || !v.key || !VALID_VAR_NAME.test(v.key)) continue;
    map.set(v.key, String(v.value == null ? "" : v.value));
  }
  return map;
}

// Pre/post-processor scripts are inlined into the generated script as
// block-scoped code. Assignments to `vars.<name>` make {{name}} usable in
// later URLs/headers/bodies (see scanAssignedVars + interpolate.js).
const ASSIGNED_VAR =
  /\bvars\.([A-Za-z_]\w*)\s*(?:=(?!=)|[+\-*/%]=|\*\*=|&&=|\|\|=|\?\?=|\+\+|--)/g;

function scanAssignedVars(code, into) {
  for (const m of code.matchAll(ASSIGNED_VAR)) into.add(m[1]);
}

// Compile (without executing) to reject broken user code with a clear
// message instead of producing a script that k6 cannot parse.
function validateProcessor(code, label, withRes) {
  try {
    new Function(withRes ? `const res = 0;\n${code}` : code);
  } catch (e) {
    throw new Error(`${label} is not valid JavaScript: ${e.message}`);
  }
}

function buildProcessorBlock(code, label, resVar) {
  const body = code
    .split("\n")
    .map((l) => (l.trim() ? "    " + l : ""))
    .join("\n");
  const lines = [`  // ${label}`, `  {`];
  if (resVar) lines.push(`    const res = ${resVar};`);
  lines.push(body, `  }`);
  return lines.join("\n") + "\n";
}

// Headers are merged global → group → request at codegen time. Later levels
// override earlier levels using case-insensitive HTTP header names.
function mergeHeaders(globalHeaders, reqHeaders) {
  const out = [];
  const byName = new Map(); // lowercase name → index in out
  const all = [...globalHeaders, ...(Array.isArray(reqHeaders) ? reqHeaders : [])];
  for (const h of all) {
    if (!h || !h.key) continue;
    const name = String(h.key).toLowerCase();
    if (byName.has(name)) out[byName.get(name)] = h;
    else { byName.set(name, out.length); out.push(h); }
  }
  return out;
}

export function generateScript(config) {
  const scenario    = config.scenario || {};
  const options     = buildOptions(config);
  const logRequests = !!(config.options && config.options.logRequests);
  const globals     = collectGlobalVars(config.variables);
  const globalVars  = new Set(globals.keys());

  const globalHeaders = (Array.isArray(config.globalHeaders) ? config.globalHeaders : [])
    .filter((h) => h && h.key && String(h.key).trim());
  const groups = new Map(
    (Array.isArray(scenario.groups) ? scenario.groups : [])
      .filter((group) => group && group.id)
      .map((group) => [group.id, group])
  );
  const groupPosition = new Map([...groups.keys()].map((id, position) => [id, position]));
  const dataSets = prepareDataSets(config.dataSets, groups);
  const withInheritedHeaders = (req) => {
    const group = req && groups.get(req.groupId);
    const groupHeaders = group?.headers || [];
    const grouped = group
      ? {
          ...req,
          headers: mergeHeaders(groupHeaders, req.headers),
          _groupId: group.id,
          _groupName: group.name || "Request group",
        }
      : { ...req };
    return globalHeaders.length
      ? { ...grouped, headers: mergeHeaders(globalHeaders, grouped.headers) }
      : grouped;
  };

  // A payload with Before/After sub-requests (`pre` / `post`) runs them as ordinary requests.
  const mainReqs = (expandSubRequests(scenario.requests) || [])
    .filter((r) => {
      const group = r && groups.get(r.groupId);
      return r && r.enabled !== false && (!group || group.enabled !== false) && String(r.url || "").trim();
    })
    .map(withInheritedHeaders);

  // Auto-import the k6 utility modules a processor script refers to, so
  // e.g. crypto.sha256(...) works in a pre/post-processor out of the box.
  const allScripts = mainReqs
    .map((r) => `${r.preScript || ""}\n${r.postScript || ""}`)
    .join("\n");

  const grpcIndexes = mainReqs
    .map((r, i) => (r.type === "grpc" ? i : -1))
    .filter((i) => i !== -1);

  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { sleep, check } from 'k6';\n\n`;
  if (logRequests) out += `${RESPONSE_REDACTOR_SOURCE}\n\n`;
  if (grpcIndexes.length)              out += `import grpc from 'k6/net/grpc';\n`;
  if (/\bcrypto\./.test(allScripts))   out += `import crypto from 'k6/crypto';\n`;
  if (/\bencoding\./.test(allScripts)) out += `import encoding from 'k6/encoding';\n`;
  out += buildDataImports(dataSets);
  out += `\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;

  if (globals.size > 0) {
    out += `\n// Global variables — used via {{name}} in URLs, headers, and bodies\n`;
    out += `const GLOBALS = {\n`;
    for (const [key, value] of globals) {
      out += `  ${key}: ${JSON.stringify(value)},\n`;
    }
    out += `};\n`;
  }

  out += buildDataDeclarations(dataSets);

  if (grpcIndexes.length) {
    out += `\n// gRPC clients — connect with server reflection (no .proto files needed)\n`;
    for (const i of grpcIndexes) {
      out += `const grpc_client_${i} = new grpc.Client();\n`;
    }
  }

  // "Save to CSV": checked up front, so a broken export is a 400 before any code is built.
  validateExports(mainReqs);
  const exportDefaults = extractionDefaultsByName(mainReqs);

  // extractOr() is only written when an extraction that will run has a default.
  const hasDefault = (e) => isExtractable(e) && extractionDefault(e) !== null;
  if (mainReqs.some((r) => (r.extractions || []).some(hasDefault))) {
    out += `\n${EXTRACT_OR_SOURCE}\n`;
  }

  out += `\nexport default function() {\n`;
  out += buildDataRowCode(dataSets);
  out += buildDataHoists(dataSets);

  // Variables already declared — prevents a double `let`
  const declaredVars   = new Set();
  // Extracted by a request inside a conditional block, declared with `let` above
  // it so requests after the block can still read them (see beginRun)
  const hoistedVars    = new Set();
  // {{name}}s made available by processor scripts assigning vars.<name>
  const processorVars  = new Set();
  const ctx = { localVars: declaredVars, processorVars, dataVars: dataColumns(dataSets), globalVars, hoistedVars };

  const hasProcessors = mainReqs.some(
    (r) => String(r.preScript || "").trim() || String(r.postScript || "").trim()
  );
  if (hasProcessors) {
    out += `  const vars = {};  // shared by pre/post-processor scripts\n`;
  }

  // Consecutive requests of one group form a "run". A run starts by choosing the
  // rows of the group's data files and, with a "run only if" condition, opens
  // `if (...) {` (closed after the run's last request). The condition is read
  // when the run starts, so a group split by other requests is checked per run.
  const groupIdOf = (req) => req._groupId || "";
  let blockOpen = false;
  const endRun = () => {
    if (blockOpen) out += `  }\n`;
    blockOpen = false;
  };
  const beginRun = (start) => {
    const group = groups.get(mainReqs[start]._groupId);
    let end = start;
    while (end + 1 < mainReqs.length && groupIdOf(mainReqs[end + 1]) === group.id) end++;
    const run = mainReqs.slice(start, end + 1);

    if (group.runIf != null) {
      const condition = buildRunIfCondition(group, groupPosition.get(group.id), ctx, dataSets);
      out += hoistRunDeclarations(run);
      out += `\n${runIfComment(group, groupPosition.get(group.id))}`;
      out += `  if (${condition}) {\n`;
      blockOpen = true;
    }
    const rows = buildGroupDataRowCode(dataSets, group.id);
    if (rows) out += (blockOpen ? "" : "\n") + rows;
  };

  // Names a conditional run extracts or assigns would otherwise live and die
  // inside its block. An extracted name starts at its extraction's default (the
  // first extraction of that name in the run that has one), else empty, so a
  // skipped group leaves the default behind.
  const hoistRunDeclarations = (run) => {
    const extracted = new Map(); // name → default or null
    const assigned = new Set();
    for (const r of run) {
      for (const e of r.extractions || []) {
        if (!isExtractable(e) || declaredVars.has(e.varName)) continue;
        if (extracted.has(e.varName)) {
          if (extracted.get(e.varName) === null) extracted.set(e.varName, extractionDefault(e));
          continue;
        }
        if (hoistedVars.has(e.varName)) continue;
        hoistedVars.add(e.varName);
        extracted.set(e.varName, extractionDefault(e));
      }
      scanAssignedVars(String(r.preScript || ""), assigned);
      scanAssignedVars(String(r.postScript || ""), assigned);
    }
    let code = "";
    if (extracted.size) {
      const withDefaults = [...extracted.values()].some((value) => value !== null);
      code += `\n  // Extracted inside a conditional group: declared here so later requests can read them (${withDefaults ? "their default, or empty," : "empty"} if the group does not run)\n`;
      for (const [name, fallback] of extracted) code += `  let ${name} = ${fallback === null ? '""' : jsLiteral(fallback)};\n`;
    }
    if (assigned.size) {
      code += `\n  // Set by scripts inside a conditional group: empty until they run\n`;
      for (const name of assigned) code += `  if (vars.${name} === undefined) vars.${name} = "";\n`;
    }
    return code;
  };

  for (let i = 0; i < mainReqs.length; i++) {
    const req = mainReqs[i];
    const preScript  = String(req.preScript  || "").trim();
    const postScript = String(req.postScript || "").trim();

    if (groupIdOf(req) !== (i ? groupIdOf(mainReqs[i - 1]) : "")) {
      endRun();
      if (req._groupId) beginRun(i);
    }

    if (req._groupName) {
      out += `\n  // Group: ${String(req._groupName).replace(/[\r\n]+/g, " ")}\n`;
    }

    // ── Pre-processor ────────────────────────────────────────
    if (preScript) {
      validateProcessor(preScript, `Pre-processor of request ${i + 1}`, false);
      scanAssignedVars(preScript, processorVars);
      out += "\n" + buildProcessorBlock(preScript, `Pre-processor: request ${i + 1}`, null);
    }

    // ── Main request (HTTP or gRPC) ──────────────────────────
    const isGrpc = req.type === "grpc";
    if (isGrpc) {
      validateGrpcRequest(req, `Request ${i + 1}`);
      out += "\n" + buildGrpcRequestCode(req, i, "main", ctx, logRequests);
    } else {
      out += "\n" + buildRequestCode(req, i, "main", ctx, null, logRequests);
    }
    out += "\n";

    // ── Assertions ───────────────────────────────────────────
    const assertCode = buildAssertionsCode(req.assertions, `res_main_${i}`, isGrpc ? "grpc" : "http");
    if (assertCode) out += assertCode;

    // ── Post-processor ───────────────────────────────────────
    if (postScript) {
      validateProcessor(postScript, `Post-processor of request ${i + 1}`, true);
      out += "\n" + buildProcessorBlock(postScript, `Post-processor: request ${i + 1}`, `res_main_${i}`);
      scanAssignedVars(postScript, processorVars);
    }

    // Add variables extracted by the main request to the declared set
    for (const e of req.extractions || []) {
      if (e && e.varName) declaredVars.add(e.varName);
    }

    // ── Save to CSV (after everything of this request) ───────
    out += buildExportCode(req.exports, ctx, exportDefaults);
  }

  endRun();
  out += `}\n`;
  return out;
}
