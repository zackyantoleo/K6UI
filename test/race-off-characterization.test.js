// Race burst must not change a script that does not use it: every project below
// generates byte for byte what `main` generated before race mode existed
// (9753f9f). The hashes are SHA-256 of generateScript(config). When the generator
// changes on purpose, print the new ones with
//   K6UI_PRINT_HASHES=1 node test/race-off-characterization.test.js
// and say in the commit why the scripts changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateScript } from '../server/generator/index.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');

export const RACE_OFF_PROJECTS = {
  'fixed VUs, processors, extraction, assertions': {
    variables: [{ key: 'baseUrl', value: 'https://example.test' }],
    globalHeaders: [{ key: 'Accept', value: 'application/json' }],
    load: { mode: 'simple', vus: 2, duration: '10s' },
    thresholds: { p95: 500, errorRate: 1 },
    scenario: {
      requests: [{
        type: 'http', method: 'POST', url: '{{baseUrl}}/login',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: '{"name":"zack"}', checkStatus: true, sleepAfter: 1,
        preScript: "vars.seed = 'x';",
        extractions: [{ varName: 'token', source: 'json', selector: 'token', default: 'NONE' }],
        assertions: [{ type: 'body-contains', value: 'ok', value2: '' }],
        postScript: 'vars.done = res.status;',
      }, {
        type: 'http', method: 'GET', url: '{{baseUrl}}/me', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
        checkStatus: true, sleepAfter: 0,
      }],
    },
  },
  'iterations, outcome rules, expected statuses, targets, request log': {
    variables: [{ key: 'QUOTA', value: '3' }, { key: 'host', value: 'http://127.0.0.1:9' }],
    load: { mode: 'iterations', vus: '4', iterations: '1', maxDuration: '1m' },
    thresholds: { p95: '', errorRate: '', outcomes: [{ request: 'req_redeem', label: 'success', op: '<=', value: '{{QUOTA}}' }] },
    options: { logRequests: true, logFilter: 'all', logRedact: true },
    scenario: {
      requests: [{
        id: 'req_redeem', type: 'http', method: 'POST', url: '{{host}}/redeem', body: '{"code":"A"}',
        checkStatus: true, sleepAfter: 0, expectedStatuses: '200,4xx',
        outcomes: {
          rules: [
            { label: 'success', status: '200', source: 'none', selector: '', operator: 'equals', value: '' },
            { label: 'quota_reached', status: '400', source: 'json', selector: 'error.code', operator: 'equals', value: 'PROM-422001' },
          ],
          fallback: 'other',
        },
        exports: [{ file: 'out.csv', columns: [{ name: 'label', value: '{{$outcome}}' }], skipMissing: false }],
      }],
    },
  },
  'stages, conditional group, data file': {
    variables: [{ key: 'MODE', value: 'ALL' }],
    load: { mode: 'stages', stages: [{ duration: '10s', target: '5' }, { duration: '5s', target: '0' }] },
    thresholds: {},
    dataSets: [{ id: 'ds_users', name: 'Users', fileName: 'u.csv', delimiter: ',', skipHeader: true, columns: [], content: 'email\na@x.test\nb@x.test\n', share: 'next-row', onEnd: 'recycle' }],
    scenario: {
      groups: [{ id: 'grp_a', name: 'Orders', enabled: true, headers: [{ key: 'X-Service', value: 'orders' }], runIf: { variable: 'MODE', operator: 'one-of', values: ['ALL', 'ORDER'] } }],
      requests: [
        { type: 'http', method: 'GET', url: 'https://example.test/a?u={{email}}', checkStatus: true, sleepAfter: 1 },
        { type: 'http', method: 'POST', url: 'https://example.test/order', groupId: 'grp_a', body: '{}', checkStatus: false, sleepAfter: 0, extractions: [{ varName: 'orderId', source: 'json', selector: 'id' }] },
        { type: 'http', method: 'GET', url: 'https://example.test/order/{{orderId}}', checkStatus: true, sleepAfter: 0 },
      ],
    },
  },
  'gRPC request': {
    load: { mode: 'simple', vus: 1, duration: '5s' },
    scenario: {
      requests: [{ type: 'grpc', url: 'grpc.example.test:443', grpcMethod: 'pkg.Service/Call', body: '{"a":1}', headers: [{ key: 'x-md', value: 'v' }], checkStatus: true, sleepAfter: 0 }],
    },
  },
};

const EXPECTED = {
  'fixed VUs, processors, extraction, assertions': 'f663a2c06623a4aada7cbfd2c76e04db7033cf962bf975cb90c879c68d13b25c',
  'iterations, outcome rules, expected statuses, targets, request log': '3d550b718857d5c8fe8f701e44d5dc078ab20a9b502895347b6245a7fe2bd0e7',
  'stages, conditional group, data file': 'ad9ddf875100508975506c5db996d390706e8b59bc16159e63482b6850fdf14c',
  'gRPC request': '8b6cbee8e63b9d8b302ae8af57066a370f93d1a972f5258117cb72075bc02dcb',
};

if (process.env.K6UI_PRINT_HASHES) {
  for (const [name, config] of Object.entries(RACE_OFF_PROJECTS)) console.log(`  ${JSON.stringify(name)}: '${sha256(generateScript(config))}',`);
}

test('a project without race mode generates exactly what main generated before race mode', () => {
  for (const [name, config] of Object.entries(RACE_OFF_PROJECTS)) {
    assert.equal(sha256(generateScript(config)), EXPECTED[name], `${name}: the generated script changed`);
  }
});
