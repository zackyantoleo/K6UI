// {{varName}} variable interpolation into JS expressions.
// Turns "https://api/{{userId}}" into the template literal `https://api/${userId}`.
// The ctx object holds the known variable names; resolution order
// (first match wins):
//   localVars     → varName            (extracted from an earlier response)
//   processorVars → vars.varName       (assigned by a pre/post-processor script)
//   dataVars      → DATA_1_ROW.varName (a column of a data file: the row of this iteration)
//   globalVars    → GLOBALS.varName    (global variables)
// A column of the same name as an extracted variable therefore reads the data
// row until a request has extracted it, and the extracted value afterwards.
// Unknown names are left as-is as literal {{...}} text.

export function interpolate(str, ctx) {
  if (str == null) return '""';
  const s = String(str);
  if (!s.includes("{{")) return JSON.stringify(s);

  const { localVars, processorVars, dataVars, globalVars } = ctx || {};
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
    } else if (processorVars && processorVars.has(name)) {
      result += `\${vars.${name}}`;
    } else if (dataVars && dataVars.has(name)) {
      result += `\${${dataVars.get(name)}.${name}}`;
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
