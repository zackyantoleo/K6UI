import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readExtractionRow } from '../public/js/components/rows.js';
import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { readStyles } from './helpers/styles.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const css = readStyles();
const rows = read('../public/js/components/rows.js');
const reqCard = read('../public/js/components/req-card.js');
const config = read('../public/js/config.js');
const projectIo = read('../public/js/project-io.js');
const store = read('../public/js/project-store.js');

const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');
const extractionRowSource = stripComments(rows.slice(rows.indexOf('export function extractionRow'), rows.indexOf('export function readExtractionRow')));

// A stand-in for a row: only what readExtractionRow() asks for.
const fakeRow = values => ({ querySelector: selector => (selector in values ? { value: values[selector] } : null) });

test('an extraction row has one "Default" input, built once in JS for Simple and Advanced', () => {
  for (const cls of ['ext-name', 'ext-source', 'ext-selector', 'ext-default']) {
    assert.match(extractionRowSource, new RegExp(`'${cls}'`), cls);
  }
  assert.match(extractionRowSource, /Default value when nothing matches/, 'the input has an accessible name');
  assert.doesNotMatch(html, /ext-default/, 'the markup has no second copy');
  assert.doesNotMatch(extractionRowSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, 'values are DOM properties, never markup');
  assert.match(extractionRowSource, /fallback\.value = /);
  assert.doesNotMatch(stripComments(rows), /uiMode|ui-mode|localStorage|sessionStorage|data-ui-only/, 'the mode is never stored or read here');
});

test('a row is read with its default as typed; an empty default is left out', () => {
  const values = { '.ext-name': ' my token ', '.ext-source': 'json', '.ext-selector': ' data.token ', '.ext-default': ' NOT FOUND ' };
  assert.deepEqual(readExtractionRow(fakeRow(values)), { varName: 'my_token', source: 'json', selector: 'data.token', default: ' NOT FOUND ' });
  assert.deepEqual(readExtractionRow(fakeRow({ ...values, '.ext-default': '' })), { varName: 'my_token', source: 'json', selector: 'data.token' });
  const { '.ext-default': _omit, ...older } = values;
  assert.deepEqual(readExtractionRow(fakeRow(older)), { varName: 'my_token', source: 'json', selector: 'data.token' }, 'a row without the input still reads');
});

test('the default travels everywhere a row is built or read: collect, open, lazy panels, duplicate', () => {
  assert.match(config, /\.map\(readExtractionRow\)/);
  assert.match(reqCard, /list\.appendChild\(extractionRow\(extraction\)\)/, 'lazy Extract panel from card.requestState');
  assert.match(reqCard, /default: row\.querySelector\('\.ext-default'\)\.value/, 'duplicate copies the default');
  assert.doesNotMatch(reqCard, /for \(const \[name, source, selector\] of snapshot\.extractions\)/, 'no positional snapshot that would drop it');
  assert.match(store, /function normalizeExtractions/);
  assert.match(store, /request\.extractions = normalizeExtractions\(request\.extractions\)/);
});

test('the Simple notice counts a request with defaults as "Response extraction", never the value', () => {
  const summary = summarizeAdvancedSettings([
    { id: 'req_a', enabled: true, extractions: [{ varName: 'token', source: 'json', selector: 't', default: 'SECRET_FALLBACK' }] },
  ], []);
  assert.deepEqual(summary.active, [{ id: 'extractions', label: 'Response extraction', count: 1, unit: 'request' }]);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_FALLBACK/);
});

test('styling: the default input has a width and wraps on narrow rows', () => {
  assert.match(css, /\.extraction-row \{ display: flex; flex-wrap: wrap;/);
  assert.match(css, /\.extraction-row \.ext-default \{ flex: 0 1 180px; min-width: 110px; \}/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.extraction-row \.ext-default \{ flex: 1 1 200px; \}/);
});
