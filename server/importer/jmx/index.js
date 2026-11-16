// Turns a JMeter test plan (.jmx) into a K6UI configuration. The XML is only
// read, never run. One thread group becomes the flow; elements that K6UI
// cannot represent are skipped and reported as warnings.
//   xml.js      → XML → element tree (with line numbers for warnings)
//   props.js    → JMeter properties, ${var} → {{var}}, variable names
//   load.js     → thread group → load profile
//   sampler.js  → HTTP Request (+ Header Manager, HTTP Request Defaults) → request
//   rules.js    → assertions, extractors, timers
//   data.js     → CSV Data Set Config → data file (no rows: the .jmx only names the file)
//
// Scope follows JMeter: config elements, timers, assertions and extractors
// apply to every request at their level and below. Header Managers at test
// plan / thread group level become global headers; a controller directly
// under the thread group becomes a request group (with its headers); deeper
// controllers are merged into that group.
import { ScriptImportError } from "../index.js";
import { convertCsvDataSet, warnDataConflicts } from "./data.js";
import { importLoad } from "./load.js";
import { argumentsOf, isEnabled, items, jmxText, k6Name, prop, resolveVariables, str, titleOf } from "./props.js";
import { convertAssertion, convertExtractor, convertTimer } from "./rules.js";
import { buildRequest, mergeHeaders, readHeaders, urlParts } from "./sampler.js";
import { XmlError, parseXml } from "./xml.js";

const HTTP_SAMPLERS = new Set(["HTTPSamplerProxy", "HTTPSampler", "HTTPSampler2"]);
const GROUPING = new Set(["GenericController", "TransactionController", "RecordingController"]);
// Reporting and browser-like elements with nothing to import (k6 keeps cookies per VU by itself).
const SILENT = /^(?:ResultCollector|BackendListener|Summariser|CookieManager|CacheManager|DNSCacheManager|DebugSampler|DebugPostProcessor|TestFragmentController)$|(?:Collector|Visualizer|Listener)$/;

function classify(el) {
  const kind = el.name.split(".").pop();
  if (HTTP_SAMPLERS.has(kind)) return "http";
  if (kind === "TestAction") return "pause";
  if (/ThreadGroup$/.test(kind)) return "thread";
  if (SILENT.test(kind)) return "silent";
  if (/Control(?:ler)?$/.test(kind)) return "controller";
  if (/Sampler$/.test(kind)) return "sampler";
  if (kind === "HeaderManager") return "headers";
  if (kind === "ConfigTestElement" && (el.attrs.guiclass === "HttpDefaultsGui" || prop(el, "HTTPSampler.domain"))) return "defaults";
  if (kind === "Arguments") return "variables";
  if (/Timer$/.test(kind)) return "timer";
  if (/Assertion$/.test(kind)) return "assertion";
  if (/Extractor$|PostProcessor$/.test(kind)) return "extractor";
  return "other";
}

// A .jmx tree pairs each element with the <hashTree> that follows it (its children).
function entries(tree) {
  const kids = tree?.children ?? [];
  const out = [];
  kids.forEach((el, i) => {
    if (el.name !== "hashTree") out.push({ el, tree: kids[i + 1]?.name === "hashTree" ? kids[i + 1] : null });
  });
  return out;
}

function createContext() {
  const warnings = [];
  const seen = new Set();
  return {
    names: new Map(),       // JMeter variable name → K6UI name
    variables: new Map(),   // global variables: K6UI name → value
    dataSets: [],           // [{ set, el }] CSV data files, see data.js
    globalHeaders: [],
    groups: [],
    requests: [],
    flow: [],               // [{ req | null, delay, enabled }] in execution order
    warnings,
    warn(el, message) {
      if (seen.has(message)) return;
      seen.add(message);
      warnings.push({ line: el?.line ?? null, message });
    },
  };
}

function addVariables(args, el, ctx) {
  for (const arg of args) {
    const name = str(arg, "Argument.name").trim();
    if (!name) continue;
    const key = k6Name(name, ctx, el);
    const value = resolveVariables(jmxText(str(arg, "Argument.value"), ctx, el, `variable "${name}"`), ctx);
    const unresolved = /\{\{\w+\}\}/.exec(value);
    if (unresolved) ctx.warn(el, `Variable "${name}" uses ${unresolved[0]}, which has no value when the test starts; it was kept as text.`);
    ctx.variables.set(key, value);
  }
}

// First pass over one level: everything that is not a request or controller
// changes the scope for the requests at this level and below.
function collectScope(tree, parent, ctx) {
  const scope = {
    ...parent,
    defaults: { ...parent.defaults },
    timers: [...parent.timers],
    assertions: [...parent.assertions],
    extractors: [...parent.extractors],
    extractions: [],
  };
  for (const { el } of entries(tree)) {
    const kind = classify(el);
    if (!isEnabled(el) || ["http", "pause", "thread", "silent", "controller", "sampler"].includes(kind)) continue;

    if (kind === "headers") {
      const headers = readHeaders(el, ctx);
      if (scope.level === "plan" || scope.level === "thread") ctx.globalHeaders = mergeHeaders(ctx.globalHeaders, headers);
      else if (scope.level === "group") scope.group.headers = mergeHeaders(scope.group.headers, headers);
      else scope.headers = mergeHeaders(scope.headers, headers);
    } else if (kind === "defaults") {
      for (const [key, value] of Object.entries(urlParts(el))) if (value) scope.defaults[key] = value;
      if (argumentsOf(el, "HTTPsampler.Arguments").length) {
        ctx.warn(el, `The default parameters in HTTP Request Defaults "${titleOf(el)}" are not supported and were ignored.`);
      }
    } else if (kind === "variables") {
      addVariables(items(el, "Arguments.arguments"), el, ctx);
    } else if (kind === "timer") {
      const ms = convertTimer(el, ctx);
      if (ms) scope.timers.push(ms);
    } else if (kind === "assertion") {
      const { assertions, ignoreStatus } = convertAssertion(el, ctx);
      scope.assertions.push(...assertions);
      scope.ignoreStatus ||= ignoreStatus;
    } else if (kind === "extractor") {
      const extractions = convertExtractor(el, ctx);
      if (!extractions.length) continue;
      if (scope.level === "request") scope.extractions.push(...extractions);
      else scope.extractors.push({ el, extractions, claimed: false });
    } else if (el.name === "CSVDataSet") {
      convertCsvDataSet(el, scope, ctx);
    } else {
      ctx.warn(el, `${el.name.split(".").pop()} "${titleOf(el)}" is not supported and was skipped.`);
    }
  }
  return scope;
}

const sameAssertion = (a, b) => a.type === b.type && a.value === b.value && a.value2 === b.value2;

function addRequest(el, tree, scope, ctx) {
  const local = collectScope(tree, { ...scope, level: "request" }, ctx);
  const built = buildRequest(el, local.defaults, ctx, `req_jmx_${ctx.requests.length + 1}`);
  if (!built) return;
  const { req, form } = built;
  req.enabled = isEnabled(el) && scope.enabled;
  req.groupId = scope.group?.id ?? "";
  req.headers = local.headers;
  const inherited = [...ctx.globalHeaders, ...(scope.group?.headers ?? []), ...req.headers];
  if (form && !inherited.some((h) => h.key.toLowerCase() === "content-type")) {
    req.headers = [...req.headers, { key: "Content-Type", value: "application/x-www-form-urlencoded" }];
  }
  req.checkStatus = !local.ignoreStatus;
  req.assertions = local.assertions.filter((a, i, all) => all.findIndex((b) => sameAssertion(a, b)) === i);

  // An extractor above a request runs after every request in its scope in
  // JMeter; K6UI gives it to the first one (later ones would fail to parse).
  req.extractions = [...local.extractions];
  for (const extractor of local.extractors) {
    if (extractor.claimed) continue;
    extractor.claimed = true;
    req.extractions.push(...extractor.extractions);
    ctx.warn(extractor.el, `"${titleOf(extractor.el)}" applies to every request in its scope in JMeter; K6UI attached it to the first one, "${req.name}".`);
  }
  ctx.requests.push(req);
  ctx.flow.push({ req, delay: local.timers.reduce((a, b) => a + b, 0) });
}

// Flow Control Action: a pause (plus the timers in its scope) before the next request.
function addPause(el, tree, scope, ctx) {
  if (!isEnabled(el)) return;
  const local = collectScope(tree, { ...scope, level: "request" }, ctx);
  let delay = local.timers.reduce((a, b) => a + b, 0);
  if (str(el, "ActionProcessor.action").trim() === "1") {
    delay += Math.max(Number(str(el, "ActionProcessor.duration")) || 0, 0);
  } else {
    ctx.warn(el, `Flow Control Action "${titleOf(el)}" only imports as a pause; its stop / next-loop action was skipped.`);
  }
  ctx.flow.push({ req: null, delay, enabled: scope.enabled });
}

function addController(el, tree, scope, ctx) {
  const kind = el.name.split(".").pop();
  const name = titleOf(el);
  if (kind === "ModuleController" || kind === "IncludeController") {
    ctx.warn(el, `${kind} "${name}" is not supported; the requests it refers to were not imported.`);
    return;
  }
  if (!GROUPING.has(kind)) {
    ctx.warn(el, `${kind} "${name}": its logic is not supported, so its requests were imported to run once per iteration, in order.`);
  }
  if (scope.level === "thread") {
    const group = { id: `grp_jmx_${ctx.groups.length + 1}`, name: name.slice(0, 120), enabled: isEnabled(el), collapsed: false, headers: [] };
    ctx.groups.push(group);
    walk(tree, { ...scope, level: "group", group }, ctx);
    return;
  }
  if (GROUPING.has(kind) && scope.group) {
    ctx.warn(el, `Nested controller "${name}" was merged into group "${scope.group.name}" (K6UI groups are one level deep).`);
  }
  walk(tree, { ...scope, level: "nested", enabled: scope.enabled && isEnabled(el) }, ctx);
}

function walk(tree, parent, ctx) {
  const scope = collectScope(tree, parent, ctx);
  for (const { el, tree: children } of entries(tree)) {
    const kind = classify(el);
    if (kind === "http") addRequest(el, children, scope, ctx);
    else if (kind === "pause") addPause(el, children, scope, ctx);
    else if (kind === "controller") addController(el, children, scope, ctx);
    else if (kind === "sampler" && isEnabled(el)) {
      ctx.warn(el, `${el.name.split(".").pop()} "${titleOf(el)}" is not an HTTP request and was skipped.`);
    }
  }
}

// JMeter timers pause *before* a request; K6UI pauses *after* one. A pause
// before request N becomes a pause after request N-1 (the first one wraps to
// the end of the previous iteration).
function placePauses(ctx) {
  const groups = new Map(ctx.groups.map((g) => [g.id, g]));
  const runs = (item) => (item.req ? item.req.enabled && groups.get(item.req.groupId)?.enabled !== false : item.enabled);
  const live = ctx.flow.filter(runs);
  const requests = live.filter((item) => item.req);
  if (!requests.length) return;
  live.forEach((item, i) => {
    if (!item.delay) return;
    const before = live.slice(0, i).filter((x) => x.req);
    const target = (before.length ? before : requests).at(-1).req;
    target.sleepAfter = String(+(Number(target.sleepAfter) + item.delay / 1000).toFixed(3));
  });
}

function pickThreadGroup(planTree, ctx) {
  const groups = entries(planTree).filter(({ el }) => classify(el) === "thread");
  let chosen = null;
  for (const entry of groups) {
    const { el } = entry;
    const kind = el.name.split(".").pop();
    if (!isEnabled(el)) continue;
    if (kind === "SetupThreadGroup" || kind === "PostThreadGroup") {
      ctx.warn(el, `${kind === "SetupThreadGroup" ? "setUp" : "tearDown"} thread group "${titleOf(el)}" is not supported and was skipped.`);
    } else if (!chosen) {
      chosen = entry;
    } else {
      ctx.warn(el, `Thread group "${titleOf(el)}" was skipped: K6UI runs one flow, so only "${titleOf(chosen.el)}" was imported.`);
    }
  }
  return chosen;
}

// → { config, warnings: [{ line, message }] }
export function importJmx(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new ScriptImportError("Paste or choose a JMeter test plan (.jmx) to import.");
  }
  let root;
  try {
    root = parseXml(source);
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    throw new ScriptImportError(`This is not a valid .jmx file: ${e.message}.`);
  }
  if (root.name !== "jmeterTestPlan") {
    throw new ScriptImportError(`This XML is not a JMeter test plan: its root element is <${root.name}>, not <jmeterTestPlan>.`);
  }

  const ctx = createContext();
  const plan = entries(root.children.find((c) => c.name === "hashTree")).find(({ el }) => el.name === "TestPlan");
  if (!plan) throw new ScriptImportError("No Test Plan element was found in the .jmx file.");
  addVariables(argumentsOf(plan.el, "TestPlan.user_defined_variables"), plan.el, ctx);

  const base = {
    level: "plan", group: null, enabled: true, ignoreStatus: false,
    defaults: {}, headers: [], timers: [], assertions: [], extractors: [],
  };
  const planScope = collectScope(plan.tree, base, ctx);
  const threadGroup = pickThreadGroup(plan.tree, ctx);
  if (!threadGroup) {
    throw new ScriptImportError("No enabled thread group was found — K6UI imports the requests of one thread group.", ctx.warnings);
  }
  const load = importLoad(threadGroup.el, ctx);
  walk(threadGroup.tree, { ...planScope, level: "thread" }, ctx);
  placePauses(ctx);
  warnDataConflicts(ctx);

  if (!ctx.requests.length) {
    throw new ScriptImportError(`Thread group "${titleOf(threadGroup.el)}" has no HTTP requests to import.`, ctx.warnings);
  }
  const config = {
    schemaVersion: 2,
    scenario: {
      groups: ctx.groups.filter((g) => ctx.requests.some((r) => r.groupId === g.id)),
      requests: ctx.requests,
    },
    variables: [...ctx.variables].map(([key, value]) => ({ key, value })),
    dataSets: ctx.dataSets.map(({ set }) => set),
    globalHeaders: ctx.globalHeaders,
    load,
    thresholds: { p95: "", errorRate: "" },
    options: { logRequests: false },
  };
  return { config, warnings: ctx.warnings };
}
