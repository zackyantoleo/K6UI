import test from 'node:test';
import assert from 'node:assert/strict';

import * as uiMode from '../public/js/ui-mode.js';

test('preference writes only valid enum values and tolerates storage write failures', () => {
  assert.equal(typeof uiMode.writeUiMode, 'function', 'writeUiMode is not implemented');
  const writes = [];
  const storage = { setItem: (...args) => writes.push(args) };
  for (const value of ['simple', 'advanced', '', null, 'SIMPLE', { token: 'synthetic' }]) {
    uiMode.writeUiMode(value, storage);
  }
  assert.deepEqual(writes, [['k6ui.uiMode', 'simple'], ['k6ui.uiMode', 'advanced']]);
  assert.doesNotThrow(() => uiMode.writeUiMode('simple', { setItem() { throw new Error('quota'); } }));
  assert.doesNotThrow(() => uiMode.writeUiMode('simple', {}));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked getter'); } });
    assert.doesNotThrow(() => uiMode.writeUiMode('simple'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('unavailable storage and throwing localStorage access fall back to Advanced', () => {
  assert.equal(uiMode.readUiMode({ getItem() { throw new Error('blocked'); } }), 'advanced');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked getter'); } });
    assert.equal(uiMode.readUiMode(), 'advanced');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
  assert.equal(uiMode.readUiMode({}), 'advanced');
});

test('UI preference accepts only simple/advanced and defaults to Advanced', () => {
  assert.equal(typeof uiMode.readUiMode, 'function', 'readUiMode is not implemented');
  for (const [stored, expected] of [
    ['simple', 'simple'], ['advanced', 'advanced'], [null, 'advanced'],
    ['', 'advanced'], ['Simple', 'advanced'], [' advanced ', 'advanced'],
    ['{"uiMode":"simple"}', 'advanced'],
  ]) {
    const keys = [];
    assert.equal(uiMode.readUiMode({ getItem: key => { keys.push(key); return stored; } }), expected);
    assert.deepEqual(keys, ['k6ui.uiMode']);
  }
});
