import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScript } from '../server/generator/index.js';
import { migrateProject, serializeProject } from '../public/js/project-store.js';

const baseProject = {
  scenario: {
    requests: [
      { id: 'req_login', name: 'Login', enabled: true, type: 'http', method: 'POST', url: 'https://example.test/login' },
      { id: 'req_disabled', name: 'Disabled', enabled: false, type: 'http', method: 'GET', url: 'https://disabled.example.test' },
    ],
  },
};

test('disabled request persists in project JSON but is excluded from generated script', () => {
  const migrated = migrateProject(baseProject);
  const roundTrip = JSON.parse(serializeProject(migrated));
  assert.equal(roundTrip.scenario.requests[1].enabled, false);
  assert.equal(roundTrip.scenario.requests[1].name, 'Disabled');

  const script = generateScript(roundTrip);
  assert.match(script, /example\.test\/login/);
  assert.doesNotMatch(script, /disabled\.example\.test/);
});

test('duplicate-style requests retain distinct stable IDs through serialization', () => {
  const migrated = migrateProject({
    scenario: {
      requests: [
        { id: 'req_a', name: 'Login', url: '/login' },
        { id: 'req_b', name: 'Login copy', url: '/login' },
      ],
    },
  });
  const roundTrip = JSON.parse(serializeProject(migrated));
  assert.deepEqual(roundTrip.scenario.requests.map(request => request.id), ['req_a', 'req_b']);
  assert.deepEqual(roundTrip.scenario.requests.map(request => request.name), ['Login', 'Login copy']);
});
