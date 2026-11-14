import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { outlineModel, resolveSelection } from '../public/js/components/flow-outline.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const groups = [
  { id: 'grp_auth', name: 'Auth', enabled: true },
  { id: 'grp_checkout', name: 'Checkout', enabled: true },
];
const request = (id, groupId, extra = {}) => ({
  id, groupId, name: '', type: 'http', method: 'GET', url: '', enabled: true, ...extra,
});

test('outline keeps the global execution order with group labels, not grouped order', () => {
  const model = outlineModel([
    request('req_login', 'grp_auth', { name: 'Login', method: 'POST', url: 'https://api.example.test/session' }),
    request('req_cart', 'grp_checkout', { name: 'Cart' }),
    request('req_profile', 'grp_auth', { name: 'Profile' }),
  ], groups);

  assert.deepEqual(model.requests.map(item => [item.number, item.id, item.label, item.groupName]), [
    [1, 'req_login', 'Login', 'Auth'],
    [2, 'req_cart', 'Cart', 'Checkout'],
    [3, 'req_profile', 'Profile', 'Auth'],
  ]);
  assert.equal(model.requests[0].method, 'POST');
  assert.equal(model.requests[0].url, 'https://api.example.test/session');
  assert.deepEqual(model.groups.map(group => [group.id, group.name, group.count]), [
    ['grp_auth', 'Auth', 2],
    ['grp_checkout', 'Checkout', 1],
  ]);
});

test('outline marks skipped requests honestly and falls back for blank names', () => {
  const model = outlineModel([
    request('req_off', 'grp_auth', { enabled: false }),
    request('req_group_off', 'grp_admin'),
    request('req_grpc', '', { type: 'grpc', name: '  ' }),
    request('req_orphan', 'grp_missing'),
  ], [
    { id: 'grp_auth', name: 'Auth', enabled: true },
    { id: 'grp_admin', name: '   ', enabled: false },
  ]);

  assert.deepEqual(model.requests.map(item => [item.label, item.method, item.groupName, item.skipReason]), [
    ['Request 1', 'GET', 'Auth', 'Disabled'],
    ['Request 2', 'GET', 'Untitled group', 'Group off'],
    ['Request 3', 'gRPC', '', ''],
    ['Request 4', 'GET', '', ''],
  ]);
  assert.deepEqual(model.groups.map(group => [group.name, group.enabled, group.count]), [
    ['Auth', true, 1],
    ['Untitled group', false, 1],
  ]);
});

test('outline is a text-only sibling that never reparents cards; handlers notify it', async () => {
  const [outline, flowView, requestCard, requestGroups, config] = await Promise.all([
    read('public/js/components/flow-outline.js'),
    read('public/js/components/flow-view.js'),
    read('public/js/components/req-card.js'),
    read('public/js/components/request-groups.js'),
    read('public/js/config.js'),
  ]);
  assert.doesNotMatch(outline, /innerHTML|insertAdjacentHTML|cloneNode|collectConfig|applyConfig|projectStore/);
  assert.doesNotMatch(outline, /#reqs-main'\)\.append|reqs-main.*insertBefore/);
  assert.match(flowView, /layout\.append\(createFlowOutline\(/);
  assert.match(config, /collectReqList\('reqs-main'\)/, 'collector still reads every card in #reqs-main');
  assert.equal(requestCard.match(/notifyFlowChanged\(/g)?.length, 4, 'move up/down, duplicate, remove');
  assert.match(flowView, /notifyFlowChanged\(\{ kind: 'request'/);
  assert.match(flowView, /notifyFlowChanged\(\{ kind: 'group'/);
  assert.match(requestGroups, /notifyFlowChanged\(\)/);
  assert.doesNotMatch(requestGroups, /addEventListener\('input', refreshRequestGroupOptions\)/,
    'the input Event must not be passed as preferredGroups');
});

test('selection keeps stable IDs and picks a deterministic neighbor when its item disappears', () => {
  const model = (requestIds, groupIds = []) => ({
    requests: requestIds.map(id => ({ id })),
    groups: groupIds.map(id => ({ id })),
  });
  const before = model(['a', 'b', 'c'], ['g1', 'g2', 'g3']);
  const selectB = { kind: 'request', id: 'b' };

  assert.equal(resolveSelection(selectB, before, model(['c', 'a', 'b'])), selectB, 'reorder keeps the same ID');
  assert.deepEqual(resolveSelection(null, before, model(['a', 'b'])), { kind: 'request', id: 'a' });
  assert.equal(resolveSelection(null, before, model([], ['g1'])), null, 'no request means empty editor state');
  assert.deepEqual(resolveSelection(selectB, before, model(['a', 'c'])), { kind: 'request', id: 'c' }, 'next survivor');
  assert.deepEqual(resolveSelection({ kind: 'request', id: 'c' }, before, model(['a', 'b'])), { kind: 'request', id: 'b' }, 'previous when last removed');
  assert.equal(resolveSelection(selectB, before, model([])), null);
  assert.deepEqual(resolveSelection({ kind: 'group', id: 'g2' }, before, model(['a'], ['g1', 'g3'])), { kind: 'group', id: 'g3' });
  assert.deepEqual(resolveSelection({ kind: 'group', id: 'g1' }, before, model(['a'], [])), { kind: 'request', id: 'a' }, 'last group falls back to a request');
});
