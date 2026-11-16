// "Run only if" conditions of request groups → `if (...) {` around the group's
// requests. The condition is data (see public/js/run-if.js), never free code:
// the variable is read by the same precedence as {{variable}} (extracted >
// processor > data column > global, see interpolate.js) when the group starts,
// and values are compared as strings.
import { cleanRunIfValues, describeRunIf, runIfProblem } from "../../public/js/run-if.js";
import { resolveVariable } from "./interpolate.js";

// U+2028/U+2029 end a JS line, so they must not appear raw in a string literal or a comment.
const literal = (value) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const oneLine = (text) => String(text ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();

// "Group "Checkout"" (or "Request group 2" when it has no name), for error messages.
export function groupLabel(group, position) {
  const name = oneLine(group.name);
  return name ? `Group "${name}"` : `Request group ${position + 1}`;
}

// The JS condition for `runIf`, read with the variables known right now.
// Throws (a 400, like a broken processor script) for a condition that cannot
// work: a bad shape, or a variable that is not known when the group starts.
// `dataSets` = prepared data sets, to catch a variable that only a data file of
// the same group would fill (its row is read after the condition is checked).
export function buildRunIfCondition(group, position, ctx, dataSets) {
  const label = groupLabel(group, position);
  const problem = runIfProblem(group.runIf);
  if (problem) throw new Error(`${label}: invalid "run only if" condition. ${problem}`);

  const variable = group.runIf.variable.trim();
  const expression = resolveVariable(variable, ctx);
  const owner = expression && dataSets.find((set) => set.row === expression.split(".")[0]);
  if (!expression || (owner && owner.groupId === group.id)) {
    const why = owner
      ? `it is a column of a data file that is read inside this group, after the condition is checked`
      : `it is not a known variable at this point`;
    throw new Error(
      `${label}: the "run only if" condition reads {{${variable}}}, but ${why}. ` +
      `Define it under Global variables, in a data file, or extract it in a request before this group.`
    );
  }

  const values = cleanRunIfValues(group.runIf.values).map(literal);
  const subject = `String(${expression})`;
  switch (group.runIf.operator) {
    case "equals": return `${subject} === ${values[0]}`;
    case "not-equals": return `${subject} !== ${values[0]}`;
    default: return `[${values.join(", ")}].includes(${subject})`;
  }
}

// `// Group "Order flow" runs only if EXECUTION_MODE is one of ORDER_FLOW, ALL`
export function runIfComment(group, position) {
  return `  // ${oneLine(groupLabel(group, position))} runs only if ${oneLine(describeRunIf(group.runIf))}\n`;
}
