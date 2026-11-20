import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CsvError, normalizeDelimiter, parseCsv, readDataSet, toColumnName,
} from '../public/js/shared/csv-parse.js';

test('parses plain rows with LF, CRLF, and CR line ends and skips empty lines', () => {
  const expected = [['a', 'b'], ['1', '2'], ['3', '4']];
  assert.deepEqual(parseCsv('a,b\n1,2\n3,4'), expected);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n'), expected);
  assert.deepEqual(parseCsv('a,b\r1,2\r3,4\r'), expected);
  assert.deepEqual(parseCsv('\n\na,b\n\n1,2\n\n3,4\n\n'), expected);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
});

test('quoted fields keep commas, doubled quotes, and line breaks', () => {
  const rows = parseCsv('name,note\n"Doe, Jane","say ""hi"""\n"two\nlines","a\r\nb"\n');
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Doe, Jane', 'say "hi"'],
    ['two\nlines', 'a\r\nb'],
  ]);
});

test('keeps empty fields, a quoted empty value, and a final line without a line break', () => {
  assert.deepEqual(parseCsv('a,,c\n,,\n"",x'), [['a', '', 'c'], ['', '', ''], ['', 'x']]);
  assert.deepEqual(parseCsv('only\n""\nlast'), [['only'], [''], ['last']]);
});

test('strips a leading BOM and does not trim values', () => {
  assert.deepEqual(parseCsv('﻿email,password\n u@example.com , p '), [
    ['email', 'password'],
    [' u@example.com ', ' p '],
  ]);
});

test('a quote in the middle of an unquoted value is plain text', () => {
  assert.deepEqual(parseCsv('5" pipe,ok'), [['5" pipe', 'ok']]);
});

test('supports semicolon, tab, and pipe delimiters, and "\\t" as written by JMeter', () => {
  assert.deepEqual(parseCsv('a;b\n1;"x;y"', { delimiter: ';' }), [['a', 'b'], ['1', 'x;y']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\t' }), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\\t' }), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a|b', { delimiter: '|' }), [['a', 'b']]);
  for (const odd of ['^', '-', ']', '\\', '.', '*']) {
    assert.deepEqual(parseCsv(`a${odd}b${odd}"c${odd}d"`, { delimiter: odd }), [['a', 'b', `c${odd}d`]], `delimiter ${odd}`);
  }
  assert.equal(normalizeDelimiter(''), ',');
  assert.equal(normalizeDelimiter(undefined), ',');
  assert.equal(normalizeDelimiter('tab'), '\t');
  assert.throws(() => normalizeDelimiter('ab'), CsvError);
  assert.throws(() => normalizeDelimiter('"'), CsvError);
  assert.throws(() => normalizeDelimiter('\n'), CsvError);
});

test('an unclosed quote is an error that names the line, not silent data loss', () => {
  assert.throws(() => parseCsv('a,b\n1,"never closed\n2,3\n'), error => {
    assert.ok(error instanceof CsvError);
    assert.match(error.message, /line 2/);
    return true;
  });
});

test('reads a big file quickly', () => {
  const rows = Array.from({ length: 100_000 }, (_, i) => `user${i}@example.com,"pass,${i}"`);
  const started = performance.now();
  const parsed = parseCsv(`email,password\n${rows.join('\n')}`);
  assert.equal(parsed.length, 100_001);
  assert.deepEqual(parsed[100_000], ['user99999@example.com', 'pass,99999']);
  assert.ok(performance.now() - started < 2000, 'parsing 100k rows should take well under 2s');
});

test('column names: spaces become underscores, invalid ones are listed as ignored', () => {
  assert.equal(toColumnName('  First Name '), 'First_Name');
  const set = {
    content: 'a,b,c,d,e,f\n1,2,3,4,5,6',
    skipHeader: true,
    columns: ['email', '', '1bad', 'email', '__proto__', 'ok_1'],
  };
  const read = readDataSet(set);
  assert.deepEqual(read.columns, [{ name: 'email', field: 0 }, { name: 'ok_1', field: 5 }]);
  assert.deepEqual(read.ignored, ['1bad', 'email', '__proto__']);
  assert.deepEqual(read.rows, [['1', '2', '3', '4', '5', '6']]);
  assert.deepEqual(read.header, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('with no column names a header row supplies them; without a header nothing does', () => {
  const content = 'First Name,Last-Name,id\nA,B,1';
  const withHeader = readDataSet({ content, skipHeader: true, columns: [] });
  assert.deepEqual(withHeader.columns.map(c => c.name), ['First_Name', 'id']);
  assert.deepEqual(withHeader.ignored, ['Last-Name']);
  assert.equal(withHeader.rows.length, 1);

  const noHeader = readDataSet({ content, skipHeader: false, columns: [] });
  assert.deepEqual(noHeader.columns, []);
  assert.equal(noHeader.rows.length, 2);
});

test('readDataSet trims cell whitespace by default and preserves it when trimValues is false', () => {
  const set = { content: 'order_number,auth\n 1001 , Bearer tok \n', skipHeader: true, columns: ['order_number', 'auth'] };
  assert.deepEqual(readDataSet(set).rows, [['1001', 'Bearer tok']]);
  assert.deepEqual(readDataSet({ ...set, trimValues: false }).rows, [[' 1001 ', ' Bearer tok ']]);
});
