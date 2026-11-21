// Small codegen helpers: JSON selectors (JS accessor for gRPC messages, gjson path for
// HTTP bodies) and regex literals.
import { oneLine } from "../../public/js/shared/basics.js";
import { regexLiteralBody, regexParts, regexProblem } from "../../public/js/shared/regex.js";

// "data.token"   → ?.['data']?.['token']
// "items[0].id"  → ?.['items']?.[0]?.['id']
// "[0]"          → ?.[0]
export function buildJsonAccessor(selector) {
  if (!selector || !String(selector).trim()) return "";
  return String(selector)
    .split(".")
    .map((part) => {
      const rootArr = part.match(/^\[(\d+)\]$/);
      if (rootArr) return `?.[${rootArr[1]}]`;
      const keyArr = part.match(/^(.+?)\[(\d+)\]$/);
      if (keyArr) return `?.[${JSON.stringify(keyArr[1])}]?.[${keyArr[2]}]`;
      return `?.[${JSON.stringify(part)}]`;
    })
    .join("");
}

// A selector as a gjson path for k6's `res.json(path)`, which reads the body in Go
// instead of `JSON.parse(res.body)` in JavaScript (about twice the requests per CPU
// second in a three-request flow, see docs/baseline-performance.md):
// "data.token"        → data.token
// "items[0].id"       → items.0.id
// "[0].id"            → 0.id
// "grid[1][2]"        → grid.1.2
// Characters gjson reads as syntax (* ? # @ | and the rest outside letters, digits,
// _ - :) are escaped with "\", so every key is matched literally, as before. Empty
// parts ("a..b") are dropped, as the importer does.
export function buildGjsonPath(selector) {
  const components = [];
  for (const part of String(selector ?? "").split(".")) {
    const indexed = part.match(/^(.*?)((?:\[\d+\])+)$/);
    const key = indexed ? indexed[1] : part;
    if (key) components.push(key.replace(GJSON_UNSAFE, "\\$&"));
    if (indexed) components.push(...indexed[2].slice(1, -1).split("]["));
  }
  return components.join(".");
}

// gjson's own rule (isSafePathKeyChar): letters, digits, _ - :, spaces, control and non-ASCII characters need no escape.
const GJSON_UNSAFE = /[^A-Za-z0-9_\-:\x00-\x20\x7f-￿]/g;

// A regex as typed → a JS regex literal for the script. Text from the project never
// ends the literal early (public/js/shared/regex.js regexLiteralBody), so it can never
// become code. Throws for one that regexProblem() refuses (plan.js reports those first,
// naming the request; config.js before Run).
export function buildRegex(selector) {
  if (!selector) return "/(?:)/";
  const problem = regexProblem(selector);
  if (problem) throw new Error(`"${oneLine(String(selector))}" is not a regular expression: ${problem}.`);
  const { source, flags } = regexParts(selector);
  return `/${regexLiteralBody(source).body}/${flags}`;
}

// An HTTP header name as k6 keys it in `res.headers`: Go's canonical form
// (textproto.CanonicalMIMEHeaderKey), the first letter and every letter after "-" in
// upper case, the rest in lower case, for HTTP/1.1 and HTTP/2 alike. "x-request-id"
// (as browser DevTools show it) → "X-Request-Id". Go leaves a name with a character
// that cannot be in one (a space, say) as it is, and so does this.
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function canonicalHeaderName(name) {
  const value = String(name ?? "").trim();
  if (!HEADER_TOKEN.test(value)) return value;
  return value.toLowerCase().replace(/(^|-)([a-z])/g, (_match, dash, letter) => dash + letter.toUpperCase());
}

// Any text → a JS string literal. U+2028 / U+2029 end a line in older JavaScript,
// so they are escaped too (built from char codes to keep this file plain ASCII).
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
export const jsLiteral = (value) =>
  JSON.stringify(String(value)).replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

// Any text → one line, safe inside a `//` comment of the script. \r, \n, U+2028 and
// U+2029 all end a JavaScript line, so a URL or a name holding one would otherwise
// turn the rest of it into code. Every comment value goes through it.
export { oneLine, regexParts, regexProblem };

// The variable that holds the response of request `index` (from 0) in the script.
export const responseVar = (index) => `res_main_${index}`;
