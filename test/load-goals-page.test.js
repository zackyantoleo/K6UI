// Load & goals page (UX stage 6): "What do you want to find out?" with five goals,
// the technical load modes inside Custom, a plain sentence of what will happen, a
// short race burst with "Advanced timing", and pass/fail goals as sentences with a
// switch. Presentation only: the project keeps the same `load` and `thresholds`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSentence, loadShape } from '../public/js/components/load-chart.js';
import { GOAL_DEFAULTS, goalExpression } from '../public/js/components/pass-fail-goals.js';
import { raceTimingSummary } from '../public/js/components/race-settings.js';
import { generateScript } from '../server/generator/index.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const page = html.slice(html.indexOf('<section id="view-load"'), html.indexOf('<!-- VIEW: k6 Script -->'));
// load-goals.js builds stage rows (DOM), so its two tables are read as source here.
const goalsSource = read('../public/js/components/load-goals.js');
const table = name => goalsSource.slice(goalsSource.indexOf(`export const ${name} = {`), goalsSource.indexOf('};', goalsSource.indexOf(`export const ${name} = {`)));
const keys = name => [...table(name).matchAll(/^  (\w+): /gm)].map(match => match[1]);
const LOAD_PRESETS = {
  smoke: { stages: [{ duration: '30s', target: '1' }] },
  load: { stages: [{ duration: '1m', target: '10' }, { duration: '3m', target: '10' }, { duration: '1m', target: '0' }] },
};

test('the page asks what you want to find out: five goals, Smoke marked as the place to start', () => {
  const goals = [...page.matchAll(/class="load-goal" data-goal="(\w+)" aria-pressed="(\w+)"/g)].map(match => match.slice(1));
  assert.deepEqual(goals, [['smoke', 'false'], ['load', 'false'], ['stress', 'false'], ['race', 'false'], ['custom', 'true']],
    'a fresh page keeps its fixed 10 VUs for 30s, shown as Custom');
  assert.match(page, /data-goal="smoke"[^]*?Start here[^]*?Does my flow work at all\?/);
  assert.equal((page.match(/load-goal-badge/g) || []).length, 1, 'one "Start here"');
  assert.deepEqual(keys('LOAD_GOALS'), ['smoke', 'load', 'stress', 'race', 'custom']);
  assert.deepEqual(keys('LOAD_PRESETS'), ['smoke', 'load', 'stress']);
  // The presets are the same staged loads as before (so the same script).
  assert.match(table('LOAD_PRESETS'), /smoke:  \{ stages: \[\{ duration: '30s', target: '1' \}\] \}/);
  assert.match(table('LOAD_PRESETS'), /load:   \{ stages: \[\{ duration: '1m', target: '10' \}, \{ duration: '3m', target: '10' \}, \{ duration: '1m', target: '0' \}\] \}/);
  assert.match(table('LOAD_PRESETS'), /stress: \{ stages: \[\{ duration: '2m', target: '10' \}, \{ duration: '2m', target: '50' \}, \{ duration: '1m', target: '50' \}, \{ duration: '1m', target: '0' \}\] \}/);
  assert.doesNotMatch(page, /data-ui-only="[a-z]+"[^>]*class="load-goal/, 'the goals show in both modes');
});

test('Custom holds the kind of load; Advanced always shows it, Simple hides it under a preset', () => {
  assert.match(page, /<div id="load-settings" class="form-card load-settings" data-goal="custom">/);
  const css = read('../public/css/views.css');
  assert.match(css, /\.load-settings\[data-goal="race"\] \.load-kind-field/);
  assert.match(css, /html:not\(\[data-ui-mode="advanced"\]\) \.load-settings:is\(\[data-goal="smoke"\], \[data-goal="load"\], \[data-goal="stress"\]\) \.load-kind-field \{ display: none; \}/);
  for (const id of ['load-simple', 'load-stages', 'load-iterations', 'load-race']) assert.match(page, new RegExp(`id="${id}"`));
});

test('a race burst shows the request, users and timing; the rest is under Advanced timing', () => {
  const race = page.slice(page.indexOf('id="load-race"'), page.indexOf('<section class="form-card load-shape"'));
  const body = race.slice(race.indexOf('id="race-advanced-body"'));
  const top = race.slice(0, race.indexOf('id="race-advanced-body"'));
  for (const id of ['race-request', 'race-vus', 'race-timing', 'race-spread', 'race-offsets']) assert.match(top, new RegExp(`id="${id}"`), id);
  for (const id of ['race-lead', 'race-warmup', 'race-warmup-path', 'race-fail-late', 'race-max-duration']) {
    assert.match(body, new RegExp(`id="${id}"`), id);
    assert.doesNotMatch(top, new RegExp(`id="${id}"`), id);
  }
  assert.match(race, /id="race-advanced-body" hidden/, 'folded at first (Simple)');
  assert.match(race, /id="race-advanced-toggle" aria-expanded="false" aria-controls="race-advanced-body" data-ui-only="simple"/);
  assert.match(read('../public/css/views.css'), /html\[data-ui-mode="advanced"\] \.race-advanced-body\[hidden\] \{ display: block; \}/);
  // Safe defaults, the same as before: 2 s lead, warm-up on, a late VU only warns, 1h limit.
  assert.match(body, /id="race-lead" value="2000"/);
  assert.match(body, /id="race-warmup" checked/);
  assert.match(body, /id="race-fail-late" \/>/);
  assert.match(body, /id="race-max-duration" value="1h"/);
  assert.equal(raceTimingSummary({ leadMs: '2000', warmup: true, failIfLate: false, maxDuration: '1h' }),
    '2000 ms lead time · warm-up on · a late VU is a warning · stops after 1h');
  assert.equal(raceTimingSummary({ leadMs: '', warmup: false, failIfLate: true, maxDuration: '' }),
    '? ms lead time · no warm-up · a late VU fails the run · stops after 1h');
});

test('what will happen is one plain sentence per kind of load', () => {
  const say = (form, options) => loadSentence(form, loadShape(form), options);
  assert.equal(say({ mode: 'stages', stages: LOAD_PRESETS.smoke.stages }, { goal: 'smoke', requests: 3 }),
    '1 user runs your 3 requests over and over for 30s. If anything fails here, fix it before adding load.');
  assert.equal(say({ mode: 'stages', stages: LOAD_PRESETS.load.stages }, { goal: 'load', requests: 1 }),
    'Starts with 1 user, climbs to 10 users, then comes back down to 0. The whole test takes 5m.');
  assert.equal(say({ mode: 'stages', stages: [{ duration: '1m', target: '20' }] }),
    'Starts with 1 user, climbs to 20 users. The whole test takes 1m.');
  assert.equal(say({ mode: 'simple', vus: '10', duration: '30s' }, { requests: 2 }),
    '10 users run your 2 requests over and over for 30s, all starting at once.');
  assert.equal(say({ mode: 'simple', vus: '1', duration: '1m' }), '1 user runs the flow over and over for 1m.');
  assert.equal(say({ mode: 'iterations', vus: '5', iterations: '2', maxDuration: '1h' }, { requests: 4 }),
    '5 users each run your 4 requests 2 times (10 runs in total), then stop.');
  assert.equal(say({ mode: 'iterations', vus: '1', iterations: '3' }), '1 user runs the flow 3 times, then stops.');
  const race = timing => ({ mode: 'race', vus: '4', race: { timing, spreadMs: '200', offsets: '0,10,20,30', leadMs: '2000' } });
  assert.equal(say(race('together'), { goal: 'race', raceRequest: 'Request 2 · Redeem' }),
    '4 users each run the requests before "Request 2 · Redeem" once, then send it at the same moment.');
  assert.equal(say(race('spread')), '4 users each run the requests before the race request once, then send it spread over 200 ms.');
  assert.equal(say(race('offsets')), '4 users each run the requests before the race request once, then send it at the times you set.');
  assert.equal(loadSentence({ mode: 'simple' }, null), '');
});

test('pass/fail goals are sentences with a switch; off means "" in the project', () => {
  const goals = page.slice(page.indexOf('id="load-block-goals"'));
  assert.match(goals, /<input type="checkbox" class="switch-input" id="goal-p95-on"[^>]*\/>\s*<span class="pass-goal-text" id="goal-p95-text"><span>95% of requests finish within<\/span> <input type="number" id="p95" min="0" value="500"[^>]* disabled \/> <span>ms<\/span><\/span>\s*<button data-help="p95"><\/button>/);
  assert.match(goals, /<input type="checkbox" class="switch-input" id="goal-error-on"[^>]*\/>\s*<span class="pass-goal-text" id="goal-error-text"><span>Less than<\/span> <input type="number" id="errorRate"[^>]*value="1"[^>]* disabled \/> <span>% of requests fail<\/span><\/span>\s*<button data-help="errorRate"><\/button>/);
  assert.doesNotMatch(goals, /id="goal-(p95|error)-on"[^>]*checked/, 'off until the user turns one on');
  assert.match(goals, /ask your team for the real numbers/);
  assert.deepEqual(GOAL_DEFAULTS, { p95: '500', errorRate: '1' });
  // The k6 expression shown in Advanced is the generator's own.
  const thresholds = p95 => generateScript({
    scenario: { groups: [], requests: [{ id: 'r', method: 'GET', url: 'https://example.test/' }] },
    load: { mode: 'simple', vus: '1', duration: '1s' }, thresholds: { p95, errorRate: '1.5' },
  });
  assert.match(thresholds('500'), new RegExp(goalExpression('p95', '500').replace(/[()]/g, '\\$&')));
  assert.match(thresholds('500'), new RegExp(goalExpression('errorRate', '1.5').replace('.', '\\.')));
  assert.equal(goalExpression('p95', ''), '');
  assert.equal(goalExpression('errorRate', 'x'), '');
  const passFail = read('../public/js/components/pass-fail-goals.js');
  assert.match(passFail, /values\[goal\.key\] = \$\(goal\.toggle\)\?\.checked \? \$\(goal\.input\)\.value : '';/);
  assert.match(passFail, /\$\(goal\.toggle\)\.checked = value !== '';/);
});

test('outcome targets are added from "Add goal", in both modes', () => {
  const goals = page.slice(page.indexOf('id="load-block-goals"'));
  assert.match(goals, /id="add-goal-btn" aria-controls="add-goal-menu">Add goal</);
  assert.match(goals, /role="menuitem" id="add-outcome-target"><strong>Count of a response label <span class="tag-advanced">Advanced<\/span><\/strong>/);
  assert.doesNotMatch(goals.slice(0, goals.indexOf('</section>')), /What are Thresholds\?|Performance Targets/);
});

test('the chosen goal is never saved: the project keeps load and thresholds as before', () => {
  for (const file of ['load-goals.js', 'pass-fail-goals.js', 'load-chart.js']) {
    const source = read(`../public/js/components/${file}`);
    assert.doesNotMatch(source, /localStorage|sessionStorage|projectStore|uiMode|ui-mode/, file);
  }
  const config = read('../public/js/config.js');
  assert.match(config, /const mode = readLoadMode\(\);/);
  assert.match(config, /return \{ \.\.\.readThresholdFields\(\), \.\.\.\(outcomes\.length \? \{ outcomes \} : \{\}\) \};/);
  const io = read('../public/js/project-io.js');
  assert.match(io, /restoreLoadMode\(mode\);/);
  assert.match(io, /restoreThresholdFields\(cfg\.thresholds\);/);
});
