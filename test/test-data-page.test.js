// UX stage 5: one Test data page (variables, shared headers, CSV data files),
// pass/fail goals inside Load & goals, a summary under each Simple step, "Used in"
// beside each global variable, and CSV files dropped onto the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadSummary, stepSummaries } from '../public/js/components/step-summary.js';
import { loadShape } from '../public/js/components/load-chart.js';
import { dataFileRejection } from '../public/js/data-files.js';
import { flowFromConfig, globalVariableName, variableUsage } from '../public/js/variables.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const nav = read('../public/js/nav.js');
const viewsCss = read('../public/css/views.css');
const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');
const section = id => html.match(new RegExp(`<section id="${id}" class="view hidden">[\\s\\S]*?\\n {8}</section>`))?.[0];

test('Test data is one page with three blocks; the separate views are gone', () => {
  const page = section('view-data');
  assert.ok(page, 'the Test data page');
  const blocks = [...page.matchAll(/<section class="view-block" id="([^"]+)" data-block="([^"]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(blocks, [
    ['data-block-vars', 'vars'], ['data-block-headers', 'headers'], ['data-block-datafiles', 'datafiles'],
  ]);
  for (const id of ['global-vars-list', 'add-global-var', 'global-headers-list', 'add-global-header', 'data-files-list']) {
    assert.equal(html.match(new RegExp(`id="${id}"`, 'g')).length, 1, `${id}: one DOM for both modes`);
    assert.ok(page.includes(`id="${id}"`), `${id} on the page`);
  }
  for (const gone of ['view-vars', 'view-headers', 'view-datafiles', 'view-sla', 'data-rule-card']) {
    assert.doesNotMatch(html, new RegExp(gone), gone);
  }
});

test('each Test data block folds in Simple only, and its toggle controls its body', () => {
  const page = section('view-data');
  const toggles = [...page.matchAll(/<button type="button" class="view-block-toggle" data-ui-only="simple" aria-expanded="true" aria-controls="([^"]+)">([^<]+)</g)];
  assert.deepEqual(toggles.map(m => m[2]), ['Variables', 'Shared headers', 'CSV data files']);
  for (const [, body] of toggles) assert.match(page, new RegExp(`class="view-block-body" id="${body}"`));
  // Advanced shows the title as text and never a folded body.
  assert.equal(page.match(/<span data-ui-only="advanced">/g).length, 3);
  assert.match(viewsCss, /html\[data-ui-mode="advanced"\] \.view-block-body\[hidden\] \{ display: flex; \}/);
});

test('pass/fail goals are a block of the Load & goals page (Thresholds / SLA in Advanced)', () => {
  const page = section('view-load');
  assert.ok(page);
  assert.match(page, /<div class="view-block" id="load-block-load" data-block="load">/);
  assert.match(page, /<section class="view-block" id="load-block-goals" data-block="sla" aria-labelledby="load-goals-title">/);
  for (const id of ['p95', 'errorRate', 'outcome-targets-list', 'add-outcome-target']) assert.ok(page.includes(`id="${id}"`), id);
  assert.ok(page.indexOf('load-block-load') < page.indexOf('load-block-goals'), 'goals after the load');
});

test('navigation: a category that is one block opens its page; Simple steps are renamed', () => {
  assert.match(nav, /PAGE_OF = \{ vars: 'data', headers: 'data', datafiles: 'data', sla: 'load' \}/);
  assert.match(nav, /data:\s+'Test data'/);
  assert.match(nav, /load:\s+'Load & goals'/);
  assert.match(nav, /sla:\s+'Thresholds \/ SLA'/);
  const simple = html.match(/<nav id="simple-nav"[\s\S]*?<\/nav>/)[0];
  const steps = [...simple.matchAll(/<strong>([\s\S]*?)<\/strong><small id="step-summary-(\w+)">/g)]
    .map(m => [m[2], m[1].replace(/<[^>]+>/g, '').trim()]);
  assert.deepEqual(steps, [
    ['flow', 'Build Flow'], ['data', 'Test data Optional'], ['load', 'Load &amp; goals'], ['results', 'Run &amp; Results'],
  ]);
  // Blocks are only hidden, never moved (one DOM).
  assert.doesNotMatch(stripComments(nav), /appendChild|append\(|insertBefore|replaceChildren|cloneNode|innerHTML/);
});

test('step summaries say what each step holds', () => {
  const base = { requests: 0, off: 0, groups: 0, variables: 0, headers: 0, dataFiles: 0, load: '', goals: 0, run: 'idle' };
  assert.deepEqual(stepSummaries(base), {
    flow: 'Add what a user does',
    data: 'Nothing added yet',
    load: 'Finish the load settings · no goals',
    results: 'Not run yet',
    vars: 'None yet', headersSum: 'None yet', files: 'None yet', goalsSum: 'None yet',
  });
  const full = stepSummaries({
    requests: 4, off: 1, groups: 1, variables: 2, headers: 1, dataFiles: 1,
    load: 'Smoke · 1 user · 30s', goals: 2, run: 'passed',
  });
  assert.equal(full.flow, '4 requests · 1 group · 1 off');
  assert.equal(full.data, '2 variables · 1 shared header · 1 CSV file');
  assert.equal(full.load, 'Smoke · 1 user · 30s · 2 goals');
  assert.equal(full.results, 'Last run passed');
  assert.equal(full.files, '1 file · one row per iteration');
  assert.equal(full.goalsSum, '2 goals');
  assert.equal(stepSummaries({ ...base, run: 'threshold-failed' }).results, 'Last run missed a goal');
  assert.equal(stepSummaries({ ...base, run: 'aborted' }).results, 'Last run was stopped');
});

test('the load part of the summary follows the load form', () => {
  const summary = (form, preset) => loadSummary(form, loadShape(form), preset);
  assert.equal(summary({ mode: 'simple', vus: '10', duration: '30s' }), '10 users · 30s');
  assert.equal(summary({ mode: 'stages', stages: [{ duration: '30s', target: '1' }] }, 'smoke'), 'Smoke · 1 user · 30s');
  assert.equal(summary({
    mode: 'stages', stages: [{ duration: '1m', target: '10' }, { duration: '3m', target: '10' }, { duration: '1m', target: '0' }],
  }, 'load'), 'Load · up to 10 users · 5m');
  assert.equal(summary({ mode: 'iterations', vus: '5', iterations: '2', maxDuration: '1h' }), '5 users × 2 runs');
  assert.equal(summary({ mode: 'simple', vus: '10', duration: 'soon' }), '', 'nothing to say yet');
  assert.equal(loadSummary({ mode: 'race' }, { mode: 'race', peak: 4 }), 'Race burst · 4 users');
  assert.equal(loadSummary({ mode: 'race' }, { mode: 'race', problem: 'x' }), '');
});

test('"Used in": how many requests that run send {{name}} of a global variable', () => {
  const config = {
    scenario: {
      groups: [{ id: 'g_off', name: 'Off', enabled: false }],
      requests: [
        { id: 'a', type: 'http', method: 'POST', url: '{{base}}/login', body: '{"u":"{{user}}","again":"{{base}}"}', enabled: true },
        { id: 'b', type: 'http', method: 'GET', url: 'https://x.test/b', enabled: true },
        { id: 'c', type: 'http', method: 'GET', url: '{{base}}/c', enabled: false },
        { id: 'd', type: 'http', method: 'GET', url: '{{base}}/d', groupId: 'g_off', enabled: true },
      ],
    },
    variables: [{ key: 'base', value: 'https://x.test' }, { key: 'token', value: 't' }, { key: 'user name', value: 'u' }],
    globalHeaders: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
  };
  const usage = variableUsage(flowFromConfig(config));
  assert.equal(usage.get('base'), 1, 'counted once per request; turned-off requests and groups do not count');
  assert.equal(usage.get('token'), 2, 'a shared header is sent with every request that runs');
  assert.equal(usage.get('user_name'), 0, 'the key as the generator reads it');
  assert.equal(globalVariableName(' user name '), 'user_name');
});

test('a dropped or chosen file must look like a CSV and fit the limit', () => {
  assert.equal(dataFileRejection({ name: 'users.csv', type: 'text/csv', size: 10 }), '');
  assert.equal(dataFileRejection({ name: 'users.csv', type: 'application/vnd.ms-excel', size: 10 }), '', 'Excel on Windows');
  assert.equal(dataFileRejection({ name: 'rows.tsv', type: '', size: 10 }), '');
  assert.equal(dataFileRejection({ name: 'notes', type: 'text/plain', size: 10 }), '');
  assert.match(dataFileRejection({ name: 'photo.png', type: 'image/png', size: 10 }), /"photo\.png" is not a CSV file/);
  assert.match(dataFileRejection({ name: 'big.csv', type: 'text/csv', size: 6 * 1024 * 1024 }), /"big\.csv" is 6\.0 MB; the limit is 5\.0 MB/);
});

test('data file cards: share and end of rows as sentences, the rest under File options', () => {
  const template = html.match(/<template id="data-file-template">[\s\S]*?<\/template>/)[0];
  assert.match(template, /<label>Each iteration gets\s*<select class="df-share">/);
  assert.match(template, /<label>When the rows run out,\s*<select class="df-end">/);
  const options = template.match(/<details class="df-options">[\s\S]*?<\/details>/)[0];
  for (const cls of ['df-delimiter', 'df-skip-header', 'df-trim', 'df-columns', 'df-group']) assert.match(options, new RegExp(cls), cls);
  assert.doesNotMatch(options, /df-share|df-end/);
  const source = stripComments(read('../public/js/data-files.js'));
  assert.match(source, /placeholder\.replaceWith\(helpButton\(placeholder\.dataset\.help\)\)/, 'the help button of a clone works');
  assert.match(source, /if \(set\.content && !confirm\(`Replace the rows of/, 'a drop on a card asks before replacing rows');
  assert.match(source, /event\.dataTransfer\.dropEffect = 'none'/, 'a file dropped elsewhere does not open in the tab');
});
