import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { describeDataSet, guessDelimiter, parseColumnNames, validateDataSets } from '../public/js/data-files.js';
import { readStyles } from './helpers/styles.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const css = readStyles();
const dataFiles = read('../public/js/data-files.js');
const config = read('../public/js/config.js');
const projectIo = read('../public/js/project-io.js');
const app = read('../public/js/app.js');
const nav = read('../public/js/nav.js');
const notice = read('../public/js/components/advanced-notice.js');

const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');

test('Data files is one view reached from Simple step 2 and from an Advanced category', () => {
  assert.match(html, /<section id="view-datafiles" class="view hidden">/);
  const simple = html.match(/<section id="view-data"[\s\S]*?<\/section>/)[0];
  assert.match(simple, /class="data-rule-card" data-view="datafiles"/);
  const advanced = html.match(/<nav[^>]*id="advanced-nav"[^>]*>([\s\S]*?)<\/nav>/)[1];
  assert.match(advanced, /data-view="datafiles">Data files</);
  assert.equal(html.match(/id="view-datafiles"/g).length, 1, 'one DOM for both modes');
  assert.match(nav, /datafiles:\s*'data'/, 'Simple shows it under step 2');
  assert.match(nav, /datafiles:\s*'Data files'/);
});

test('the panel warns that the rows are saved in the project and in the script', () => {
  const view = html.match(/<section id="view-datafiles"[\s\S]*?<\/section>/)[0];
  assert.match(view, /class="data-files-warning" role="note"/);
  assert.match(view, /saved inside the project file and written into the generated script/);
  assert.match(view, /passwords or tokens/);
  assert.match(view, /id="add-data-file"/);
  assert.match(view, /id="data-files-list"/);
});

test('each data file card offers file or pasted text, delimiter, header, columns, share mode, end of file, and a preview', () => {
  const template = html.match(/<template id="data-file-template">[\s\S]*?<\/template>/)[0];
  for (const cls of [
    'df-name', 'df-remove', 'df-pick', 'df-file', 'df-paste-text', 'df-paste-apply', 'df-delimiter',
    'df-skip-header', 'df-trim', 'df-columns', 'df-share', 'df-end', 'df-status', 'df-preview',
  ]) {
    assert.match(template, new RegExp(`class="[^"]*\\b${cls}\\b`), cls);
  }
  assert.match(template, /accept="\.csv,/);
  assert.match(template, /<option value="next-row">/);
  assert.match(template, /<option value="per-vu">/);
  assert.match(template, /<option value="recycle">/);
  assert.match(template, /<option value="stop">/);
  assert.match(template, /aria-label="Remove data file"/);
  assert.doesNotMatch(template.replace(/^<template id="[^"]*">/, ''), /\sid="/, 'cards repeat, so the template carries no ids');
  assert.equal(template.split('<label').length - 1, template.split('</label>').length - 1);
});

test('the panel renders file content with textContent only and never stores the UI mode', () => {
  const source = stripComments(dataFiles);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /new FileReader\(\)/);
  assert.match(source, /readAsText/);
  assert.doesNotMatch(source, /uiMode|ui-mode|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /data-ui-only/);
});

test('data files travel with the project: collected, validated, restored, and initialized', () => {
  assert.match(config, /dataSets:\s*collectDataSets\(\)/);
  assert.match(config, /validateDataSets\(config\.dataSets\)/);
  assert.match(projectIo, /restoreDataSets\(cfg\.dataSets \|\| \[\]\)/);
  assert.match(app, /initDataFiles\(\)/);
});

test('the Simple notice counts data files and still ignores their content', () => {
  assert.match(stripComments(notice), /usableDataFileCount/);
  assert.match(notice, /k6ui:data-sets-changed/);
  assert.deepEqual(summarizeAdvancedSettings([], []), { active: [], skipped: { requests: 0, groups: 0 }, visible: false });
  const summary = summarizeAdvancedSettings([], [], 2);
  assert.deepEqual(summary.active, [{ id: 'dataFiles', label: 'Data files', count: 2, unit: 'file' }]);
  assert.equal(summary.visible, true);
});

test('styling covers the cards, preview, warning, and error text', () => {
  for (const selector of ['.data-files-warning', '.data-file-card', '.df-preview', '.df-status.df-error', '.data-file-options']) {
    assert.ok(css.includes(selector), selector);
  }
});

// ── Pure helpers ──────────────────────────────────────────────

test('column names are read from a comma list; blanks keep their position, trailing blanks go', () => {
  assert.deepEqual(parseColumnNames('email, password'), ['email', 'password']);
  assert.deepEqual(parseColumnNames('first name,, last_name ,'), ['first_name', '', 'last_name']);
  assert.deepEqual(parseColumnNames(''), []);
});

test('the delimiter is guessed from the first line', () => {
  assert.equal(guessDelimiter('email,password\na,b'), ',');
  assert.equal(guessDelimiter('email;password\na;b'), ';');
  assert.equal(guessDelimiter('email\tpassword\na\tb'), '\t');
  assert.equal(guessDelimiter('email|password'), '|');
  assert.equal(guessDelimiter('single'), ',');
  assert.equal(guessDelimiter('﻿a;b'), ';');
});

test('a data file is described by its rows, used columns, and ignored names', () => {
  const info = describeDataSet({
    content: 'email,password,note\nuser1@example.com,pass1,x\nuser2@example.com,pass2,y\n',
    delimiter: ',', skipHeader: true, columns: ['email', 'password', '9bad'],
  });
  assert.equal(info.error, '');
  assert.equal(info.rows.length, 2);
  assert.deepEqual(info.columns.map(c => c.name), ['email', 'password']);
  assert.deepEqual(info.ignored, ['9bad']);
  assert.match(describeDataSet({ content: '"open', delimiter: ',' }).error, /never closed/);
  assert.match(describeDataSet({ content: 'a', delimiter: 'xx' }).error, /single character/);
});

test('validation blocks Run and View Script only for files that cannot be used', () => {
  const ok = { name: 'login', content: 'email\nuser1@example.com\n', skipHeader: true, columns: ['email'] };
  assert.equal(validateDataSets([]), null);
  assert.equal(validateDataSets(undefined), null);
  assert.equal(validateDataSets([ok]), null);
  assert.equal(validateDataSets([{ name: 'empty', content: '' }]), null, 'a file with no content is simply ignored');
  assert.match(validateDataSets([{ ...ok, content: 'email\n"oops' }]), /Data file "login": A quoted value that starts on line 2 is never closed/);
  assert.match(validateDataSets([{ ...ok, columns: ['1bad'] }]), /Data file "login": name its columns/);
  assert.match(validateDataSets([{ ...ok, content: `email\n${'x'.repeat(5 * 1024 * 1024)}` }]), /Data file "login" is 5\.1 MB; the limit is 5\.0 MB per file/);
  const nearLimit = { ...ok, content: `email\n${'x'.repeat(4.9 * 1024 * 1024)}` };
  assert.match(validateDataSets([nearLimit, nearLimit, nearLimit]), /The data files add up to 14\.\d MB; the limit is 10\.0 MB in total/);
});
