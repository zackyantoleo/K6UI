import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';
import { generateScript } from '../server/generator/index.js';
import { ScriptImportError, importK6Script } from '../server/importer/index.js';
import { migrateProject } from '../public/js/project-store.js';

const HANDWRITTEN = `
import http from 'k6/http';
import { check, sleep, group } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://api.example.com';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<900'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  group('auth', () => {
    const login = http.post(\`\${BASE_URL}/login\`, JSON.stringify({ user: 'zack', age: 30 }), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'Login' },
    });
    check(login, {
      'status is 200': (r) => r.status === 200,
      'has token': (r) => r.body.includes('token'),
      'fast': (r) => r.timings.duration < 300,
      'weird': (r) => r.json('x') === 1,
    });
    const token = login.json('data.token');
    sleep(1);
    const me = http.get(BASE_URL + '/me?x=' + token, { headers: { Authorization: \`Bearer \${token}\` } });
    check(me, { ok: (r) => r.status >= 200 && r.status < 300 });
  });
  for (let i = 0; i < 3; i++) { http.get(BASE_URL + '/loop'); }
  sleep(Math.random() * 3);
}
`;

const messages = (warnings) => warnings.map((w) => w.message).join('\n');

test('imports options, groups, requests, extractions, checks, and sleeps from a handwritten script', () => {
  const { config, warnings } = importK6Script(HANDWRITTEN);

  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.load, {
    mode: 'stages', vus: '1', duration: '30s',
    stages: [{ duration: '30s', target: '20' }, { duration: '1m', target: '20' }],
  });
  assert.deepEqual(config.thresholds, { p95: '500', errorRate: '5' });
  assert.deepEqual(config.variables, [{ key: 'BASE_URL', value: 'https://api.example.com' }]);

  assert.deepEqual(config.scenario.groups.map((g) => g.name), ['auth']);
  const [login, me] = config.scenario.requests;
  assert.equal(login.groupId, config.scenario.groups[0].id);
  assert.equal(login.name, 'Login');
  assert.equal(login.method, 'POST');
  assert.equal(login.url, '{{BASE_URL}}/login');
  assert.deepEqual(login.headers, [{ key: 'Content-Type', value: 'application/json' }]);
  assert.deepEqual(JSON.parse(login.body), { user: 'zack', age: 30 });
  assert.deepEqual(login.extractions, [{ varName: 'token', source: 'json', selector: 'data.token' }]);
  assert.deepEqual(login.assertions.map((a) => [a.type, a.value]), [
    ['status-eq', '200'], ['body-contains', 'token'], ['duration-lt', '300'],
  ]);
  assert.equal(login.sleepAfter, '1');

  assert.equal(me.url, '{{BASE_URL}}/me?x={{token}}');
  assert.deepEqual(me.headers, [{ key: 'Authorization', value: 'Bearer {{token}}' }]);
  assert.deepEqual(me.assertions.map((a) => a.type), ['status-2xx']);
  assert.equal(config.scenario.requests.length, 2);

  const text = messages(warnings);
  assert.match(text, /p\(99\)<900/);
  assert.match(text, /Check "weird"/);
  assert.match(text, /a loop cannot be imported/);
  assert.match(text, /Math\.random\(\)/);
});

test('the imported configuration is a valid project that generates a script again', () => {
  const { config } = importK6Script(HANDWRITTEN);
  assert.doesNotThrow(() => migrateProject(config));
  const script = generateScript(config);
  assert.match(script, /http\.request\("POST", `\$\{GLOBALS\.BASE_URL\}\/login`/);
  assert.match(script, /let token = JSON\.parse\(res_main_0\.body\)\?\.\["data"\]\?\.\["token"\]/);
});

test('reads simple load options, local constants, form bodies, and every http verb', () => {
  const { config } = importK6Script(`
    import http from 'k6/http';
    export const options = { vus: 5, duration: '2m' };
    const params = { headers: { 'X-Key': 'abc' } };
    export default function () {
      const id = 42;
      http.get('https://x.test/items/' + id, params);
      http.put('https://x.test/items/42', '{"a":1}', params);
      http.patch('https://x.test/items/42', '{"a":2}');
      http.del('https://x.test/items/42');
      http.head('https://x.test/items/42');
      http.options('https://x.test/items/42');
      http.request('POST', 'https://x.test/form', { name: 'a b', city: 'x&y' });
    }
  `);
  assert.deepEqual(config.load, { mode: 'simple', vus: '5', duration: '2m', stages: [] });
  assert.deepEqual(config.scenario.requests.map((r) => r.method), ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'POST']);
  assert.equal(config.scenario.requests[0].url, 'https://x.test/items/42');
  assert.deepEqual(config.scenario.requests[0].headers, [{ key: 'X-Key', value: 'abc' }]);
  assert.equal(config.scenario.requests[1].body, '{"a":1}');
  const form = config.scenario.requests[6];
  assert.equal(form.body, 'name=a%20b&city=x%26y');
  assert.deepEqual(form.headers, [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
});

test('extracts from headers, regex, and parsed JSON, also when used inline', () => {
  const { config } = importK6Script(`
    import http from 'k6/http';
    export default function () {
      const res = http.get('https://x.test/a');
      const body = res.json();
      const userId = body.users[0].id;
      const session = res.headers['X-Session'];
      const csrf = res.body.match(/csrf="(\\w+)"/)[1];
      http.get('https://x.test/u/' + userId + '?s=' + session + '&c=' + csrf);
      http.get(\`https://x.test/p/\${JSON.parse(res.body).profile.slug}\`);
    }
  `);
  const [first, second, third] = config.scenario.requests;
  assert.deepEqual(first.extractions, [
    { varName: 'userId', source: 'json', selector: 'users[0].id' },
    { varName: 'session', source: 'header', selector: 'X-Session' },
    { varName: 'csrf', source: 'regex', selector: 'csrf="(\\w+)"' },
    { varName: 'slug', source: 'json', selector: 'profile.slug' },
  ]);
  assert.equal(second.url, 'https://x.test/u/{{userId}}?s={{session}}&c={{csrf}}');
  assert.equal(third.url, 'https://x.test/p/{{slug}}');
});

test('an unresolvable URL keeps the request, as literal text, with a warning', () => {
  const { config, warnings } = importK6Script(`
    import http from 'k6/http';
    export default function () { http.get(buildUrl('/x')); }
  `);
  assert.equal(config.scenario.requests[0].url, '${buildUrl(\'/x\')}');
  assert.match(messages(warnings), /Could not convert URL/);
});

test('scripts written by the K6UI generator import back to the same flow', () => {
  const original = {
    variables: [{ key: 'baseUrl', value: 'https://example.test' }],
    load: { mode: 'stages', stages: [{ duration: '10s', target: '5' }, { duration: '5s', target: '0' }] },
    thresholds: { p95: '500', errorRate: '1' },
    options: { logRequests: true },
    scenario: {
      requests: [
        {
          type: 'http', method: 'POST', url: '{{baseUrl}}/login',
          headers: [{ key: 'Content-Type', value: 'application/json' }],
          body: '{"u":"a","t":"{{baseUrl}}"}', checkStatus: true, sleepAfter: 1,
          extractions: [
            { varName: 'token', source: 'json', selector: 'data.items[0].token' },
            { varName: 'sid', source: 'header', selector: 'X-Sid' },
            { varName: 'csrf', source: 'regex', selector: 'csrf="(\\w+)"' },
          ],
          assertions: [
            { type: 'status-eq', value: '200' }, { type: 'body-not-contains', value: 'err' },
            { type: 'body-matches', value: '/ok\\d+/i' }, { type: 'header-exists', value: 'X-A' },
            { type: 'header-eq', value: 'X-B', value2: 'v' }, { type: 'duration-lt', value: '800' },
            { type: 'status-2xx' }, { type: 'status-ne', value: '500' }, { type: 'status-lt', value: '300' },
          ],
        },
        {
          type: 'http', method: 'GET', url: '{{baseUrl}}/me/{{token}}?s={{sid}}&c={{csrf}}',
          headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }], checkStatus: false, sleepAfter: 0,
        },
      ],
    },
  };
  const { config, warnings } = importK6Script(generateScript(original));

  assert.deepEqual(warnings, []);
  assert.deepEqual(config.variables, original.variables);
  assert.deepEqual(config.load.stages, original.load.stages);
  assert.deepEqual(config.thresholds, original.thresholds);
  assert.equal(config.options.logRequests, true);

  const [login, me] = config.scenario.requests;
  const expected = original.scenario.requests;
  assert.equal(login.url, expected[0].url);
  assert.equal(login.body, expected[0].body);
  assert.equal(login.checkStatus, true);
  assert.equal(login.sleepAfter, '1');
  assert.deepEqual(login.extractions, expected[0].extractions);
  assert.deepEqual(login.assertions.map(({ type, value, value2 }) => ({ type, value, value2 })), [
    { type: 'status-eq', value: '200', value2: '' }, { type: 'body-not-contains', value: 'err', value2: '' },
    { type: 'body-matches', value: '/ok\\d+/i', value2: '' }, { type: 'header-exists', value: 'X-A', value2: '' },
    { type: 'header-eq', value: 'X-B', value2: 'v' }, { type: 'duration-lt', value: '800', value2: '' },
    { type: 'status-2xx', value: '', value2: '' }, { type: 'status-ne', value: '500', value2: '' },
    { type: 'status-lt', value: '300', value2: '' },
  ]);
  assert.equal(me.url, expected[1].url);
  assert.equal(me.checkStatus, false);
  assert.deepEqual(me.headers, expected[1].headers);

  // …and the regenerated script keeps the flow.
  const again = generateScript(config);
  assert.match(again, /GLOBALS\.baseUrl/);
  assert.match(again, /sleep\(1\)/);
});

test('rejects scripts that cannot be imported, with a readable reason', () => {
  assert.throws(() => importK6Script('  '), ScriptImportError);
  assert.throws(() => importK6Script('export default function ( {'), /not valid JavaScript at line 1/);
  assert.throws(() => importK6Script("import http from 'k6/http'; export const options = {};"), /No `export default function`/);
  assert.throws(
    () => importK6Script("import http from 'k6/http'; export default function () { for (;;) { http.get('x'); } }"),
    (err) => err instanceof ScriptImportError && /No HTTP requests/.test(err.message) && err.warnings.length > 0,
  );
});

test('never executes the script it imports', () => {
  globalThis.__k6ImportExecuted = false;
  importK6Script(`
    import http from 'k6/http';
    globalThis.__k6ImportExecuted = true;
    export default function () { globalThis.__k6ImportExecuted = true; http.get('https://x.test'); }
  `);
  assert.equal(globalThis.__k6ImportExecuted, false);
  delete globalThis.__k6ImportExecuted;
});

let server;
let baseUrl;

before(async () => {
  server = createServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

test('POST /api/import-script returns the configuration and warnings, or a 400 with the reason', async () => {
  const post = (script) => fetch(`${baseUrl}/api/import-script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script }),
  });

  const ok = await post("import http from 'k6/http'; export default function () { http.get('https://test.k6.io'); }");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.config.scenario.requests[0].url, 'https://test.k6.io');
  assert.ok(Array.isArray(body.warnings));

  const bad = await post('export default function ( {');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not valid JavaScript/);

  const missing = await fetch(`${baseUrl}/api/import-script`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(missing.status, 400);
});

test('per-vu-iterations scenarios import as the iterations load mode', () => {
  const script = (scenarios, extra = '') => `
    import http from 'k6/http';
    export const options = { ${extra} scenarios: ${scenarios} };
    export default function () { http.get('https://x.test/a'); }
  `;

  // What K6UI's generator writes comes back as the same load profile.
  const generated = importK6Script(generateScript({
    load: { mode: 'iterations', vus: '5', iterations: '2' },
    scenario: { requests: [{ method: 'GET', url: 'https://x.test/a', checkStatus: false }] },
  }));
  assert.deepEqual(generated.config.load, { mode: 'iterations', vus: '5', iterations: '2' });
  assert.deepEqual(generated.warnings, []);

  // A custom maxDuration is kept; k6's own defaults (1 VU, 1 iteration, 10m) apply when omitted.
  const handwritten = importK6Script(script(`{ checkout: { executor: 'per-vu-iterations', vus: 3, iterations: 4, maxDuration: '2h' } }`));
  assert.deepEqual(handwritten.config.load, { mode: 'iterations', vus: '3', iterations: '4', maxDuration: '2h' });
  assert.deepEqual(importK6Script(script(`{ a: { executor: 'per-vu-iterations' } }`)).config.load,
    { mode: 'iterations', vus: '1', iterations: '1', maxDuration: '10m' });

  // Anything else is skipped with a warning.
  const withExtras = importK6Script(script(`{ a: { executor: 'per-vu-iterations', vus: 2, startTime: '5s' } }`, 'vus: 9, duration: "1m",'));
  assert.deepEqual(withExtras.config.load, { mode: 'iterations', vus: '2', iterations: '1', maxDuration: '10m' });
  assert.match(messages(withExtras.warnings), /option startTime is not supported/);
  assert.match(messages(withExtras.warnings), /options\.vus, duration and stages are ignored when scenarios are set/);

  for (const [scenarios, warning] of [
    [`{ a: { executor: 'constant-vus', vus: 2, duration: '1m' } }`, /does not use the per-vu-iterations executor/],
    [`{ a: { executor: 'per-vu-iterations' }, b: { executor: 'per-vu-iterations' } }`, /more than one scenario/],
  ]) {
    const skipped = importK6Script(script(scenarios));
    assert.equal(skipped.config.load.mode, 'simple');
    assert.match(messages(skipped.warnings), warning);
  }
});

test('a K6UI script with data files imports without crashing: columns return as {{column}}, the data itself is a warning', () => {
  const script = generateScript({
    load: { mode: 'iterations', vus: '2', iterations: '1' },
    scenario: { requests: [{
      method: 'POST', url: 'https://api.test/{{email}}', body: '{"p":"{{password}}"}',
      headers: [{ key: 'X-User', value: '{{email}}' }], checkStatus: true, sleepAfter: '1',
    }] },
    dataSets: [{
      name: 'login.csv', fileName: 'login.csv', delimiter: ',', skipHeader: true,
      columns: ['email', 'password'], content: 'email,password\nuser1@example.com,pass1\n',
      share: 'next-row', onEnd: 'stop',
    }],
  });
  const { config, warnings } = importK6Script(script);
  const [request] = config.scenario.requests;
  assert.equal(request.url, 'https://api.test/{{email}}');
  assert.equal(request.body, '{"p":"{{password}}"}');
  assert.deepEqual(request.headers, [{ key: 'X-User', value: '{{email}}' }]);
  assert.equal(config.load.mode, 'iterations');
  assert.equal('dataSets' in config, false, 'the importer does not rebuild data files');

  const text = messages(warnings);
  assert.match(text, /import "k6\/data" was ignored; data read with SharedArray is not imported/);
  assert.match(text, /SharedArray DATA_1 \(a data file\) is not imported; add the CSV file under Data & Rules/);
  assert.doesNotMatch(text, /Could not convert/);
});

test('a hand-written SharedArray warns and does not crash', () => {
  const { warnings } = importK6Script(`
import http from 'k6/http';
import { SharedArray } from 'k6/data';
const users = new SharedArray('users', function () { return JSON.parse(open('./users.json')); });
export default function () {
  const user = users[0];
  http.get('https://api.test/users');
}`);
  assert.match(messages(warnings), /SharedArray users \(a data file\) is not imported/);
});
