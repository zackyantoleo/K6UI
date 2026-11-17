import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { outlineModel } from '../public/js/components/flow-outline.js';
import { describeRunIf, normalizeRunIf, runIfProblem } from '../public/js/run-if.js';
import { readStyles } from './helpers/styles.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/index.html');
const css = readStyles();
const groups = read('../public/js/components/request-groups.js');
const outline = read('../public/js/components/flow-outline.js');
const notice = read('../public/js/components/advanced-notice.js');
const config = read('../public/js/config.js');
const projectIo = read('../public/js/project-io.js');
const dataFiles = read('../public/js/data-files.js');
const store = read('../public/js/project-store.js');

const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');

// ── The condition itself (pure) ───────────────────────────────

test('a condition needs a valid variable, a known operator, and values that fit the operator', () => {
  const ok = { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] };
  assert.equal(runIfProblem(ok), '');
  assert.equal(runIfProblem(null), '');
  assert.equal(runIfProblem(undefined), '');
  assert.match(runIfProblem({ ...ok, variable: '' }), /Enter the variable/);
  assert.match(runIfProblem({ ...ok, variable: '1st' }), /"1st" is not a valid variable name/);
  assert.match(runIfProblem({ ...ok, variable: 'a-b' }), /not a valid variable name/);
  assert.match(runIfProblem({ ...ok, operator: 'like' }), /Choose "is", "is not" or "is one of"/);
  assert.match(runIfProblem({ ...ok, values: [' ', ''] }), /at least one value/);
  assert.match(runIfProblem({ ...ok, operator: 'equals' }), /"is" compares one value; use "is one of" for several/);
  assert.match(runIfProblem({ ...ok, operator: 'not-equals' }), /"is not" compares one value/);
  assert.equal(runIfProblem({ ...ok, operator: 'equals', values: ['A', ' A '] }), '', 'a repeated value is one value');
  assert.match(runIfProblem([]), /must be an object/);
  assert.match(runIfProblem('X == A'), /must be an object/);
});

test('a condition is normalized to one shape and described in words', () => {
  assert.deepEqual(normalizeRunIf({ variable: ' X ', operator: 'one-of', values: [' A', 'B ', 'A', 3], x: 1 }), { variable: 'X', operator: 'one-of', values: ['A', 'B', '3'] });
  assert.equal(normalizeRunIf({ variable: 'X', operator: 'equals', values: [] }), null);
  assert.equal(normalizeRunIf(null), null);
  assert.equal(describeRunIf({ variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] }), 'EXECUTION_MODE is one of ORDER_FLOW, ALL');
  assert.equal(describeRunIf({ variable: 'X', operator: 'equals', values: ['A'] }), 'X is A');
  assert.equal(describeRunIf({ variable: 'X', operator: 'not-equals', values: ['A'] }), 'X is not A');
  assert.equal(describeRunIf({ variable: 'X', operator: 'bad', values: ['A'] }), '');
});

// ── One DOM for both modes, text only ─────────────────────────

test('the group editor has one "Run only if" row, built once, for Simple and Advanced', () => {
  for (const cls of ['group-run-if', 'run-if-variable', 'run-if-operator', 'run-if-values', 'run-if-message', 'request-group-runif']) {
    assert.match(groups, new RegExp(`['"\`. ]${cls}\\b`), cls);
  }
  assert.match(groups, /Run only if/);
  for (const operator of ["'equals'", "'not-equals'", "'one-of'"]) assert.ok(groups.includes(operator), operator);
  assert.doesNotMatch(html, /run-if/, 'the group is built in JS, so the markup has no second copy');
  const source = stripComments(groups);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /uiMode|ui-mode|localStorage|sessionStorage|data-ui-only/, 'the mode is never stored or read here');
  assert.match(source, /badge\.textContent\s*=/);
});

test('the condition travels with the group: collected, validated before Run, restored, and kept by the store', () => {
  assert.match(groups, /readRunIfDraft\(group\) \? \{ runIf: readRunIfDraft\(group\) \}/);
  assert.match(groups, /runIfRow\(group\.runIf\)/);
  assert.match(config, /requestGroupProblem\(\)/);
  assert.match(projectIo, /restoreGroups\(cfg\.scenario\?\.groups \|\| \[\]\)/);
  assert.match(store, /normalizeRunIf\(group\.runIf\)/);
});

test('a half-typed condition is reported, not dropped; Run and View Script need it fixed', () => {
  assert.match(groups, /export function requestGroupProblem/);
  assert.match(groups, /"Run only if": \$\{problem\}/);
  assert.match(groups, /aria-invalid/);
  assert.match(groups, /role', 'status'/);
});

// ── Outline and Simple notice ─────────────────────────────────

test('the outline shows the condition of a group next to its name', () => {
  const model = outlineModel(
    [{ id: 'req_a', name: 'Login', type: 'http', method: 'POST', url: 'https://x.test', enabled: true, groupId: 'grp_a' }],
    [
      { id: 'grp_a', name: 'Order flow', enabled: true, condition: 'Runs only if EXECUTION_MODE is one of ORDER_FLOW, ALL' },
      { id: 'grp_b', name: 'Plain', enabled: true },
    ],
  );
  assert.equal(model.groups[0].condition, 'Runs only if EXECUTION_MODE is one of ORDER_FLOW, ALL');
  assert.equal(model.groups[1].condition, '');
  assert.match(outline, /'outline-cond'/);
  assert.ok(outline.includes("'.run-if-variable', '.run-if-operator', '.run-if-values'"), 'editing the row refreshes the outline');
  assert.match(css, /\.outline-cond/);
});

test('the Simple notice counts conditional groups, and a turned-off one is "configured but not run"', () => {
  const on = summarizeAdvancedSettings([], [{ id: 'g1', enabled: true, runIf: { variable: 'X' } }, { id: 'g2', enabled: true, headers: [{ key: 'X-A' }] }, { id: 'g3', enabled: true }]);
  assert.deepEqual(on.active, [
    { id: 'groupHeaders', label: 'Group header defaults', count: 1, unit: 'group' },
    { id: 'conditionalGroups', label: 'Conditional groups', count: 1, unit: 'group' },
  ]);
  assert.equal(on.visible, true);
  const off = summarizeAdvancedSettings([], [{ id: 'g1', enabled: false, runIf: { variable: 'X' }, headers: [{ key: 'X-A' }] }]);
  assert.deepEqual(off.active, []);
  assert.deepEqual(off.skipped, { requests: 0, groups: 1 }, 'one group, counted once');
  assert.equal(off.visible, true);
  assert.deepEqual(summarizeAdvancedSettings([], [{ id: 'g1', enabled: true, runIf: null }]).active, []);
  assert.match(notice, /Conditional groups/);
  assert.match(notice, /request-group-runif/);
});

// ── Data files that belong to a group ─────────────────────────

test('a data file card can be tied to a group, and the list follows the groups', () => {
  const template = html.match(/<template id="data-file-template">[\s\S]*?<\/template>/)[0];
  assert.match(template, /class="df-group"/);
  assert.match(template, /<option value="">At the start of every iteration<\/option>/);
  assert.doesNotMatch(template.replace(/^<template id="[^"]*">/, ''), /\sid="/);
  assert.match(dataFiles, /export function refreshDataSetGroups/);
  assert.match(groups, /refreshDataSetGroups\(groups\)/);
  assert.match(dataFiles, /set\.groupId = event\.target\.value/);
  assert.doesNotMatch(stripComments(dataFiles), /innerHTML|insertAdjacentHTML/);
  assert.match(stripComments(dataFiles), /textContent/);
});

test('styling covers the badge, the row, the message, and the outline text', () => {
  for (const selector of ['.request-group-runif', '.group-run-if', '.run-if-message', '.run-if-invalid', '.outline-cond']) {
    assert.ok(css.includes(selector), selector);
  }
});
