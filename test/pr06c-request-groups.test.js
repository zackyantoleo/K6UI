import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { generateScript } from '../server/generator/index.js';
import { migrateProject } from '../public/js/project-store.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('project store normalizes flat groups and clears invalid request memberships', () => {
  const project = migrateProject({
    schemaVersion: 2,
    scenario: {
      groups: [
        {
          id: 'grp_checkout',
          name: 'Checkout',
          enabled: true,
          collapsed: true,
          headers: [{ key: 'X-Service', value: 'checkout' }],
          parentId: 'grp_parent',
          children: [{ id: 'grp_nested' }],
        },
        { id: 'grp_checkout', name: 'Duplicate ID', enabled: false, headers: [] },
      ],
      requests: [
        { id: 'req_cart', groupId: 'grp_checkout', method: 'GET', url: 'https://example.test/cart' },
        { id: 'req_orphan', groupId: 'grp_missing', method: 'GET', url: 'https://example.test/orphan' },
      ],
    },
  });

  assert.equal(project.scenario.groups.length, 2);
  assert.equal(project.scenario.groups[0].id, 'grp_checkout');
  assert.notEqual(project.scenario.groups[1].id, 'grp_checkout');
  assert.deepEqual(project.scenario.groups[0].headers, [{ key: 'X-Service', value: 'checkout' }]);
  assert.equal(project.scenario.groups[0].collapsed, true);
  assert.equal('parentId' in project.scenario.groups[0], false);
  assert.equal('children' in project.scenario.groups[0], false);
  assert.equal(project.scenario.requests[0].groupId, 'grp_checkout');
  assert.equal(project.scenario.requests[1].groupId, '');
});

test('request groups apply middle-precedence headers and skip disabled groups', () => {
  const script = generateScript({
    globalHeaders: [
      { key: 'X-Global', value: 'global' },
      { key: 'X-Override', value: 'global' },
    ],
    scenario: {
      groups: [
        {
          id: 'grp_auth',
          name: 'Auth flow',
          enabled: true,
          headers: [
            { key: 'X-Service', value: 'auth' },
            { key: 'X-Override', value: 'group' },
          ],
        },
        {
          id: 'grp_admin',
          name: 'Admin flow',
          enabled: false,
          headers: [{ key: 'X-Service', value: 'admin' }],
        },
      ],
      requests: [
        {
          id: 'req_login', groupId: 'grp_auth', name: 'Login', type: 'http', method: 'GET',
          url: 'https://example.test/login', headers: [{ key: 'X-Override', value: 'request' }],
          pre: {
            method: 'GET', url: 'https://example.test/setup',
            headers: [{ key: 'X-Override', value: 'pre-request' }], extractions: [],
          },
        },
        {
          id: 'req_admin', groupId: 'grp_admin', type: 'http', method: 'GET',
          url: 'https://example.test/admin', headers: [],
        },
        {
          id: 'req_health', groupId: '', type: 'http', method: 'GET',
          url: 'https://example.test/health', headers: [],
        },
      ],
    },
  });

  assert.match(script, /\/\/ Group: Auth flow/);
  assert.match(script, /https:\/\/example\.test\/login/);
  assert.match(script, /https:\/\/example\.test\/health/);
  assert.doesNotMatch(script, /https:\/\/example\.test\/admin/);
  assert.match(script, /"X-Global": "global"/);
  assert.match(script, /"X-Service": "auth"/);
  assert.match(script, /"X-Override": "request"/);
  assert.match(script, /"X-Override": "pre-request"/);
  assert.doesNotMatch(script, /"X-Override": "group"/);
});

test('flow UI exposes one-level groups, membership moves, collapse, and group header defaults', async () => {
  const [flowView, requestCard, requestGroups, config, projectIo, css] = await Promise.all([
    read('public/js/components/flow-view.js'),
    read('public/js/components/req-card.js'),
    read('public/js/components/request-groups.js'),
    read('public/js/config.js'),
    read('public/js/project-io.js'),
    read('public/css/style.css'),
  ]);
  const source = `${flowView}\n${requestCard}\n${requestGroups}\n${config}\n${projectIo}`;

  for (const contract of [
    /createRequestGroup/,
    /refreshRequestGroupOptions/,
    /request-group-select/,
    /request-group-collapse/,
    /request-group-enabled/,
    /group-headers-list/,
    /preferredGroups/,
    /scenario:\s*\{\s*groups/,
    /restoreGroups/,
  ]) {
    assert.match(source, contract);
  }
  assert.match(css, /\.request-group/);
  assert.doesNotMatch(source, /parentGroupId|nestedGroups|group\.children/);
});
