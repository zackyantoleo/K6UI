// The "?" help buttons and the Glossary panel: every key used in the markup or
// in a JS-built panel has an entry, entries are plain text, and search works.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GLOSSARY, GLOSSARY_SECTIONS, glossaryEntry, glossarySection, searchGlossary,
} from '../public/js/glossary.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const jsFiles = dir => fs.readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? jsFiles(`${dir}/${entry.name}`)
    : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []);

test('every help key in index.html and in JS-built panels has a glossary entry', () => {
  const html = read('public/index.html');
  const fromHtml = [...html.matchAll(/data-help="([^"]+)"/g)].map(match => match[1]);
  const fromJs = jsFiles('public/js').flatMap(file => [...read(file).matchAll(/helpButton\('([^']+)'\)/g)].map(match => match[1]));
  assert.ok(fromHtml.length >= 15, 'the main fields have help buttons');
  assert.ok(fromJs.length >= 8, 'the request editor and groups have help buttons');
  for (const key of [...fromHtml, ...fromJs]) assert.ok(glossaryEntry(key), `no glossary entry for "${key}"`);
});

test('help buttons sit beside labels, never inside a <label>, so field names stay as they are', () => {
  const html = read('public/index.html');
  for (const label of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    // A radio card's radio is named by aria-labelledby (below), so its help button is allowed.
    if (/aria-labelledby=/.test(label[1])) continue;
    assert.doesNotMatch(label[1], /data-help=/, `help button inside a label: ${label[0].slice(0, 80)}`);
  }
  // A radio card is one big label: its radio is named by the title only.
  for (const value of ['simple', 'stages', 'iterations', 'race']) {
    assert.match(html, new RegExp(`value="${value}"[^>]*aria-labelledby="load-mode-${value}-name"`));
  }
});

test('glossary entries are complete plain text in known sections', () => {
  const sections = new Set(GLOSSARY_SECTIONS.map(section => section.id));
  for (const [key, item] of Object.entries(GLOSSARY)) {
    assert.match(key, /^[a-z][A-Za-z0-9]*$/);
    assert.ok(sections.has(item.section), `${key}: unknown section ${item.section}`);
    assert.ok(item.term.trim() && item.text.trim().length > 30, `${key}: term and a real explanation`);
    assert.doesNotMatch(item.text, /<[a-z]/i, `${key}: text only, no markup`);
    assert.match(item.text, /[.!?)]$/, `${key}: ends as a sentence`);
  }
  const listed = GLOSSARY_SECTIONS.flatMap(section => glossarySection(section.id).map(item => item.key));
  assert.deepEqual(listed.sort(), Object.keys(GLOSSARY).sort(), 'every entry appears in exactly one section');
  assert.equal(glossaryEntry('toString'), null, 'only own keys');
  assert.equal(glossaryEntry('nope'), null);
});

test('glossary search matches every word in the term or the text, ignoring case', () => {
  assert.deepEqual(searchGlossary('').length, Object.keys(GLOSSARY).length);
  assert.ok(searchGlossary('P95').some(item => item.key === 'p95'));
  assert.ok(searchGlossary('virtual user').some(item => item.key === 'vu'));
  assert.deepEqual(searchGlossary('zzzz no such term'), []);
});

test('Import is one menu: a cURL command or a k6 script / JMeter plan', () => {
  const html = read('public/index.html');
  const menu = html.match(/<div class="menu" id="import-menu"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(html, /id="import-menu-btn"[^>]*aria-controls="import-menu"/);
  assert.match(menu, /role="menu"/);
  assert.match(menu, /id="import-curl-btn"/);
  assert.match(menu, /id="import-k6-btn"/);
  assert.equal([...menu.matchAll(/role="menuitem"/g)].length, 2);
});

test('a fresh page starts in Simple, with the matching nav visible', () => {
  const html = read('public/index.html');
  assert.match(html, /<html lang="en" data-ui-mode="simple">/);
  assert.match(html, /name="ui-mode" value="simple" checked/);
  assert.match(html, /<nav id="simple-nav"(?![^>]*hidden)[^>]*>/);
  assert.match(html, /<nav id="advanced-nav"[^>]*hidden/);
});
