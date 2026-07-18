// Codegen for extracting variables from a response (JSON path / header / regex).
import { buildJsonAccessor, buildRegex } from "./helpers.js";

// targetPrefix = 'data' → data.varName = ...  (for setup, stored on the return value)
// targetPrefix = null   → let varName = ...   (for the main function/teardown)
// localVarSet prevents a double `let` for the same variable name.
export function buildExtractionLines(extractions, resVar, targetPrefix, localVarSet) {
  if (!Array.isArray(extractions)) return "";
  const lines = [];

  for (const e of extractions) {
    if (!e || !e.varName || !e.source) continue;

    let rhs;
    const sel = e.selector || "";
    if (e.source === "json") {
      rhs = `JSON.parse(${resVar}.body)${buildJsonAccessor(sel)}`;
    } else if (e.source === "header") {
      rhs = `${resVar}.headers[${JSON.stringify(sel)}]`;
    } else if (e.source === "regex") {
      rhs = `(${resVar}.body.match(${buildRegex(sel)}) || [])[1] || ""`;
    } else {
      continue;
    }

    if (targetPrefix) {
      lines.push(`  ${targetPrefix}.${e.varName} = ${rhs};`);
    } else {
      const declared = localVarSet && localVarSet.has(e.varName);
      lines.push(`  ${declared ? '' : 'let '}${e.varName} = ${rhs};`);
      if (localVarSet) localVarSet.add(e.varName);
    }
  }

  return lines.join("\n");
}
