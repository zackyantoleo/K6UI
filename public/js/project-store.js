// Lightweight versioned project state. The store owns a normalized immutable
// snapshot; DOM adapters in config.js/project-io.js synchronize at UI boundaries.
import { normalizeRunIf } from './run-if.js';
import { normalizeExports } from './csv-export.js';
import { normalizeOutcomes } from './outcomes.js';
import { isBlankOutcomeThreshold, normalizeOutcomeThresholds } from './outcome-thresholds.js';
import { expandSubRequests } from './sub-requests.js';

export const CURRENT_SCHEMA_VERSION = 2;

const REQUEST_ID_PATTERN = /^req_[a-z0-9_-]+$/;
const GROUP_ID_PATTERN = /^grp_[a-z0-9_-]+$/;
const DATA_SET_ID_PATTERN = /^ds_[a-z0-9_-]+$/;

const DEFAULT_PROJECT = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  scenario: { groups: [], requests: [] },
  variables: [],
  dataSets: [],
  globalHeaders: [],
  load: { mode: 'simple', vus: 10, duration: '30s', stages: [] },
  thresholds: {},
  options: {},
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function hashItem(item, index) {
  const source = `${index}:${JSON.stringify(item)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function uniqueItemId(item, index, used, prefix, pattern) {
  const existing = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
  if (pattern.test(existing) && !used.has(existing)) return existing;

  const withoutId = { ...item };
  delete withoutId.id;
  const base = `${prefix}_${hashItem(withoutId, index)}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function normalizeGroup(rawGroup, index, used) {
  if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
    throw new TypeError(`Request group ${index + 1} must be an object.`);
  }
  const group = clone(rawGroup);
  group.id = uniqueItemId(group, index, used, 'grp', GROUP_ID_PATTERN);
  used.add(group.id);
  group.name = typeof group.name === 'string' ? group.name.trim().slice(0, 120) : '';
  group.enabled = group.enabled !== false;
  group.collapsed = group.collapsed === true;
  // "Run only if" condition (see run-if.js): absent or null = always runs; a
  // condition that cannot work becomes null instead of being applied partly.
  if (group.runIf !== undefined) group.runIf = normalizeRunIf(group.runIf);
  group.headers = Array.isArray(group.headers)
    ? group.headers
      .filter(header => header && typeof header === 'object' && String(header.key || '').trim())
      .map(header => ({ key: String(header.key).trim(), value: String(header.value ?? '') }))
    : [];
  // Request groups are deliberately flat. Hierarchy-shaped fields are dropped
  // instead of allowing imported projects to grow a JMeter-like tree.
  delete group.parentId;
  delete group.parentGroupId;
  delete group.children;
  delete group.groups;
  delete group.nestedGroups;
  return group;
}

// An extraction's optional `default` (see CLAUDE.md): fixed text used when nothing
// matches. Non-empty text is kept as is (a number or boolean becomes text); anything
// else, "" included, is dropped, which means "no default". Other fields pass through.
function normalizeExtractions(extractions) {
  if (!Array.isArray(extractions)) return extractions;
  return extractions.map(extraction => {
    if (!extraction || typeof extraction !== 'object' || !Object.hasOwn(extraction, 'default')) return extraction;
    const { default: value, ...rest } = extraction;
    const text = typeof value === 'string' ? value
      : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : '';
    return text ? { ...rest, default: text } : rest;
  });
}

function normalizeRequest(rawRequest, index, used, validGroupIds) {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new TypeError(`Request ${index + 1} must be an object.`);
  }
  const request = clone(rawRequest);
  request.id = uniqueItemId(request, index, used, 'req', REQUEST_ID_PATTERN);
  used.add(request.id);
  request.name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
  request.enabled = request.enabled !== false;
  request.groupId = validGroupIds.has(request.groupId) ? request.groupId : '';
  if (!request.type) request.type = 'http';
  if (request.extractions !== undefined) request.extractions = normalizeExtractions(request.extractions);
  // "Save to CSV" (see csv-export.js): one shape, unknown fields kept; absent stays absent.
  if (request.exports !== undefined) request.exports = normalizeExports(request.exports);
  // Outcome rules (see outcomes.js): one shape; a value that is not one is dropped.
  if (request.outcomes !== undefined) {
    const outcomes = normalizeOutcomes(request.outcomes);
    if (outcomes) request.outcomes = outcomes;
    else delete request.outcomes;
  }
  return request;
}

// A CSV data file: see "Configuration object schema" in CLAUDE.md. Missing
// fields (older projects have no data sets at all) fall back to the defaults.
function normalizeDataSet(rawDataSet, index, used, validGroupIds) {
  if (!rawDataSet || typeof rawDataSet !== 'object' || Array.isArray(rawDataSet)) {
    throw new TypeError(`Data file ${index + 1} must be an object.`);
  }
  const dataSet = clone(rawDataSet);
  dataSet.id = uniqueItemId(dataSet, index, used, 'ds', DATA_SET_ID_PATTERN);
  used.add(dataSet.id);
  dataSet.name = typeof dataSet.name === 'string' ? dataSet.name.trim().slice(0, 120) : '';
  dataSet.fileName = typeof dataSet.fileName === 'string' ? dataSet.fileName : '';
  dataSet.delimiter = typeof dataSet.delimiter === 'string' && dataSet.delimiter ? dataSet.delimiter : ',';
  dataSet.skipHeader = dataSet.skipHeader === true;
  dataSet.columns = Array.isArray(dataSet.columns) ? dataSet.columns.map(column => String(column ?? '')) : [];
  dataSet.content = typeof dataSet.content === 'string' ? dataSet.content : '';
  dataSet.share = dataSet.share === 'per-vu' ? 'per-vu' : 'next-row';
  dataSet.onEnd = dataSet.onEnd === 'stop' ? 'stop' : 'recycle';
  // Optional: trim cell whitespace on read (default on when absent).
  if (dataSet.trimValues !== undefined) dataSet.trimValues = dataSet.trimValues !== false;
  // Optional: the request group whose start reads this file's row. A group that
  // no longer exists means "global" (every iteration), like a request's groupId.
  if (dataSet.groupId !== undefined) dataSet.groupId = validGroupIds.has(dataSet.groupId) ? dataSet.groupId : '';
  return dataSet;
}

// Thresholds: p95 / errorRate pass through; outcome targets (see outcome-thresholds.js)
// get one shape, blank rows dropped. Absent stays absent; a value that is not a list is dropped.
function normalizeThresholds(raw, requestIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const thresholds = { ...raw };
  if (thresholds.outcomes === undefined) return thresholds;
  if (!Array.isArray(thresholds.outcomes)) {
    delete thresholds.outcomes;
    return thresholds;
  }
  thresholds.outcomes = normalizeOutcomeThresholds(thresholds.outcomes)
    .filter(target => !isBlankOutcomeThreshold(target))
    .map(target => ({ ...target, request: requestIds.get(target.request) ?? target.request }));
  return thresholds;
}

function normalizeProject(rawProject) {
  if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) {
    throw new TypeError('Project JSON must contain an object.');
  }

  const source = clone(rawProject);
  const requests = source.scenario?.requests;
  if (requests !== undefined && !Array.isArray(requests)) {
    throw new TypeError('Project scenario.requests must be an array.');
  }
  const groups = source.scenario?.groups;
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new TypeError('Project scenario.groups must be an array.');
  }

  const usedGroupIds = new Set();
  const normalizedGroups = (groups || []).map((group, index) => normalizeGroup(group, index, usedGroupIds));
  const usedRequestIds = new Set();
  const usedDataSetIds = new Set();
  // Before/After sub-requests of older projects become ordinary requests.
  const rawRequests = expandSubRequests(requests || []);
  const normalizedRequests = rawRequests.map((request, index) =>
    normalizeRequest(request, index, usedRequestIds, usedGroupIds));
  // An id the store had to change (case, spaces, a repeat) is followed by the
  // outcome targets that name it; the first request with that id wins.
  const requestIds = new Map();
  rawRequests.forEach((request, index) => {
    const raw = typeof request?.id === 'string' ? request.id.trim() : '';
    if (raw && !requestIds.has(raw)) requestIds.set(raw, normalizedRequests[index].id);
  });
  return {
    ...source,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    scenario: {
      ...(source.scenario || {}),
      groups: normalizedGroups,
      requests: normalizedRequests,
    },
    variables: Array.isArray(source.variables) ? source.variables : [],
    dataSets: (Array.isArray(source.dataSets) ? source.dataSets : [])
      .map((dataSet, index) => normalizeDataSet(dataSet, index, usedDataSetIds, usedGroupIds)),
    globalHeaders: Array.isArray(source.globalHeaders) ? source.globalHeaders : [],
    load: {
      ...DEFAULT_PROJECT.load,
      ...(source.load || {}),
      stages: Array.isArray(source.load?.stages) ? source.load.stages : [],
    },
    thresholds: normalizeThresholds(source.thresholds, requestIds),
    options: source.options && typeof source.options === 'object' && !Array.isArray(source.options)
      ? source.options
      : {},
  };
}

export function migrateProject(rawProject) {
  const version = rawProject?.schemaVersion ?? 1;
  if (version !== 1 && version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Project schema version ${version} is not supported. K6UI supports version ${CURRENT_SCHEMA_VERSION}.`);
  }
  return normalizeProject(rawProject);
}

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) return `req_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createRequestGroupId() {
  if (globalThis.crypto?.randomUUID) return `grp_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createDataSetId() {
  if (globalThis.crypto?.randomUUID) return `ds_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  return `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createProjectStore(initialProject = DEFAULT_PROJECT) {
  let state = deepFreeze(migrateProject(initialProject));
  return {
    getState() {
      return state;
    },
    replace(project) {
      state = deepFreeze(migrateProject(project));
      return state;
    },
  };
}

export function serializeProject(project) {
  return JSON.stringify(migrateProject(project), null, 2);
}

export const projectStore = createProjectStore();
