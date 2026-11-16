import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const app = read('../public/js/app.js');
const checks = read('../public/js/components/request-editor/checks.js');
const css = read('../public/css/style.css');
const config = read('../public/js/config.js');
const projectIo = read('../public/js/project-io.js');

test('Smoke, Load, and Stress use explicit staged starter configurations', () => {
  assert.match(app, /smoke:\s*\{[\s\S]*stages:/);
  assert.match(app, /load:\s*\{[\s\S]*stages:/);
  assert.match(app, /stress:\s*\{[\s\S]*stages:/);
  assert.match(app, /stageRow\(stage\.duration, stage\.target\)/);
});

test('custom stages are progressively disclosed behind Customize', () => {
  assert.match(html, /id="customize-load"/);
  assert.match(html, /aria-controls="load-custom-editor"/);
  assert.match(html, /id="load-custom-editor"[^>]*hidden/);
  assert.match(app, /customize-load/);
});

test('preset replacement requires confirmation after edited or loaded load values', () => {
  assert.match(app, /loadPresetDirty/);
  assert.match(app, /confirm\(/);
  assert.match(app, /keep your custom load values/i);
  assert.match(app, /function protectLoadedLoadValues\(\)[\s\S]*loadPresetDirty = true/);
  assert.match(app, /k6ui:project-applied/);
});

test('iterations mode is a third load mode wired through the form, save/open, and validation', () => {
  assert.match(html, /name="load-mode" value="iterations"/);
  for (const id of ['load-iterations', 'iter-vus', 'iterations', 'max-duration']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="load-iterations" class="hidden"/);
  assert.match(app, /#load-iterations'\)\.classList\.toggle\('hidden', mode !== 'iterations'\)/);
  assert.match(projectIo, /#load-iterations'\)\.classList\.toggle\('hidden', mode !== 'iterations'\)/);
  assert.match(projectIo, /\$\('#iterations'\)\.value\s*=\s*cfg\.load\?\.iterations/);
  assert.match(config, /load\.iterations\s*=\s*\$\('#iterations'\)\.value/);
  assert.match(config, /config\.load\.mode === 'iterations'/);
});

test('load guidance explains beginner terms inline', () => {
  assert.match(html, />Virtual Users \(VUs\)</);
  assert.match(html, /VUs simulate concurrent users/i);
  assert.match(html, /Duration is how long/i);
  assert.match(html, /p95 means 95%/i);
  assert.match(html, /Error rate is the percentage/i);
});

test('checks expose four plain-language starter templates while advanced types remain available', () => {
  for (const template of ['Successful response', 'Expected status', 'Response contains', 'Response time']) {
    assert.match(checks, new RegExp(template, 'i'));
  }
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
  assert.match(css, /\.preset-btn\[aria-pressed="true"\]/);
  assert.match(css, /\.load-guidance/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.assertion-row/);
  assert.match(css, /\.assertion-row[\s\S]*flex-wrap:\s*wrap/);
});
