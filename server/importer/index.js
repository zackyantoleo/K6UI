// Turns a k6 script into a K6UI configuration (the reverse of generator/).
// The script is parsed with acorn and read statically — it is never executed.
//   values.js   → constants, {{variable}} text, static evaluation
//   options.js  → `options` → load profile + thresholds
//   request.js  → http.* calls → requests
//   checks.js   → check() predicates → assertions
//   flow.js     → default function → request flow (groups, sleeps, extractions)
import { parse } from "acorn";

import { importOptions } from "./options.js";
import { importFlow } from "./flow.js";
import { VALID_VAR_NAME, sourceOf, staticValue, Unresolvable } from "./values.js";
import { normalizeRequestLog } from "../../public/js/request-log.js";
import { outcomeLabels } from "../../public/js/outcomes.js";
import { THRESHOLD_NUMBER, THRESHOLD_VARIABLE } from "../../public/js/outcome-thresholds.js";
import { RACE_MODE, normalizeRace, raceOffsetEntries } from "../../public/js/race.js";

export class ScriptImportError extends Error {
  constructor(message, warnings = []) {
    super(message);
    this.warnings = warnings;
  }
}

const K6_NAMES = { http: "http", check: "check", sleep: "sleep", group: "group" };
const LIFECYCLE = new Set(["setup", "teardown", "handleSummary"]);

function createContext(src) {
  const warnings = [];
  const seen = new Set();
  return {
    src,
    names: { ...K6_NAMES },
    consts: new Map(),      // name → { node, top }: constants, resolved where they are used
    bindings: new Map(),    // name → where a response value came from (see flow.js)
    variables: new Map(),   // global variables created while importing: name → value
    globalsName: null,      // name of K6UI's own `const GLOBALS = {...}` object
    dataRows: new Set(),    // K6UI's own data file rows: DATA_1_ROW → {{column}}
    extractOr: false,       // the script declares K6UI's extractOr() helper (extraction defaults)
    outcomeHelper: false,   // the script declares K6UI's outcome helpers (outcomeText(), outcome rules)
    metricsImport: null,    // `import ... from 'k6/metrics'`: K6UI's own when outcomeHelper, else ignored
    outcomeCounts: [],      // count thresholds on k6ui_outcome{rq,outcome} (options.js)
    outcomeRequests: new Map(), // request number of an outcomeOf_<n>() line → its imported request
    raceHelper: false,      // the script declares K6UI's k6uiRaceWait(t0) helper (race burst)
    racePending: false,     // k6uiRaceWait() was read; the next request is the race request
    raceRequest: null,      // the imported race request
    requests: [],
    groups: [],
    logRequests: false,
    warnings,
    warn(node, message) {
      if (seen.has(message)) return;
      seen.add(message);
      warnings.push({ line: node?.loc?.start.line ?? null, message });
    },
  };
}

function parseSource(source) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  } catch (e) {
    const line = e.loc ? ` at line ${e.loc.line}` : "";
    throw new ScriptImportError(`This is not valid JavaScript${line}: ${String(e.message).replace(/\s*\(\d+:\d+\)$/, "")}`);
  }
}

// Which local names do `import http from 'k6/http'` and `import { check } from 'k6'` use?
function readImports(ast, ctx) {
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const from = node.source.value;
    if (from === "k6/http") {
      for (const spec of node.specifiers) {
        if (spec.type !== "ImportSpecifier") ctx.names.http = spec.local.name;
      }
    } else if (from === "k6") {
      for (const spec of node.specifiers) {
        if (spec.type === "ImportSpecifier" && Object.hasOwn(K6_NAMES, spec.imported.name)) {
          ctx.names[spec.imported.name] = spec.local.name;
        }
      }
    } else if (from === "k6/metrics") {
      ctx.metricsImport = node; // reported after the top level is read (see importK6Script)
    } else if (from === "k6/data") {
      ctx.warn(node, `import "${from}" was ignored; data read with SharedArray is not imported — add the CSV file under Data & Rules (Data files).`);
    } else {
      ctx.warn(node, `import "${from}" was ignored; code that uses it is not imported.`);
    }
  }
}

function declarationOf(node) {
  return node.type === "ExportNamedDeclaration" ? node.declaration : node;
}

// K6UI's race burst setup() (generator/race.js): `return { k6uiRaceT0: ... };` and nothing else.
function isRaceSetup(decl) {
  const body = decl.body?.body;
  const returned = body?.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : null;
  return returned?.type === "ObjectExpression" && returned.properties.length === 1
    && returned.properties[0].type === "Property" && !returned.properties[0].computed
    && returned.properties[0].key.type === "Identifier" && returned.properties[0].key.name === "k6uiRaceT0";
}

function collectTopLevel(ast, ctx) {
  const functions = new Map();
  let optionsNode = null;
  let raceSetup = null;

  for (const stmt of ast.body) {
    const decl = declarationOf(stmt);
    if (decl?.type === "FunctionDeclaration" && decl.id) {
      functions.set(decl.id.name, decl);
      if (stmt.type === "ExportNamedDeclaration" && decl.id.name === "setup" && isRaceSetup(decl)) {
        raceSetup = stmt; // reported below unless the script is K6UI's race burst
      } else if (stmt.type === "ExportNamedDeclaration" && LIFECYCLE.has(decl.id.name)) {
        ctx.warn(stmt, `${decl.id.name}() is not imported.`);
      } else if (stmt.type === "ExportNamedDeclaration") {
        ctx.warn(stmt, `Exported function ${decl.id.name}() is not imported (only the default function is).`);
      }
      if (decl.id.name === "redactResponseSample") ctx.logRequests = true; // K6UI's request-log helper
      if (decl.id.name === "extractOr" && !decl.async && !decl.generator && decl.params.length === 2) ctx.extractOr = true;
      if (decl.id.name === "outcomeText" && !decl.async && !decl.generator && decl.params.length === 1) ctx.outcomeHelper = true;
      if (decl.id.name === "k6uiRaceWait" && !decl.async && !decl.generator && decl.params.length === 1) ctx.raceHelper = true;
    } else if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        if (d.init.type === "NewExpression" && d.init.callee.name === "SharedArray") {
          ctx.warn(d, `SharedArray ${d.id.name} (a data file) is not imported; add the CSV file under Data & Rules (Data files) and use {{column}} in the requests.`);
          if (/^DATA_\d+$/.test(d.id.name)) ctx.dataRows.add(`${d.id.name}_ROW`);
        }
        ctx.consts.set(d.id.name, { node: d.init, top: true });
        if (d.id.name === "options" && d.init.type === "ObjectExpression") optionsNode = d.init;
        if (d.id.name === "GLOBALS" && d.init.type === "ObjectExpression") readGlobals(d.init, ctx);
      }
    } else if (stmt.type === "ExpressionStatement") {
      ctx.warn(stmt, `Top-level code \`${sourceOf(stmt, ctx)}\` is not imported.`);
    }
  }
  // K6UI's race setup() only sets T0, which comes back as the race burst's lead time.
  if (raceSetup && !ctx.raceHelper) ctx.warn(raceSetup, "setup() is not imported.");
  return { functions, optionsNode };
}

// `const GLOBALS = { baseUrl: "…" }` is how K6UI's generator writes global variables.
function readGlobals(node, ctx) {
  try {
    const values = staticValue(node, ctx);
    for (const [key, value] of Object.entries(values)) {
      if (VALID_VAR_NAME.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
        ctx.variables.set(key, String(value));
      }
    }
    ctx.globalsName = "GLOBALS";
  } catch (e) {
    if (!(e instanceof Unresolvable)) throw e;
  }
}

// K6UI's request-log helpers: `function redactResponseSample` turns logging on,
// `const REQUEST_LOG = { filter, every, redact }` (newer scripts) says which requests it
// logs and whether it hides secrets. Scripts from before `redact` existed always hid them.
function requestLogOptions(ctx) {
  if (!ctx.logRequests) return { logRequests: false };
  const options = { logRequests: true, logRedact: true };
  const entry = ctx.consts.get("REQUEST_LOG");
  if (entry?.top && entry.node.type === "ObjectExpression") {
    try {
      const value = staticValue(entry.node, ctx);
      Object.assign(options, normalizeRequestLog({
        ...options, logFilter: value.filter, logSampleEvery: value.every, logRedact: value.redact ?? true,
      }));
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
    }
  }
  return options;
}

// Outcome targets: the count thresholds on k6ui_outcome{rq:<n>,outcome:<label>}, on
// a request whose outcomeOf_<n>() line was read. K6UI's own `const OUTCOME_THRESHOLDS`
// (the targets as typed) gives their order and a {{variable}} back when the variable
// still stands for that number; the thresholds decide what is imported. The
// always-passing count>=0 every label has is not a target unless that list has it.
function readOutcomeThresholds(ctx) {
  const found = ctx.outcomeCounts.map((entry) => ({ ...entry, used: false }));
  if (!found.length) return [];
  let typed = [];
  const entry = ctx.outcomeHelper ? ctx.consts.get("OUTCOME_THRESHOLDS") : null;
  if (entry?.top) {
    try {
      const value = staticValue(entry.node, ctx);
      if (Array.isArray(value)) typed = value.filter((item) => item && typeof item === "object");
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
    }
  }
  const numberOf = (text) => {
    const value = String(text ?? "").trim();
    if (THRESHOLD_NUMBER.test(value)) return Number(value);
    const variable = THRESHOLD_VARIABLE.exec(value)?.[1];
    const resolved = variable && ctx.variables.has(variable) ? ctx.variables.get(variable).trim() : "";
    return THRESHOLD_NUMBER.test(resolved) ? Number(resolved) : NaN;
  };
  const picked = [];
  for (const item of typed) {
    const match = found.find((count) => !count.used && count.rq === item.rq && count.label === item.label
      && count.op === item.op && count.number === numberOf(item.value));
    if (!match) continue;
    match.used = true;
    picked.push({ count: match, value: String(item.value).trim() });
  }
  for (const count of found) {
    if (count.used || (count.op === ">=" && count.number === 0)) continue;
    picked.push({ count, value: String(count.number) });
  }
  const targets = [];
  for (const { count, value } of picked) {
    const req = ctx.outcomeRequests.get(count.rq);
    const where = `Threshold ${count.metric}: "${count.expr}"`;
    if (!req) {
      ctx.warn(count.node, `${where} was ignored: request ${count.rq} has no outcome rules that K6UI could read.`);
    } else if (!outcomeLabels(req.outcomes).includes(count.label)) {
      ctx.warn(count.node, `${where} was ignored: "${count.label}" is not a label of the outcome rules of request ${count.rq}.`);
    } else {
      targets.push({ request: req.id, label: count.label, op: count.op, value });
    }
  }
  return targets;
}

// Race burst: K6UI's `const RACE = { ..., config: { timing, vus, ... } }` (the settings as
// typed) + its per-vu-iterations scenario → the race load mode. The race request is the
// one after the k6uiRaceWait() line (flow.js).
function readRace(load, ctx) {
  if (!ctx.raceHelper) return load;
  const entry = ctx.consts.get("RACE");
  let value = null;
  try {
    value = entry?.top ? staticValue(entry.node, ctx) : null;
  } catch (e) {
    if (!(e instanceof Unresolvable)) throw e;
  }
  const typed = value && typeof value === "object" ? value.config : null;
  if (!typed || typeof typed !== "object" || Array.isArray(typed)) {
    ctx.warn(entry?.node ?? null, "The race burst settings (const RACE) could not be read, so the load profile was imported without them.");
    return load;
  }
  if (load.mode !== "iterations" || load.iterations !== "1") {
    ctx.warn(entry.node, "The race burst needs one per-vu-iterations scenario with 1 iteration per VU, so the load profile was imported without it.");
    return load;
  }
  if (!ctx.raceRequest) {
    ctx.warn(entry.node, "The race request (the request after k6uiRaceWait()) could not be read; the race burst sends the first request.");
  }
  const { vus: typedVus, ...settings } = typed;
  const race = normalizeRace({ ...settings, request: ctx.raceRequest?.id ?? "" });
  const vus = race.timing === "offsets"
    ? String(raceOffsetEntries(race.offsets).length || load.vus)
    : (typeof typedVus === "string" && typedVus.trim()) || load.vus;
  return { mode: RACE_MODE, vus, ...(load.maxDuration ? { maxDuration: load.maxDuration } : {}), race };
}

const isFunction = (node) =>
  node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";

function findDefaultFunction(ast, functions, ctx) {
  const exported = ast.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (!exported) return null;
  const decl = exported.declaration;
  if (isFunction(decl)) return decl;
  if (decl.type === "Identifier") {
    if (functions.has(decl.name)) return functions.get(decl.name);
    const entry = ctx.consts.get(decl.name);
    if (isFunction(entry?.node)) return entry.node;
  }
  return null;
}

// → { config, warnings: [{ line, message }] }
export function importK6Script(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new ScriptImportError("Paste or choose a k6 script to import.");
  }
  const ast = parseSource(source);
  const ctx = createContext(source);

  readImports(ast, ctx);
  const { functions, optionsNode } = collectTopLevel(ast, ctx);
  // K6UI's outcome rules and race burst use a Counter from k6/metrics; any other use is not imported.
  if (ctx.metricsImport && !ctx.outcomeHelper && !ctx.raceHelper) {
    ctx.warn(ctx.metricsImport, `import "k6/metrics" was ignored; code that uses it is not imported.`);
  }
  const { load, thresholds } = importOptions(optionsNode, ctx);

  const main = findDefaultFunction(ast, functions, ctx);
  if (!main) {
    throw new ScriptImportError("No `export default function` found — k6 needs one to run requests.", ctx.warnings);
  }
  importFlow(main, ctx);
  const raceLoad = readRace(load, ctx);
  const outcomeThresholds = readOutcomeThresholds(ctx);
  if (outcomeThresholds.length) thresholds.outcomes = outcomeThresholds;

  if (!ctx.requests.length) {
    throw new ScriptImportError("No HTTP requests (http.get, http.post, …) could be read from the default function.", ctx.warnings);
  }

  const config = {
    schemaVersion: 2,
    scenario: { groups: ctx.groups, requests: ctx.requests },
    variables: [...ctx.variables].map(([key, value]) => ({ key, value })),
    globalHeaders: [],
    load: raceLoad,
    thresholds,
    options: requestLogOptions(ctx),
  };
  return { config, warnings: ctx.warnings };
}
