// The `if (...) { ... }` that K6UI's own generator writes for a group with a
// "Run only if" row (server/generator/run-if.js) → that group's `runIf`.
// Only these exact shapes are read; any other `if` stays unsupported (flow.js).
//   [ "A", "B" ].includes(String(GLOBALS.X))   → one-of
//   String(GLOBALS.X) === "A" / !== "A"        → equals / not-equals
// The variable may be read as GLOBALS.X, vars.X, DATA_n_ROW.X or a plain name.
import { VALID_VAR_NAME } from "./values.js";

const stringLiteral = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : null);

// String(<variable>) → the variable's name, or null
function readSubject(node) {
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "String") return null;
  const arg = node.arguments.length === 1 ? node.arguments[0] : null;
  if (arg?.type === "Identifier") return arg.name;
  if (arg?.type === "MemberExpression" && !arg.computed && arg.object.type === "Identifier"
      && (/^(?:GLOBALS|vars|DATA_\d+_ROW)$/.test(arg.object.name)) && arg.property.type === "Identifier") {
    return arg.property.name;
  }
  return null;
}

export function readRunIf(test) {
  let variable = null;
  let operator = null;
  let values = null;

  if (test?.type === "CallExpression" && test.callee.type === "MemberExpression" && !test.callee.computed
      && test.callee.property.name === "includes" && test.callee.object.type === "ArrayExpression") {
    variable = readSubject(test.arguments[0]);
    values = test.callee.object.elements.map(stringLiteral);
    operator = "one-of";
  } else if (test?.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(test.operator)) {
    variable = readSubject(test.left);
    values = [stringLiteral(test.right)];
    operator = test.operator.startsWith("!") ? "not-equals" : "equals";
  }
  if (!variable || !VALID_VAR_NAME.test(variable) || !values?.length || values.some((value) => value == null)) return null;
  return { variable, operator, values };
}

// The group name K6UI wrote just above the `if`: `// Group "Order flow" runs only if ...`
export function groupNameBefore(src, ifStart) {
  const above = src.slice(Math.max(0, ifStart - 400), ifStart);
  const found = /\/\/ Group "([^"\n]*)" runs only if [^\n]*\n\s*$/.exec(above);
  return found ? found[1].trim().slice(0, 120) : "";
}
