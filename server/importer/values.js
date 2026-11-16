// Static reading of k6 script expressions. Imported scripts are only parsed,
// never executed: staticValue() folds literals and constants into plain JS
// values (options, headers, JSON bodies), and textOf() renders an expression as
// K6UI text, turning variable references into {{name}} placeholders.

export class Unresolvable extends Error {}

export const VALID_VAR_NAME = /^[A-Za-z_]\w*$/;
const MAX_DEPTH = 24;

export function unwrap(node) {
  return node && node.type === "ChainExpression" ? node.expression : node;
}

export function sourceOf(node, ctx) {
  const text = ctx.src.slice(node.start, node.end).replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// __ENV.NAME / __ENV["NAME"] → "NAME"; anything else → null.
export function envName(rawNode) {
  const node = unwrap(rawNode);
  if (node?.type !== "MemberExpression" || node.object.type !== "Identifier" || node.object.name !== "__ENV") {
    return null;
  }
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return null;
}

// Key of an object Property or a MemberExpression (string or number).
export function keyOf(keyNode, computed, ctx, depth = 0) {
  if (!computed) {
    if (keyNode.type === "Identifier") return keyNode.name;
    if (keyNode.type === "Literal") return keyNode.value;
  }
  const value = staticValue(keyNode, ctx, depth + 1);
  if (typeof value !== "string" && typeof value !== "number") throw new Unresolvable("computed key");
  return value;
}

const isPrimitive = (v) => ["string", "number", "boolean"].includes(typeof v);

export function staticValue(rawNode, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new Unresolvable("expression is too deeply nested");
  const node = unwrap(rawNode);
  const next = (n) => staticValue(n, ctx, depth + 1);

  switch (node.type) {
    case "Literal":
      if (node.regex) throw new Unresolvable("regular expression");
      return node.value;

    case "TemplateLiteral": {
      let out = node.quasis[0].value.cooked;
      node.expressions.forEach((expr, i) => {
        out += String(next(expr)) + node.quasis[i + 1].value.cooked;
      });
      return out;
    }

    case "UnaryExpression": {
      const v = next(node.argument);
      if (node.operator === "-") return -v;
      if (node.operator === "+") return +v;
      if (node.operator === "!") return !v;
      throw new Unresolvable(`operator ${node.operator}`);
    }

    case "BinaryExpression": {
      const l = next(node.left);
      const r = next(node.right);
      switch (node.operator) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        default: throw new Unresolvable(`operator ${node.operator}`);
      }
    }

    case "LogicalExpression": {
      // __ENV.X || 'default': the environment is unknown at import time, so the default wins.
      if ((node.operator === "||" || node.operator === "??") && envName(node.left) !== null) {
        return next(node.right);
      }
      const l = next(node.left);
      if (node.operator === "||") return l || next(node.right);
      if (node.operator === "&&") return l && next(node.right);
      return l ?? next(node.right);
    }

    case "ArrayExpression":
      return node.elements.map((el) => {
        if (!el || el.type === "SpreadElement") throw new Unresolvable("spread in array");
        return next(el);
      });

    case "ObjectExpression": {
      const out = Object.create(null);
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.kind !== "init" || prop.method) {
          throw new Unresolvable("spread or method in object");
        }
        out[String(keyOf(prop.key, prop.computed, ctx, depth))] = next(prop.value);
      }
      return out;
    }

    case "Identifier": {
      if (node.name === "undefined") return undefined;
      if (ctx.bindings.has(node.name)) throw new Unresolvable(`\`${node.name}\` comes from a response`);
      const entry = ctx.consts.get(node.name);
      if (!entry) throw new Unresolvable(`\`${node.name}\` is not defined`);
      return next(entry.node);
    }

    case "MemberExpression": {
      if (envName(node) !== null) throw new Unresolvable("environment variable");
      const obj = next(node.object);
      const key = keyOf(node.property, node.computed, ctx, depth);
      if (obj === null || typeof obj !== "object" || !Object.hasOwn(obj, key)) {
        throw new Unresolvable("unknown property");
      }
      return obj[key];
    }

    default:
      throw new Unresolvable(`unsupported expression (${node.type})`);
  }
}

// staticValue() that answers undefined instead of throwing Unresolvable.
export function tryStatic(node, ctx) {
  try {
    return staticValue(node, ctx);
  } catch (e) {
    if (e instanceof Unresolvable) return undefined;
    throw e;
  }
}

// Follow `const x = <init>` chains to the initializer (for params objects etc.).
export function resolveConst(rawNode, ctx) {
  let node = unwrap(rawNode);
  for (let i = 0; node?.type === "Identifier" && i < MAX_DEPTH; i++) {
    if (ctx.bindings.has(node.name)) break;
    const entry = ctx.consts.get(node.name);
    if (!entry) break;
    node = unwrap(entry.node);
  }
  return node;
}

function identifierText(node, ctx, depth) {
  const name = node.name;
  if (ctx.bindings.has(name)) return ctx.materialize(name);

  const entry = ctx.consts.get(name);
  if (!entry) {
    ctx.warn(node, `\`${name}\` is not defined in the script; it was left as {{${name}}}.`);
    return `{{${name}}}`;
  }
  // Top-level constants with a plain value become global variables.
  if (entry.top && VALID_VAR_NAME.test(name)) {
    const value = tryStatic(node, ctx);
    if (isPrimitive(value)) {
      ctx.variables.set(name, String(value));
      return `{{${name}}}`;
    }
  }
  return textOf(entry.node, ctx, depth + 1);
}

function memberText(node, ctx, depth) {
  const env = envName(node);
  if (env !== null) {
    if (!VALID_VAR_NAME.test(env)) throw new Unresolvable(`environment variable "${env}" is not a valid variable name`);
    if (!ctx.variables.has(env)) {
      ctx.variables.set(env, "");
      ctx.warn(node, `__ENV.${env} has no value in K6UI; it became the global variable "${env}" — set its value under Global variables.`);
    }
    return `{{${env}}}`;
  }

  // The GLOBALS object written by K6UI's own script generator.
  const object = unwrap(node.object);
  if (object.type === "Identifier" && object.name === ctx.globalsName) {
    const key = keyOf(node.property, node.computed, ctx, depth);
    if (ctx.variables.has(key)) return `{{${key}}}`;
  }

  // A column of the data file row K6UI's generator reads: DATA_1_ROW.email → {{email}}.
  if (object.type === "Identifier" && ctx.dataRows?.has(object.name) && !node.computed
    && node.property.type === "Identifier" && VALID_VAR_NAME.test(node.property.name)) {
    return `{{${node.property.name}}}`;
  }

  const fromResponse = ctx.refText?.(node);
  if (fromResponse != null) return fromResponse;

  const value = staticValue(node, ctx, depth + 1);
  if (isPrimitive(value)) return String(value);
  throw new Unresolvable("not a plain value");
}

export function textOf(rawNode, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new Unresolvable("expression is too deeply nested");
  const node = unwrap(rawNode);
  const next = (n) => textOf(n, ctx, depth + 1);

  switch (node.type) {
    case "Literal":
      if (node.regex) throw new Unresolvable("regular expression");
      return String(node.value);

    case "TemplateLiteral": {
      let out = node.quasis[0].value.cooked;
      node.expressions.forEach((expr, i) => {
        out += next(expr) + node.quasis[i + 1].value.cooked;
      });
      return out;
    }

    case "BinaryExpression": {
      if (node.operator !== "+") throw new Unresolvable(`operator ${node.operator}`);
      const l = tryStatic(node.left, ctx);
      const r = tryStatic(node.right, ctx);
      // Two numbers add; anything else concatenates.
      if (typeof l === "number" && typeof r === "number") return String(l + r);
      return next(node.left) + next(node.right);
    }

    case "Identifier":
      return identifierText(node, ctx, depth);

    case "MemberExpression":
      return memberText(node, ctx, depth);

    case "CallExpression": {
      const callee = node.callee;
      if (callee.type === "Identifier" && callee.name === "String" && node.arguments.length === 1) {
        return next(node.arguments[0]);
      }
      const fromResponse = ctx.refText?.(node);
      if (fromResponse != null) return fromResponse;
      throw new Unresolvable("function call");
    }

    default: {
      const value = tryStatic(node, ctx);
      if (isPrimitive(value)) return String(value);
      // `${res.json('id') || "NONE"}`: a response value with a fallback (flow.js)
      const fromResponse = node.type === "LogicalExpression" ? ctx.refText?.(node) : null;
      if (fromResponse != null) return fromResponse;
      throw new Unresolvable(`unsupported expression (${node.type})`);
    }
  }
}

// textOf() that keeps the source text (and warns) when conversion is impossible.
export function safeText(node, ctx, what) {
  try {
    return textOf(node, ctx);
  } catch (e) {
    if (!(e instanceof Unresolvable)) throw e;
    const src = sourceOf(node, ctx);
    ctx.warn(node, `Could not convert ${what} \`${src}\` (${e.message}); kept as literal text — fix it in the editor.`);
    return `\${${src}}`;
  }
}
