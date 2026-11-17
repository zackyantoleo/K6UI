// Sorting of the Run & Results "Requests" table: the pure rules in
// public/js/request-sort.js and the markup/wiring around them. The browser
// check (scripts/verify-ui-modes.mjs) sorts a real run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SORT_COLUMNS, ariaSortOf, compareRecords, insertIndex, nextSort,
} from '../public/js/request-sort.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../public/js/runner.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

let seq = 0;
const record = (entry) => ({ entry, seq: seq++ });
const sorted = (records, sort) => [...records].sort((a, b) => compareRecords(a, b, sort));

test('a heading cycles ascending → descending → arrival order; another heading starts ascending', () => {
  let sort = nextSort(null, 'd');
  assert.deepEqual(sort, { key: 'd', dir: 'asc' });
  sort = nextSort(sort, 'd');
  assert.deepEqual(sort, { key: 'd', dir: 'desc' });
  assert.equal(nextSort(sort, 'd'), null);
  assert.deepEqual(nextSort(sort, 'url'), { key: 'url', dir: 'asc' });
  assert.deepEqual(nextSort(sort, 'nope'), sort, 'an unknown column changes nothing');
});

test('numbers sort as numbers, text without case; ties and no sort keep arrival order', () => {
  const records = [
    record({ d: 10, s: 200, url: 'http://b', m: 'GET' }),
    record({ d: 9.5, s: 500, url: 'http://A', m: 'post' }),
    record({ d: 100, s: 200, url: 'http://c', m: 'GET' }),
    record({ d: 9.5, s: 404, url: 'http://a', m: 'DELETE' }),
  ];
  const ds = (list) => list.map(r => r.entry.d);
  assert.deepEqual(ds(sorted(records, { key: 'd', dir: 'asc' })), [9.5, 9.5, 10, 100]);
  assert.deepEqual(ds(sorted(records, { key: 'd', dir: 'desc' })), [100, 10, 9.5, 9.5]);
  assert.deepEqual(sorted(records, { key: 'd', dir: 'desc' }).slice(2).map(r => r.entry.s), [500, 404],
    'equal durations keep arrival order, also descending');
  assert.deepEqual(sorted(records, { key: 'url', dir: 'asc' }).map(r => r.entry.url), ['http://A', 'http://a', 'http://b', 'http://c']);
  assert.deepEqual(sorted(records, { key: 's', dir: 'desc' }).map(r => r.entry.s), [500, 404, 200, 200]);
  assert.deepEqual(sorted(records, null), records);
});

test('a missing number sorts as the smallest value', () => {
  const records = [record({ s: 200 }), record({ s: null }), record({}), record({ s: 0 })];
  assert.deepEqual(sorted(records, { key: 's', dir: 'asc' }).map(r => r.entry.s), [null, undefined, 0, 200]);
});

test('a record that arrives later goes where the sort puts it, after its equals', () => {
  const sort = { key: 'd', dir: 'desc' };
  const list = sorted([record({ d: 5 }), record({ d: 50 }), record({ d: 20 })], sort);
  for (const d of [30, 20, 1, 99]) {
    const next = record({ d });
    list.splice(insertIndex(list, next, sort), 0, next);
  }
  assert.deepEqual(list.map(r => r.entry.d), [99, 50, 30, 20, 20, 5, 1]);
  assert.ok(list[3].seq < list[4].seq, 'the earlier 20 stays first');
  const arrival = [record({}), record({})];
  assert.equal(insertIndex(arrival, record({}), null), 2, 'no sort: appended');
});

test('aria-sort names the sorted column only', () => {
  assert.equal(ariaSortOf({ key: 'd', dir: 'asc' }, 'd'), 'ascending');
  assert.equal(ariaSortOf({ key: 'd', dir: 'desc' }, 'd'), 'descending');
  assert.equal(ariaSortOf({ key: 'd', dir: 'desc' }, 's'), null);
  assert.equal(ariaSortOf(null, 'd'), null);
});

test('every column heading is a sort button for a known column, wired in app.js', () => {
  const thead = html.match(/<table class="req-log-table"[\s\S]*?<\/thead>/)[0];
  const keys = [...thead.matchAll(/<th scope="col" data-sort-key="(\w+)"><button type="button" class="req-sort-btn" data-sort="\1">/g)].map(m => m[1]);
  assert.deepEqual(keys, Object.keys(SORT_COLUMNS));
  assert.match(app, /\.req-sort-btn[\s\S]*sortRequestLog\(button\.dataset\.sort\)/);
  assert.match(runner, /setAttribute\('aria-sort', state\)/);
  assert.match(runner, /insertIndex\(reqRows, record, reqSort\)/, 'live records keep the sort');
});
