// {{variables}}: the panel catalog, the {{ suggestions and the warnings on the
// request cards (public/js/variables.js). The parity test checks the warnings
// against the generator: a name is flagged exactly when the script sends it as text.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeIssue, flowFromConfig, placeholderNames, scriptAssignments, spacedPlaceholders,
  variableCatalog, variableIssues, variableSuggestions,
} from '../public/js/variables.js';
import { generateScript } from '../server/generator/index.js';

const LABEL_RULES = { rules: [{ label: 'ok', status: '200', source: 'none', operator: 'equals', value: '' }], fallback: 'other' };

const request = (id, fields = {}) => ({
  id, name: id, type: 'http', method: 'GET', url: `https://api.test/${id}`, enabled: true, ...fields,
});

function project(requests, extra = {}) {
  return {
    scenario: { groups: extra.groups || [], requests },
    variables: extra.variables || [{ key: 'base', value: 'https://api.test' }],
    dataSets: extra.dataSets || [],
    globalHeaders: extra.globalHeaders || [],
    load: { mode: 'simple', vus: '1', duration: '5s' },
    thresholds: { p95: '', errorRate: '' },
  };
}

const issuesOf = config => variableIssues(flowFromConfig(config));
const kinds = (issues, id) => (issues.get(id) || []).map(issue => [issue.raw, issue.kind]);

// {{name}}s the generated script still holds as text (comment lines repeat the URL as typed).
function literalNames(script) {
  const code = script.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  return new Set([...code.matchAll(/\{\{(\$?\w+)\}\}/g)].map(match => match[1]));
}

test('placeholders, spaced placeholders and script assignments are read like the generator', () => {
  assert.deepEqual(placeholderNames('{{base}}/u/{{id}}?x={{id}}&o={{$outcome}}&{{ bad }}&{{}}'), ['base', 'id', '$outcome']);
  assert.deepEqual(spacedPlaceholders('{{ token }} {{id }} {{ok}}'), [
    { raw: '{{ token }}', name: 'token' }, { raw: '{{id }}', name: 'id' },
  ]);
  assert.deepEqual(scriptAssignments('vars.a = 1; vars.b += 2; if (vars.c === 1) {} vars.d++; vars.e ??= 3'), ['a', 'b', 'd', 'e']);
});

test('a value from a response is known from the next request on, and in its own Save to CSV', () => {
  const config = project([
    request('req_early', { url: '{{base}}/orders/{{order_id}}' }),
    request('req_create', {
      method: 'POST', body: '{"name":"{{order_id}}"}',
      extractions: [{ varName: 'order_id', source: 'json', selector: 'id' }],
      exports: [{ file: 'orders.csv', columns: [{ name: 'id', value: '{{order_id}}' }] }],
    }),
    request('req_pay', { url: '{{base}}/pay/{{order_id}}' }),
  ]);
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_early'), [['{{order_id}}', 'later']]);
  assert.deepEqual(kinds(issues, 'req_create'), [['{{order_id}}', 'later']], 'its own body cannot use it');
  assert.equal(issues.get('req_create')[0].source.self, true);
  assert.deepEqual(issues.get('req_create')[0].places, ['the body'], 'Save to CSV of the same request can');
  assert.equal(issues.has('req_pay'), false);
  const early = describeIssue(issues.get('req_early')[0]);
  assert.equal(early.text, '{{order_id}} not available yet');
  assert.match(early.detail, /^Request #2 \(req_create\) gives \{\{order_id\}\}, but it runs after this one\. Move this request below it/);
  assert.match(early.detail, /Used in the URL\.$/);
});

test('requests that do not run neither give values nor get warnings', () => {
  const config = project([
    request('req_off', { enabled: false, url: '{{nothing_here}}', extractions: [{ varName: 'token', source: 'json', selector: 't' }] }),
    request('req_grouped', { groupId: 'grp_off', extractions: [{ varName: 'cart', source: 'json', selector: 'c' }] }),
    request('req_blank', { url: '', extractions: [{ varName: 'session', source: 'header', selector: 'X-S' }] }),
    request('req_use', { headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }, { key: 'X-Cart', value: '{{cart}}' }, { key: 'X-S', value: '{{session}}' }] }),
  ], { groups: [{ id: 'grp_off', name: 'Cart', enabled: false, headers: [] }] });
  const issues = issuesOf(config);
  assert.deepEqual([...issues.keys()], ['req_use']);
  const [token, cart, session] = issues.get('req_use');
  assert.deepEqual([token.kind, cart.kind, session.kind], ['off', 'off', 'off']);
  assert.match(describeIssue(token).detail, /^Only request #1 \(req_off\) gives \{\{token\}\}, and it is turned off\./);
  assert.match(describeIssue(cart).detail, /and its group is turned off\./);
  assert.match(describeIssue(session).detail, /and it has no URL\./);
  assert.equal(describeIssue(token).text, '{{token}} not available');
  assert.deepEqual(token.places, ['the header Authorization']);
});

test('global variables and used data file columns are known everywhere; unknown names are named', () => {
  const config = project([
    request('req_a', {
      url: '{{base}}/login?u={{email}}&t={{tenant}}&x={{emial}}&s={{secret}}&o={{$nope}}',
    }),
  ], {
    variables: [{ key: 'base', value: 'x' }, { key: 'not valid', value: 'y' }, { key: '9bad', value: 'z' }],
    groups: [{ id: 'grp_off', name: 'Off', enabled: false, headers: [] }],
    dataSets: [
      { id: 'ds_u', name: 'Users', fileName: 'users.csv', skipHeader: true, columns: [], content: 'email,tenant\na@x,t1\n' },
      { id: 'ds_s', name: 'Secrets', fileName: 's.csv', skipHeader: true, columns: [], content: 'secret\ns1\n', groupId: 'grp_off' },
      { id: 'ds_e', name: 'Empty', fileName: 'e.csv', skipHeader: true, columns: ['unused_col'], content: '' },
    ],
  });
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_a'), [['{{emial}}', 'unknown'], ['{{secret}}', 'off'], ['{{$nope}}', 'unknown']]);
  const [typo, secret, dollar] = issues.get('req_a');
  assert.match(describeIssue(typo).detail, /Check the spelling\./);
  assert.equal(describeIssue(typo).text, '{{emial}} is not defined');
  assert.match(describeIssue(secret).detail, /^Only the data file Secrets gives \{\{secret\}\}, and its group is turned off\./);
  assert.match(describeIssue(dollar).detail, /one built-in variable, \{\{\$outcome\}\}/);

  const catalog = variableCatalog(flowFromConfig(config));
  assert.deepEqual(catalog.globals, ['base', 'not_valid'], 'spaces become _ as on Run; an invalid name is left out');
  assert.deepEqual(catalog.files, [{ label: 'Users', groupName: '', columns: ['email', 'tenant'] }],
    'files the script does not read are left out');
});

test('a data file with no rows says so', () => {
  const issues = issuesOf(project([request('req_a', { url: '{{base}}/{{unused_col}}' })], {
    dataSets: [{ id: 'ds_e', name: 'Empty', fileName: 'e.csv', skipHeader: true, columns: ['unused_col'], content: '' }],
  }));
  assert.match(describeIssue(issues.get('req_a')[0]).detail, /^Only the data file Empty gives \{\{unused_col\}\}, and it has no rows yet\./);
});

test('script variables: a pre-processor serves its own request, a post-processor the next one', () => {
  const config = project([
    request('req_a', { url: '{{base}}/{{signed}}/{{after_a}}', preScript: 'vars.signed = "x";', postScript: 'vars.after_a = 1;' }),
    request('req_b', { url: '{{base}}/{{after_a}}' }),
  ]);
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_a'), [['{{after_a}}', 'later']]);
  assert.equal(issues.get('req_a')[0].source.self, true);
  assert.equal(issues.has('req_b'), false);
  const catalog = variableCatalog(flowFromConfig(config));
  assert.deepEqual(catalog.scripts.map(item => [item.name, item.number, item.when]), [['signed', 1, 'from'], ['after_a', 1, 'after']]);
});

test('{{$outcome}} is known after the first request with outcome rules', () => {
  const config = project([
    request('req_a', { url: '{{base}}/a?o={{$outcome}}', outcomes: LABEL_RULES }),
    request('req_b', {
      url: '{{base}}/b?o={{$outcome}}',
      exports: [{ file: 'b.csv', columns: [{ name: 'o', value: '{{$outcome}}' }] }],
    }),
    request('req_grpc', { type: 'grpc', url: 'localhost:50051', grpcMethod: 'svc.S/M', body: '{"o":"{{$outcome}}"}' }),
  ]);
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_a'), [['{{$outcome}}', 'later']]);
  assert.equal(issues.has('req_b'), false);
  assert.equal(issues.has('req_grpc'), false);
  const catalog = variableCatalog(flowFromConfig(config));
  assert.deepEqual(catalog.builtIn, [{ name: '$outcome', number: 1, label: 'req_a' }]);

  const noRules = issuesOf(project([request('req_a', { url: '{{base}}/{{$outcome}}' })]));
  assert.deepEqual(kinds(noRules, 'req_a'), [['{{$outcome}}', 'unknown']]);
});

test('headers are merged global → group → request before they are checked', () => {
  const config = project([
    request('req_login', { extractions: [{ varName: 'token', source: 'json', selector: 't' }] }),
    request('req_own', { groupId: 'grp_a', headers: [{ key: 'authorization', value: 'Bearer fixed' }] }),
    request('req_group', { groupId: 'grp_a' }),
  ], {
    groups: [{ id: 'grp_a', name: 'A', enabled: true, headers: [{ key: 'X-Tenant', value: '{{tenant_id}}' }] }],
    globalHeaders: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
  });
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_login'), [['{{token}}', 'later']], 'the login request sends the global header before it has the token');
  assert.deepEqual(issues.get('req_login')[0].places, ['the global header Authorization']);
  assert.deepEqual(kinds(issues, 'req_own'), [['{{tenant_id}}', 'unknown']], 'its own Authorization wins over the global one');
  assert.deepEqual(issues.get('req_own')[0].places, ['the group header X-Tenant']);
});

test('a GET body is not sent, so it is not checked; spaces inside braces are named', () => {
  const issues = issuesOf(project([
    request('req_get', { body: '{{nowhere}}' }),
    request('req_post', { method: 'POST', body: '{"t":"{{ base }}","u":"{{base}}"}' }),
  ]));
  assert.equal(issues.has('req_get'), false);
  assert.deepEqual(kinds(issues, 'req_post'), [['{{ base }}', 'spaces']]);
  assert.deepEqual(describeIssue(issues.get('req_post')[0]), {
    text: '{{ base }} has spaces',
    detail: 'Write it without spaces, as {{base}}: with spaces it is sent as plain text. Used in the body.',
  });
});

test('suggestions: what the request can use first, then what a later request gives', () => {
  const config = project([
    request('req_a', { url: '' }),
    request('req_login', { extractions: [{ varName: 'token', source: 'json', selector: 't' }], outcomes: LABEL_RULES }),
    request('req_b'),
  ], {
    dataSets: [{ id: 'ds_u', name: 'Users', fileName: 'users.csv', skipHeader: true, columns: [], content: 'email\na@x\n' }],
  });
  const flow = flowFromConfig(config);
  const at = (requestId, options = {}) => variableSuggestions(flow, { requestId, ...options })
    .map(item => [item.name, item.available]);
  assert.deepEqual(at('req_a'), [['base', true], ['email', true], ['token', false], ['$outcome', false]],
    'a request without a URL yet is typed at its place in the flow');
  assert.deepEqual(at('req_b'), [['base', true], ['email', true], ['token', true], ['$outcome', true]]);
  assert.deepEqual(at('req_login'), [['base', true], ['email', true], ['token', false], ['$outcome', false]]);
  assert.deepEqual(at('req_login', { after: true }).map(([, available]) => available), [true, true, true, true]);
  assert.deepEqual(at('req_b', { prefix: 'T' }), [['token', true], ['$outcome', true]], 'starts with the text first, then contains it');
  assert.deepEqual(at('req_b', { prefix: '$' }), [['$outcome', true]]);
  assert.deepEqual(at('', { prefix: 'e' }), [['email', null], ['base', null], ['token', null], ['$outcome', null]],
    'a shared header: names that start with the text first, no availability');
  const [first] = variableSuggestions(flow, { requestId: 'req_b' });
  assert.deepEqual(first, { name: 'base', source: 'global', detail: 'Global variable', available: true });
  assert.equal(variableSuggestions(flow, { requestId: 'req_b', prefix: 'tok' })[0].detail, 'From #2 req_login');
});

test('parity with the generator: flagged exactly when the script sends {{name}} as text', () => {
  const config = project([
    request('req_1', {
      url: '{{base}}/one/{{late_id}}/{{own_id}}/{{pre_v}}/{{post_v}}/{{$outcome}}/{{typo_1}}/{{email}}',
      preScript: 'vars.pre_v = "p";',
      postScript: 'vars.post_v = "q";',
      extractions: [{ varName: 'own_id', source: 'json', selector: 'id' }],
      outcomes: LABEL_RULES,
      exports: [{ file: 'one.csv', columns: [{ name: 'a', value: '{{own_id}}' }, { name: 'b', value: '{{after_only}}' }] }],
    }),
    request('req_off', { enabled: false, extractions: [{ varName: 'off_v', source: 'json', selector: 'x' }] }),
    request('req_2', {
      method: 'POST',
      url: '{{base}}/two/{{post_v}}/{{$outcome}}/{{off_v}}/{{secret}}',
      body: '{"own":"{{own_id}}","late":"{{late_id}}"}',
      headers: [{ key: 'X-Unknown', value: '{{typo_2}}' }],
      extractions: [{ varName: 'late_id', source: 'json', selector: 'id' }],
    }),
    request('req_3', {
      url: '{{base}}/three/{{late_id}}/{{after_only}}',
      extractions: [{ varName: 'after_only', source: 'header', selector: 'X-A' }],
    }),
  ], {
    groups: [{ id: 'grp_off', name: 'Off', enabled: false, headers: [] }],
    dataSets: [
      { id: 'ds_u', name: 'Users', fileName: 'users.csv', skipHeader: true, columns: [], content: 'email\na@x\n' },
      { id: 'ds_s', name: 'Secrets', fileName: 's.csv', skipHeader: true, columns: [], content: 'secret\ns1\n', groupId: 'grp_off' },
    ],
  });
  const literal = literalNames(generateScript(config));
  const flagged = new Set([...issuesOf(config).values()].flat().map(issue => issue.name));
  assert.deepEqual([...flagged].sort(), [...literal].sort());
  assert.deepEqual([...flagged].sort(), ['$outcome', 'after_only', 'late_id', 'off_v', 'own_id', 'post_v', 'secret', 'typo_1', 'typo_2'].sort());
  // Each name above is flagged in one place only, except where it is used twice.
  const issues = issuesOf(config);
  assert.deepEqual(kinds(issues, 'req_1').map(([raw]) => raw),
    ['{{late_id}}', '{{own_id}}', '{{post_v}}', '{{$outcome}}', '{{typo_1}}', '{{after_only}}']);
  assert.deepEqual(kinds(issues, 'req_2'), [['{{off_v}}', 'off'], ['{{secret}}', 'off'], ['{{typo_2}}', 'unknown'], ['{{late_id}}', 'later']]);
  assert.deepEqual(kinds(issues, 'req_3'), [['{{after_only}}', 'later']]);
});
