import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readStyles } from './helpers/styles.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/js/app.js');
const checks = read('../public/js/components/request-editor/checks.js');
const css = readStyles();
const config = read('../public/js/config.js');
const goals = read('../public/js/components/load-goals.js');
const projectIo = read('../public/js/project-io.js');

test('Smoke, Load, and Stress use explicit staged starter configurations', () => {
  assert.match(goals, /smoke:\s*\{[\s\S]*stages:/);
  assert.match(goals, /load:\s*\{[\s\S]*stages:/);
  assert.match(goals, /stress:\s*\{[\s\S]*stages:/);
  assert.match(goals, /stageRow\(stage\.duration, stage\.target\)/);
  assert.match(goals, /\$\('#load-kind'\)\.value = 'stages'/);
  assert.doesNotMatch(app, /LOAD_PRESETS|load-mode/);
});

test('the technical load modes sit inside Custom as the kind of load', () => {
  const kinds = [...html.matchAll(/<select id="load-kind">([\s\S]*?)<\/select>/g)][0][1];
  assert.deepEqual([...kinds.matchAll(/value="(\w+)"/g)].map(match => match[1]), ['simple', 'stages', 'iterations']);
  assert.doesNotMatch(html, /name="load-mode"|id="customize-load"|id="load-custom-editor"/);
});

test('preset replacement requires confirmation after edited or loaded load values', () => {
  assert.match(goals, /confirm\(/);
  assert.match(goals, /keep your custom load values/i);
  assert.match(goals, /export function restoreLoadMode\(mode\)[\s\S]*custom = true/);
  assert.match(goals, /k6ui:project-applied/);
});

test('iterations mode is a third load mode wired through the form, save/open, and validation', () => {
  assert.match(html, /<option value="iterations">/);
  for (const id of ['load-iterations', 'iter-vus', 'iterations', 'max-duration']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="load-iterations" class="hidden"/);
  assert.match(goals, /iterations: '#load-iterations'/);
  assert.match(projectIo, /restoreLoadMode\(mode\)/);
  assert.match(projectIo, /\$\('#iterations'\)\.value\s*=\s*cfg\.load\?\.iterations/);
  assert.match(config, /load\.iterations\s*=\s*\$\('#iterations'\)\.value/);
  assert.match(config, /config\.load\.mode === 'iterations'/);
});

test('load terms are explained by the glossary and a plain sentence', () => {
  assert.match(html, />Virtual Users \(VUs\)</);
  for (const key of ['smoke', 'loadTest', 'stress', 'race', 'customLoad', 'vu', 'duration', 'stages', 'p95', 'errorRate']) {
    assert.match(html, new RegExp(`data-help="${key}"`), key);
  }
  assert.match(html, /95% of requests finish within/);
  assert.match(html, /% of requests fail/);
  assert.match(html, /<h3 id="load-shape-title">What will happen<\/h3>/);
});

test('checks expose plain-language starter templates (no status ones: Success statuses covers them) while every type remains available', () => {
  const templates = checks.slice(checks.indexOf('const CHECK_TEMPLATES'), checks.indexOf('];', checks.indexOf('const CHECK_TEMPLATES')));
  for (const template of ['Response contains', 'Response time']) assert.match(templates, new RegExp(template));
  for (const template of ['Successful response', 'Expected status']) assert.doesNotMatch(templates, new RegExp(template));
  for (const type of ['status-2xx', 'status-eq']) assert.match(checks, new RegExp(`value: '${type}'`), `${type} still loads from saved projects`);
  // A blank "body contains" row would not pass validation; a 2xx row is valid as it is.
  assert.match(checks, /assertionRow\('status-2xx', '', '', onCountChange\)/, 'a custom check starts valid');
  assert.match(checks, /CHECK_TEMPLATES/);
  assert.match(checks, /Add custom check/);
  assert.match(checks, /body-matches/);
  assert.match(checks, /header-eq/);
  assert.match(checks, /value:\s*'expected text'/);
  assert.match(checks, /aria-label.*Check type/i);
  assert.match(checks, /aria-label.*Expected value/i);
  assert.match(checks, /k6 records a failed check/i);
});

test('new controls have visible focus and selected-state styling', () => {
  assert.match(css, /\.check-template-btn:focus-visible/);
  assert.match(css, /\.load-goal\[aria-pressed="true"\]/);
  assert.match(css, /\.load-goal:focus-visible/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.assertion-row/);
  assert.match(css, /\.assertion-row[\s\S]*flex-wrap:\s*wrap/);
});
