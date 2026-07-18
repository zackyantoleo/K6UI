// Turns the UI configuration into a ready-to-run k6 script.
// Main orchestration — codegen details live in sibling modules:
//   options.js     → k6 options object (load + thresholds)
//   request.js     → code block for one HTTP request
//   assertions.js  → check() block for per-request assertions
//   extract.js     → variable extraction from responses
//   interpolate.js → {{varName}} interpolation
import { buildOptions } from "./options.js";
import { buildRequestCode } from "./request.js";
import { buildAssertionsCode } from "./assertions.js";

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

// Global headers are merged into every request (including pre/post
// sub-requests) at codegen time, so their values go through the normal
// {{var}} interpolation. A request-level header with the same name
// (case-insensitive, as HTTP headers are) overrides the global one.
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
  const withGlobalHeaders = (req) =>
    globalHeaders.length ? { ...req, headers: mergeHeaders(globalHeaders, req.headers) } : req;

  const mainReqs = (scenario.requests || []).filter((r) => r && String(r.url || "").trim());

  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { check, sleep } from 'k6';\n\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;

  if (globals.size > 0) {
    out += `\n// Global variables — used via {{name}} in URLs, headers, and bodies\n`;
    out += `const GLOBALS = {\n`;
    for (const [key, value] of globals) {
      out += `  ${key}: ${JSON.stringify(value)},\n`;
    }
    out += `};\n`;
  }

  out += `\nexport default function() {\n`;

  // Variables already declared — prevents a double `let`
  const declaredVars   = new Set();
  // {{name}}s made available by processor scripts assigning vars.<name>
  const processorVars  = new Set();
  const ctx = { localVars: declaredVars, processorVars, globalVars };

  const hasProcessors = mainReqs.some(
    (r) => String(r.preScript || "").trim() || String(r.postScript || "").trim()
  );
  if (hasProcessors) {
    out += `  const vars = {};  // shared by pre/post-processor scripts\n`;
  }

  for (let i = 0; i < mainReqs.length; i++) {
    const req = mainReqs[i];
    const preScript  = String(req.preScript  || "").trim();
    const postScript = String(req.postScript || "").trim();

    // ── Pre sub-request ──────────────────────────────────────
    const preReq = req.pre && String(req.pre.url || "").trim() ? req.pre : null;
    if (preReq) {
      out += `\n  // Pre: request ${i + 1}\n`;
      out += buildRequestCode(withGlobalHeaders(preReq), i, `pre${i}`, ctx, null, false);
      out += "\n";
      for (const e of preReq.extractions || []) {
        if (e && e.varName) declaredVars.add(e.varName);
      }
    }

    // ── Pre-processor ────────────────────────────────────────
    if (preScript) {
      validateProcessor(preScript, `Pre-processor of request ${i + 1}`, false);
      scanAssignedVars(preScript, processorVars);
      out += "\n" + buildProcessorBlock(preScript, `Pre-processor: request ${i + 1}`, null);
    }

    // ── Main request ─────────────────────────────────────────
    out += "\n" + buildRequestCode(withGlobalHeaders(req), i, "main", ctx, null, logRequests);
    out += "\n";

    // ── Assertions ───────────────────────────────────────────
    const assertCode = buildAssertionsCode(req.assertions, `res_main_${i}`);
    if (assertCode) out += assertCode;

    // ── Post-processor ───────────────────────────────────────
    if (postScript) {
      validateProcessor(postScript, `Post-processor of request ${i + 1}`, true);
      out += "\n" + buildProcessorBlock(postScript, `Post-processor: request ${i + 1}`, `res_main_${i}`);
      scanAssignedVars(postScript, processorVars);
    }

    // ── Post sub-request ─────────────────────────────────────
    const postReq = req.post && String(req.post.url || "").trim() ? req.post : null;
    if (postReq) {
      out += `\n  // Post: request ${i + 1}\n`;
      out += buildRequestCode(withGlobalHeaders(postReq), i, `post${i}`, ctx, null, false);
      out += "\n";
      for (const e of postReq.extractions || []) {
        if (e && e.varName) declaredVars.add(e.varName);
      }
    }

    // Add variables extracted by the main request to the declared set
    for (const e of req.extractions || []) {
      if (e && e.varName) declaredVars.add(e.varName);
    }
  }

  out += `}\n`;
  return out;
}
