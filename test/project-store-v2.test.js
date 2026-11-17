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
    migratedA.scenario.requests.map(({ id: _id, name: _name, enabled: _enabled, groupId: _groupId, ...request }) => request),
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

test('request names and disabled state survive project normalization', () => {
  const migrated = migrateProject({
    scenario: { requests: [{ name: ' Login ', enabled: false, method: 'POST', url: '/login' }] },
  });
  assert.equal(migrated.scenario.requests[0].name, 'Login');
  assert.equal(migrated.scenario.requests[0].enabled, false);
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

test('iterations load settings pass through migration without changing older projects', () => {
  const iterations = { mode: 'iterations', vus: '5', iterations: '2', maxDuration: '2h' };
  const migrated = migrateProject({ load: iterations, scenario: { requests: [] } });
  assert.deepEqual({ ...migrated.load }, { ...iterations, duration: '30s', stages: [] });
  assert.deepEqual(migrateProject(JSON.parse(serializeProject(migrated))).load, migrated.load);

  // Projects saved before the mode existed gain no iterations fields.
  const legacy = migrateProject({ load: { mode: 'stages', stages: [{ duration: '5s', target: '2' }] }, scenario: { requests: [] } });
  assert.equal('iterations' in legacy.load, false);
  assert.equal('maxDuration' in legacy.load, false);
});

test('projects without data files open with an empty list and old fields are untouched', () => {
  const migrated = migrateProject(legacyV1);
  assert.deepEqual(migrated.dataSets, []);
  assert.equal('dataSets' in legacyV1, false, 'migration must not mutate imported data');
  assert.deepEqual(migrateProject({ schemaVersion: 2, dataSets: 'nope' }).dataSets, []);
});

test('data files keep their content, get defaults for missing fields, and unique ids', () => {
  const content = 'email,password\nuser1@example.com,pass1\n';
  const migrated = migrateProject({
    schemaVersion: 2,
    dataSets: [
      { id: 'ds_login', name: '  Users  ', fileName: 'login.csv', delimiter: ';', skipHeader: true, columns: ['email', 7], content, share: 'per-vu', onEnd: 'stop', extra: 1 },
      { id: 'ds_login', content: 'x' },
      { content: 'y', share: 'weird', onEnd: 'weird', skipHeader: 'yes', columns: 'a,b' },
    ],
  });
  const [first, second, third] = migrated.dataSets;
  assert.deepEqual(first, {
    id: 'ds_login', name: 'Users', fileName: 'login.csv', delimiter: ';', skipHeader: true,
    columns: ['email', '7'], content, share: 'per-vu', onEnd: 'stop', extra: 1,
  });
  assert.deepEqual({ ...second, id: undefined }, {
    id: undefined, name: '', fileName: '', delimiter: ',', skipHeader: false,
    columns: [], content: 'x', share: 'next-row', onEnd: 'recycle',
  });
  assert.equal(third.share, 'next-row');
  assert.equal(third.onEnd, 'recycle');
  assert.equal(third.skipHeader, false);
  assert.deepEqual(third.columns, []);
  assert.equal(new Set(migrated.dataSets.map(set => set.id)).size, 3);
  assert.match(second.id, /^ds_[a-z0-9_-]+$/);
  assert.throws(() => migrateProject({ dataSets: [null] }), /Data file 1 must be an object/);
});

test('data files round-trip through serializeProject and the frozen store', () => {
  const store = createProjectStore();
  const snapshot = store.replace({
    scenario: { requests: [] },
    dataSets: [{ id: 'ds_a', name: 'a', content: 'h\n1\n', columns: ['h'], skipHeader: true }],
  });
  assert.equal(Object.isFrozen(snapshot.dataSets[0]), true);
  assert.equal(Object.isFrozen(snapshot.dataSets[0].columns), true);
  const reopened = migrateProject(JSON.parse(serializeProject(snapshot)));
  assert.deepEqual(reopened.dataSets, snapshot.dataSets);
});

// ── "Run only if" on request groups, and data files that belong to a group ──

test('a valid runIf is kept in its canonical shape; an invalid one becomes null; no runIf stays absent', () => {
  const project = migrateProject({
    schemaVersion: 2,
    scenario: {
      groups: [
        { id: 'grp_ok', name: 'ok', runIf: { variable: ' EXECUTION_MODE ', operator: 'one-of', values: [' ORDER_FLOW ', 'ALL', 'ALL', ''], extra: 1 } },
        { id: 'grp_old', name: 'no condition' },
        { id: 'grp_null', name: 'explicit null', runIf: null },
        { id: 'grp_bad_name', name: 'a', runIf: { variable: 'my var', operator: 'equals', values: ['A'] } },
        { id: 'grp_bad_op', name: 'b', runIf: { variable: 'X', operator: 'contains', values: ['A'] } },
        { id: 'grp_no_values', name: 'c', runIf: { variable: 'X', operator: 'equals', values: [' '] } },
        { id: 'grp_many', name: 'd', runIf: { variable: 'X', operator: 'not-equals', values: ['A', 'B'] } },
        { id: 'grp_text', name: 'e', runIf: 'X == A' },
      ],
      requests: [],
    },
  });
  const byId = Object.fromEntries(project.scenario.groups.map(group => [group.id, group]));
  assert.deepEqual(byId.grp_ok.runIf, { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] });
  assert.equal('runIf' in byId.grp_old, false, 'old projects gain nothing');
  assert.equal(byId.grp_null.runIf, null);
  for (const id of ['grp_bad_name', 'grp_bad_op', 'grp_no_values', 'grp_many', 'grp_text']) assert.equal(byId[id].runIf, null, id);
});

test('runIf survives serializeProject and the frozen store', () => {
  const store = createProjectStore();
  const snapshot = store.replace({
    scenario: { groups: [{ id: 'grp_a', name: 'a', runIf: { variable: 'MODE', operator: 'equals', values: ['A'] } }], requests: [] },
  });
  assert.equal(Object.isFrozen(snapshot.scenario.groups[0].runIf), true);
  assert.equal(Object.isFrozen(snapshot.scenario.groups[0].runIf.values), true);
  assert.deepEqual(migrateProject(JSON.parse(serializeProject(snapshot))).scenario.groups, snapshot.scenario.groups);
});

test('a data file keeps the group it belongs to; a group that is gone means every iteration', () => {
  const project = migrateProject({
    schemaVersion: 2,
    scenario: { groups: [{ id: 'grp_a', name: 'a' }], requests: [] },
    dataSets: [
      { id: 'ds_a', groupId: 'grp_a', content: 'h\n1\n' },
      { id: 'ds_b', groupId: 'grp_gone', content: 'h\n1\n' },
      { id: 'ds_c', groupId: 7, content: 'h\n1\n' },
      { id: 'ds_d', content: 'h\n1\n' },
    ],
  });
  assert.deepEqual(project.dataSets.map(set => set.groupId), ['grp_a', '', '', undefined]);
  assert.equal('groupId' in project.dataSets[3], false, 'older data files gain no field');
  assert.equal('trimValues' in project.dataSets[3], false, 'older data files gain no trimValues field');

  const withTrim = migrateProject({
    schemaVersion: 2,
    dataSets: [
      { id: 'ds_keep', content: 'h\n1\n', trimValues: false },
      { id: 'ds_trim', content: 'h\n1\n', trimValues: 'yes' },
    ],
  });
  assert.deepEqual(withTrim.dataSets.map(set => set.trimValues), [false, true]);
});
