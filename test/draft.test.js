// The browser draft (public/js/draft.js): the pure storage helpers and the
// structure of the wiring. The browser check is scripts/verify-ui-mode-shell.mjs
// (refresh restores the project, New clears it) and A7 in verify-ui-modes.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runnerSource } from './helpers/runner-source.js';

import {
  DRAFT_KEY, DRAFT_VERSION, clearDraft, draftStatus, leaveLosesWork, readDraft, writeDraft,
} from '../public/js/draft.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: key => { items.delete(key); },
  };
}

function withBlockedLocalStorage(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked getter'); } });
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

const project = {
  scenario: { groups: [], requests: [{ id: 'req_a', url: 'https://api.example.test/{{id}}', headers: [{ key: 'Authorization', value: 'Bearer secret' }] }] },
  variables: [{ key: 'id', value: '42' }],
};

test('a draft round-trips under one key, with its version, time and view', () => {
  const storage = memoryStorage();
  assert.equal(writeDraft({ project, ui: { view: 'load', goal: 'smoke' }, savedAt: 1234 }, storage), true);
  assert.deepEqual([...storage.items.keys()], [DRAFT_KEY]);
  assert.equal(DRAFT_KEY, 'k6ui.draft');
  const stored = JSON.parse(storage.items.get(DRAFT_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ['project', 'savedAt', 'ui', 'version']);
  assert.equal(stored.version, DRAFT_VERSION);
  assert.deepEqual(readDraft(storage), { project, ui: { view: 'load', goal: 'smoke' }, savedAt: 1234 });
  clearDraft(storage);
  assert.equal(storage.items.size, 0);
  assert.equal(readDraft(storage), null);
});

test('a draft the browser refuses reports false and never throws', () => {
  assert.equal(writeDraft({ project }, { setItem() { throw new Error('QuotaExceededError'); } }), false);
  assert.equal(writeDraft({ project }, {}), false);
  withBlockedLocalStorage(() => {
    assert.equal(writeDraft({ project }), false);
    assert.equal(readDraft(), null);
    assert.doesNotThrow(() => clearDraft());
  });
  assert.doesNotThrow(() => clearDraft({ removeItem() { throw new Error('blocked'); } }));
});

test('anything but a draft of this version reads as no draft', () => {
  const stored = value => memoryStorage({ [DRAFT_KEY]: typeof value === 'string' ? value : JSON.stringify(value) });
  for (const value of [
    '', 'not json', 'null', '[]', '"text"',
    { project },                                   // no version
    { version: 2, project },                       // a later version
    { version: 1 },                                // no project
    { version: 1, project: [] },
    { version: 1, project: 'text' },
  ]) {
    assert.equal(readDraft(stored(value)), null, JSON.stringify(value));
  }
  assert.equal(readDraft({ getItem() { throw new Error('blocked'); } }), null);
  assert.equal(readDraft({}), null);
  // Missing or odd extras fall back instead of dropping the project.
  assert.deepEqual(readDraft(stored({ version: 1, project, ui: 'flow', savedAt: 'yesterday' })), { project, ui: {}, savedAt: null });
});

test('leaving asks only while a test runs or when the draft was refused', () => {
  assert.equal(leaveLosesWork({ running: false, kept: true }), false);
  assert.equal(leaveLosesWork({ running: true, kept: true }), true);
  assert.equal(leaveLosesWork({ running: false, kept: false }), true);
  assert.equal(leaveLosesWork({ running: true, kept: false }), true);
});

test('the top bar status: nothing for an empty project, words and a known icon otherwise', () => {
  assert.equal(draftStatus('empty'), null);
  assert.equal(draftStatus('unknown'), null);
  const icons = new Set([...read('public/css/base.css').matchAll(/\[data-icon="([a-z-]+)"\]/g)].map(match => match[1]));
  for (const [state, text, tone] of [
    ['kept', 'Kept in this browser', 'kept'],
    ['restored', 'Restored from your last visit', 'kept'],
    ['refused', 'Not kept in this browser', 'refused'],
  ]) {
    const status = draftStatus(state);
    assert.equal(status.text, text);
    assert.equal(status.tone, tone);
    assert.ok(icons.has(status.icon), `${state}: icon ${status.icon} exists`);
    assert.ok(status.title.length > status.text.length, `${state}: the tooltip explains it`);
  }
  assert.match(draftStatus('refused').title, /Save/);
});

test('wiring: New and the status sit with the project file actions; the draft starts after the forms', () => {
  const html = read('public/index.html');
  const actions = html.slice(html.indexOf('class="project-actions"'), html.indexOf('id="project-file-input"'));
  assert.ok(actions.indexOf('id="new-project-btn"') > 0 && actions.indexOf('id="new-project-btn"') < actions.indexOf('id="open-project-btn"'), 'New comes before Open');
  assert.match(actions, /<span class="draft-status" id="draft-status" role="status" hidden><\/span>/);

  const app = read('public/js/app.js');
  assert.match(app, /initDraft\(\{\s*read: readProjectDraft,/);
  assert.ok(app.indexOf('initDraft(') > app.indexOf('initUiMode();'), 'after the forms and the mode exist');
  assert.match(app, /draft\.discard\(\);\s*window\.location\.reload\(\);/);

  // The draft reader never builds a lazy request panel and leaves the store alone.
  const config = read('public/js/config.js');
  const lazy = config.slice(config.indexOf('function readCardLazily'), config.indexOf('// ── Global variables'));
  assert.ok(lazy.length > 0);
  assert.doesNotMatch(lazy, /ensureRequestPanel|projectStore/);
  assert.match(config, /export function readProjectDraft\(\) \{\s*return readConfig\(\{ hydrate: false \}\);/);

  // A running test is what the guard protects; New stays off while one runs.
  const runner = runnerSource();
  assert.match(runner, /export const isTestRunning = \(\) => Boolean\(abortCtrl\);/);
  assert.match(runner, /newProject\.disabled = running;/);
});
