// Small codegen helpers: JSON selectors and regex literals.

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

// Turns user input into a JS regex literal.
// Input already shaped like /.../flags is used as-is.
export function buildRegex(selector) {
  if (!selector) return "/(?:)/";
  const s = String(selector);
  if (/^\/.+\/[gimsuy]*$/.test(s)) return s;
  return `/${s.replace(/\//g, "\\/").replace(/\n/g, "\\n")}/`;
}
