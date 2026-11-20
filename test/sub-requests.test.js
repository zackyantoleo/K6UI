// Before/After sub-requests are gone from the editor; `pre` / `post` in an
// older project or API payload are read as ordinary requests in the same order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSubRequests } from '../public/js/shared/sub-requests.js';
import { migrateProject } from '../public/js/project-store.js';
import { generateScript } from '../server/generator/index.js';

const sub = (url, extra = {}) => ({ method: 'GET', url, headers: [], body: '', extractions: [], ...extra });

test('a request without sub-requests is left alone', () => {
  const plain = { id: 'req_a', url: 'https://api.test/a', sleepAfter: '2' };
  assert.deepEqual(expandSubRequests([plain]), [plain]);
  assert.deepEqual(expandSubRequests([{ ...plain, pre: null, post: null }]), [plain], 'empty keys are dropped');
  assert.deepEqual(expandSubRequests([{ ...plain, pre: sub('  '), post: {} }]), [plain], 'a sub-request with no URL never ran');
  assert.deepEqual(expandSubRequests([null, 'x']), [null, 'x'], 'the store reports bad entries itself');
  assert.equal(expandSubRequests(undefined), undefined);
});

test('before, request, after: same order, group and on/off state; pause and CSV rows move to the end', () => {
  const [before, main, after, next] = expandSubRequests([
    {
      id: 'req_login', name: 'Login', groupId: 'grp_auth', enabled: false, method: 'POST', url: 'https://api.test/login',
      sleepAfter: '2', preScript: 'vars.a = 1;', exports: [{ file: 'tokens.csv', columns: [] }],
      pre: sub('https://api.test/csrf', { headers: [{ key: 'X-Pre', value: '1' }], extractions: [{ varName: 'csrf', source: 'header', selector: 'X-CSRF' }] }),
      post: sub('https://api.test/logout', { method: 'DELETE', body: '{}' }),
    },
    { id: 'req_next', url: 'https://api.test/next' },
  ]);
  assert.deepEqual(before, {
    name: 'Login (before)', type: 'http', method: 'GET', url: 'https://api.test/csrf',
    headers: [{ key: 'X-Pre', value: '1' }], body: '', extractions: [{ varName: 'csrf', source: 'header', selector: 'X-CSRF' }],
    checkStatus: true, sleepAfter: '0', id: 'req_login_before', groupId: 'grp_auth', enabled: false,
  });
  assert.deepEqual([main.id, main.sleepAfter, main.preScript], ['req_login', '0', 'vars.a = 1;']);
  assert.equal('pre' in main || 'post' in main || 'exports' in main, false);
  assert.deepEqual([after.id, after.name, after.method, after.sleepAfter, after.groupId, after.enabled],
    ['req_login_after', 'Login (after)', 'DELETE', '2', 'grp_auth', false]);
  assert.deepEqual(after.exports, [{ file: 'tokens.csv', columns: [] }]);
  assert.equal(next.id, 'req_next');
});

test('only a Before request: the request keeps its own pause and CSV rows', () => {
  const [before, main] = expandSubRequests([{ url: 'https://api.test/a', sleepAfter: '3', exports: [], pre: sub('https://api.test/setup') }]);
  assert.equal(before.name, 'Request (before)');
  assert.equal('id' in before, false, 'no id to derive from: the store gives one');
  assert.deepEqual([main.sleepAfter, main.exports], ['3', []]);
});

test('opening an older project turns sub-requests into requests with stable ids', () => {
  const project = migrateProject({
    scenario: { requests: [{ id: 'req_a', name: 'A', url: 'https://api.test/a', pre: sub('https://api.test/pre'), post: sub('https://api.test/post') }] },
  });
  assert.deepEqual(project.scenario.requests.map(request => [request.id, request.name, request.url]), [
    ['req_a_before', 'A (before)', 'https://api.test/pre'],
    ['req_a', 'A', 'https://api.test/a'],
    ['req_a_after', 'A (after)', 'https://api.test/post'],
  ]);
  assert.deepEqual(migrateProject(project), project, 'opening it again changes nothing');
});

test('an API payload with sub-requests still runs the same calls in the same order', () => {
  const script = generateScript({
    load: { mode: 'simple', vus: 1, duration: '1s' },
    scenario: { requests: [{
      method: 'POST', url: 'https://api.test/main', body: '{}', sleepAfter: 2, checkStatus: true,
      preScript: 'vars.seed = 1;', postScript: 'vars.done = res.status;',
      pre: sub('https://api.test/pre'), post: sub('https://api.test/post'),
    }] },
  });
  const order = ['https://api.test/pre', '// Pre-processor: request 2', 'https://api.test/main', '// Post-processor: request 2', 'https://api.test/post', 'sleep(2);'];
  const positions = order.map(marker => script.indexOf(marker));
  assert.ok(positions.every(position => position !== -1), `every step is generated: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'before → pre-processor → request → post-processor → after → pause');
  assert.equal(script.match(/sleep\(/g).length, 1, 'one pause, after the last call');
});
