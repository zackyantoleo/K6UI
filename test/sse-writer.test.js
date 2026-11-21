// /api/run's event stream (server/sse-writer.js): while the connection is backed up,
// k6 output lines are left out and counted, never kept in memory; every other event
// is always written, and the count goes out once it drains (or before the end).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseWriter, droppedLogLine } from '../server/sse-writer.js';

// A response whose write() reports a full buffer while `full` is set.
function fakeResponse() {
  const res = new EventEmitter();
  res.full = false;
  res.events = [];
  res.write = (chunk) => {
    const [, event, data] = /^event: (.*)\ndata: (.*)\n\n$/.exec(chunk);
    res.events.push([event, JSON.parse(data)]);
    return !res.full;
  };
  return res;
}

test('a backed-up stream drops k6 output lines and says how many once it drains', () => {
  const res = fakeResponse();
  const write = createSseWriter(res);
  write('log', { line: 'one\n' });
  res.full = true;
  write('log', { line: 'two\n' });           // written: the buffer fills with it
  for (let i = 0; i < 1000; i++) write('log', { line: `spam ${i}\n` });
  write('req-log', { i: 0 });               // never dropped
  write('metrics', { vus: 1 });
  assert.deepEqual(res.events.map(([event]) => event), ['log', 'log', 'req-log', 'metrics']);

  res.full = false;
  res.emit('drain');
  write('log', { line: 'three\n' });
  assert.deepEqual(res.events.slice(4), [['log', { line: droppedLogLine(1000) }], ['log', { line: 'three\n' }]]);
  assert.match(droppedLogLine(1000), /left out 1000 lines of k6 output/);
  assert.match(droppedLogLine(1), /left out 1 line of k6 output/);
});

test('a run that ends backed up still reports the count, right before done', () => {
  const res = fakeResponse();
  const write = createSseWriter(res);
  res.full = true;
  write('log', { line: 'fills the buffer\n' });
  write('log', { line: 'dropped\n' });
  write('done', { code: 0 });
  assert.deepEqual(res.events.map(([event, data]) => (event === 'log' ? data.line : event)), ['fills the buffer\n', droppedLogLine(1), 'done']);
});
