import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURRENT_SCHEMA_VERSION,
  createProjectStore,
  migrateProject,
  serializeProject,
} from '../public/js/project-store.js';

const legacyV1 = {
  load: { mode: 'simple', vus: 3, duration: '45s' },
  variables: [{ key: 'baseUrl', value: 'https://test.k6.io' }],
  globalHeaders: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
  thresholds: { p95: 500, errorRate: 0.01 },
  options: { insecureSkipTlsVerify: true },
  scenario: {
    requests: [
      { type: 'http', method: 'GET', url: '{{baseUrl}}/public/crocodiles/1/', headers: [], assertions: [] },
      { type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.HelloService/SayHello', grpcPlaintext: true },
    ],
  },
};

test('v1 migration adds schemaVersion and deterministic unique request IDs without changing semantics', () => {
  const migratedA = migrateProject(legacyV1);
  const migratedB = migrateProject(legacyV1);

  assert.equal(migratedA.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migratedA.schemaVersion, 2);
  assert.equal(migratedA.scenario.requests.length, 2);
  assert.deepEqual(
    migratedA.scenario.requests.map(({ id: _id, ...request }) => request),
    legacyV1.scenario.requests,
  );
  assert.deepEqual(
    migratedA.scenario.requests.map(request => request.id),
    migratedB.scenario.requests.map(request => request.id),
  );
  assert.equal(new Set(migratedA.scenario.requests.map(request => request.id)).size, 2);
  assert.match(migratedA.scenario.requests[0].id, /^req_[a-z0-9_-]+$/);
  assert.equal('schemaVersion' in legacyV1, false, 'migration must not mutate imported data');
  assert.equal('id' in legacyV1.scenario.requests[0], false, 'migration must not mutate requests');
});

test('existing valid request IDs are preserved and duplicates are repaired', () => {
  const migrated = migrateProject({
    schemaVersion: 2,
    scenario: {
      requests: [
        { id: 'req_login', type: 'http', method: 'POST', url: '/login' },
        { id: 'req_login', type: 'http', method: 'GET', url: '/profile' },
      ],
    },
  });

  assert.equal(migrated.scenario.requests[0].id, 'req_login');
  assert.notEqual(migrated.scenario.requests[1].id, 'req_login');
});

test('unknown schema versions fail with an actionable compatibility error', () => {
  assert.throws(
    () => migrateProject({ schemaVersion: 99, scenario: { requests: [] } }),
    /schema version 99.*supports version 2/i,
  );
});

test('project store owns normalized immutable state and round-trips v2 JSON', () => {
  const store = createProjectStore(legacyV1);
  const first = store.getState();
  assert.equal(first.schemaVersion, 2);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.scenario.requests), true);

  const changed = structuredClone(first);
  changed.load.vus = 9;
  store.replace(changed);
  assert.equal(store.getState().load.vus, 9);
  assert.equal(first.load.vus, 3);

  const json = serializeProject(store.getState());
  assert.deepEqual(migrateProject(JSON.parse(json)), store.getState());
});

test('defaults make partial legacy projects safe to apply', () => {
  const migrated = migrateProject({ scenario: { requests: [{ method: 'GET', url: '/health' }] } });
  assert.deepEqual(migrated.load, { mode: 'simple', vus: 10, duration: '30s', stages: [] });
  assert.deepEqual(migrated.variables, []);
  assert.deepEqual(migrated.globalHeaders, []);
  assert.deepEqual(migrated.thresholds, {});
  assert.deepEqual(migrated.options, {});
  assert.equal(migrated.scenario.requests[0].type, 'http');
});

test('malformed array-valued object domains fall back to safe defaults', () => {
  const migrated = migrateProject({
    thresholds: ['not', 'an', 'object'],
    options: ['also-invalid'],
    scenario: { requests: [] },
  });
  assert.deepEqual(migrated.thresholds, {});
  assert.deepEqual(migrated.options, {});
});
