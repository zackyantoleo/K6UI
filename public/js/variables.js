// Which {{variables}} a request can use, and where (pure, no DOM). The rules
// follow server/generator/index.js + interpolate.js exactly, so the panel, the
// {{ suggestions and the warnings on the request cards never disagree with the
// script that runs:
//   - only requests that run count (enabled, group on, a URL), in list order;
//   - global variables and the columns of every data file that is used are
//     known everywhere;
//   - a value taken from a response, a `vars.name` set by a request's post-
//     processor and {{$outcome}} (after a request with outcome rules) are known
//     from the NEXT request on, and in the request's own Save to CSV columns;
//     a pre-processor's `vars.name` already in that request's URL, headers, body;
//   - an unknown name, or one written with spaces ({{ token }}), is sent as text.
//
// `flow` is what the page holds (components/variables-panel.js reads it from the
// cards without opening their editors; `flowFromConfig()` builds it from a project):
// {
//   variables:     [{ key, value }],                        global variables as typed
//   dataFiles:     [{ label, groupId, columns, usable, problem }],
//   groups:        [{ id, name, enabled, headers: [{ key, value }] }],
//   globalHeaders: [{ key, value }],
//   requests:      [{ id, name, enabled, groupId, type, method, url, grpcMethod, headers, body,
//                     extractions: [{ varName }], preScript, postScript, hasOutcomes,
//                     exportValues: [text] }],   every card, in order (number = position + 1)
// }
import { OUTCOME_VARIABLE, hasOutcomeRules } from './outcomes.js';
import { readDataSet } from './csv-parse.js';

export const VARIABLE_NAME = /^[A-Za-z_]\w*$/;
// What interpolate.js replaces; anything else between braces is sent as text.
const PLACEHOLDER = /\{\{(\$?\w+)\}\}/g;
const SPACED_PLACEHOLDER = /\{\{(\s*)(\$?\w+)(\s*)\}\}/g;
// Same as ASSIGNED_VAR in server/generator/index.js.
const ASSIGNED_VAR = /\bvars\.([A-Za-z_]\w*)\s*(?:=(?!=)|[+\-*/%]=|\*\*=|&&=|\|\|=|\?\?=|\+\+|--)/g;
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

const text = value => (value == null ? '' : String(value));
const unique = list => [...new Set(list)];

// "{{a}}/{{$outcome}}" → ['a', '$outcome'] (each name once, in order).
export function placeholderNames(value) {
  return unique([...text(value).matchAll(PLACEHOLDER)].map(match => match[1]));
}

// Placeholders written with spaces inside the braces: [{ raw: '{{ token }}', name: 'token' }].
export function spacedPlaceholders(value) {
  return [...text(value).matchAll(SPACED_PLACEHOLDER)]
    .filter(match => match[1] || match[3])
    .map(match => ({ raw: match[0], name: match[2] }));
}

export function scriptAssignments(code) {
  return unique([...text(code).matchAll(ASSIGNED_VAR)].map(match => match[1]));
}

export const requestLabel = (request, index) => text(request.name).trim() || `Request ${index + 1}`;

// Why a request does not run, or '' when it does (the generator's filter).
export function skipReason(request, groupsById) {
  if (request.enabled === false) return 'it is turned off';
  const group = groupsById.get(request.groupId);
  if (group && group.enabled === false) return 'its group is turned off';
  if (!text(request.url).trim()) return 'it has no URL';
  return '';
}

// Headers merged global → group → request; a later one with the same name
// (case-insensitive) wins, as in the generator. Each keeps where it came from.
function mergedHeaders(flow, request, group) {
  const byName = new Map();
  const add = (headers, from) => {
    for (const header of headers || []) {
      const key = text(header?.key).trim();
      if (key) byName.set(key.toLowerCase(), { key, value: text(header.value), from });
    }
  };
  add(flow.globalHeaders, 'global');
  if (group) add(group.headers, 'group');
  add(request.headers, 'request');
  return [...byName.values()];
}

// Every text of a request that is sent with it ({ place, value }); `after: true`
// marks the Save to CSV columns, written once the request is done.
function requestTexts(flow, request, group) {
  const grpc = request.type === 'grpc';
  const places = [{ place: grpc ? 'the address' : 'the URL', value: request.url }];
  if (grpc) places.push({ place: 'the gRPC method', value: request.grpcMethod });
  for (const header of mergedHeaders(flow, request, group)) {
    const kind = { global: 'the global header', group: 'the group header', request: 'the header' }[header.from];
    places.push({ place: `${kind} ${header.key}`, value: header.value });
  }
  const sendsBody = grpc || BODY_METHODS.includes(text(request.method).toUpperCase() || 'GET');
  if (sendsBody && text(request.body).trim()) places.push({ place: grpc ? 'the message' : 'the body', value: request.body });
  for (const value of request.exportValues || []) places.push({ place: 'Save to CSV', value, after: true });
  return places;
}

// What a request makes available: { before: names its pre-processor sets,
// after: extracted names + post-processor names, outcome: true when it labels responses }.
function provides(request) {
  return {
    before: scriptAssignments(request.preScript),
    after: unique([
      ...(request.extractions || []).map(item => text(item?.varName).trim()).filter(Boolean),
      ...scriptAssignments(request.postScript),
    ]),
    outcome: request.type !== 'grpc' && Boolean(request.hasOutcomes),
  };
}

const globalNames = flow => unique((flow.variables || [])
  .map(item => text(item?.key).trim().replace(/\s+/g, '_'))
  .filter(name => VARIABLE_NAME.test(name)));

// Data files the script reads: rows, a column, and not tied to a group that is off.
function fileUsed(file, groupsById) {
  const group = groupsById.get(file.groupId);
  return Boolean(file.usable) && !(group && group.enabled === false);
}

// One pass over the flow: what each request knows before it is sent and after it.
function analyse(flow) {
  const groupsById = new Map((flow.groups || []).map(group => [group.id, group]));
  const requests = flow.requests || [];
  const base = new Set(globalNames(flow));
  for (const file of flow.dataFiles || []) {
    if (fileUsed(file, groupsById)) for (const name of file.columns || []) base.add(name);
  }
  const known = new Set(base);
  const steps = requests.map((request, index) => {
    const reason = skipReason(request, groupsById);
    const made = provides(request);
    const step = { request, index, reason, made, group: groupsById.get(request.groupId) };
    // A request that does not run still gets a "before" set, for suggestions while it is typed.
    step.before = new Set([...known, ...made.before]);
    step.after = new Set([...step.before, ...made.after, ...(made.outcome ? [OUTCOME_VARIABLE] : [])]);
    if (!reason) for (const name of step.after) known.add(name);
    return step;
  });
  return { groupsById, base, steps };
}

// ── Panel ──────────────────────────────────────────────────────
// Every variable a request that runs can use, by source. A name taken by more
// than one request is listed once, at the first request that gives it.
export function variableCatalog(flow) {
  const { groupsById, steps } = analyse(flow);
  const files = (flow.dataFiles || [])
    .filter(file => fileUsed(file, groupsById) && (file.columns || []).length)
    .map(file => ({
      label: file.label,
      groupName: groupsById.get(file.groupId) ? text(groupsById.get(file.groupId).name).trim() || 'Untitled group' : '',
      columns: [...file.columns],
    }));
  const seen = new Set();
  const extracted = [];
  const scripts = [];
  const builtIn = [];
  for (const step of steps) {
    if (step.reason) continue;
    const from = { number: step.index + 1, label: requestLabel(step.request, step.index) };
    for (const name of step.made.before) if (!seen.has(`s:${name}`)) { seen.add(`s:${name}`); scripts.push({ name, ...from, when: 'from' }); }
    for (const item of step.request.extractions || []) {
      const name = text(item?.varName).trim();
      if (VARIABLE_NAME.test(name) && !seen.has(`e:${name}`)) { seen.add(`e:${name}`); extracted.push({ name, ...from }); }
    }
    for (const name of scriptAssignments(step.request.postScript)) {
      if (!seen.has(`s:${name}`)) { seen.add(`s:${name}`); scripts.push({ name, ...from, when: 'after' }); }
    }
    if (step.made.outcome && !builtIn.length) builtIn.push({ name: OUTCOME_VARIABLE, ...from });
  }
  const globals = globalNames(flow);
  const count = globals.length + files.reduce((sum, file) => sum + file.columns.length, 0)
    + extracted.length + scripts.length + builtIn.length;
  return { globals, files, extracted, scripts, builtIn, count };
}

// ── Warnings ───────────────────────────────────────────────────
// Where a name comes from when the request cannot use it: the first request at
// or after it that gives the name ('later'), else a request or data file that
// is not used ('off'), else nothing ('unknown').
function sourceOf(name, step, analysis, flow) {
  const { steps, groupsById } = analysis;
  const gives = other => (name === OUTCOME_VARIABLE
    ? other.made.outcome
    : other.made.after.includes(name) || other.made.before.includes(name));
  const later = steps.find(other => other.index >= step.index && !other.reason && gives(other));
  if (later) {
    return {
      kind: 'later',
      self: later.index === step.index,
      number: later.index + 1,
      label: requestLabel(later.request, later.index),
    };
  }
  const off = steps.find(other => other.reason && gives(other));
  if (off) return { kind: 'off', number: off.index + 1, label: requestLabel(off.request, off.index), reason: off.reason };
  const file = (flow.dataFiles || []).find(item => (item.columns || []).includes(name) && !fileUsed(item, groupsById));
  if (file) {
    const group = groupsById.get(file.groupId);
    const reason = group && group.enabled === false ? 'its group is turned off' : file.problem || 'it is not used';
    return { kind: 'off', file: file.label, reason };
  }
  return { kind: 'unknown' };
}

// requestId → [{ name, raw, kind, places, source }] for every request that runs and
// sends a {{name}} it cannot use. kind: 'later' | 'off' | 'unknown' | 'spaces'.
export function variableIssues(flow) {
  const analysis = analyse(flow);
  const issues = new Map();
  for (const step of analysis.steps) {
    if (step.reason) continue;
    const found = new Map();
    const note = (key, make, place) => {
      if (!found.has(key)) found.set(key, { ...make(), places: [] });
      const entry = found.get(key);
      if (!entry.places.includes(place)) entry.places.push(place);
    };
    for (const { place, value, after } of requestTexts(flow, step.request, step.group)) {
      const knownHere = after ? step.after : step.before;
      for (const name of placeholderNames(value)) {
        if (knownHere.has(name)) continue;
        const source = sourceOf(name, step, analysis, flow);
        note(`n:${name}`, () => ({ name, raw: `{{${name}}}`, kind: source.kind, source }), place);
      }
      for (const { raw, name } of spacedPlaceholders(value)) {
        note(`s:${raw}`, () => ({ name, raw, kind: 'spaces', source: null }), place);
      }
    }
    if (found.size) issues.set(step.request.id, [...found.values()]);
  }
  return issues;
}

const listPlaces = places => (places.length < 2
  ? places[0] || ''
  : `${places.slice(0, -1).join(', ')} and ${places.at(-1)}`);

// Short text for the chip and a sentence that says why and what to do.
export function describeIssue(issue) {
  const { raw, kind, source, places } = issue;
  const where = places.length ? ` Used in ${listPlaces(places)}.` : '';
  if (kind === 'spaces') {
    return {
      text: `${raw} has spaces`,
      detail: `Write it without spaces, as {{${issue.name}}}: with spaces it is sent as plain text.${where}`,
    };
  }
  if (kind === 'later') {
    return {
      text: `${raw} not available yet`,
      detail: (source.self
        ? `This request sets ${raw} only after it is sent, so it can use it in Save to CSV but not in what it sends. Until then the text ${raw} is sent as it is.`
        : `Request #${source.number} (${source.label}) gives ${raw}, but it runs after this one. Move this request below it, or the text ${raw} is sent as it is.`) + where,
    };
  }
  if (kind === 'off') {
    const from = source.file ? `the data file ${source.file}` : `request #${source.number} (${source.label})`;
    return {
      text: `${raw} not available`,
      detail: `Only ${from} gives ${raw}, and ${source.reason}. Until that changes the text ${raw} is sent as it is.${where}`,
    };
  }
  return {
    text: `${raw} is not defined`,
    detail: (issue.name.startsWith('$')
      ? `K6UI has one built-in variable, {{${OUTCOME_VARIABLE}}}. The text ${raw} is sent as it is.`
      : `No global variable, data file column or earlier request has this name, so the text ${raw} is sent as it is. Check the spelling.`) + where,
  };
}

// ── {{ suggestions ─────────────────────────────────────────────
// The names to offer in a field: { requestId } for a field of that request
// (`after: true` for its Save to CSV columns), or none for a shared header.
// → [{ name, source, detail, available }]; available is null without a request.
// Names the request can use come first; then names a later request gives, marked.
export function variableSuggestions(flow, { requestId = '', after = false, prefix = '' } = {}) {
  const analysis = analyse(flow);
  const catalog = variableCatalog(flow);
  const step = analysis.steps.find(item => item.request.id === requestId) || null;
  const knownHere = step ? (after ? step.after : step.before) : null;
  const entries = [];
  const add = (name, source, detail) => {
    if (entries.some(entry => entry.name === name)) return;
    entries.push({ name, source, detail, available: knownHere ? knownHere.has(name) : null });
  };
  for (const name of catalog.globals) add(name, 'global', 'Global variable');
  for (const file of catalog.files) for (const name of file.columns) add(name, 'column', `Column of ${file.label}`);
  // A request that does not run yet (no URL, turned off) still gets what came before it.
  if (step) for (const name of step.made.before) add(name, 'script', 'Set by this request\'s code');
  for (const item of catalog.extracted) add(item.name, 'extracted', `From #${item.number} ${item.label}`);
  for (const item of catalog.scripts) add(item.name, 'script', `Set by code in #${item.number} ${item.label}`);
  for (const item of catalog.builtIn) add(item.name, 'builtIn', `Latest outcome label, after #${item.number}`);
  const query = text(prefix).toLowerCase();
  const rank = entry => {
    const name = entry.name.toLowerCase();
    return (entry.available === false ? 2 : 0) + (name.startsWith(query) ? 0 : 1);
  };
  return entries
    .filter(entry => entry.name.toLowerCase().includes(query))
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.order - b.order)
    .map(({ entry }) => entry);
}

// Why a data file gives no values, in words that follow "the data file X …, and".
export function dataFileProblem({ content, broken, rows, columns }) {
  if (!content) return 'it has no rows yet';
  if (broken) return 'it cannot be read';
  if (!rows) return 'it has no rows';
  if (!columns) return 'its columns have no usable names';
  return '';
}

// ── A project file → flow ──────────────────────────────────────
// The same shape the page reads, from a saved project or an API payload.
export function flowFromConfig(config = {}) {
  const scenario = config.scenario || {};
  return {
    variables: Array.isArray(config.variables) ? config.variables : [],
    dataFiles: (Array.isArray(config.dataSets) ? config.dataSets : []).map((set, index) => {
      let read = { rows: [], columns: [] };
      let broken = false;
      try { read = readDataSet(set); } catch { broken = true; }
      const content = typeof set?.content === 'string' && set.content !== '';
      const names = read.columns.length ? read.columns.map(column => column.name)
        : (Array.isArray(set?.columns) ? set.columns : []).filter(name => VARIABLE_NAME.test(text(name)));
      return {
        label: text(set?.name).trim() || text(set?.fileName) || `Data file ${index + 1}`,
        groupId: text(set?.groupId),
        columns: names,
        usable: content && !broken && read.rows.length > 0 && read.columns.length > 0,
        problem: dataFileProblem({ content, broken, rows: read.rows.length, columns: read.columns.length }),
      };
    }),
    groups: (Array.isArray(scenario.groups) ? scenario.groups : []).map(group => ({
      id: group.id, name: group.name, enabled: group.enabled !== false, headers: group.headers || [],
    })),
    globalHeaders: Array.isArray(config.globalHeaders) ? config.globalHeaders : [],
    requests: (Array.isArray(scenario.requests) ? scenario.requests : []).map(request => ({
      id: request.id,
      name: request.name,
      enabled: request.enabled !== false,
      groupId: request.groupId || '',
      type: request.type || 'http',
      method: request.method || 'GET',
      url: request.url,
      grpcMethod: request.grpcMethod,
      headers: request.headers || [],
      body: request.body,
      extractions: request.extractions || [],
      preScript: request.preScript,
      postScript: request.postScript,
      hasOutcomes: hasOutcomeRules(request.outcomes),
      exportValues: (request.exports || []).flatMap(exp => (exp?.columns || []).map(column => column?.value)),
    })),
  };
}
