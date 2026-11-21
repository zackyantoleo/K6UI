// k6 check() predicates → K6UI assertions. Only the shapes K6UI can generate
// are recognized (see assertions.js in the generator); anything else is
// reported back as skipped.
import { keyOf, tryStatic, unwrap } from "./values.js";

const num = (node, ctx) => {
  const value = node ? tryStatic(node, ctx) : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const str = (node, ctx) => {
  const value = node ? tryStatic(node, ctx) : undefined;
  return typeof value === "string" ? value : null;
};

const assertion = (type, value, value2 = "") => ({ type, value: String(value), value2: String(value2) });

// RegExp literal → the selector K6UI expects: plain source, or /source/flags.
export function regexSelector(node) {
  const { pattern, flags } = node.regex;
  const source = pattern.replace(/\\\//g, "/");
  return flags ? `/${source}/${flags}` : source;
}

function flattenAnd(node, out = []) {
  const n = unwrap(node);
  if (n.type === "LogicalExpression" && n.operator === "&&") {
    flattenAnd(n.left, out);
    flattenAnd(n.right, out);
  } else {
    out.push(n);
  }
  return out;
}

// `<root>.<prop>` where root is the check() callback parameter or the response variable.
function makeMatchers(roots) {
  const isRoot = (node) => node?.type === "Identifier" && roots.has(node.name);
  const member = (node, prop) =>
    node?.type === "MemberExpression" && !node.computed && node.property.name === prop && isRoot(node.object);
  // `r.body`, or K6UI's `r.body ?? ""` (a response without a body reads as "").
  const isBody = (node) => member(node, "body")
    || (node?.type === "LogicalExpression" && (node.operator === "??" || node.operator === "||")
      && member(node.left, "body") && node.right.type === "Literal" && node.right.value === "");
  return {
    isStatus: (node) => member(node, "status"),
    isBody,
    isDuration: (node) =>
      node?.type === "MemberExpression" && !node.computed && node.property.name === "duration"
      && member(node.object, "timings"),
    // r.headers['X'] / r.headers.X → header name, else null
    headerName: (node, ctx) => {
      if (node?.type !== "MemberExpression" || !member(node.object, "headers")) return null;
      try {
        const key = keyOf(node.property, node.computed, ctx);
        return typeof key === "string" ? key : null;
      } catch {
        return null;
      }
    },
  };
}

const isNullish = (node) =>
  (node.type === "Literal" && node.value === null) || (node.type === "Identifier" && node.name === "undefined");

function convertTerm(term, m, ctx) {
  // `r.body && ...` guards add nothing.
  if (m.isBody(term)) return { ignore: true };

  if (term.type === "UnaryExpression" && term.operator === "!") {
    const inner = convertTerm(unwrap(term.argument), m, ctx);
    if (inner?.assertion?.type === "body-contains") return { assertion: assertion("body-not-contains", inner.assertion.value) };
    return null;
  }

  if (term.type === "CallExpression" && term.callee.type === "MemberExpression" && !term.callee.computed) {
    const { object, property } = term.callee;
    const arg = term.arguments[0];
    if (property.name === "includes" && m.isBody(object)) {
      const value = str(arg, ctx);
      return value == null ? null : { assertion: assertion("body-contains", value) };
    }
    if (property.name === "test" && object.type === "Literal" && object.regex && m.isBody(arg)) {
      return { assertion: assertion("body-matches", regexSelector(object)) };
    }
    return null;
  }

  if (term.type !== "BinaryExpression") return null;
  const { operator: op, left, right } = term;

  if (m.isStatus(left)) {
    const n = num(right, ctx);
    if (n == null) return null;
    if (op === "===" || op === "==") return { assertion: assertion("status-eq", n) };
    if (op === "!==" || op === "!=") return { assertion: assertion("status-ne", n) };
    if (op === "<") return { assertion: assertion("status-lt", n) };
    return null;
  }

  if (m.isDuration(left)) {
    const n = num(right, ctx);
    return op === "<" && n != null ? { assertion: assertion("duration-lt", n) } : null;
  }

  const header = m.headerName(left, ctx);
  if (header != null) {
    if ((op === "!==" || op === "!=") && isNullish(right)) return { assertion: assertion("header-exists", header) };
    const expected = str(right, ctx);
    if ((op === "===" || op === "==") && expected != null) return { assertion: assertion("header-eq", header, expected) };
    return null;
  }

  // r.body.indexOf('x') !== -1 / > -1 / >= 0
  if (left.type === "CallExpression" && left.callee.type === "MemberExpression"
      && left.callee.property.name === "indexOf" && m.isBody(left.callee.object)) {
    const value = str(left.arguments[0], ctx);
    const n = num(right, ctx);
    const found = (op === "!==" || op === "!=" || op === ">") && n === -1 || op === ">=" && n === 0;
    return value != null && found ? { assertion: assertion("body-contains", value) } : null;
  }
  return null;
}

function flattenOr(node, out = []) {
  const n = unwrap(node);
  if (n.type === "LogicalExpression" && n.operator === "||") {
    flattenOr(n.left, out);
    flattenOr(n.right, out);
  } else {
    out.push(n);
  }
  return out;
}

// K6UI's status check of a request with expected statuses (generator/request.js):
// `(r) => r.status === 200 || (r.status >= 400 && r.status < 500)` → "200,4xx";
// null for any other shape.
export function statusListOf(fnNode, resName, ctx) {
  const param = fnNode.params?.[0];
  const roots = new Set([resName].filter(Boolean));
  if (param?.type === "Identifier") roots.add(param.name);
  let expr = fnNode.body;
  if (expr.type === "BlockStatement") {
    if (expr.body.length !== 1 || expr.body[0].type !== "ReturnStatement" || !expr.body[0].argument) return null;
    expr = expr.body[0].argument;
  }
  const m = makeMatchers(roots);
  const compares = (term, ops) => term?.type === "BinaryExpression" && ops.includes(term.operator)
    && m.isStatus(term.left) && num(term.right, ctx) != null;
  const parts = [];
  for (const term of flattenOr(expr)) {
    if (compares(term, ["===", "=="])) {
      parts.push(String(num(term.right, ctx)));
      continue;
    }
    const range = term.type === "LogicalExpression" && term.operator === "&&" ? flattenAnd(term) : [];
    const low = range.length === 2 && compares(range[0], [">="]) ? num(range[0].right, ctx) : null;
    const high = range.length === 2 && compares(range[1], ["<"]) ? num(range[1].right, ctx) : null;
    if (low == null || low % 100 !== 0 || high !== low + 100) return null;
    parts.push(`${low / 100}xx`);
  }
  return parts.join(",") || null;
}

// Status ranges: >=200 && <300 → status-2xx; >=200 && <400 is K6UI's automatic status check.
function takeStatusRange(terms, m, ctx) {
  const find = (ops) => terms.findIndex((t) =>
    t.type === "BinaryExpression" && ops.includes(t.operator) && m.isStatus(t.left) && num(t.right, ctx) != null);
  const lo = find([">="]);
  const hi = find(["<"]);
  if (lo < 0 || hi < 0 || num(terms[lo].right, ctx) !== 200) return null;
  const upper = num(terms[hi].right, ctx);
  if (upper !== 300 && upper !== 400) return null;
  terms.splice(Math.max(lo, hi), 1);
  terms.splice(Math.min(lo, hi), 1);
  return upper === 300 ? "2xx" : "auto";
}

// → { assertions, statusCheck, skipped: [node] }
export function convertPredicate(fnNode, resName, ctx) {
  const result = { assertions: [], statusCheck: false, skipped: [] };
  const param = fnNode.params?.[0];
  const roots = new Set([resName].filter(Boolean));
  if (param?.type === "Identifier") roots.add(param.name);

  let expr = fnNode.body;
  if (expr.type === "BlockStatement") {
    const only = expr.body.length === 1 && expr.body[0].type === "ReturnStatement" ? expr.body[0].argument : null;
    if (!only) {
      result.skipped.push(fnNode);
      return result;
    }
    expr = only;
  }

  const m = makeMatchers(roots);
  const terms = flattenAnd(expr);
  const range = takeStatusRange(terms, m, ctx);
  if (range === "2xx") result.assertions.push(assertion("status-2xx", ""));
  if (range === "auto") result.statusCheck = true;

  for (const term of terms) {
    const converted = convertTerm(term, m, ctx);
    if (converted?.assertion) result.assertions.push(converted.assertion);
    else if (!converted?.ignore) result.skipped.push(term);
  }
  return result;
}
