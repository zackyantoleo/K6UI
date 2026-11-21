// Pre/post-processor scripts are inlined into the generated script as
// block-scoped code. Assignments to `vars.<name>` make {{name}} usable in
// later URLs/headers/bodies (see scanAssignedVars + interpolate.js).
const ASSIGNED_VAR =
  /\bvars\.([A-Za-z_]\w*)\s*(?:=(?!=)|[+\-*/%]=|\*\*=|&&=|\|\|=|\?\?=|\+\+|--)/g;

export function scanAssignedVars(code, into) {
  for (const m of code.matchAll(ASSIGNED_VAR)) into.add(m[1]);
}

// Compile (without executing) to reject broken user code with a clear
// message instead of producing a script that k6 cannot parse. In strict mode, as the
// script is a module: `010`, `with`, `let eval` and the like are refused here too.
export function validateProcessor(code, label, withRes) {
  try {
    new Function(`"use strict";\n${withRes ? "const res = 0;\n" : ""}${code}`);
  } catch (e) {
    throw new Error(`${label} is not valid JavaScript: ${e.message}`);
  }
}

export function buildProcessorBlock(code, label, resVar) {
  const body = code
    .split("\n")
    .map((l) => (l.trim() ? "    " + l : ""))
    .join("\n");
  const lines = [`  // ${label}`, `  {`];
  if (resVar) lines.push(`    const res = ${resVar};`);
  lines.push(body, `  }`);
  return lines.join("\n") + "\n";
}
