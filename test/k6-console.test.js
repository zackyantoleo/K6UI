// Reading k6's output: Go-quoted console messages (server/k6-console.js), whole UTF-8
// lines (server/line-splitter.js), and a run that ends exactly once (server/k6-runner.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleMessageOf, unquoteGo } from '../server/k6-console.js';
import { createLineSplitter } from '../server/line-splitter.js';
import { startK6Run } from '../server/k6-runner.js';

// Built from char codes so this file stays plain ASCII.
const BS = '\\';
const DEL = String.fromCharCode(0x7f);
const BELL = String.fromCharCode(7);
const EURO = String.fromCharCode(0x20ac);
const GRIN = String.fromCodePoint(0x1f600);

test('Go escapes that JSON.parse rejects are unquoted', () => {
  assert.equal(unquoteGo(`a${BS}x7fb`), `a${DEL}b`);
  assert.equal(unquoteGo(`${BS}a${BS}v`), `${BELL}${String.fromCharCode(11)}`);
  assert.equal(unquoteGo(`${BS}U0001f600`), GRIN);
  assert.equal(unquoteGo(`${BS}u20ac ${BS}"q${BS}" ${BS}${BS}n`), `${EURO} "q" ${BS}n`);
  assert.equal(unquoteGo(`tab${BS}tline${BS}n`), 'tab\tline\n');
});

test('a console line as k6 v2 prints it (a DEL in a body) reads back as the record', () => {
  // Captured from `k6 run` of console.log(JSON.stringify({ __r: 1, rb: 'bell\x07 del\x7f' })).
  const line = `time="2026-11-20T16:45:40+07:00" level=info msg="{${BS}"__r${BS}":1,${BS}"rb${BS}":${BS}"bell${BS}${BS}u0007 del${BS}x7f${BS}"}" source=console`;
  assert.deepEqual(JSON.parse(consoleMessageOf(line)), { __r: 1, rb: `bell${BELL} del${DEL}` });
  assert.equal(consoleMessageOf('     data_received..........: 1 kB'), null);
});

test('line splitter keeps a UTF-8 character cut between chunks and hands over the last line', () => {
  const lines = [];
  const splitter = createLineSplitter(line => lines.push(line));
  const bytes = Buffer.from(`one ${EURO}\ntwo ${EURO}\nlast`, 'utf8');
  for (let i = 0; i < bytes.length; i++) splitter.push(bytes.subarray(i, i + 1)); // one byte at a time
  assert.deepEqual(lines, [`one ${EURO}`, `two ${EURO}`]);
  splitter.end();
  assert.deepEqual(lines, [`one ${EURO}`, `two ${EURO}`, 'last']);
});

// A fake `k6` on PATH running the given shell lines; resolves with every event once onEnd ran.
async function runFakeK6(shellLines, { onEvent } = {}) {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  await writeFile(join(binDir, 'k6'), ['#!/bin/sh', ...shellLines, ''].join('\n'), 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    return await new Promise(resolve => {
      const events = [];
      startK6Run('export default function() {}', {
        onEvent: (event, data) => { events.push({ event, data }); onEvent?.(event, data); },
        onEnd: () => resolve(events),
      });
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(binDir, { recursive: true, force: true });
  }
}

const quoteSh = text => `'${text.replace(/'/g, "'\\''")}'`;

test('runner: a request record with a DEL is a req-log event and never a raw log line', async () => {
  const line = `time="t" level=info msg="{${BS}"__r${BS}":1,${BS}"i${BS}":0,${BS}"rb${BS}":${BS}"secret-token del${BS}x7f${BS}"}" source=console`;
  const events = await runFakeK6([`printf '%s\\n' ${quoteSh(line)} >&2`, 'exit 0']);
  const records = events.filter(item => item.event === 'req-log').map(item => item.data);
  assert.equal(records.length, 1);
  assert.equal(records[0].rb, `secret-token del${DEL}`);
  const logs = events.filter(item => item.event === 'log').map(item => item.data.line).join('');
  assert.doesNotMatch(logs, /secret-token|__r/);
});

test('runner: output cut inside a UTF-8 character and a last line without a newline both arrive whole', async () => {
  // E2 82 AC is the euro sign, written in two parts with a pause between them.
  const events = await runFakeK6([`printf '${BS}342${BS}202'`, 'sleep 0.2', `printf '${BS}254 euro${BS}n'`, "printf 'last line'", 'exit 0']);
  const logs = events.filter(item => item.event === 'log').map(item => item.data.line);
  assert.deepEqual(logs, [`${EURO} euro\n`, 'last line\n']);
});

test('runner: without k6 the run reports the error and ends once, with no `done`', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'k6ui-no-k6-'));
  const previousPath = process.env.PATH;
  process.env.PATH = emptyDir;
  let ends = 0;
  const events = [];
  try {
    await new Promise(resolve => {
      startK6Run('export default function() {}', {
        onEvent: (event, data) => events.push({ event, data }),
        onEnd: () => { ends++; resolve(); },
      });
    });
    await new Promise(resolve => setTimeout(resolve, 200)); // the `close` after the spawn error
  } finally {
    process.env.PATH = previousPath;
    await rm(emptyDir, { recursive: true, force: true });
  }
  assert.equal(ends, 1);
  assert.deepEqual(events.map(item => item.event), ['status', 'error']);
  assert.match(events[1].data.message, /k6 was not found/);
});

test('runner: a failure while the results are handed over is an error event, not an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const events = await runFakeK6(['exit 0'], {
      onEvent: event => { if (event === 'done') throw new Error('boom'); },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const error = events.find(item => item.event === 'error');
    assert.match(error?.data.message || '', /Failed to read the results: boom/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});
