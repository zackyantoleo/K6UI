// Send once in the editor and the first-run screen (stage 8): the pure parts
// (public/js/send-once.js, public/js/templates.js) and the structure of the DOM
// modules. The browser check is scripts/verify-ui-mode-shell.mjs (stage 8 block).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MAX_VALUE_BUTTONS, bodyNote, formatBytes, resultSummary, responseJson, responseSize, selectorFor,
  unresolvedText, variableNameFor,
} from '../public/js/send-once.js';
import { LOGIN_TEMPLATE_VARIABLES, loginTemplateRequests, withLoginTemplate } from '../public/js/templates.js';
import { buildJsonAccessor, buildGjsonPath } from '../server/generator/helpers.js';
import { generateScript } from '../server/generator/index.js';
import { migrateProject, serializeProject } from '../public/js/project-store.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Every value of a JSON document with the parts of its path.
function* leaves(value, parts = []) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) yield* leaves(child, [...parts, key]);
  } else {
    yield { parts, value };
  }
}

test('a clicked value becomes the selector "Take a value from the response" reads', () => {
  assert.equal(selectorFor(['data', 'token']), 'data.token');
  assert.equal(selectorFor(['items', 0, 'id']), 'items[0].id');
  assert.equal(selectorFor([0, 'id']), '[0].id');
  assert.equal(selectorFor(['grid', 1, 2]), 'grid[1][2]');
  assert.equal(selectorFor(['user name', 'e-mail', '$ref', '名前']), 'user name.e-mail.$ref.名前');
  for (const parts of [[], ['a.b'], ['a[0]'], [''], [' padded'], ['x', -1], 'data']) assert.equal(selectorFor(parts), null, JSON.stringify(parts));
  assert.equal(selectorFor(['grid', 1, 2], { grpc: true }), null, 'gRPC: one [n] per key');
  assert.equal(selectorFor([0, 1], { grpc: true }), null);
  assert.equal(selectorFor(['items', 0, 'id'], { grpc: true }), 'items[0].id');

  // The selector reads back the same value: the JS accessor the generator writes for
  // gRPC, and the gjson path for HTTP (no escapes for these keys, so the same parts).
  const body = { data: { token: 'abc', items: [{ id: 7, ok: true }, { id: 8, note: null }] }, 'user name': { 'e-mail': 'a@x.test' }, $ref: 1, list: [[1, 2]] };
  for (const { parts, value } of leaves(body)) {
    const selector = selectorFor(parts);
    assert.ok(selector, parts.join('/'));
    // The gRPC accessor reads one [n] per key (grid[1][2] is HTTP only, as before).
    if (!selector.includes('][')) {
      const read = new Function('body', `return body${buildJsonAccessor(selector)};`);
      assert.deepEqual(read(body), value, selector);
    }
    assert.equal(buildGjsonPath(selector).replace(/\\/g, ''), parts.join('.'), selector);
  }
});

test('a taken value is named after its key, never twice in one request', () => {
  assert.equal(variableNameFor(['data', 'token']), 'token');
  assert.equal(variableNameFor(['items', 0, 'id']), 'id');
  assert.equal(variableNameFor(['e-mail address']), 'e_mail_address');
  assert.equal(variableNameFor(['2fa']), 'value_2fa');
  assert.equal(variableNameFor([0]), 'value');
  assert.equal(variableNameFor(['名前']), 'value');
  assert.equal(variableNameFor(['data', 'token'], new Set(['token', 'token_2'])), 'token_3');
  for (const parts of [['a-b'], ['9'], [3], ['$x']]) assert.match(variableNameFor(parts), /^[A-Za-z_]\w*$/);
});

test('the response: JSON or why not, size, status in plain words, {{names}} sent as typed', () => {
  assert.deepEqual(responseJson({ body: '{"a":[1]}' }), { json: { a: [1] } });
  assert.deepEqual(responseJson({ body: '  ' }), { reason: 'empty' });
  assert.deepEqual(responseJson({ body: '{"a":', truncated: true }), { reason: 'cut' });
  assert.deepEqual(responseJson({ body: '<html>' }), { reason: 'not-json' });
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(responseSize({ headers: { 'Content-Length': '3000' }, body: 'x' }), '2.9 KB');
  assert.equal(responseSize({ headers: {}, body: 'é' }), '2 B');
  assert.equal(responseSize({ headers: {}, body: 'xx', truncated: true, totalChars: 5000 }), '2 B shown of 5,000 characters');

  assert.deepEqual(resultSummary({ ok: true, response: { status: 201, durationMs: 12.34, headers: {}, body: '{}' } }),
    { status: '201', tone: 'ok', verdict: 'Counts as a success in a run.', facts: ['12.3 ms', '2 B'] });
  assert.equal(resultSummary({ ok: false, response: { status: 500, durationMs: 1, headers: {}, body: '' } }).tone, 'bad');
  assert.equal(resultSummary({ ok: false, error: 'refused', response: { status: 0, durationMs: 0, headers: {}, body: '' } }).status, 'No response');

  assert.equal(unresolvedText([]), '');
  assert.equal(unresolvedText(['token']), '{{token}} has no value before this request, so it was sent as typed. In a run, an earlier request or Test data gives the value.');
  assert.match(unresolvedText(['a', 'b', 'c']), /^\{\{a\}\}, \{\{b\}\} and \{\{c\}\} have no value .* they were sent/);
  assert.match(bodyNote('cut', { totalChars: 300000 }), /300,000 characters long/);
  assert.match(bodyNote('not-json'), /not JSON/);
  assert.equal(bodyNote(null), 'Click a value to take it for later requests.');
  assert.ok(MAX_VALUE_BUTTONS >= 1000);
});

test('the login template is an ordinary project: the token the first request takes is sent by the second', () => {
  const ids = ['req_a', 'req_b'];
  const project = withLoginTemplate({ variables: [{ key: 'base_url', value: 'https://staging.example.test' }], load: { mode: 'simple', vus: '1', duration: '30s' } }, ids);
  assert.deepEqual(project.variables.map(v => v.key), ['base_url', 'username', 'password']);
  assert.equal(project.variables[0].value, 'https://staging.example.test', 'a variable the page has keeps its value');
  assert.equal(LOGIN_TEMPLATE_VARIABLES[0].value, 'http://localhost:8080', 'local by default');
  assert.deepEqual(project.scenario.requests.map(r => [r.id, r.name, r.method]), [['req_a', 'Log in', 'POST'], ['req_b', 'Use the token', 'GET']]);
  assert.deepEqual(project.load, { mode: 'simple', vus: '1', duration: '30s' });

  // The existing schema: the store keeps every field as it is.
  const stored = JSON.parse(serializeProject(migrateProject(project)));
  assert.deepEqual(stored.scenario.requests[0].extractions, [{ varName: 'token', source: 'json', selector: 'token' }]);
  assert.deepEqual(stored.scenario.requests[1].headers, [{ key: 'Authorization', value: 'Bearer {{token}}' }]);
  assert.deepEqual(Object.keys(stored).sort(), Object.keys(JSON.parse(serializeProject(migrateProject({})))).sort(), 'no new top-level key');

  const script = generateScript(project);
  assert.match(script, /let token = res_main_0\.json\("token"\);/);
  assert.match(script, /"Authorization": `Bearer \$\{token\}`/);
  assert.match(script, /"username": "\$\{GLOBALS\.username\}"/);
  assert.equal(loginTemplateRequests(ids).length, 2);
});

test('Send once and the first-run screen render text only, one DOM in both modes, help beside labels', () => {
  for (const file of ['public/js/components/send-once.js', 'public/js/components/first-run.js', 'public/js/send-once.js', 'public/js/templates.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, `${file}: markup from data`);
    assert.doesNotMatch(source, /uiMode|data-ui-mode|data-ui-only/, `${file}: does not read the mode`);
  }
  const card = read('public/js/components/req-card.js');
  assert.match(card, /sendButton\.textContent = 'Send once';\s*send\.append\(sendButton, helpButton\('sendOnce'\)\);/);
  const html = read('public/index.html');
  const first = html.slice(html.indexOf('<section id="flow-empty-state"'), html.indexOf('</section>', html.indexOf('<section id="flow-empty-state"')));
  assert.doesNotMatch(first, /data-ui-only/, 'the same first-run screen in Simple and Advanced');
  assert.match(first, /<strong class="first-step-title">Choose how much traffic<\/strong><button data-help="smoke"><\/button>/);
  assert.match(read('public/js/app.js'), /initFirstRun\(\);[\s\S]*initSendOnce\(\);/);
  // Colours and sizes come from the tokens.
  const css = read('public/css/flow.css') + read('public/css/components.css');
  for (const block of css.matchAll(/(\.(?:so-|send-once|req-send|first-|flow-first)[^{]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(block[2], /#[0-9a-f]{3,8}\b|rgba?\(/i, `${block[1].trim()}: raw colour`);
  }
});
