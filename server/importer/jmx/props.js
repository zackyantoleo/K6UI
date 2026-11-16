// JMeter property readers, variable names, and ${...} → {{...}} text.
//   <stringProp name="HTTPSampler.path">/login</stringProp>  → str(el, "HTTPSampler.path")

export const prop = (el, name) => el?.children.find((child) => child.attrs.name === name) ?? null;
export const str = (el, name) => prop(el, name)?.text ?? "";
export const items = (el, name) => prop(el, name)?.children ?? [];
export const bool = (el, name, fallback = false) => {
  const p = prop(el, name);
  return p ? p.text.trim() === "true" : fallback;
};

// elementProp(Arguments) → collectionProp → one elementProp per argument
export const argumentsOf = (el, name) => items(prop(el, name), "Arguments.arguments");

export const isEnabled = (el) => el.attrs.enabled !== "false";
export const titleOf = (el) => (el.attrs.testname || el.name).trim();

// ── Variable names ─────────────────────────────────────────────
// K6UI variables become JS identifiers in the generated script, so JMeter
// names like `user-id` or `class` are renamed (consistently, everywhere).
const RESERVED = new Set(`break case catch class const continue debugger default delete do else enum
  export extends false finally for function if import in instanceof let new null return super switch
  this throw true try typeof var void while with yield await implements interface package private
  protected public static arguments eval undefined NaN Infinity
  http check sleep group grpc crypto encoding GLOBALS vars options data res console JSON Math Date`.split(/\s+/));
const GENERATED = /^(?:res|body|d|grpc_client)_/;

export function k6Name(name, ctx, el) {
  if (ctx.names.has(name)) return ctx.names.get(name);
  let base = name.replace(/\W+/g, "_").replace(/^(?=\d)/, "_") || "var";
  if (RESERVED.has(base) || GENERATED.test(base)) base += "_";
  const used = new Set(ctx.names.values());
  let out = base;
  for (let i = 2; used.has(out); i++) out = `${base}_${i}`;
  ctx.names.set(name, out);
  if (out !== name) ctx.warn(el, `JMeter variable "${name}" was renamed to {{${out}}} (K6UI names use letters, digits and _ and cannot be JavaScript words).`);
  return out;
}

// ── ${...} references ──────────────────────────────────────────
function closingBrace(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

// JMeter function arguments are comma-separated; `\,` is a literal comma.
const splitArgs = (args) => args.split(/(?<!\\),/).map((arg) => arg.replace(/\\,/g, ","));

const FUNCTION = /^(__\w+)\(([\s\S]*)\)$/;

function reference(inner, whole, ctx, el, where) {
  const name = inner.trim();
  const fn = FUNCTION.exec(name);
  if (!fn) {
    return name && !/[\s(){}$]/.test(name) ? `{{${k6Name(name, ctx, el)}}}` : whole;
  }
  // ${__P(host,example.com)} / ${__property(host,,example.com)}: a -Jhost=… property
  // with a default → a global variable holding the default.
  if (fn[1] === "__P" || fn[1] === "__property") {
    const args = splitArgs(fn[2]);
    const key = args[0]?.trim();
    if (key && !key.includes("${")) {
      const fallback = (fn[1] === "__P" ? args[1] ?? "1" : args[2]) ?? "";
      const varName = k6Name(key, ctx, el);
      if (!ctx.variables.has(varName)) ctx.variables.set(varName, fallback.trim());
      return `{{${varName}}}`;
    }
  }
  ctx.warn(el, `JMeter function ${whole} in ${where} has no K6UI equivalent and was kept as plain text.`);
  return whole;
}

// "Bearer ${token}" → "Bearer {{token}}". `where` names the field for warnings.
export function jmxText(raw, ctx, el, where) {
  const text = String(raw ?? "");
  let out = "";
  let at = 0;
  for (let start = text.indexOf("${"); start >= 0; start = text.indexOf("${", at)) {
    const end = closingBrace(text, start + 2);
    if (end < 0) break;
    out += text.slice(at, start) + reference(text.slice(start + 2, end), text.slice(start, end + 1), ctx, el, where);
    at = end + 1;
  }
  return out + text.slice(at);
}

// {{name}} → the global variable's value, where one is known.
export const resolveVariables = (text, ctx) =>
  text.replace(/\{\{(\w+)\}\}/g, (m, name) => (ctx.variables.has(name) ? ctx.variables.get(name) : m));

// A number setting (threads, ramp-up, delays…) that may be written as
// ${__P(threads,10)}. Its default is used directly; no variable is created.
export function jmxNumber(raw, ctx, el, where) {
  const known = new Set(ctx.variables.keys());
  const text = resolveVariables(jmxText(raw, ctx, el, where), ctx).trim();
  for (const key of ctx.variables.keys()) if (!known.has(key)) ctx.variables.delete(key);
  return text && Number.isFinite(Number(text)) ? Number(text) : null;
}
