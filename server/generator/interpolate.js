// {{varName}} variable interpolation into JS expressions.
// Turns "https://api/{{userId}}" into the template literal `https://api/${userId}`.
// localVars  → accessed directly as varName (extracted in the main function)
// globalVars → accessed as GLOBALS.varName (global variables declared at the top
//              of the script). Local variables take precedence, so a value
//              extracted from a response overrides a global with the same name.
// Unknown names are left as-is as literal {{...}} text.

export function interpolate(str, localVars, globalVars) {
  if (str == null) return '""';
  const s = String(str);
  if (!s.includes("{{")) return JSON.stringify(s);

  const pattern = /\{\{(\w+)\}\}/g;
  let result = "`";
  let last = 0;
  let m;

  while ((m = pattern.exec(s)) !== null) {
    const literal = s
      .slice(last, m.index)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    result += literal;

    const name = m[1];
    if (localVars && localVars.has(name)) {
      result += `\${${name}}`;
    } else if (globalVars && globalVars.has(name)) {
      result += `\${GLOBALS.${name}}`;
    } else {
      result += m[0].replace(/`/g, "\\`");
    }
    last = m.index + m[0].length;
  }

  const tail = s
    .slice(last)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  result += tail + "`";
  return result;
}
