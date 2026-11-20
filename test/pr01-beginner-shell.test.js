import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readStyles } from './helpers/styles.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
}

test('Simple navigation exposes exactly four ordered steps', async () => {
  const html = await read('public/index.html');
  const simple = html.match(/<nav[^>]*id="simple-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(simple, 'Simple has its own navigation');
  const steps = matches(simple, /data-step="([^"]+)"[^>]*data-view="([^"]+)"/g)
    .map(([, step, view]) => ({ step, view }));

  assert.deepEqual(steps, [
    { step: '1', view: 'flow' },
    { step: '2', view: 'data' },
    { step: '3', view: 'load' },
    { step: '4', view: 'results' },
  ]);
});

test('Advanced navigation exposes eight direct categories', async () => {
  const html = await read('public/index.html');
  const advanced = html.match(/<nav[^>]*id="advanced-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(advanced, 'Advanced has its own navigation');
  assert.deepEqual(matches(advanced, /data-view="([^"]+)"[^>]*>([^<]+)</g)
    .map(([, view, label]) => [view, label]), [
    ['flow', 'Request Flow'], ['vars', 'Variables'], ['headers', 'Headers'],
    ['datafiles', 'Data files'], ['load', 'Load Profile'], ['sla', 'Thresholds / SLA'],
    ['script', 'k6 Script'], ['results', 'Run &amp; Results'],
  ]);
});

test('unfinished features are absent from the active shell', async () => {
  const html = await read('public/index.html');
  assert.doesNotMatch(html, /badge-soon|class="[^"]*\bsoon\b|Coming Soon/i);
  assert.doesNotMatch(html, />\s*(CSV Data|Cookies|Timers|Multi Scenario)\s*</i);
});

test('first-use flow offers accessible blank and cURL starts', async () => {
  const html = await read('public/index.html');
  assert.match(html, /id="flow-empty-state"[^>]*role="status"/);
  assert.match(html, /id="empty-add-request"[^>]*type="button"/);
  assert.match(html, /id="empty-import-curl"[^>]*type="button"/);
});

test('load step starts from a question with five goals and results has a pre-run state', async () => {
  const html = await read('public/index.html');
  const goals = matches(html, /class="load-goal" data-goal="([^"]+)"/g).map(([, goal]) => goal);
  assert.deepEqual(goals, ['smoke', 'load', 'stress', 'race', 'custom']);
  assert.match(html, /What do you want to find out\?/);
  assert.match(html, /id="results-empty-state"[^>]*role="status"/);
});

test('shell includes semantic navigation and accessible status regions', async () => {
  const html = await read('public/index.html');
  assert.match(html, /<nav[^>]*aria-label="Test builder steps"/);
  assert.match(html, /id="page-title"[^>]*tabindex="-1"/);
  assert.match(html, /id="k6-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="run-state"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('keyboard, reduced-motion, and narrow/zoom fallbacks are explicit', async () => {
  const css = readStyles();
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media\s*\(max-width:\s*960px\)/);
});
