// Small codegen helpers: JSON selectors (JS accessor for gRPC messages, gjson path for
// HTTP bodies) and regex literals.

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

// Turns user input into a JS regex literal.
// Input already shaped like /.../flags is used as-is.
export function buildRegex(selector) {
  if (!selector) return "/(?:)/";
  const s = String(selector);
  if (/^\/.+\/[gimsuy]*$/.test(s)) return s;
  return `/${s.replace(/\//g, "\\/").replace(/\n/g, "\\n")}/`;
}

// Any text → a JS string literal. U+2028 / U+2029 end a line in older JavaScript,
// so they are escaped too (built from char codes to keep this file plain ASCII).
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
export const jsLiteral = (value) =>
  JSON.stringify(String(value)).replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

// Any text → one line, safe inside a `//` comment of the script. \r, \n, U+2028 and
// U+2029 all end a JavaScript line, so a URL or a name holding one would otherwise
// turn the rest of it into code.
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(10, 13, 0x2028, 0x2029)}]+`, "g");
export const oneLine = (value) => String(value ?? "").replace(LINE_BREAKS, " ").trim();
