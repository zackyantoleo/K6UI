import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, loadShape, parseDuration } from '../public/js/components/load-chart.js';

test('durations read like k6 reads them', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('500ms'), 0.5);
  assert.equal(parseDuration(' 1m30s '), 90);
  for (const bad of ['', '30', 'abc', '5 m', '1h-5m', null, undefined]) assert.equal(parseDuration(bad), null, String(bad));
});

test('durations are written back in the same short form', () => {
  assert.equal(formatDuration(35), '35s');
  assert.equal(formatDuration(360), '6m');
  assert.equal(formatDuration(5400), '1h 30m');
  assert.equal(formatDuration(0.5), '500ms');
});

test('fixed VUs: a flat line for the whole duration', () => {
  const shape = loadShape({ mode: 'simple', vus: '10', duration: '30s' });
  assert.deepEqual(shape.points, [[0, 10], [30, 10]]);
  assert.deepEqual([shape.peak, shape.total, shape.open], [10, 30, false]);
  assert.equal(loadShape({ mode: 'simple', vus: '10', duration: 'soon' }), null);
});

test('stages: starts at 1 VU like k6, then one point per stage', () => {
  const shape = loadShape({ mode: 'stages', stages: [
    { duration: '10s', target: '2' }, { duration: '20s', target: '5' }, { duration: '5s', target: '0' },
  ] });
  assert.deepEqual(shape.points, [[0, 1], [10, 2], [30, 5], [35, 0]]);
  assert.deepEqual(shape.boundaries, [10, 30]);
  assert.deepEqual([shape.peak, shape.total], [5, 35]);
  assert.match(shape.summary, /^3 stages over 35s, reaching 5 virtual users/);
});

test('stages: half-typed rows are left out, and none left means nothing to draw', () => {
  const shape = loadShape({ mode: 'stages', stages: [{ duration: '', target: '5' }, { duration: '1m', target: '3' }, { duration: '10s', target: '' }] });
  assert.deepEqual(shape.points, [[0, 1], [60, 3]]);
  assert.equal(loadShape({ mode: 'stages', stages: [{ duration: 'x', target: '5' }] }), null);
  assert.equal(loadShape({ mode: 'stages', stages: [] }), null);
});

test('iterations: no set end, capped by the max duration', () => {
  const shape = loadShape({ mode: 'iterations', vus: '5', iterations: '2', maxDuration: '10m' });
  assert.deepEqual([shape.peak, shape.total, shape.open], [5, 600, true]);
  assert.match(shape.summary, /10 runs in total/);
  assert.equal(loadShape({ mode: 'iterations', vus: '1', iterations: '1', maxDuration: '' }).total, 3600);
});
