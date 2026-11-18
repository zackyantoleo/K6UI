// Outcome rules (see public/js/outcomes.js) → k6 code. Every response of a request
// with rules gets one label (the first rule that matches, else the fallback) and is
// counted in the counter `k6ui_outcome`, tagged `rq` (request number, from 1) and
// `outcome` (the label).
//
// Each request gets its own plain function, `outcomeOf_<n>(res)`, with one `if` per
// rule: k6 runs JavaScript in an interpreter, and a generic loop over rule objects
// cost about twice as much per response (measured, see docs/baseline-performance.md).
// The rules are also written as data (`OUTCOME_RULES_<n>`) so the importer can read
// them back; the function is derived from that data and nothing else.
import {
  activeOutcomeRules, hasOutcomeRules, normalizeOutcomes, outcomeLabels, outcomeMetricKey,
  outcomeRegexParts, outcomesProblem, parseOutcomeStatus, OUTCOME_METRIC,
} from "../../public/js/outcomes.js";
import { planOutcomeThresholds } from "../../public/js/outcome-thresholds.js";
import { buildGjsonPath, jsLiteral } from "./helpers.js";

// Written once, above the default function, when a request that runs has rules.
export const OUTCOME_HELPER_SOURCE = `// Outcome rules (Request → Outcomes): every response of a request with rules gets one
// label, from the first rule that matches it (else the fallback), counted in
// ${OUTCOME_METRIC}{rq:<request number>,outcome:<label>}
const OUTCOME = new Counter(${JSON.stringify(OUTCOME_METRIC)});
const OUTCOME_UNREAD = {}; // a JSON path not read yet for this response

// A JSON path of the body (gjson, read in Go); no value for a missing path or a body that is not JSON.
function outcomeJson(res, path) {
  try {
    return path ? res.json(path) : res.json();
  } catch (e) {
    return undefined;
  }
}

function outcomeHeader(headers, name) {
  if (!headers) return undefined;
  if (headers[name] !== undefined) return headers[name];
  const wanted = name.toLowerCase();
  for (const key in headers) if (key.toLowerCase() === wanted) return headers[key];
  return undefined;
}

// A value as the text rules compare (an object or array as JSON), or null for no value.
function outcomeText(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function outcomeContains(value, part) {
  const text = outcomeText(value);
  return text !== null && text.indexOf(part) !== -1;
}

function outcomeMatches(value, pattern) {
  const text = outcomeText(value);
  return text !== null && pattern.test(text);
}
`;

// Requests that will run ([{ ..., type, outcomes }], in generate order) → 400 for
// outcome rules that cannot work, naming the request.
export function validateOutcomes(requests) {
  const problem = outcomesProblem(requests.map((req, i) => ({
    label: `Request ${i + 1}`, type: req.type, outcomes: req.outcomes,
  })));
  if (problem) {
    const err = new Error(problem);
    err.status = 400;
    throw err;
  }
}

// The requests with rules: [{ rq, index, name, method, url, labels, fallback }] (rq = index + 1).
export function outcomeTargets(requests) {
  const targets = [];
  requests.forEach((req, index) => {
    if (req.type === "grpc" || !hasOutcomeRules(req.outcomes)) return;
    targets.push({
      rq: index + 1,
      index,
      name: req.name || "",
      method: String(req.method || "GET").toUpperCase(),
      url: String(req.url || ""),
      labels: outcomeLabels(req.outcomes),
      fallback: normalizeOutcomes(req.outcomes).fallback,
    });
  });
  return targets;
}

// k6 only reports a submetric (in --summary-export and its REST API) that has a
// threshold, so every label gets one that always passes. Outcome targets
// (public/js/outcome-thresholds.js planOutcomeThresholds: checked, resolved) add
// their own expression to the same list; one that is already there is not repeated
// (k6 keys a threshold's result by its expression).
export function addOutcomeThresholds(options, targets, outcomeThresholds = []) {
  if (!targets.length) return;
  const thresholds = { ...(options.thresholds || {}) };
  for (const target of targets) {
    for (const label of target.labels) thresholds[outcomeMetricKey(target.rq, label)] = ["count>=0"];
  }
  for (const item of outcomeThresholds) {
    if (item.skipped || !item.expression) continue;
    const list = (thresholds[outcomeMetricKey(item.rq, item.label)] ||= ["count>=0"]);
    if (!list.includes(item.expression)) list.push(item.expression);
  }
  options.thresholds = thresholds;
}

// Outcome targets as typed (a {{variable}} stays a variable), written as data for
// the importer only: k6 checks the expressions in `options.thresholds`. A target
// whose request does not run is not in the script, only named in a comment.
export function buildOutcomeThresholdsSource(outcomeThresholds) {
  if (!outcomeThresholds.length) return "";
  const checked = outcomeThresholds.filter((item) => !item.skipped);
  let out = "";
  if (checked.length) {
    out += `\n// Outcome targets (Thresholds / SLA) as typed, which K6UI reads back on import;\n`;
    out += `// k6 checks them as the ${OUTCOME_METRIC}{...} thresholds in \`options\` above\n`;
    out += `const OUTCOME_THRESHOLDS = [\n`;
    out += checked.map((item) => `  { rq: ${item.rq}, label: ${jsLiteral(item.label)}, op: ${jsLiteral(item.op)}, value: ${jsLiteral(item.value)} },\n`).join("");
    out += `];\n`;
  }
  for (const item of outcomeThresholds.filter((entry) => entry.skipped)) {
    const what = `${item.label} ${item.op} ${item.value}`.replace(/[\r\n\u2028\u2029]+/g, " ");
    out += `// Outcome target ${item.number} (${what}) is not checked: ${item.skipped}\n`;
  }
  return out;
}

// Outcome targets that cannot work → a 400 naming the target.
export function planThresholds(config) {
  const { problem, thresholds } = planOutcomeThresholds(config);
  if (problem) {
    const err = new Error(problem);
    err.status = 400;
    throw err;
  }
  return thresholds;
}

// One rule as a JS object literal with only the fields its source uses. A JSON
// path is written as the gjson path `res.json()` reads.
function ruleLiteral(rule) {
  const fields = [`label: ${jsLiteral(rule.label)}`];
  if (rule.status) fields.push(`status: ${jsLiteral(rule.status)}`);
  fields.push(`source: ${jsLiteral(rule.source)}`);
  if (rule.source !== "none") {
    if (rule.source !== "body") fields.push(`selector: ${jsLiteral(ruleSelector(rule))}`);
    fields.push(`operator: ${jsLiteral(rule.operator)}`);
    if (rule.operator !== "exists") fields.push(`value: ${jsLiteral(rule.value)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

const ruleSelector = (rule) => (rule.source === "json" ? buildGjsonPath(rule.selector) : rule.selector);

// "200, 4xx" → `(status === 200 || (status >= 400 && status < 500))`; "" → "" (any status).
function statusCondition(text) {
  const { codes, classes } = parseOutcomeStatus(text);
  const parts = [
    ...codes.map((code) => `status === ${code}`),
    ...classes.map((digit) => `(status >= ${digit * 100} && status < ${digit * 100 + 100})`),
  ];
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
}

// The function of one request: one `if` per rule, top to bottom. A JSON path is read
// at most once per response (json_<k>, read on first use).
function classifierSource(target, outcomes) {
  const rules = activeOutcomeRules(outcomes);
  const paths = [];
  const patterns = [];
  const lines = [];
  for (const [index, rule] of rules.entries()) {
    const conditions = [];
    const status = statusCondition(rule.status);
    if (status) conditions.push(status);
    if (rule.source !== "none") {
      let value;
      if (rule.source === "json") {
        const path = ruleSelector(rule);
        let slot = paths.indexOf(path);
        if (slot === -1) slot = paths.push(path) - 1;
        // Only ever a whole call argument, so it needs no parentheses of its own.
        value = `json_${slot} === OUTCOME_UNREAD ? (json_${slot} = outcomeJson(res, ${jsLiteral(path)})) : json_${slot}`;
      } else if (rule.source === "header") {
        value = `outcomeHeader(res.headers, ${jsLiteral(rule.selector)})`;
      } else {
        value = "res.body";
      }
      // `!= null`: neither undefined nor null, without turning an object into text.
      if (rule.operator === "exists") conditions.push(`(${value}) != null`);
      else if (rule.operator === "equals") conditions.push(`outcomeText(${value}) === ${jsLiteral(rule.value)}`);
      else if (rule.operator === "contains") conditions.push(`outcomeContains(${value}, ${jsLiteral(rule.value)})`);
      else {
        const { source, flags } = outcomeRegexParts(rule.value);
        patterns.push(`new RegExp(${jsLiteral(source)}, ${jsLiteral(flags.replace(/[gy]/g, ""))})`);
        conditions.push(`outcomeMatches(${value}, OUTCOME_PATTERNS_${target.rq}[${patterns.length - 1}])`);
      }
    }
    const test = conditions.length ? conditions.join(" && ") : "true";
    lines.push(`  if (${test}) return ${jsLiteral(rule.label)}; // rule ${index + 1}`);
  }
  let out = "";
  if (patterns.length) out += `const OUTCOME_PATTERNS_${target.rq} = [${patterns.join(", ")}];\n`;
  out += `function outcomeOf_${target.rq}(res) {\n`;
  out += `  const status = res.status;\n`;
  for (const [slot, path] of paths.entries()) out += `  let json_${slot} = OUTCOME_UNREAD; // ${jsLiteral(path)}\n`;
  out += lines.join("\n") + "\n";
  out += `  return ${jsLiteral(target.fallback)};\n}\n`;
  return out;
}

// Top-level declarations of every target: its rules as data, its tags, its function.
export function buildOutcomeRulesSource(targets, requests) {
  let out = "";
  for (const target of targets) {
    const outcomes = requests[target.index].outcomes;
    const rules = activeOutcomeRules(outcomes);
    out += `\n// Outcome rules of request ${target.rq} (Request → Outcomes), as K6UI reads them back on import;\n`;
    out += `// outcomeOf_${target.rq}() below applies them, first match wins\n`;
    out += `const OUTCOME_RULES_${target.rq} = {\n  rules: [\n`;
    out += rules.map((rule) => `    ${ruleLiteral(rule)},\n`).join("");
    out += `  ],\n  fallback: ${jsLiteral(target.fallback)},\n};\n`;
    const tags = target.labels.map((label) => `${jsLiteral(label)}: { rq: ${jsLiteral(String(target.rq))}, outcome: ${jsLiteral(label)} }`);
    out += `const OUTCOME_TAGS_${target.rq} = {\n  ${tags.join(",\n  ")},\n};\n`;
    out += classifierSource(target, outcomes);
  }
  return out;
}

// The lines after the request (in its block): label + count this response.
export function buildOutcomeCode(target, resVar) {
  const name = `outcome_${resVar.replace(/^res_/, "")}`;
  return `  const ${name} = outcomeOf_${target.rq}(${resVar});\n`
    + `  OUTCOME.add(1, OUTCOME_TAGS_${target.rq}[${name}]);`;
}
