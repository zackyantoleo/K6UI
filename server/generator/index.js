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
//   outcomes.js    → outcome rules → one label per response, counted in k6ui_outcome
//   expected-statuses.js → expected statuses → responseCallback + the status check
//   race.js        → race burst load mode → setup() T0, the wait before the race request
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
import {
  OUTCOME_HELPER_SOURCE, addOutcomeThresholds, buildOutcomeCode, buildOutcomeRulesSource,
  buildOutcomeThresholdsSource, outcomeTargets, planThresholds, usesOutcomeVariable, validateOutcomes,
} from "./outcomes.js";
import { buildExpectedStatusesSource, validateExpectedStatuses } from "./expected-statuses.js";
import { buildRaceSource, buildRaceWaitCode, planRaceScript, raceRequestCode } from "./race.js";
import { OUTCOME_VARIABLE } from "../../public/js/outcomes.js";
import { expandSubRequests } from "../../public/js/sub-requests.js";
import { LOG_BODY_LIMIT, normalizeRequestLog } from "../../public/js/request-log.js";
import { REQ_LOG_RATE } from "../request-log-throttle.js";

// Request logging is opt-in because URLs, headers and bodies can contain
// credentials or personal data. These helpers run inside the generated k6
// script: they pick which requests to log (REQUEST_LOG, see
// public/js/request-log.js), keep each VU within a record budget (REQUEST_LOG.rate /
// .burst, see requestLogBudget), redact common secrets when REQUEST_LOG.redact is
// on ("Hide secrets"; off by default: values are shown as sent), cap the bodies, and print
// one {__r:1,...} JSON line that k6-runner.js turns into a req-log event.
const REQUEST_LOG_HELPERS = String.raw`
// Bearer tokens first ("Authorization: Bearer x" would otherwise hide only the word Bearer).
// A secret field keeps its quotes ("password":"[REDACTED]"), so a JSON body stays JSON;
// a quoted value cut at the size cap (no closing quote) is redacted to its end.
function redactText(value) {
  if (!REQUEST_LOG.redact) return String(value == null ? '' : value);
  return String(value == null ? '' : value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|proxy-authorization|token|access_token|refresh_token|api[_-]?key|password|passwd|secret)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"?|'[^']*'?|[^,"'&\s}]+)/gi, function (match, key, secret) {
      const quote = secret.charAt(0) === '"' || secret.charAt(0) === "'" ? secret.charAt(0) : '';
      return key + quote + '[REDACTED]' + quote;
    });
}

function redactResponseSample(value, limit) {
  const text = String(value == null ? '' : value);
  const max = limit || 500;
  if (text.length <= max) return redactText(text);
  return redactText(text.slice(0, max)) + '\n… [' + (text.length - max) + ' more characters not shown]';
}

function redactRequestUrl(value) {
  const text = redactText(String(value == null ? '' : value).slice(0, 2048));
  if (!REQUEST_LOG.redact) return text;
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return text;
  return text.slice(0, queryStart + 1) + text.slice(queryStart + 1)
    .split('&')
    .map(function (part) {
      const separator = part.indexOf('=');
      if (separator < 0) return part;
      const key = part.slice(0, separator);
      let decodedKey = key;
      try { decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')); } catch (e) {}
      return /(?:authorization|token|api[_-]?key|password|passwd|secret)/i.test(decodedKey)
        ? key + '=[REDACTED]'
        : part;
    })
    .join('&');
}

// With "Hide secrets": header names whose value is not logged (Authorization, Cookie, Set-Cookie, X-Api-Key, ...).
const SECRET_HEADER_NAME = /authorization|cookie|token|secret|password|passwd|api[_-]?key|session|signature|credential/i;

function redactHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  Object.keys(headers).forEach(function (name) {
    const value = headers[name];
    const text = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
    out[name] = REQUEST_LOG.redact && SECRET_HEADER_NAME.test(name) ? '[REDACTED]' : redactResponseSample(text, 1024);
  });
  return out;
}

function errorText(error) {
  if (!error) return '';
  return redactResponseSample(typeof error === 'object' ? (error.message || JSON.stringify(error)) : error, 500);
}

function shouldLogRequest(ok) {
  if (REQUEST_LOG.filter === 'errors') return !ok;
  if (REQUEST_LOG.filter === 'sample') return !ok || __ITER % REQUEST_LOG.every === 0;
  return true;
}

// Budget of this VU (each VU runs its own copy of the script): REQUEST_LOG.burst records
// at first, then REQUEST_LOG.rate a second, for passed and for failed requests each. The
// server forwards only 50 + 50 a second to the browser, so building every record would
// only take time from the test. A record carries how many this VU left out before it (sk).
const LOG_BUDGET = { ok: { tokens: REQUEST_LOG.burst, at: 0 }, failed: { tokens: REQUEST_LOG.burst, at: 0 } };
let logSkipped = 0;

function takeLogBudget(ok) {
  const bucket = ok ? LOG_BUDGET.ok : LOG_BUDGET.failed;
  const now = Date.now();
  if (bucket.at) bucket.tokens = Math.min(REQUEST_LOG.burst, bucket.tokens + (now - bucket.at) * REQUEST_LOG.rate / 1000);
  bucket.at = now;
  if (bucket.tokens < 1) {
    logSkipped += 1;
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

function skippedBefore() {
  const count = logSkipped;
  logSkipped = 0;
  return count;
}

function logHttpRequest(i, method, url, res) {
  const ok = res.status >= 200 && res.status < 400;
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  printHttpRecord(i, method, url, res, ok, undefined);
}

// A request with outcome rules or expected statuses: oc = its outcome label (undefined
// without rules), ok = whether the status counts as a success (its expected statuses,
// else 200–399). Apart from logHttpRequest() so that one keeps its four arguments:
// k6's interpreter ran a six-parameter version called with four about 10% slower.
function logHttpOutcome(i, method, url, res, oc, ok) {
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  printHttpRecord(i, method, url, res, ok, oc);
}

function printHttpRecord(i, method, url, res, ok, oc) {
  const request = res.request || {};
  console.log(JSON.stringify({
    __r: 1, sk: skippedBefore(), vu: __VU, it: __ITER, i: i, m: method, url: redactRequestUrl(url),
    s: res.status, d: +(res.timings.duration.toFixed(1)), ok: ok, oc: oc, er: errorText(res.error),
    rqh: redactHeaders(request.headers), rq: redactResponseSample(request.body, REQUEST_LOG.bodyLimit),
    rh: redactHeaders(res.headers), rb: redactResponseSample(res.body, REQUEST_LOG.bodyLimit),
  }));
}`;

// Only in scripts with a gRPC request.
const GRPC_REQUEST_LOG_HELPER = String.raw`
function logGrpcRequest(i, address, method, message, metadata, res, duration) {
  const ok = !!res && res.status === 0;
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  console.log(JSON.stringify({
    __r: 1, sk: skippedBefore(), vu: __VU, it: __ITER, i: i, m: 'gRPC', url: redactRequestUrl(String(address) + '/' + String(method)),
    s: res ? res.status : null, d: duration, ok: ok, er: errorText(res && res.error),
    rqh: redactHeaders(metadata), rq: redactResponseSample(JSON.stringify(message || {}), REQUEST_LOG.bodyLimit),
    rh: redactHeaders(res && res.headers), rb: redactResponseSample(JSON.stringify((res && res.message) || {}), REQUEST_LOG.bodyLimit),
  }));
}`;

// The browser keeps the 500 most recent records (MAX_REQ_LOGS in public/js/runner.js).
const LOG_BURST_TOTAL = 500;

// Most VUs the load profile runs at once (k6 options from buildOptions).
function maxVusOf(options) {
  if (options.scenarios) return Math.max(1, ...Object.values(options.scenarios).map((s) => Number(s.vus) || 1));
  if (Array.isArray(options.stages) && options.stages.length) {
    return Math.max(1, ...options.stages.map((s) => Number(s.target) || 0));
  }
  return Math.max(1, Number(options.vus) || 1);
}

// Per-VU record budget (see takeLogBudget above): all VUs together write about twice
// what the server forwards (REQ_LOG_RATE passed + as many failed a second), so the
// server limit still decides what is shown, and a short run with few VUs (a race test:
// every VU sends one burst of requests) still records all of them.
export function requestLogBudget(options) {
  const vus = maxVusOf(options);
  return {
    rate: Number(((2 * REQ_LOG_RATE) / vus).toPrecision(3)),
    burst: Math.min(10, Math.max(1, Math.ceil(LOG_BURST_TOTAL / vus))),
  };
}

function requestLogSource(settings, withGrpc, options, bodyLimit = LOG_BODY_LIMIT) {
  const config = {
    filter: settings.logFilter, every: settings.logSampleEvery, redact: settings.logRedact, bodyLimit,
    ...requestLogBudget(options),
  };
  return `\n// Request details for K6UI (Run & Results → Requests)\nconst REQUEST_LOG = ${JSON.stringify(config)};\n`
    + REQUEST_LOG_HELPERS
    + (withGrpc ? `\n${GRPC_REQUEST_LOG_HELPER}` : "")
    + "\n";
}

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

// `meta` (optional) receives what the run needs to read the results back:
// meta.outcomes = the requests with outcome rules (see outcomes.js outcomeTargets),
// meta.race = the race burst plan (race.js), only in race mode.
// `logBodyLimit` (optional) raises the request record's body cap (LOG_BODY_LIMIT) for
// Send once (server/send-once.js); without it the script is unchanged.
export function generateScript(config, meta = null, { logBodyLimit } = {}) {
  const scenario    = config.scenario || {};
  // Race burst: checked first (a 400 naming the field), it decides the scenario.
  const race        = planRaceScript(config);
  const options     = buildOptions(config, race);
  const requestLog  = normalizeRequestLog(config.options);
  const logRequests = requestLog.logRequests;
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

  // Outcome rules: checked up front (400 before any code is built); each label
  // gets an always-passing threshold so k6 reports its count. Outcome targets add
  // their expressions to those thresholds (same request numbers: the requests that run).
  validateOutcomes(mainReqs);
  validateExpectedStatuses(mainReqs);
  const outcomes = outcomeTargets(mainReqs);
  const outcomeByIndex = new Map(outcomes.map((target) => [target.index, target]));
  const outcomeThresholds = planThresholds(config);
  addOutcomeThresholds(options, outcomes, outcomeThresholds);
  if (meta) {
    meta.outcomes = outcomes;
    meta.outcomeThresholds = outcomeThresholds;
    if (race) meta.race = race;
  }

  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { sleep, check } from 'k6';\n\n`;
  if (grpcIndexes.length)              out += `import grpc from 'k6/net/grpc';\n`;
  if (/\bcrypto\./.test(allScripts))   out += `import crypto from 'k6/crypto';\n`;
  if (/\bencoding\./.test(allScripts)) out += `import encoding from 'k6/encoding';\n`;
  if (outcomes.length || race)         out += `import { Counter } from 'k6/metrics';\n`;
  out += buildDataImports(dataSets);
  out += `\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;
  out += buildOutcomeThresholdsSource(outcomeThresholds);
  if (race) out += buildRaceSource(race);
  if (logRequests) out += requestLogSource(requestLog, grpcIndexes.length > 0, options, logBodyLimit);

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

  if (outcomes.length) {
    out += `\n${OUTCOME_HELPER_SOURCE}`;
    out += buildOutcomeRulesSource(outcomes, mainReqs);
  }
  out += buildExpectedStatusesSource(mainReqs);

  // {{$outcome}} reads the label of the latest request with outcome rules that ran in
  // this iteration: kept in one variable, only when a request uses it.
  const keepOutcome = outcomes.length > 0 && mainReqs.some(usesOutcomeVariable);

  // Race burst: the default function reads T0 from setup()'s data.
  out += race ? `\nexport default function(data) {\n` : `\nexport default function() {\n`;
  out += buildDataRowCode(dataSets);
  out += buildDataHoists(dataSets);
  if (keepOutcome) {
    out += `  let ${OUTCOME_VARIABLE} = ""; // {{${OUTCOME_VARIABLE}}}: the latest outcome label of this iteration\n`;
  }

  // Variables already declared — prevents a double `let`
  const declaredVars   = new Set();
  // Extracted by a request inside a conditional block, declared with `let` above
  // it so requests after the block can still read them (see beginRun)
  const hoistedVars    = new Set();
  // {{name}}s made available by processor scripts assigning vars.<name>
  const processorVars  = new Set();
  // {{$name}}: K6UI's own variables, known from the point where they get a value
  const dynamicVars    = new Map();
  const ctx = { localVars: declaredVars, processorVars, dataVars: dataColumns(dataSets), globalVars, hoistedVars, dynamicVars };

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

    // ── Race burst: warm-up + wait, before the pre-processor ─
    if (race && race.index === i) {
      const assigned = new Set();
      scanAssignedVars(preScript, assigned);
      out += buildRaceWaitCode(race, req, ctx, assigned);
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
      const target = outcomeByIndex.get(i);
      const outcome = target ? buildOutcomeCode(target, `res_main_${i}`, keepOutcome) : null;
      const raceCode = race && race.index === i ? raceRequestCode(race, outcome?.name) : null;
      out += "\n" + buildRequestCode(req, i, "main", ctx, null, logRequests, outcome, raceCode);
      // From here on (this request's Save to CSV included), {{$outcome}} has a value.
      if (outcome && keepOutcome) dynamicVars.set(OUTCOME_VARIABLE, OUTCOME_VARIABLE);
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
