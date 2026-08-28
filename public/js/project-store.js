// Lightweight versioned project state. The store owns a normalized immutable
// snapshot; DOM adapters in config.js/project-io.js synchronize at UI boundaries.
export const CURRENT_SCHEMA_VERSION = 2;

const REQUEST_ID_PATTERN = /^req_[a-z0-9_-]+$/;

const DEFAULT_PROJECT = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  scenario: { requests: [] },
  variables: [],
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

function hashRequest(request, index) {
  const source = `${index}:${JSON.stringify(request)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function uniqueRequestId(request, index, used) {
  const existing = typeof request.id === 'string' ? request.id.trim().toLowerCase() : '';
  if (REQUEST_ID_PATTERN.test(existing) && !used.has(existing)) return existing;

  const withoutId = { ...request };
  delete withoutId.id;
  const base = `req_${hashRequest(withoutId, index)}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function normalizeRequest(rawRequest, index, used) {
  if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new TypeError(`Request ${index + 1} must be an object.`);
  }
  const request = clone(rawRequest);
  request.id = uniqueRequestId(request, index, used);
  used.add(request.id);
  request.name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
  request.enabled = request.enabled !== false;
  if (!request.type) request.type = 'http';
  return request;
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

  const used = new Set();
  return {
    ...source,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    scenario: {
      ...(source.scenario || {}),
      requests: (requests || []).map((request, index) => normalizeRequest(request, index, used)),
    },
    variables: Array.isArray(source.variables) ? source.variables : [],
    globalHeaders: Array.isArray(source.globalHeaders) ? source.globalHeaders : [],
    load: {
      ...DEFAULT_PROJECT.load,
      ...(source.load || {}),
      stages: Array.isArray(source.load?.stages) ? source.load.stages : [],
    },
    thresholds: source.thresholds && typeof source.thresholds === 'object' && !Array.isArray(source.thresholds)
      ? source.thresholds
      : {},
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
