// Outcome targets (config.thresholds.outcomes): pass criteria on how many responses
// of one request got one outcome label (see outcomes.js), e.g. "success <= {{QUOTA}}":
//   [{ request: "req_redeem", label: "success", op: "<=", value: "{{QUOTA}}" }, ...]
// Each becomes one more k6 threshold on that label's submetric, next to the
// always-passing one outcome rules already add:
//   "k6ui_outcome{rq:1,outcome:success}": ["count>=0", "count<=300"]
// k6 reads `options` before the test starts, so a value is a number or a global
// variable, resolved when the script is generated. A value that is only known during
// the run (a data file column, an extracted value, a `vars.x` set by a script) cannot
// be a target. A target whose request does not run (turned off, in a turned-off
// group, no URL) is not checked: it is left out of the script and reported as such.
// Pure and DOM-free: shared by the store, the Thresholds / SLA view, the results
// panel, the report, server/generator/outcomes.js, server/routes.js and the importer.
import { activeOutcomeRules, outcomeLabels, outcomeMetricKey } from './outcomes.js';
import { readDataSet } from './csv-parse.js';
import { expandSubRequests } from './sub-requests.js';

export const OUTCOME_THRESHOLD_OPS = [
  { value: '<', label: '< fewer than' },
  { value: '<=', label: '<= at most' },
  { value: '==', label: '== exactly' },
  { value: '>=', label: '>= at least' },
  { value: '>', label: '> more than' },
];
export const DEFAULT_OUTCOME_THRESHOLD_OP = '<=';

const OP_VALUES = new Set(OUTCOME_THRESHOLD_OPS.map(op => op.value));
// A count: a whole or decimal number, never negative (k6 counts never are).
export const THRESHOLD_NUMBER = /^\d+(?:\.\d+)?$/;
// `{{QUOTA}}`: a global variable, written like any other {{variable}}.
export const THRESHOLD_VARIABLE = /^\{\{([A-Za-z_]\w*)\}\}$/;
const VALID_NAME = /^[A-Za-z_]\w*$/;
// `vars.name = ...` (and +=, ++, ...) in a pre/post-processor script, as the generator reads it.
const ASSIGNED_VAR = /\bvars\.([A-Za-z_]\w*)\s*(?:=(?!=)|[+\-*/%]=|\*\*=|&&=|\|\|=|\?\?=|\+\+|--)/g;

const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const oneLine = value => text(value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

// One target in its canonical shape (unknown fields pass through); null for a value
// that is not one. A number value is read as text.
export function normalizeOutcomeThreshold(raw) {
  if (!isObject(raw)) return null;
  const op = text(raw.op).trim();
  return {
    ...raw,
    request: text(raw.request).trim(),
    label: text(raw.label).trim(),
    op: op || DEFAULT_OUTCOME_THRESHOLD_OP,
    value: text(raw.value).trim(),
  };
}

// → the list in its canonical shape ([] for anything that is not a list).
export function normalizeOutcomeThresholds(raw) {
  return Array.isArray(raw) ? raw.map(normalizeOutcomeThreshold).filter(Boolean) : [];
}

// A row left empty in the Thresholds / SLA view: ignored everywhere.
export const isBlankOutcomeThreshold = threshold => !threshold.request && !threshold.label && !threshold.value;

// "success <= {{QUOTA}}"
export const describeOutcomeThreshold = threshold => `${threshold.label} ${threshold.op} ${threshold.value}`.trim();

// The k6 threshold expression of a resolved target: "count<=300".
export const outcomeThresholdExpression = (op, resolved) => `count${op}${Number(resolved)}`;

// "Request 2 · Redeem voucher" (or the method and URL when it has no name).
export function requestTitle({ rq, name, method, url }) {
  const what = oneLine(name) || `${text(method)} ${oneLine(url)}`.trim();
  const number = rq ? `Request ${rq}` : 'Request';
  return what ? `${number} · ${what}` : number;
}

// The requests of a project as targets see them, in project order:
// [{ id, name, method, url, type, rq, labels, skipped }]. `rq` numbers the requests
// that will run (enabled, in a group that is on, with a URL) from 1, like the
// generator and the Requests table; `skipped` says why one does not run ('' if it
// does). `labels` are the request's outcome labels (empty without rules, and for gRPC).
export function thresholdRequests(config) {
  const scenario = isObject(config?.scenario) ? config.scenario : {};
  const groups = new Map((Array.isArray(scenario.groups) ? scenario.groups : [])
    .filter(group => isObject(group) && group.id)
    .map(group => [group.id, group]));
  let rq = 0;
  return (expandSubRequests(scenario.requests) || []).filter(isObject).map(request => {
    const group = groups.get(request.groupId);
    let skipped = '';
    if (request.enabled === false) skipped = 'the request is turned off';
    else if (group && group.enabled === false) skipped = 'the request is in a turned-off group';
    else if (!text(request.url).trim()) skipped = 'the request has no URL';
    const runs = !skipped;
    const grpc = request.type === 'grpc';
    return {
      id: text(request.id),
      name: text(request.name),
      method: grpc ? 'gRPC' : text(request.method || 'GET').toUpperCase(),
      url: text(request.url),
      type: grpc ? 'grpc' : 'http',
      rq: runs ? (rq += 1) : null,
      labels: !grpc && activeOutcomeRules(request.outcomes).length ? outcomeLabels(request.outcomes) : [],
      skipped,
      _request: request,
    };
  });
}

// Names whose value is only known during the run: extracted from a response or set
// by a script (vars.name), in any request that runs → Map name → how it is set.
function runtimeNames(requests) {
  const names = new Map();
  for (const { _request: request, rq } of requests) {
    if (!rq) continue;
    for (const extraction of Array.isArray(request.extractions) ? request.extractions : []) {
      const name = text(extraction?.varName).trim();
      if (name && !names.has(name)) names.set(name, 'is extracted from a response during the run');
    }
    for (const code of [request.preScript, request.postScript]) {
      for (const match of text(code).matchAll(ASSIGNED_VAR)) {
        if (!names.has(match[1])) names.set(match[1], 'is set by a script during the run');
      }
    }
  }
  return names;
}

// Columns of the data files the run reads (not those of a turned-off group, an empty
// file, or a file the generator refuses).
function dataColumnNames(config) {
  const scenario = isObject(config?.scenario) ? config.scenario : {};
  const offGroups = new Set((Array.isArray(scenario.groups) ? scenario.groups : [])
    .filter(group => isObject(group) && group.enabled === false).map(group => group.id));
  const names = new Set();
  for (const set of Array.isArray(config?.dataSets) ? config.dataSets : []) {
    if (!isObject(set) || offGroups.has(set.groupId) || typeof set.content !== 'string' || !set.content) continue;
    try {
      const { rows, columns } = readDataSet(set);
      if (rows.length) for (const column of columns) names.add(column.name);
    } catch {
      // A broken file is reported by the data file checks.
    }
  }
  return names;
}

function globalValues(variables) {
  const map = new Map();
  for (const variable of Array.isArray(variables) ? variables : []) {
    const key = text(variable?.key).trim();
    if (key && VALID_NAME.test(key)) map.set(key, text(variable.value));
  }
  return map;
}

const LIST = items => items.join(', ');

// The value of a target → { resolved } or { problem }. `context` is filled lazily.
function resolveValue(value, context) {
  if (!value) return { problem: 'enter a number, or a global variable like {{QUOTA}}.' };
  if (THRESHOLD_NUMBER.test(value)) return { resolved: Number(value) };
  const variable = THRESHOLD_VARIABLE.exec(value)?.[1];
  if (!variable) {
    return { problem: `"${value}" is not a number; use a number like 300, or a global variable like {{QUOTA}}.` };
  }
  const later = 'but targets are set before the test starts; use a number or a global variable.';
  context.runtime ??= runtimeNames(context.requests);
  if (context.runtime.has(variable)) return { problem: `{{${variable}}} ${context.runtime.get(variable)}, ${later}` };
  context.columns ??= dataColumnNames(context.config);
  if (context.columns.has(variable)) return { problem: `{{${variable}}} is a data file column, which changes per iteration, ${later}` };
  context.globals ??= globalValues(context.config?.variables);
  if (!context.globals.has(variable)) {
    return { problem: `{{${variable}}} is not a global variable; add it under Global variables, or enter a number.` };
  }
  const resolved = context.globals.get(variable).trim();
  if (!THRESHOLD_NUMBER.test(resolved)) {
    return { problem: `the global variable ${variable} is "${oneLine(resolved).slice(0, 60)}", not a number of 0 or more.` };
  }
  return { resolved: Number(resolved) };
}

// A whole config → { problem, thresholds }: the first reason a target cannot work
// ('' when none), and every target that is not blank, in order:
// [{ number, request, label, op, value, name, method, url, rq, resolved, expression, skipped }].
// `number` is the target's position in the list (from 1), as in messages. A target
// whose request does not run has `skipped` set and is not checked any further.
export function planOutcomeThresholds(config) {
  const raw = normalizeOutcomeThresholds(config?.thresholds?.outcomes);
  if (!raw.some(threshold => !isBlankOutcomeThreshold(threshold))) return { problem: '', thresholds: [] };
  const requests = thresholdRequests(config);
  const context = { config, requests };
  const thresholds = [];
  let problem = '';
  raw.forEach((threshold, index) => {
    if (isBlankOutcomeThreshold(threshold)) return;
    const number = index + 1;
    const item = {
      number, request: threshold.request, label: threshold.label, op: threshold.op, value: threshold.value,
      name: '', method: '', url: '', rq: null, resolved: null, expression: '', skipped: '',
    };
    thresholds.push(item);
    const fail = why => { if (!problem) problem = `Outcome target ${number}: ${why}`; };
    if (!threshold.request) return fail('choose a request.');
    const request = requests.find(entry => entry.id === threshold.request && entry.rq)
      || requests.find(entry => entry.id === threshold.request);
    if (!request) return fail('its request is no longer in the flow; choose another request, or remove the target.');
    Object.assign(item, { name: request.name, method: request.method, url: request.url, rq: request.rq });
    if (request.skipped) {
      item.skipped = request.skipped;
      return;
    }
    const title = requestTitle(request);
    if (!request.labels.length) return fail(`${title} has no outcome rules; add them under Request › Outcomes, or remove the target.`);
    if (!threshold.label) return fail('choose a label.');
    if (!request.labels.includes(threshold.label)) {
      return fail(`${title} has no label "${threshold.label}" (its labels: ${LIST(request.labels)}).`);
    }
    if (!OP_VALUES.has(threshold.op)) {
      return fail(`"${threshold.op}" is not a comparison; use ${LIST([...OP_VALUES])}.`);
    }
    const value = resolveValue(threshold.value, context);
    if (value.problem) return fail(value.problem);
    item.resolved = value.resolved;
    item.expression = outcomeThresholdExpression(threshold.op, value.resolved);
  });
  return { problem, thresholds };
}

export const outcomeThresholdsProblem = config => planOutcomeThresholds(config).problem;

// One planned target as a result, before anything was counted (status "unknown").
function emptyResult(target) {
  return {
    number: target.number, request: text(target.request), name: text(target.name), method: text(target.method),
    url: text(target.url), rq: target.rq ?? null, label: text(target.label), op: text(target.op),
    value: text(target.value), resolved: target.resolved ?? null, expression: text(target.expression),
    skipped: text(target.skipped), status: 'unknown', count: null,
  };
}

// The planned targets + a k6 --summary-export → [{ ...target, status, count }], status
// "met" | "not-met" | "skipped" | "unknown" (no summary, e.g. a stopped run). In a k6
// summary export a threshold maps to `true` when it FAILED, `false` when it passed.
export function readOutcomeThresholdResults(thresholds, summary) {
  if (!Array.isArray(thresholds)) return [];
  const metrics = isObject(summary?.metrics) ? summary.metrics : null;
  return thresholds.filter(isObject).map(target => {
    const result = emptyResult(target);
    if (result.skipped) return { ...result, status: 'skipped' };
    if (!metrics || !result.rq) return result;
    const metric = metrics[outcomeMetricKey(result.rq, result.label)];
    const count = Number(metric?.count);
    result.count = Number.isFinite(count) ? count : 0;
    const failed = metric?.thresholds?.[result.expression];
    if (failed === true) result.status = 'not-met';
    else if (failed === false) result.status = 'met';
    return result;
  });
}

// While the test runs: the planned targets + the live outcome counts
// ({ "k6ui_outcome{rq:1,outcome:success}": 12 }, the `outcomeCounts` of a `metrics`
// event) → [{ ...target, status, count }] with what the count says so far. A count
// only grows, so some answers are already final:
//   <, <=  holds: "on-track" (may still break)   broken: "not-met" (final)
//   >, >=  holds: "met" (final)                    not yet: "not-yet" (may still be met)
//   ==     below: "not-yet"   equal: "on-track"   above: "not-met" (final)
// "skipped" for a target that is not checked, "unknown" while its label has no count.
// The final word is k6's, at the end of the run (readOutcomeThresholdResults).
export function readLiveOutcomeThresholdResults(thresholds, counts) {
  if (!Array.isArray(thresholds)) return [];
  const live = isObject(counts) ? counts : {};
  return thresholds.filter(isObject).map(target => {
    const result = emptyResult(target);
    if (result.skipped) return { ...result, status: 'skipped' };
    const count = live[outcomeMetricKey(result.rq, result.label)];
    const limit = result.resolved;
    if (!result.rq || typeof count !== 'number' || !Number.isFinite(count) || typeof limit !== 'number') return result;
    result.count = count;
    const op = result.op;
    if (op === '<' || op === '<=') result.status = (op === '<' ? count < limit : count <= limit) ? 'on-track' : 'not-met';
    else if (op === '>' || op === '>=') result.status = (op === '>' ? count > limit : count >= limit) ? 'met' : 'not-yet';
    else if (op === '==') result.status = count < limit ? 'not-yet' : count === limit ? 'on-track' : 'not-met';
    return result;
  });
}

// "success <= {{QUOTA}} (300)": the target as typed, plus the number a variable stood for.
export function outcomeThresholdText(target) {
  const typed = describeOutcomeThreshold(target);
  return THRESHOLD_VARIABLE.test(text(target.value)) && target.resolved != null ? `${typed} (${target.resolved})` : typed;
}
