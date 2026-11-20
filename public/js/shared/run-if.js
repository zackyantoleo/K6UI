// "Run only if" condition of a request group (config.scenario.groups[].runIf):
//   { variable: "EXECUTION_MODE", operator: "equals" | "not-equals" | "one-of", values: ["ORDER_FLOW", "ALL"] }
// Structured on purpose (no free JavaScript): it is safe to run, editable in
// the UI, and an importer can map a known shape onto it. Pure and DOM-free: the
// project store, the group editor, the outline, the JMeter importer and the
// generator (server/generator/run-if.js) all use it, so they agree on what a
// valid condition is.
import { NAME_PATTERN } from './basics.js';

export const RUN_IF_OPERATORS = Object.freeze(['equals', 'not-equals', 'one-of']);

const OPERATOR_TEXT = Object.freeze({ equals: 'is', 'not-equals': 'is not', 'one-of': 'is one of' });

export const isRunIfVariable = name => typeof name === 'string' && NAME_PATTERN.test(name);

// Trimmed, non-empty, unique strings in the order they were given.
export function cleanRunIfValues(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

// → the first reason `raw` cannot be used as a condition, or '' when it can.
// `null` / `undefined` is "no condition" and is fine.
export function runIfProblem(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'The condition must be an object with a variable, an operator and values.';
  const variable = typeof raw.variable === 'string' ? raw.variable.trim() : '';
  if (!variable) return 'Enter the variable the condition reads.';
  if (!isRunIfVariable(variable)) {
    return `"${variable}" is not a valid variable name: use letters, digits and _, and do not start with a digit.`;
  }
  if (!RUN_IF_OPERATORS.includes(raw.operator)) return 'Choose "is", "is not" or "is one of".';
  const values = cleanRunIfValues(raw.values);
  if (!values.length) return 'Enter at least one value to compare with.';
  if (raw.operator !== 'one-of' && values.length > 1) {
    return `"${OPERATOR_TEXT[raw.operator]}" compares one value; use "is one of" for several.`;
  }
  return '';
}

// A valid condition in its canonical shape, or null.
export function normalizeRunIf(raw) {
  if (runIfProblem(raw) || raw == null) return null;
  return { variable: raw.variable.trim(), operator: raw.operator, values: cleanRunIfValues(raw.values) };
}

// "EXECUTION_MODE is one of ORDER_FLOW, ALL" (empty for no condition).
export function describeRunIf(raw) {
  const runIf = normalizeRunIf(raw);
  return runIf ? `${runIf.variable} ${OPERATOR_TEXT[runIf.operator]} ${runIf.values.join(', ')}` : '';
}
