import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { readStyles } from './helpers/styles.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const css = readStyles();
const exportRows = read('../public/js/components/export-rows.js');
const extractPanel = read('../public/js/components/request-editor/extract.js');
const reqCard = read('../public/js/components/req-card.js');
const config = read('../public/js/config.js');
const results = read('../public/js/export-results.js');
const runner = read('../public/js/runner.js');
const dataFiles = read('../public/js/data-files.js');
const store = read('../public/js/project-store.js');

const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');
const noMarkup = /innerHTML|insertAdjacentHTML|outerHTML|document\.write/;
const noMode = /uiMode|ui-mode|localStorage|sessionStorage|data-ui-only/;

test('the Extract tab has one "Save to CSV" section, built once in JS for Simple and Advanced', () => {
  assert.match(extractPanel, /exportsSection\.className = 'exports-section'/);
  assert.match(extractPanel, /textContent = 'Save to CSV'/);
  assert.match(extractPanel, /'add-row-btn add-export'/);
  for (const cls of ['export-block', 'export-file', 'export-skip-missing', 'export-column-row', 'export-col-name', 'export-col-value', 'export-add-column', 'export-remove']) {
    assert.match(exportRows, new RegExp(`['\` ]${cls}['\`]`), cls);
  }
  assert.doesNotMatch(html, /export-block|["\s]exports-list/, 'the markup has no second copy');
  for (const source of [exportRows, extractPanel]) {
    assert.doesNotMatch(stripComments(source), noMarkup);
    assert.doesNotMatch(stripComments(source), noMode);
  }
  assert.match(exportRows, /aria-label', label\)/);
  assert.match(exportRows, /skipBox\.checked = exp\.skipMissing === true/);
  assert.match(exportRows, /export function exportBlock\(exp = \{ skipMissing: true \}\)/, 'a new block starts with "only when found" on');
});

test('exports travel with the request: collected, validated before Run, lazy panel, duplicate, store', () => {
  assert.match(config, /exports: {5}readExportBlocks\(body\.querySelector\('\.exports-list'\)\)/);
  assert.match(config, /exportsProblem\(runnable\.map/);
  assert.match(reqCard, /for \(const exp of request\.exports \|\| \[\]\)/, 'lazy Extract panel from card.requestState');
  assert.match(reqCard, /snapshot\.exports = /);
  assert.match(reqCard, /for \(const exp of snapshot\.exports\)/);
  assert.match(store, /request\.exports = normalizeExports\(request\.exports\)/);
});

test('Run & Results: one "Saved to CSV" section with a warning, filled from `export` events, reset per run', () => {
  const section = html.match(/<section id="run-exports"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, 'section in the Overview tab');
  assert.ok(html.indexOf('id="tab-overview"') < html.indexOf('id="run-exports"'));
  assert.match(section, /\shidden>/);
  assert.doesNotMatch(section, /data-ui-only/, 'shown in both modes');
  assert.match(section, /role="note"/);
  assert.match(section, /tokens or other secrets/);
  assert.match(section, /not on the server/);
  assert.match(runner, /else if \(event === 'export'\) addExportRows\(data\);/);
  assert.match(runner, /resetErrors\(\);\n {2}resetExports\(\);/);
  const source = stripComments(results);
  assert.doesNotMatch(source, noMarkup);
  assert.doesNotMatch(source, noMode);
  assert.match(source, /name\.textContent = file/);
  assert.match(source, /link\.download = downloadName\(file\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.doesNotMatch(source, /fetch\(/, 'rows never go back to the server');
});

test('"Use as data file" fills the data file of that name (asking before replacing rows) or adds one', () => {
  assert.match(dataFiles, /export function useAsDataFile\(fileName, text\)/);
  assert.match(dataFiles, /dataSet\.fileName === fileName/);
  assert.match(dataFiles, /confirm\(`Replace the rows of the data file/);
  assert.match(dataFiles, /card\.dataSet\.skipHeader = true;/);
  assert.match(dataFiles, /MAX_DATA_SET_BYTES\) return \{ result: 'too-big'/);
});

test('the Simple notice counts requests that save to CSV, never the file name', () => {
  const summary = summarizeAdvancedSettings([
    { id: 'req_a', enabled: true, exports: [{ file: 'secret-orders.csv' }] },
    { id: 'req_b', enabled: true, exports: [{ file: '  ' }] },
  ], []);
  assert.deepEqual(summary.active, [{ id: 'exports', label: 'Save to CSV', count: 1, unit: 'request' }]);
  assert.doesNotMatch(JSON.stringify(summary), /secret-orders/);
});

test('styling covers the editor block and the results list, and wraps on narrow screens', () => {
  for (const selector of ['.exports-section', '.export-block', '.export-head', '.export-column-row', '.run-exports', '.run-exports-warning', '.run-export', '.run-export-actions']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.export-column-row \{ display: flex; flex-wrap: wrap;/);
  assert.match(css, /\.run-export \{\n {2}display: flex; flex-wrap: wrap;/);
});
