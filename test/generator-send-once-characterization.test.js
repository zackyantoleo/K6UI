// "Send once" (stage 8) must not change the script of any existing project: every
// project below generates byte for byte what `main` generated before Send once
// existed (ff89de1). The hashes are SHA-256 of generateScript(config). When the
// generator changes on purpose, print the new ones with
//   K6UI_PRINT_HASHES=1 node test/generator-send-once-characterization.test.js
// and say in the commit why the scripts changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateScript } from '../server/generator/index.js';
import { RACE_OFF_PROJECTS } from './race-off-characterization.test.js';
import { sendOnceConfig } from '../server/send-once.js';

const sha256 = text => createHash('sha256').update(text).digest('hex');

const withLog = (config, options) => ({ ...config, options: { logRequests: true, ...options } });

export const EXISTING_PROJECTS = {
  ...RACE_OFF_PROJECTS,
  'fixed VUs, processors, extraction, assertions + request log (all)': withLog(RACE_OFF_PROJECTS['fixed VUs, processors, extraction, assertions'], { logFilter: 'all' }),
  'stages, conditional group, data file + request log (errors, hide secrets)': withLog(RACE_OFF_PROJECTS['stages, conditional group, data file'], { logFilter: 'errors', logRedact: true }),
  'gRPC request + request log (sample)': withLog(RACE_OFF_PROJECTS['gRPC request'], { logFilter: 'sample', logSampleEvery: 5 }),
  'race burst, offsets, warm-up, request log': {
    variables: [{ key: 'host', value: 'http://127.0.0.1:9' }, { key: 'T2_MS', value: '1000' }],
    load: { mode: 'race', vus: '3', maxDuration: '5m', race: { request: 'req_redeem', timing: 'offsets', offsets: '0,{{T2_MS}},1030', leadMs: '500', warmup: true, warmupPath: '/', failIfLate: true } },
    options: { logRequests: true, logFilter: 'all' },
    scenario: {
      requests: [
        { id: 'req_login', type: 'http', method: 'POST', url: '{{host}}/login', body: '{}', checkStatus: true, sleepAfter: 0, extractions: [{ varName: 'token', source: 'json', selector: 'token' }] },
        { id: 'req_redeem', name: 'Redeem voucher', type: 'http', method: 'POST', url: '{{host}}/redeem', preScript: 'vars.ts = Date.now();', body: '{"ts":"{{ts}}","t":"{{token}}"}', checkStatus: true, sleepAfter: 0 },
      ],
    },
  },
  'older project: before/after sub-requests, turned-off request and group, header precedence': {
    variables: [{ key: 'base', value: 'https://example.test' }],
    globalHeaders: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Level', value: 'global' }],
    load: { mode: 'simple', vus: '3', duration: '20s' },
    thresholds: { p95: '300', errorRate: '' },
    scenario: {
      groups: [
        { id: 'grp_on', name: 'Shop', enabled: true, headers: [{ key: 'x-level', value: 'group' }] },
        { id: 'grp_off', name: 'Off', enabled: false, headers: [] },
      ],
      requests: [
        { id: 'req_a', name: 'A', type: 'http', method: 'GET', url: '{{base}}/a', groupId: 'grp_on', headers: [{ key: 'X-LEVEL', value: 'request' }], checkStatus: true, sleepAfter: '0.5',
          pre: { method: 'GET', url: '{{base}}/warm' }, post: { method: 'DELETE', url: '{{base}}/cleanup' } },
        { id: 'req_b', name: 'B', type: 'http', method: 'GET', url: '{{base}}/b', enabled: false, checkStatus: true, sleepAfter: 1 },
        { id: 'req_c', name: 'C', type: 'http', method: 'PUT', url: '{{base}}/c', groupId: 'grp_off', body: '{}', checkStatus: true, sleepAfter: 1 },
        { id: 'req_d', name: 'D', type: 'http', method: 'PATCH', url: '{{base}}/d', groupId: 'grp_on', body: '{"x":"{{base}}"}', checkStatus: true, sleepAfter: 1,
          postScript: 'vars.sig = crypto.sha256("x", "hex"); vars.b = encoding.b64encode("y");' },
      ],
    },
  },
};

const EXPECTED = {
  'fixed VUs, processors, extraction, assertions': 'c7e3c59da09c0766ba097468676be99e59b5d04cbba9cf6667b12554f412da1d',
  'iterations, outcome rules, expected statuses, targets, request log': '3d550b718857d5c8fe8f701e44d5dc078ab20a9b502895347b6245a7fe2bd0e7',
  'stages, conditional group, data file': 'ad9ddf875100508975506c5db996d390706e8b59bc16159e63482b6850fdf14c',
  'gRPC request': '8b6cbee8e63b9d8b302ae8af57066a370f93d1a972f5258117cb72075bc02dcb',
  'fixed VUs, processors, extraction, assertions + request log (all)': '94feb89af96030e28a74248756049e9894f4cb12592900c995a614feda482be2',
  'stages, conditional group, data file + request log (errors, hide secrets)': 'dd3f8994d77727b4690d536c4bffd0549179199c0b54013824bf07253790a966',
  'gRPC request + request log (sample)': '5a06114eccc43f047976f8b14a8bad2a9c8cab3cd8eccc2213978524ce045e38',
  'race burst, offsets, warm-up, request log': 'dd33f7e38547c3548c8987417842b39d2793856f08594b672e3cc80f0cfe64d9',
  'older project: before/after sub-requests, turned-off request and group, header precedence': 'c076688e45f9fa48e054619c90e06265771333c8590d36b2c1111bd2a4ddea98',
};

if (process.env.K6UI_PRINT_HASHES) {
  for (const [name, config] of Object.entries(EXISTING_PROJECTS)) console.log(`  ${JSON.stringify(name)}: '${sha256(generateScript(config))}',`);
}

test('an existing project generates exactly what main generated before Send once', () => {
  for (const [name, config] of Object.entries(EXISTING_PROJECTS)) {
    assert.equal(sha256(generateScript(config)), EXPECTED[name], `${name}: the generated script changed`);
  }
});

test('meta and the default options leave the script unchanged; only Send once asks for longer bodies', () => {
  for (const [name, config] of Object.entries(EXISTING_PROJECTS)) {
    assert.equal(generateScript(config, {}), generateScript(config), `${name}: meta changed the script`);
    assert.equal(generateScript(config, null, {}), generateScript(config), `${name}: empty options changed the script`);
  }
  const project = EXISTING_PROJECTS['race burst, offsets, warm-up, request log'];
  assert.match(generateScript(project), /"bodyLimit":4096/);
  const once = generateScript(sendOnceConfig(project, 'req_redeem'), null, { logBodyLimit: 262144 });
  assert.match(once, /"bodyLimit":262144/);
});
