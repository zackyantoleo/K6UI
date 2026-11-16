// JMeter If Controller condition → "run only if" (config.scenario.groups[].runIf).
// The condition text is only tokenized and matched against a few known shapes;
// it is never evaluated. Anything else is reported as not readable, and the
// group keeps running every iteration (see index.js).
//
// Read, in a variable expression ("Interpret Condition as Variable Expression?"
// on) wrapped in ${__groovy(...)} / ${__jexl3(...)} / ${__javaScript(...)}, or
// bare in JavaScript mode (off):
//   def m = props.get('X') ?: vars.get('X'); return m == 'A' || m == 'B'   (groovy only)
//   vars.get('X') == 'A'        props.get('X') != 'A'                        (groovy only)
//   ${X} == "A"     "${X}" == "A"     '${X}' == 'A'     != and ||
// → { variable, operator, values } with `==` terms joined by `||` becoming
//   equals / one-of, and a single `!=` becoming not-equals.
import { bool, k6Name, str, titleOf } from "./props.js";

const FUNCTION_WRAPPER = /^\$\{__(groovy|jexl3|jexl2|javaScript|js)\(([\s\S]*)\)\}$/;
const REF_ONLY = /^\$\{([^\s${}()'",]+)\}$/;
const DECLARATION = new Set(["def", "var", "let", "final", "String", "Object"]);
const LOOKUP_OBJECT = new Set(["props", "vars"]);
const LOOKUP_METHOD = new Set(["get", "getProperty", "getObject"]);

// ── Tokens ─────────────────────────────────────────────────────
// Returns null for any character or construct outside the known shapes.
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end < 0) return null;
      const token = referenceToken(text.slice(i, end + 1));
      if (!token) return null;
      tokens.push(token);
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") { value += text[j + 1] ?? ""; j += 2; } else value += text[j++];
      }
      if (j >= text.length) return null;
      const token = value.includes("$") ? referenceToken(value) : { type: "str", value };
      if (!token) return null;
      tokens.push(token);
      i = j + 1;
      continue;
    }
    const op = ["===", "!==", "==", "!=", "||", "&&", "?:"].find((candidate) => text.startsWith(candidate, i));
    if (op) { tokens.push({ type: "op", value: op }); i += op.length; continue; }
    if ("()=;.".includes(c)) { tokens.push({ type: "op", value: c }); i++; continue; }
    const word = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (!word) return null;
    tokens.push({ type: "id", value: word[0] });
    i += word[0].length;
  }
  return tokens;
}

// "${X}" (alone) → a variable reference; any other ${...} (a function, text around it) → null.
function referenceToken(text) {
  const m = REF_ONLY.exec(text);
  return m && !m[1].startsWith("__") ? { type: "ref", name: m[1] } : null;
}

// ── Parser ─────────────────────────────────────────────────────
class Reader {
  constructor(tokens) { this.tokens = tokens; this.at = 0; }
  peek(offset = 0) { return this.tokens[this.at + offset]; }
  next() { return this.tokens[this.at++]; }
  done() { return this.at >= this.tokens.length; }
  isOp(value, offset = 0) { const t = this.peek(offset); return t?.type === "op" && t.value === value; }
  eat(value) { if (this.isOp(value)) { this.at++; return true; } return false; }
}

// props.get('X') / vars.get('X') → { name, props }
function readLookup(r) {
  const [object, , method, , arg] = [0, 1, 2, 3, 4].map((k) => r.peek(k));
  if (object?.type !== "id" || !LOOKUP_OBJECT.has(object.value) || !r.isOp(".", 1)) return null;
  if (method?.type !== "id" || !LOOKUP_METHOD.has(method.value) || !r.isOp("(", 3) || arg?.type !== "str" || !r.isOp(")", 5)) return null;
  r.at += 6;
  return { name: arg.value, props: object.value === "props" };
}

// props.get('X') ?: vars.get('X') — both sides must name the same variable.
function readSource(r) {
  const first = readLookup(r);
  if (!first) return null;
  if (!r.eat("?:")) return first;
  const second = readLookup(r);
  return second && second.name === first.name ? { name: first.name, props: first.props || second.props } : null;
}

// An operand that stands for a variable: ${X}, a name bound by `def m = ...`, or a lookup.
function readVariable(r, bound, groovy) {
  const token = r.peek();
  if (token?.type === "ref") { r.at++; return { name: token.name, props: false }; }
  if (groovy && token?.type === "id" && bound.has(token.value) && !r.isOp(".", 1)) { r.at++; return bound.get(token.value); }
  return groovy ? readLookup(r) : null;
}

// term := VARIABLE ('==' | '!=') STRING   (or STRING first)
function readTerm(r, bound, groovy) {
  const start = r.at;
  let variable = readVariable(r, bound, groovy);
  let literal = null;
  if (!variable && r.peek()?.type === "str") literal = r.next().value;
  const op = r.peek();
  if (op?.type !== "op" || !["==", "!=", "===", "!=="].includes(op.value)) { r.at = start; return null; }
  r.at++;
  if (variable) {
    const right = r.peek();
    if (right?.type !== "str") { r.at = start; return null; }
    literal = r.next().value;
  } else {
    variable = readVariable(r, bound, groovy);
    if (!variable) { r.at = start; return null; }
  }
  return { kind: "term", variable, equal: op.value.startsWith("="), value: literal };
}

// group := '(' or ')' | term;  and := group ('&&' group)*;  or := and ('||' and)*
function readGroup(r, bound, groovy) {
  if (r.eat("(")) {
    const inner = readOr(r, bound, groovy);
    return inner && r.eat(")") ? inner : null;
  }
  return readTerm(r, bound, groovy);
}

function readChain(r, bound, groovy, separator, kind, readItem) {
  const first = readItem(r, bound, groovy);
  if (!first) return null;
  const items = [first];
  while (r.eat(separator)) {
    const item = readItem(r, bound, groovy);
    if (!item) return null;
    items.push(item);
  }
  return items.length === 1 ? first : { kind, items };
}

const readAnd = (r, bound, groovy) => readChain(r, bound, groovy, "&&", "and", readGroup);
const readOr = (r, bound, groovy) => readChain(r, bound, groovy, "||", "or", readAnd);

const flatten = (node, kind) => (node.kind === kind ? node.items.flatMap((item) => flatten(item, kind)) : [node]);

// Statements before the comparison: `def m = <source>;` and `return`.
function readBody(tokens, groovy) {
  const r = new Reader(tokens);
  const bound = new Map();
  if (groovy) {
    const keyword = r.peek();
    const offset = keyword?.type === "id" && DECLARATION.has(keyword.value) ? 1 : 0;
    const name = r.peek(offset);
    if (name?.type === "id" && r.isOp("=", offset + 1)) {
      r.at += offset + 2;
      const source = readSource(r);
      if (!source) return null;
      bound.set(name.value, source);
      r.eat(";");
    }
    if (r.peek()?.type === "id" && r.peek().value === "return") r.at++;
  }
  const tree = readOr(r, bound, groovy);
  r.eat(";");
  return tree && r.done() ? tree : null;
}

// ── Public ─────────────────────────────────────────────────────
// A value K6UI can store and compare exactly: it is trimmed, non-empty, and has no comma
// (the editor separates values with commas).
const usable = (value) => value !== "" && value === value.trim() && !value.includes(",");

function toRunIf(tree) {
  const terms = flatten(tree, "or");
  if (terms.some((term) => term.kind !== "term" || term.variable.name !== terms[0].variable.name)) return null;
  if (!terms.every((term) => usable(term.value))) return null;
  const usesProps = terms.some((term) => term.variable.props);
  if (terms.length === 1 && !terms[0].equal) {
    return { variable: terms[0].variable.name, operator: "not-equals", values: [terms[0].value], usesProps };
  }
  if (!terms.every((term) => term.equal)) return null;
  const values = [...new Set(terms.map((term) => term.value))];
  return { variable: terms[0].variable.name, operator: values.length === 1 ? "equals" : "one-of", values, usesProps };
}

// → { runIf: { variable, operator, values }, usesProps, evaluateAll } or { runIf: null, text }
export function readCondition(el) {
  const text = str(el, "IfController.condition").trim();
  const useExpression = bool(el, "IfController.useExpression", true);
  const evaluateAll = bool(el, "IfController.evaluateAll");

  let body = text;
  let groovy = false;
  if (useExpression) {
    const wrapper = FUNCTION_WRAPPER.exec(text);
    if (!wrapper) return { runIf: null, text };
    body = wrapper[2];
    groovy = wrapper[1] === "groovy";
  }
  const tokens = tokenize(body);
  const tree = tokens && readBody(tokens, groovy);
  const found = tree && toRunIf(tree);
  if (!found) return { runIf: null, text };
  const { usesProps, ...runIf } = found;
  return { runIf, usesProps, evaluateAll };
}

// Imports the condition of an If Controller directly under the thread group.
// → the runIf, or null (with a warning) when the condition is not one K6UI can read.
export function importCondition(el, group, ctx) {
  const name = titleOf(el);
  const found = readCondition(el);
  if (!found.runIf) {
    const quoted = found.text.replace(/\s+/g, " ");
    const shown = quoted.length > 120 ? `${quoted.slice(0, 117)}...` : quoted;
    ctx.warn(el, `IfController "${name}": its logic is not supported (condition: ${shown || "empty"}), so its requests were imported to run once per iteration, in order.`);
    return null;
  }
  const runIf = { ...found.runIf, variable: k6Name(found.runIf.variable, ctx, el) };
  ctx.conditions.push({ el, group, runIf, usesProps: found.usesProps });
  if (found.evaluateAll) {
    ctx.warn(el, `IfController "${name}" checks its condition before every child in JMeter ("Evaluate for all children"); K6UI checks it once, when the group starts.`);
  }
  return runIf;
}

// After the walk: a condition variable that no User Defined Variable or property default
// created becomes an empty global variable, and the JMeter property fallback is explained.
export function finishConditions(ctx, keptGroups) {
  for (const { el, group, runIf, usesProps } of ctx.conditions) {
    if (!keptGroups.has(group.id)) continue;
    const { variable } = runIf;
    if (!ctx.variables.has(variable)) {
      ctx.variables.set(variable, "");
      ctx.warn(el, `The condition of group "${group.name}" reads "${variable}", which has no value in the plan; it became an empty global variable. Set its value under Global variables, or the group will not run.`);
    }
    if (usesProps) {
      ctx.warn(el, `The condition of group "${group.name}" also reads the JMeter property "${variable}" (-J${variable}=...); K6UI only reads the global variable "${variable}", so change its value to choose what runs.`);
    }
  }
}
