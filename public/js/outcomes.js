// Outcome rules of a request (config.scenario.requests[].outcomes):
//   { rules: [{ label: "quota_reached", status: "400", source: "json", selector: "code",
//               operator: "equals", value: "PROM-422001" }, ...],
//     fallback: "other" }
// Every response of the request gets one label: the first rule that matches it,
// else the fallback. The generated script counts the labels in the k6 counter
// `k6ui_outcome`, tagged with the request number and the label, and Run & Results
// shows how many responses got each label. Rules are data, never JavaScript.
// Pure and DOM-free: shared by the store, the request editor, the results panel,
// server/generator/outcomes.js and the importer.

export const OUTCOME_METRIC = 'k6ui_outcome';
export const DEFAULT_OUTCOME_FALLBACK = 'other';
// {{$outcome}}: the label of the latest request with outcome rules in this iteration,
// for Save to CSV columns and later requests. `$` names are K6UI's own (dynamic
// variables); user variables are [A-Za-z_]\w* and can never take one.
export const OUTCOME_VARIABLE = '$outcome';
// Tag values become part of k6 threshold selectors (k6ui_outcome{rq:1,outcome:x}),
// so a label stays a plain word, and few enough labels keep the metric small.
export const OUTCOME_LABEL = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const MAX_OUTCOME_LABELS = 10;

// What a rule looks at after its status matched.
export const OUTCOME_SOURCES = [
  { value: 'none', label: 'Status only' },
  { value: 'json', label: 'JSON path' },
  { value: 'header', label: 'Header' },
  { value: 'body', label: 'Body text' },
];

export const OUTCOME_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'contains', label: 'contains' },
  { value: 'matches', label: 'matches regex' },
  { value: 'exists', label: 'exists' },
];

const SOURCE_VALUES = new Set(OUTCOME_SOURCES.map(source => source.value));
const OPERATOR_VALUES = new Set(OUTCOME_OPERATORS.map(operator => operator.value));
const REGEX_FLAGS = /^[gimsuy]*$/;

const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The canonical shape of one rule (unknown fields pass through). The value is kept
// as typed: a response value is compared with it exactly.
export function normalizeOutcomeRule(raw) {
  if (!isObject(raw)) return null;
  const source = SOURCE_VALUES.has(raw.source) ? raw.source : 'none';
  const operator = OPERATOR_VALUES.has(raw.operator) ? raw.operator : 'equals';
  return {
    ...raw,
    label: text(raw.label).trim(),
    status: text(raw.status).trim(),
    source,
    selector: text(raw.selector).trim(),
    operator,
    value: text(raw.value),
  };
}

// → { rules, fallback }, or null for a value that is not an outcome setting.
export function normalizeOutcomes(raw) {
  if (!isObject(raw)) return null;
  const rules = Array.isArray(raw.rules) ? raw.rules.map(normalizeOutcomeRule).filter(Boolean) : [];
  return { ...raw, rules, fallback: text(raw.fallback).trim() || DEFAULT_OUTCOME_FALLBACK };
}

// A row left completely empty in the editor: ignored everywhere.
export const isBlankOutcomeRule = rule =>
  !rule.label && !rule.status && !rule.selector && !rule.value && rule.source === 'none';

// The rules that count (normalized, blank rows left out); [] means "no outcome rules".
export function activeOutcomeRules(raw) {
  const outcomes = normalizeOutcomes(raw);
  return outcomes ? outcomes.rules.filter(rule => !isBlankOutcomeRule(rule)) : [];
}

export const hasOutcomeRules = raw => activeOutcomeRules(raw).length > 0;

// "200", "200, 201", "4xx", "200,4xx" → { codes: [200], classes: [4] }; "" → any status
// (both empty); null when a part is not a status code or class.
export function parseOutcomeStatus(raw) {
  const codes = [];
  const classes = [];
  for (const part of text(raw).split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (/^[1-5]xx$/.test(token)) classes.push(Number(token[0]));
    else if (/^[1-5]\d\d$/.test(token)) codes.push(Number(token));
    else return null;
  }
  return { codes, classes };
}

// "/quota/i" → { source: "quota", flags: "i" }; anything else is the pattern itself.
export function outcomeRegexParts(value) {
  const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(text(value));
  return literal ? { source: literal[1], flags: literal[2] } : { source: text(value), flags: '' };
}

const labelProblem = (label, what) => (OUTCOME_LABEL.test(label)
  ? ''
  : `${what} "${label}" is not a valid label: use letters, digits and _, start with a letter, at most 40 characters.`);

function ruleProblem(rule, number) {
  const where = `Rule ${number}`;
  if (!rule.label) return `${where}: enter a label.`;
  const label = labelProblem(rule.label, `${where}:`);
  if (label) return label;
  if (!parseOutcomeStatus(rule.status)) {
    return `${where}: status "${rule.status}" is not valid: use codes like 200 or classes like 4xx, separated by commas (empty = any status).`;
  }
  if (rule.source === 'none') return '';
  if (rule.source === 'header' && !rule.selector) return `${where}: enter the header name.`;
  if (rule.source === 'body' && rule.operator === 'exists') return `${where}: "exists" needs a JSON path or a header; for the body use contains or matches regex.`;
  if (rule.operator === 'matches') {
    const { source, flags } = outcomeRegexParts(rule.value);
    if (!REGEX_FLAGS.test(flags)) return `${where}: regex flags "${flags}" are not supported (use i, m, s or u).`;
    try {
      new RegExp(source, flags);
    } catch (e) {
      return `${where}: the regex is not valid: ${e.message}.`;
    }
  }
  return '';
}

// Labels in the order they can happen: the rules, top to bottom, then the fallback.
export function outcomeLabels(raw) {
  const outcomes = normalizeOutcomes(raw);
  const rules = activeOutcomeRules(raw);
  if (!rules.length) return [];
  const labels = [];
  for (const rule of rules) if (rule.label && !labels.includes(rule.label)) labels.push(rule.label);
  if (!labels.includes(outcomes.fallback)) labels.push(outcomes.fallback);
  return labels;
}

// → the first reason these outcome rules cannot be used, or '' (also when there are none).
export function outcomeProblem(raw) {
  if (raw === undefined || raw === null) return '';
  const outcomes = normalizeOutcomes(raw);
  if (!outcomes) return 'Outcome rules must be an object with a list of rules.';
  const rules = activeOutcomeRules(raw);
  if (!rules.length) return '';
  for (const [index, rule] of outcomes.rules.entries()) {
    if (isBlankOutcomeRule(rule)) continue;
    const problem = ruleProblem(rule, index + 1);
    if (problem) return problem;
  }
  const fallback = labelProblem(outcomes.fallback, 'The label for any other response,');
  if (fallback) return fallback;
  const labels = outcomeLabels(raw);
  if (labels.length > MAX_OUTCOME_LABELS) {
    return `A request can have at most ${MAX_OUTCOME_LABELS} labels (this one has ${labels.length}, the fallback included).`;
  }
  return '';
}

// Requests that will run, in order, as [{ label, type, outcomes }] → the first problem
// across them ('' when there is none).
export function outcomesProblem(requests) {
  for (const { label, type, outcomes } of requests) {
    if (!hasOutcomeRules(outcomes)) {
      const problem = outcomeProblem(outcomes);
      if (problem) return `${label}, Outcomes: ${problem}`;
      continue;
    }
    if (type === 'grpc') return `${label}: outcome rules work on HTTP requests only; remove them or switch the request to HTTP.`;
    const problem = outcomeProblem(outcomes);
    if (problem) return `${label}, Outcomes: ${problem}`;
  }
  return '';
}

// The k6 submetric of one label of one request (request numbers start at 1).
export const outcomeMetricKey = (rq, label) => `${OUTCOME_METRIC}{rq:${rq},outcome:${label}}`;

// Requests with outcome rules ([{ rq, name, method, url, labels, fallback }], as the
// generator describes them) + a k6 --summary-export → what each label counted:
// [{ rq, name, method, url, fallback, total, outcomes: [{ label, count, share }] }].
// share is a fraction of the request's total (0 when it never ran).
export function readOutcomeResults(targets, summary) {
  if (!Array.isArray(targets) || !targets.length) return [];
  const metrics = summary?.metrics || {};
  return targets.map(target => {
    const outcomes = (target.labels || []).map(label => {
      const count = Number(metrics[outcomeMetricKey(target.rq, label)]?.count);
      return { label, count: Number.isFinite(count) ? count : 0 };
    });
    const total = outcomes.reduce((sum, item) => sum + item.count, 0);
    return {
      rq: target.rq,
      name: target.name || '',
      method: target.method || '',
      url: target.url || '',
      fallback: target.fallback || DEFAULT_OUTCOME_FALLBACK,
      total,
      outcomes: outcomes.map(item => ({ ...item, share: total ? item.count / total : 0 })),
    };
  });
}
