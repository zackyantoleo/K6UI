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

function collectTopLevel(ast, ctx) {
  const functions = new Map();
  let optionsNode = null;

  for (const stmt of ast.body) {
    const decl = declarationOf(stmt);
    if (decl?.type === "FunctionDeclaration" && decl.id) {
      functions.set(decl.id.name, decl);
      if (stmt.type === "ExportNamedDeclaration" && LIFECYCLE.has(decl.id.name)) {
        ctx.warn(stmt, `${decl.id.name}() is not imported.`);
      } else if (stmt.type === "ExportNamedDeclaration") {
        ctx.warn(stmt, `Exported function ${decl.id.name}() is not imported (only the default function is).`);
      }
      if (decl.id.name === "redactResponseSample") ctx.logRequests = true; // K6UI's request-log helper
      if (decl.id.name === "extractOr" && !decl.async && !decl.generator && decl.params.length === 2) ctx.extractOr = true;
      if (decl.id.name === "outcomeText" && !decl.async && !decl.generator && decl.params.length === 1) ctx.outcomeHelper = true;
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
  // K6UI's outcome rules use a Counter from k6/metrics; any other use is not imported.
  if (ctx.metricsImport && !ctx.outcomeHelper) {
    ctx.warn(ctx.metricsImport, `import "k6/metrics" was ignored; code that uses it is not imported.`);
  }
  const { load, thresholds } = importOptions(optionsNode, ctx);

  const main = findDefaultFunction(ast, functions, ctx);
  if (!main) {
    throw new ScriptImportError("No `export default function` found — k6 needs one to run requests.", ctx.warnings);
  }
  importFlow(main, ctx);

  if (!ctx.requests.length) {
    throw new ScriptImportError("No HTTP requests (http.get, http.post, …) could be read from the default function.", ctx.warnings);
  }

  const config = {
    schemaVersion: 2,
    scenario: { groups: ctx.groups, requests: ctx.requests },
    variables: [...ctx.variables].map(([key, value]) => ({ key, value })),
    globalHeaders: [],
    load,
    thresholds,
    options: requestLogOptions(ctx),
  };
  return { config, warnings: ctx.warnings };
}
