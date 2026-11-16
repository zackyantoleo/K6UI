// Elements that act on the requests in their scope: assertions → assertions,
// extractors → extractions, timers → pauses. Anything K6UI cannot express
// is reported and skipped.
import { serializePath } from "../flow.js";
import { items, jmxNumber, k6Name, str, titleOf } from "./props.js";

// ── Regular expressions ────────────────────────────────────────
const escapeRegex = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const isPlainText = (text) => !/[\\^$.*+?()[\]{}|]/.test(text);

// JMeter (Perl5) pattern → K6UI regex selector: plain source, or /source/flags
// when the pattern starts with inline flags like (?i) or (?s). Null if JS cannot run it.
function regexSelector(pattern) {
  const inline = /^\(\?([imsx]+)\)/.exec(pattern);
  const flags = inline ? [...new Set(inline[1])].join("") : "";
  const source = inline ? pattern.slice(inline[0].length) : pattern;
  if (flags.includes("x")) return null;
  try {
    new RegExp(source, flags);
  } catch {
    return null;
  }
  return flags ? `/${source.replace(/\\?\//g, "\\/")}/${flags}` : source.replace(/\\\//g, "/");
}

// ── Assertions ─────────────────────────────────────────────────
// Response Assertion test types are bit flags (see JMeter's ResponseAssertion).
const MATCH = 1, CONTAINS = 2, NOT = 4, EQUALS = 8, SUBSTRING = 16, OR = 32;
const TWO_XX = /^2(?:\\d|\.|\[0-9\]){2}$/;

const assertion = (type, value, value2 = "") => ({ type, value: String(value), value2: String(value2) });

function bodyAssertion(text, mode, not) {
  if (mode === SUBSTRING || (mode === CONTAINS && isPlainText(text))) {
    return assertion(not ? "body-not-contains" : "body-contains", text);
  }
  if (not) return null; // K6UI has no "does not match regex" check
  const pattern = mode === CONTAINS ? text : mode === MATCH ? `^(?:${text})$` : `^${escapeRegex(text)}$`;
  const selector = regexSelector(pattern);
  return selector == null ? null : assertion("body-matches", selector);
}

function statusAssertion(text, mode, not) {
  const code = text.trim();
  if (/^\d{3}$/.test(code)) return assertion(not ? "status-ne" : "status-eq", code);
  if (!not && (mode === CONTAINS || mode === MATCH) && TWO_XX.test(code)) return assertion("status-2xx", "");
  return null;
}

function headerAssertion(text, mode, not, warn) {
  const line = text.trim();
  if (not) return null;
  if (/^[\w-]+$/.test(line) && mode !== EQUALS) return assertion("header-exists", line);
  const header = /^([\w-]+)\s*:\s*(.+)$/.exec(line);
  if (!header || (mode !== EQUALS && !isPlainText(header[2]))) return null;
  if (mode !== EQUALS) warn(`now requires header ${header[1]} to be exactly "${header[2].trim()}".`);
  return assertion("header-eq", header[1], header[2].trim());
}

// → { assertions, ignoreStatus }
function responseAssertion(el, ctx) {
  const warn = (message) => ctx.warn(el, `Response assertion "${titleOf(el)}" ${message}`);
  const field = str(el, "Assertion.test_field").trim() || "Assertion.response_data";
  const flags = Number(str(el, "Assertion.test_type")) || CONTAINS;
  const not = Boolean(flags & NOT);
  const mode = [SUBSTRING, EQUALS, MATCH, CONTAINS].find((bit) => flags & bit) ?? CONTAINS;
  // "Asserion" is JMeter's own spelling of the property.
  const strings = [...items(el, "Asserion.test_strings"), ...items(el, "Assertion.test_strings")].map((p) => p.text);
  const ignoreStatus = str(el, "Assertion.assume_success").trim() === "true";
  const assertions = [];

  if (flags & OR && strings.length > 1) {
    warn("passes when any one of several patterns matches (Or), which K6UI cannot express; it was skipped.");
    return { assertions, ignoreStatus };
  }
  for (const text of strings) {
    if (text.includes("${")) {
      warn(`compares against a variable (${text}); K6UI checks use fixed values, so it was skipped.`);
      continue;
    }
    let result;
    if (field === "Assertion.response_code") result = statusAssertion(text, mode, not);
    else if (field === "Assertion.response_data" || field === "Assertion.response_data_as_document") result = bodyAssertion(text, mode, not);
    else if (field === "Assertion.response_headers") result = headerAssertion(text, mode, not, warn);
    else {
      warn(`checks the ${field.replace(/^Assertion\./, "").replace(/_/g, " ")}, which K6UI cannot check; it was skipped.`);
      break;
    }
    if (result) assertions.push(result);
    else warn(`pattern "${text}" has no K6UI equivalent and was skipped.`);
  }
  return { assertions, ignoreStatus };
}

export function convertAssertion(el, ctx) {
  const kind = el.name.split(".").pop();
  if (kind === "ResponseAssertion") return responseAssertion(el, ctx);
  if (kind === "DurationAssertion") {
    const ms = jmxNumber(str(el, "DurationAssertion.duration"), ctx, el, `duration assertion "${titleOf(el)}"`);
    if (ms > 0) return { assertions: [assertion("duration-lt", ms)], ignoreStatus: false };
    ctx.warn(el, `Duration assertion "${titleOf(el)}" has no fixed duration and was skipped.`);
  } else {
    ctx.warn(el, `${kind} "${titleOf(el)}" has no K6UI equivalent and was skipped.`);
  }
  return { assertions: [], ignoreStatus: false };
}

// ── Extractors ─────────────────────────────────────────────────
// $.data.items[0].id / $['data']['id'] → K6UI selector "data.items[0].id"; null when
// the path uses filters, wildcards, deep scans, or keys with dots.
function jsonPathSelector(path) {
  let rest = path.trim();
  if (!rest.startsWith("$")) return null;
  rest = rest.slice(1);
  const segments = [];
  const TOKEN = /^(?:\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\])/;
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) return null;
    const key = m[1] ?? m[3] ?? m[4];
    if (key != null && (!key || /[.[\]]/.test(key))) return null;
    segments.push(key ?? Number(m[2]));
    rest = rest.slice(m[0].length);
  }
  return segments.length ? serializePath(segments) : null;
}

const FIRST_MATCH = new Set(["", "0", "1"]); // 0 = random, which is the first for a single match
const BODY_FIELDS = new Set(["", "false", "body", "unescaped", "as_document"]);

function readsBody(el, prefix, warn) {
  const field = str(el, `${prefix}.useHeaders`).trim();
  if (BODY_FIELDS.has(field)) return true;
  warn(`reads the ${field === "true" ? "response headers" : field}; K6UI regex extractions read the response body, so it was skipped.`);
  return false;
}

function jsonExtractor(el, ctx, warn) {
  const names = str(el, "JSONPostProcessor.referenceNames").split(";");
  const paths = str(el, "JSONPostProcessor.jsonPathExprs").split(";");
  const matches = str(el, "JSONPostProcessor.match_numbers").split(";");
  const out = [];
  names.forEach((rawName, i) => {
    const name = rawName.trim();
    const path = (paths[i] ?? "").trim();
    if (!name || !path) return;
    const selector = path.includes("${") ? null : jsonPathSelector(path);
    if (!FIRST_MATCH.has((matches[i] ?? "").trim())) warn(`variable "${name}" uses match number ${matches[i].trim()}; only the first match is supported, so it was skipped.`);
    else if (selector == null) warn(`JSON path "${path}" for "${name}" is not supported (K6UI reads plain paths like $.data.items[0].id), so it was skipped.`);
    else out.push({ varName: k6Name(name, ctx, el), source: "json", selector });
  });
  return out;
}

function regexExtractor(el, ctx, warn) {
  const name = str(el, "RegexExtractor.refname").trim();
  const pattern = str(el, "RegexExtractor.regex");
  const template = str(el, "RegexExtractor.template").trim() || "$1$";
  if (!name || !pattern || !readsBody(el, "RegexExtractor", warn)) return [];
  if (!FIRST_MATCH.has(str(el, "RegexExtractor.match_number").trim())) {
    warn("uses a match number other than the first; it was skipped.");
    return [];
  }
  const group = /^\$([01])\$$/.exec(template);
  if (!group) {
    warn(`uses template ${template}; K6UI extracts the first capture group ($1$), so it was skipped.`);
    return [];
  }
  // $0$ = the whole match → capture all of it as group 1.
  const inline = /^\(\?[imsx]+\)/.exec(pattern)?.[0] ?? "";
  const body = pattern.slice(inline.length);
  const selector = pattern.includes("${") ? null : regexSelector(group[1] === "0" ? `${inline}(${body})` : pattern);
  if (selector == null) {
    warn(`pattern ${pattern} cannot be used by K6UI and was skipped.`);
    return [];
  }
  return [{ varName: k6Name(name, ctx, el), source: "regex", selector }];
}

function boundaryExtractor(el, ctx, warn) {
  const name = str(el, "BoundaryExtractor.refname").trim();
  const left = str(el, "BoundaryExtractor.lboundary");
  const right = str(el, "BoundaryExtractor.rboundary");
  if (!name || !readsBody(el, "BoundaryExtractor", warn)) return [];
  if (!FIRST_MATCH.has(str(el, "BoundaryExtractor.match_number").trim()) || `${left}${right}`.includes("${")) {
    warn("uses a variable or a match number other than the first; it was skipped.");
    return [];
  }
  const selector = `${escapeRegex(left)}${right ? "([\\s\\S]*?)" : "([\\s\\S]*)"}${escapeRegex(right)}`;
  return [{ varName: k6Name(name, ctx, el), source: "regex", selector: regexSelector(selector) }];
}

// → [{ varName, source, selector }]
export function convertExtractor(el, ctx) {
  const kind = el.name.split(".").pop();
  const warn = (message) => ctx.warn(el, `${kind} "${titleOf(el)}" ${message}`);
  if (kind === "JSONPostProcessor") return jsonExtractor(el, ctx, warn);
  if (kind === "RegexExtractor") return regexExtractor(el, ctx, warn);
  if (kind === "BoundaryExtractor") return boundaryExtractor(el, ctx, warn);
  warn("has no K6UI equivalent and was skipped.");
  return [];
}

// ── Timers ─────────────────────────────────────────────────────
// → pause in milliseconds before each request in scope, or 0.
export function convertTimer(el, ctx) {
  const kind = el.name.split(".").pop();
  const name = titleOf(el);
  const num = (key) => jmxNumber(str(el, key), ctx, el, `timer "${name}"`);
  const delay = num("ConstantTimer.delay");
  const range = num("RandomTimer.range");

  let ms = null;
  if (kind === "ConstantTimer") ms = delay;
  else if (kind === "UniformRandomTimer" && delay != null && range != null) ms = delay + range / 2;
  else if ((kind === "GaussianRandomTimer" || kind === "PoissonRandomTimer") && delay != null) {
    ms = delay + (kind === "PoissonRandomTimer" ? range ?? 0 : 0);
  } else if (!/^(?:Uniform|Gaussian|Poisson)RandomTimer$/.test(kind)) {
    ctx.warn(el, `${kind} "${name}" has no K6UI equivalent and was skipped.`);
    return 0;
  }
  if (ms == null || ms < 0) {
    ctx.warn(el, `Timer "${name}" has no fixed delay and was skipped.`);
    return 0;
  }
  if (kind !== "ConstantTimer") ctx.warn(el, `Random timer "${name}" was imported as a fixed pause of its average, ${+ms.toFixed(1)} ms.`);
  return ms;
}
