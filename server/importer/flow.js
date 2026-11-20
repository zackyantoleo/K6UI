// The default function of a k6 script → K6UI request flow. The body is read
// as straight-line code: http calls become requests, check() becomes
// assertions, sleep() becomes the pause after a request, group() becomes a
// request group, and values read from a response become extractions (created
// when the variable is first used in a URL, header, or body).
import { buildRequest, httpCallInfo } from "./request.js";
import { convertPredicate, regexSelector, statusListOf } from "./checks.js";
import { groupNameBefore, readRunIf } from "./run-if.js";
import {
  Unresolvable, VALID_VAR_NAME, keyOf, resolveConst, safeText, sourceOf, staticValue, tryStatic, unwrap,
} from "./values.js";
import { OUTCOME_VARIABLE, normalizeOutcomes } from "../../public/js/shared/outcomes.js";
import { normalizeExpectedStatuses } from "../../public/js/shared/expected-statuses.js";

// ── Where does a value come from? ──────────────────────────────
// Descriptors: { kind: 'response', req } | { kind: 'json', req, path } |
// { kind: 'header', req, name } | { kind: 'regex', req, pattern }
// json / header / regex may also carry `fallback`: the extraction's default.

const isCallTo = (node, name) =>
  node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === name;

const isMember = (node, prop) =>
  node?.type === "MemberExpression" && !node.computed && node.property.name === prop;

// `X || ""`, `X || []`, `X ?? ""`: a fallback that does not change what is extracted.
function isEmptyFallback(node) {
  return (node.type === "Literal" && node.value === "")
    || (node.type === "ArrayExpression" && node.elements.length === 0);
}

// `X || "NONE"`, `X ?? 0`: a fixed fallback → the extraction's default (text), else null.
function fixedFallback(rawNode) {
  const node = unwrap(rawNode);
  let value = null;
  if (node?.type === "Literal" && (typeof node.value === "string" || (typeof node.value === "number" && Number.isFinite(node.value)))) {
    value = String(node.value);
  } else if (node?.type === "TemplateLiteral" && !node.expressions.length) {
    value = node.quasis[0].value.cooked;
  }
  return value ? value : null;
}

// A json / header / regex descriptor with a default; nested fallbacks keep the inner one,
// which is the one JavaScript would use.
function withFallback(desc, fallback) {
  if (!desc || desc.kind === "response" || fallback == null) return desc;
  return desc.fallback == null ? { ...desc, fallback } : desc;
}

// A `res.json()` path (gjson): "." separates keys, "\" makes the next character
// literal (K6UI's generator escapes characters gjson reads as syntax, see
// generator/helpers.js buildGjsonPath), a number is an array index.
function splitSelector(selector) {
  const segments = [];
  let current = "";
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\" && i + 1 < selector.length) current += selector[++i];
    else if (ch === ".") {
      segments.push(current);
      current = "";
    } else current += ch;
  }
  segments.push(current);
  return segments.filter(Boolean).map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

export function serializePath(path) {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

function extractionOf(desc) {
  let out = null;
  if (desc?.kind === "json" && desc.path.length) out = { source: "json", selector: serializePath(desc.path) };
  else if (desc?.kind === "header") out = { source: "header", selector: desc.name };
  else if (desc?.kind === "regex") out = { source: "regex", selector: desc.pattern };
  if (out && desc.fallback != null) out.default = desc.fallback;
  return out;
}

// `<response>.body` → the response descriptor, else null
function describeBody(node, state) {
  const n = unwrap(node);
  if (!isMember(n, "body")) return null;
  const base = describe(n.object, state);
  return base?.kind === "response" ? base : null;
}

// `<response>.body.match(/re/)` (optionally wrapped in `|| []`) → { req, pattern }
function describeMatch(node, state) {
  let n = unwrap(node);
  if (n.type === "LogicalExpression" && n.operator === "||" && isEmptyFallbackArray(n.right)) n = unwrap(n.left);
  if (n.type !== "CallExpression" || !isMember(n.callee, "match")) return null;
  const arg = n.arguments[0];
  const body = describeBody(n.callee.object, state);
  if (!body || arg?.type !== "Literal" || !arg.regex) return null;
  return { req: body.req, pattern: regexSelector(arg) };
}

const isEmptyFallbackArray = (node) => node.type === "ArrayExpression" && node.elements.length === 0;

function describe(rawNode, state) {
  const node = unwrap(rawNode);
  const { ctx } = state;
  switch (node.type) {
    case "Identifier":
      return ctx.bindings.get(node.name) ?? null;

    case "LogicalExpression": {
      if (node.operator !== "||" && node.operator !== "??") return null;
      if (isEmptyFallback(node.right)) return describe(node.left, state);
      const fallback = fixedFallback(node.right);
      if (fallback == null) return null;
      const base = describe(node.left, state);
      return base?.kind === "response" ? null : withFallback(base, fallback);
    }

    case "CallExpression": {
      // K6UI's own `extractOr(() => <read>, "default")` (see generator/extract.js)
      if (ctx.extractOr && isCallTo(node, "extractOr") && node.arguments.length === 2) {
        const [read, fallbackNode] = node.arguments;
        const fallback = fixedFallback(fallbackNode);
        if (read.type !== "ArrowFunctionExpression" || read.params.length || read.body.type === "BlockStatement" || fallback == null) return null;
        const base = describe(read.body, state);
        return base?.kind === "response" ? null : withFallback(base, fallback);
      }
      // res.json() / res.json('data.token')
      if (isMember(node.callee, "json")) {
        const base = describe(node.callee.object, state);
        if (base?.kind !== "response") return null;
        const selector = node.arguments[0] ? tryStatic(node.arguments[0], ctx) : "";
        if (typeof selector !== "string") return null;
        return { kind: "json", req: base.req, path: splitSelector(selector) };
      }
      // JSON.parse(res.body)
      const c = node.callee;
      if (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier"
          && c.object.name === "JSON" && c.property.name === "parse" && node.arguments[0]) {
        const body = describeBody(node.arguments[0], state);
        return body ? { kind: "json", req: body.req, path: [] } : null;
      }
      return null;
    }

    case "MemberExpression": {
      const object = unwrap(node.object);
      // res.headers['X'] / res.headers.X
      if (isMember(object, "headers")) {
        const base = describe(object.object, state);
        if (base?.kind === "response") {
          const key = safeKey(node, ctx);
          return typeof key === "string" ? { kind: "header", req: base.req, name: key } : null;
        }
      }
      // res.body.match(/re/)[1]
      if (node.computed && node.property.type === "Literal" && node.property.value === 1) {
        const match = describeMatch(object, state);
        if (match) return { kind: "regex", req: match.req, pattern: match.pattern };
      }
      // a deeper step into parsed JSON
      const base = describe(object, state);
      if (base?.kind === "json") {
        const key = safeKey(node, ctx);
        if (key != null) return { ...base, path: [...base.path, key] };
      }
      return null;
    }

    default:
      return null;
  }
}

function safeKey(node, ctx) {
  try {
    return keyOf(node.property, node.computed, ctx);
  } catch (e) {
    if (e instanceof Unresolvable) return null;
    throw e;
  }
}

// ── Extractions ────────────────────────────────────────────────
// The same value used twice (`${res.json('id')}` in the URL and the body) is one extraction.
function addExtraction(desc, name) {
  const extraction = { varName: name, ...extractionOf(desc) };
  const same = (e) => e.varName === name && e.source === extraction.source
    && e.selector === extraction.selector && e.default === extraction.default;
  if (!desc.req.extractions.some(same)) desc.req.extractions.push(extraction);
  return `{{${name}}}`;
}

// A named variable (`const token = res.json('t')`) used as {{token}}.
function materialize(name, state) {
  const desc = state.ctx.bindings.get(name);
  if (!extractionOf(desc)) throw new Unresolvable(`\`${name}\` is a whole response, not a single value`);
  if (!VALID_VAR_NAME.test(name)) throw new Unresolvable(`\`${name}\` is not a valid variable name`);
  return addExtraction(desc, name);
}

// A response expression used directly in text (`${res.json('id')}`) → generated variable name.
function inlineExtraction(node, state) {
  const desc = describe(node, state);
  const ex = extractionOf(desc);
  if (!ex) return null;
  const key = `${desc.req.id}|${ex.source}|${ex.selector}|${ex.default ?? ""}`;
  if (!state.inline.has(key)) {
    const last = desc.kind === "json" ? [...desc.path].reverse().find((seg) => typeof seg === "string") : desc.name;
    const base = String(last ?? "value").replace(/\W+/g, "_").replace(/^(\d)/, "_$1") || "value";
    let name = base;
    for (let i = 2; state.ctx.bindings.has(name) || state.ctx.variables.has(name) || state.usedInline.has(name); i++) {
      name = `${base}_${i}`;
    }
    state.usedInline.add(name);
    state.inline.set(key, name);
  }
  return addExtraction(desc, state.inline.get(key));
}

// ── Statements ─────────────────────────────────────────────────
function bodyStatements(fn) {
  if (fn.body.type === "BlockStatement") return fn.body.body;
  const { start, end, loc } = fn.body;
  return [{ type: "ExpressionStatement", expression: fn.body, start, end, loc }];
}

function addRequest(call, info, state) {
  const { ctx } = state;
  const req = buildRequest(call, info, ctx, `req_import_${ctx.requests.length + 1}`);
  if (!req) return null;
  if (state.group) req.groupId = state.group.id;
  ctx.requests.push(req);
  state.last = req;
  // Race burst: the first request after K6UI's k6uiRaceWait() is the race request.
  if (ctx.racePending) {
    ctx.raceRequest = req;
    ctx.racePending = false;
  }
  return req;
}

// K6UI's race burst lines (generator/race.js), when the script declares K6UI's
// k6uiRaceWait(t0) helper: `k6uiRaceWarmup(<url>);` is skipped (the warm-up comes back
// as a setting), `const race_at_<i> = k6uiRaceWait(data.k6uiRaceT0);` marks the
// next request as the race request, and `const race_sent_<i> = Date.now();` (the send
// time of its record) is skipped.
const isRaceWarmup = (node, ctx) => ctx.raceHelper && isCallTo(node, "k6uiRaceWarmup") && node.arguments.length === 1;
const isRaceWait = (node, ctx) => ctx.raceHelper && isCallTo(node, "k6uiRaceWait") && node.arguments.length === 1;
const isRaceSent = (name, node, ctx) =>
  ctx.raceHelper && /^race_sent_\d+$/.test(name) && node?.type === "CallExpression" && !node.arguments.length
  && node.callee.type === "MemberExpression" && !node.callee.computed
  && node.callee.object.type === "Identifier" && node.callee.object.name === "Date" && node.callee.property.name === "now";

function handleCheck(call, state) {
  const { ctx } = state;
  const [targetNode, checksNode] = call.arguments;
  const target = unwrap(targetNode);

  let req = null;
  let resName = null;
  if (target?.type === "Identifier" && ctx.bindings.get(target.name)?.kind === "response") {
    req = ctx.bindings.get(target.name).req;
    resName = target.name;
  } else {
    const info = target && httpCallInfo(target, ctx);
    if (info) req = addRequest(target, info, state);
  }
  if (!req) {
    ctx.warn(call, "check() was skipped: its first argument is not a request response.");
    return;
  }

  const obj = checksNode && resolveConst(checksNode, ctx);
  if (obj?.type !== "ObjectExpression") {
    ctx.warn(call, "check() was skipped: its checks are not written as an object literal.");
    return;
  }
  for (const prop of obj.properties) {
    const fn = prop.type === "Property" ? unwrap(prop.value) : null;
    if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) {
      ctx.warn(prop, "A check that is not a function was skipped.");
      continue;
    }
    const label = prop.computed ? sourceOf(prop.key, ctx) : String(prop.key.name ?? prop.key.value);
    // A request with expected statuses: K6UI's status check tests that list.
    if (req.expectedStatuses) {
      const list = statusListOf(fn, resName, ctx);
      if (list && normalizeExpectedStatuses(list) === req.expectedStatuses) {
        req.checkStatus = true;
        continue;
      }
    }
    const { assertions, statusCheck, skipped } = convertPredicate(fn, resName, ctx);
    if (statusCheck) req.checkStatus = true;
    for (const a of assertions) {
      if (!req.assertions.some((x) => x.type === a.type && x.value === a.value && x.value2 === a.value2)) {
        req.assertions.push(a);
      }
    }
    for (const node of skipped) {
      ctx.warn(node, `Check "${label}": \`${sourceOf(node, ctx)}\` has no K6UI equivalent and was skipped.`);
    }
  }
}

function handleSleep(call, state) {
  const { ctx } = state;
  const seconds = call.arguments[0] ? tryStatic(call.arguments[0], ctx) : undefined;
  if (typeof seconds !== "number" || !(seconds >= 0)) {
    ctx.warn(call, `\`${sourceOf(call, ctx)}\` has a dynamic duration and was skipped.`);
  } else if (!state.last) {
    ctx.warn(call, "sleep() before the first request was skipped (K6UI pauses after a request).");
  } else {
    state.last.sleepAfter = String(+(Number(state.last.sleepAfter) + seconds).toFixed(3));
  }
}

function handleGroup(call, state) {
  const { ctx } = state;
  const [nameNode, fnNode] = call.arguments;
  const fn = unwrap(fnNode);
  if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) {
    ctx.warn(call, "group() was skipped: its body is not an inline function.");
    return;
  }
  const raw = nameNode ? tryStatic(nameNode, ctx) : "";
  const name = String(raw || "Group").trim().slice(0, 120);

  if (state.group) {
    ctx.warn(call, `Nested group "${name}" was merged into "${state.group.name}" (K6UI groups are one level deep).`);
    walk(bodyStatements(fn), state);
    return;
  }
  let group = state.groups.get(name);
  if (!group) {
    group = { id: `grp_import_${state.groups.size + 1}`, name, enabled: true, collapsed: false, headers: [] };
    state.groups.set(name, group);
  }
  state.group = group;
  walk(bodyStatements(fn), state);
  state.group = null;
  if (ctx.requests.some((r) => r.groupId === group.id) && !ctx.groups.includes(group)) ctx.groups.push(group);
}

// K6UI's own `if (...) { ... }` around a group with a "Run only if" row → a group with
// that condition. Returns false for any other `if`.
function handleConditionalGroup(stmt, state) {
  const { ctx } = state;
  const runIf = !state.group && !stmt.alternate && stmt.consequent.type === "BlockStatement" ? readRunIf(stmt.test) : null;
  if (!runIf) return false;
  const name = groupNameBefore(ctx.src, stmt.start) || `Conditional group ${ctx.groups.length + 1}`;
  const group = { id: `grp_import_${state.groups.size + 1}`, name, enabled: true, collapsed: false, headers: [], runIf };
  state.groups.set(`${name}#${group.id}`, group);
  state.group = group;
  walk(stmt.consequent.body, state);
  state.group = null;
  if (ctx.requests.some((r) => r.groupId === group.id) && !ctx.groups.includes(group)) ctx.groups.push(group);
  return true;
}

// ── Save to CSV ────────────────────────────────────────────────
// K6UI's own row (generator/csv-export.js), on the request before it:
//   console.log(JSON.stringify({ k6uiExport: "file.csv", columns: ["a"], row: [`${a}`] }));
// → { file, columnsNode, rowNode }, or null for any other call.
function readExportCall(node) {
  const call = unwrap(node);
  if (!isConsoleCall(call) || call.callee.property?.name !== "log" || call.arguments.length !== 1) return null;
  const json = unwrap(call.arguments[0]);
  const c = json?.callee;
  if (json?.type !== "CallExpression" || c?.type !== "MemberExpression" || c.computed || c.object.type !== "Identifier"
      || c.object.name !== "JSON" || c.property.name !== "stringify" || json.arguments.length !== 1) return null;
  const obj = unwrap(json.arguments[0]);
  if (obj?.type !== "ObjectExpression") return null;
  const prop = (key) => obj.properties.find((p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key)?.value;
  const file = prop("k6uiExport");
  const columnsNode = prop("columns");
  const rowNode = prop("row");
  if (file?.type !== "Literal" || typeof file.value !== "string") return null;
  if (columnsNode?.type !== "ArrayExpression" || rowNode?.type !== "ArrayExpression") return null;
  if (columnsNode.elements.length !== rowNode.elements.length || rowNode.elements.some((e) => !e)) return null;
  if (!columnsNode.elements.every((e) => e?.type === "Literal" && typeof e.value === "string")) return null;
  return { file: file.value, columnsNode, rowNode };
}

function addExport(shape, skipMissing, stmt, state) {
  const { ctx } = state;
  if (!state.last) {
    ctx.warn(stmt, `"Save to CSV" for "${shape.file}" before the first request was skipped.`);
    return;
  }
  const columns = shape.columnsNode.elements.map((nameNode, i) => ({
    name: nameNode.value,
    value: safeText(shape.rowNode.elements[i], ctx, `value of column "${nameNode.value}"`),
  }));
  (state.last.exports ??= []).push({ file: shape.file, columns, skipMissing });
}

// `![undefined, null, "", ...].includes(name) && ...`: "skip missing" of a K6UI row.
function isMissingCheck(node) {
  const n = unwrap(node);
  if (n?.type === "LogicalExpression" && n.operator === "&&") return isMissingCheck(n.left) && isMissingCheck(n.right);
  if (n?.type !== "UnaryExpression" || n.operator !== "!") return false;
  const call = unwrap(n.argument);
  return call?.type === "CallExpression" && isMember(call.callee, "includes") && call.callee.object.type === "ArrayExpression"
    && call.arguments.length === 1 && call.arguments[0].type === "Identifier";
}

// `if (<missing checks>) { <K6UI row> }` → an export with skipMissing. False for any other `if`.
function handleExportIf(stmt, state) {
  if (stmt.alternate || !isMissingCheck(stmt.test)) return false;
  const body = stmt.consequent.type === "BlockStatement" ? stmt.consequent.body : [stmt.consequent];
  const shape = body.length === 1 && body[0].type === "ExpressionStatement" ? readExportCall(body[0].expression) : null;
  if (!shape) return false;
  addExport(shape, true, stmt, state);
  return true;
}

// K6UI's own outcome line (generator/outcomes.js), when the script declares K6UI's
// outcome helpers: `outcomeOf_<n>(res)`, whose rules are the top-level
// `const OUTCOME_RULES_<n> = { rules: [...], fallback: "..." }`.
// → true when the call was read (the rules go to the request of `res`).
const OUTCOME_FUNCTION = /^outcomeOf_(\d+)$/;

function handleOutcome(call, state) {
  const { ctx } = state;
  const number = call?.type === "CallExpression" && call.callee.type === "Identifier"
    ? OUTCOME_FUNCTION.exec(call.callee.name)?.[1] : null;
  if (!ctx.outcomeHelper || !number || call.arguments.length !== 1) return false;
  const resNode = unwrap(call.arguments[0]);
  const req = resNode.type === "Identifier" && ctx.bindings.get(resNode.name)?.kind === "response"
    ? ctx.bindings.get(resNode.name).req : null;
  const entry = ctx.consts.get(`OUTCOME_RULES_${number}`);
  let data = null;
  try {
    data = req && entry?.top ? staticValue(entry.node, ctx) : null;
  } catch (e) {
    if (!(e instanceof Unresolvable)) throw e;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.rules)) {
    ctx.warn(call, `Skipped \`${sourceOf(call, ctx)}\`: its outcome rules could not be read.`);
    return true;
  }
  // A JSON path was written as the gjson path res.json() reads.
  const outcomes = normalizeOutcomes({ rules: data.rules, fallback: typeof data.fallback === "string" ? data.fallback : "" });
  outcomes.rules = outcomes.rules.map((rule) => ({
    label: rule.label,
    status: rule.status,
    source: rule.source,
    selector: rule.source === "json" ? serializePath(splitSelector(rule.selector)) : rule.selector,
    operator: rule.operator,
    value: rule.value,
  }));
  req.outcomes = outcomes;
  ctx.outcomeRequests.set(Number(number), req); // for outcome targets (options.thresholds)
  return true;
}

// `name = <init>` (declaration or assignment): remember where the value comes from.
function bind(name, rawInit, state) {
  const { ctx } = state;
  // K6UI's `let $outcome = ""` and `$outcome = outcome_main_<i>`: {{$outcome}} is read
  // back where it is used (values.js).
  if (name === OUTCOME_VARIABLE && ctx.outcomeHelper) return;
  const init = unwrap(rawInit);
  if (isRaceSent(name, init, ctx)) return;
  if (isRaceWait(init, ctx)) {
    ctx.racePending = true;
    ctx.bindings.delete(name);
    ctx.consts.delete(name);
    return;
  }
  if (handleOutcome(init, state)) {
    ctx.bindings.delete(name);
    ctx.consts.delete(name);
    return;
  }

  const info = httpCallInfo(init, ctx);
  if (info) {
    const req = addRequest(init, info, state);
    ctx.consts.delete(name);
    if (req) ctx.bindings.set(name, { kind: "response", req });
    else ctx.bindings.delete(name);
    return;
  }
  if (isCallTo(init, ctx.names.check)) {
    handleCheck(init, state);
    ctx.bindings.delete(name);
    ctx.consts.delete(name);
    return;
  }
  const desc = describe(init, state);
  if (desc) {
    ctx.consts.delete(name);
    ctx.bindings.set(name, { ...desc });
    return;
  }
  // Anything else is resolved where it is used (URL, header, body…).
  ctx.bindings.delete(name);
  ctx.consts.set(name, { node: init, top: false });
}

// `OUTCOME.add(1, OUTCOME_TAGS_<n>[...])`: K6UI's count of a label, read with its outcomeOf_<n>() line.
const isOutcomeCount = (node, ctx) =>
  ctx.outcomeHelper && node.callee.type === "MemberExpression" && !node.callee.computed
  && node.callee.object.type === "Identifier" && node.callee.object.name === "OUTCOME" && node.callee.property.name === "add";

const isConsoleCall = (node) =>
  node?.type === "CallExpression" && node.callee.type === "MemberExpression"
  && node.callee.object.type === "Identifier" && node.callee.object.name === "console";

function expression(rawExpr, stmt, state) {
  const { ctx } = state;
  const expr = unwrap(rawExpr);

  if (expr.type === "CallExpression") {
    const info = httpCallInfo(expr, ctx);
    if (info) addRequest(expr, info, state);
    else if (handleOutcome(expr, state) || isOutcomeCount(expr, ctx) || isRaceWarmup(expr, ctx)) return;
    else if (isRaceWait(expr, ctx)) ctx.racePending = true;
    else if (isCallTo(expr, ctx.names.check)) handleCheck(expr, state);
    else if (isCallTo(expr, ctx.names.sleep)) handleSleep(expr, state);
    else if (isCallTo(expr, ctx.names.group)) handleGroup(expr, state);
    else if (readExportCall(expr)) addExport(readExportCall(expr), false, stmt, state);
    else if (!isConsoleCall(expr)) unsupported(stmt, state);
    return;
  }
  if (expr.type === "AssignmentExpression" && expr.operator === "=" && expr.left.type === "Identifier") {
    bind(expr.left.name, expr.right, state);
    return;
  }
  unsupported(stmt, state);
}

const KIND = {
  BlockStatement: "a custom JavaScript block",
  IfStatement: "a condition",
  ForStatement: "a loop", ForOfStatement: "a loop", ForInStatement: "a loop",
  WhileStatement: "a loop", DoWhileStatement: "a loop",
  SwitchStatement: "a switch", ThrowStatement: "a throw",
};

function unsupported(stmt, state) {
  const kind = KIND[stmt.type] ?? "this statement";
  // The requests inside are not read at all, so say so: K6UI's own conditional
  // groups (`if (...) { ... }` from a "Run only if" row) are not read back yet.
  const consequence = stmt.type === "IfStatement" ? ", so the requests inside it were left out" : "";
  state.ctx.warn(stmt, `Skipped \`${sourceOf(stmt, state.ctx)}\`: ${kind} cannot be imported${consequence}.`);
}

// try { console.log(...) } catch {} or try { logHttpRequest(...) } catch {} — the
// request-log line K6UI itself generates (helpers: server/generator/index.js), and the
// race burst's per-VU record `try { k6uiRaceRecord(...) } catch (e) {}` (generator/race.js).
const REQUEST_LOG_CALLS = new Set(["logHttpRequest", "logHttpOutcome", "logGrpcRequest", "k6uiRaceRecord"]);
const isRequestLogCall = (node) =>
  isConsoleCall(node)
  || (node?.type === "CallExpression" && node.callee.type === "Identifier" && REQUEST_LOG_CALLS.has(node.callee.name));
const isLoggingOnly = (block) =>
  block.body.length > 0 && block.body.every((s) => s.type === "ExpressionStatement" && isRequestLogCall(unwrap(s.expression)));

function statement(stmt, state) {
  switch (stmt.type) {
    case "VariableDeclaration":
      for (const decl of stmt.declarations) {
        if (decl.id.type !== "Identifier") {
          state.ctx.warn(decl, `Skipped \`${sourceOf(decl, state.ctx)}\`: destructuring cannot be imported.`);
        } else if (decl.init) {
          bind(decl.id.name, decl.init, state);
        }
      }
      break;
    case "ExpressionStatement":
      expression(stmt.expression, stmt, state);
      break;
    case "TryStatement":
      if (!isLoggingOnly(stmt.block)) unsupported(stmt, state);
      break;
    case "IfStatement":
      if (!handleConditionalGroup(stmt, state) && !handleExportIf(stmt, state)) unsupported(stmt, state);
      break;
    case "EmptyStatement":
    case "ReturnStatement":
    case "FunctionDeclaration":
      break;
    default:
      unsupported(stmt, state);
  }
}

function walk(stmts, state) {
  for (const stmt of stmts) {
    try {
      statement(stmt, state);
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
      state.ctx.warn(stmt, `Skipped \`${sourceOf(stmt, state.ctx)}\`: ${e.message}.`);
    }
  }
}

export function importFlow(fn, ctx) {
  const state = {
    ctx, last: null, group: null, groups: new Map(), inline: new Map(), usedInline: new Set(),
  };
  ctx.materialize = (name) => materialize(name, state);
  ctx.refText = (node) => inlineExtraction(node, state);
  walk(bodyStatements(fn), state);
}
