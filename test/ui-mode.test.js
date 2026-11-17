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

// ── Stage 4: "Advanced settings configured" notice (pure summary) ──────────
const noticeModule = () => import('../public/js/components/advanced-notice.js');
const req = (extra = {}) => ({
  enabled: true, groupId: '', type: 'http', preScript: '', postScript: '', extractions: [],
  assertions: [], sleepAfter: undefined, checkStatus: true, ...extra,
});
const activeCounts = summary => Object.fromEntries(summary.active.map(item => [item.id, item.count]));

test('notice summary is empty for default requests and plain groups', async () => {
  const { summarizeAdvancedSettings } = await noticeModule();
  const summary = summarizeAdvancedSettings(
    [req(), req({ sleepAfter: '1' }), req({ sleepAfter: 1, preScript: '  \n\t ', extractions: [{ varName: '  ' }] })],
    [{ id: 'grp_a', enabled: true, headers: [{ key: '  ' }] }],
  );
  assert.deepEqual(summary.active, []);
  assert.deepEqual(summary.skipped, { requests: 0, groups: 0 });
  assert.equal(summary.visible, false);
});

test('notice summary counts each advanced category once per runnable request', async () => {
  const { summarizeAdvancedSettings } = await noticeModule();
  const summary = summarizeAdvancedSettings([
    req({ type: 'grpc', preScript: 'vars.secret = "s3cr3t";' }),
    req({ postScript: 'vars.id = 1;', extractions: [{ varName: 'token' }, { varName: 'id' }] }),
    req({ assertions: [{ type: 'status-eq' }] }),
    req({ sleepAfter: '0', checkStatus: false }),
    req({ sleepAfter: '' }),
    req({ sleepAfter: '2.5', groupId: 'grp_auth' }),
  ], [
    { id: 'grp_auth', enabled: true, headers: [{ key: 'Authorization' }] },
    { id: 'grp_plain', enabled: true, headers: [] },
  ]);
  assert.deepEqual(activeCounts(summary), {
    grpc: 1, extractions: 1, checks: 1, scripts: 2, pacing: 3, statusCheck: 1, groupHeaders: 1,
  });
  assert.deepEqual(summary.active.map(item => item.unit), [
    'request', 'request', 'request', 'request', 'request', 'request', 'group',
  ]);
  assert.deepEqual(summary.skipped, { requests: 0, groups: 0 });
  assert.equal(summary.visible, true);
  assert.doesNotMatch(JSON.stringify(summary), /s3cr3t|token|127\.0\.0\.1|Authorization|vars\./,
    'the summary carries categories and counts, never values');
});

test('notice summary never reports disabled requests or groups as active', async () => {
  const { summarizeAdvancedSettings } = await noticeModule();
  const summary = summarizeAdvancedSettings([
    req({ enabled: false, preScript: 'vars.a = 1;' }),
    req({ groupId: 'grp_off', type: 'grpc' }),
    req({ groupId: 'grp_off' }),
    req({ groupId: 'grp_missing', checkStatus: false }),
  ], [
    { id: 'grp_off', enabled: false, headers: [{ key: 'X-Off' }] },
  ]);
  assert.deepEqual(activeCounts(summary), { statusCheck: 1 }, 'an unknown group ID runs like an ungrouped request');
  assert.deepEqual(summary.skipped, { requests: 2, groups: 1 });
  assert.equal(summary.visible, true);

  const onlySkipped = summarizeAdvancedSettings([req({ enabled: false, type: 'grpc' })], []);
  assert.deepEqual(onlySkipped.active, []);
  assert.deepEqual(onlySkipped.skipped, { requests: 1, groups: 0 });
  assert.equal(onlySkipped.visible, true, 'configured-but-skipped settings are still worth a notice');
});

test('notice adapter stays text-only and never collects, stores, or hydrates', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (await readFile(new URL('../public/js/components/advanced-notice.js', import.meta.url), 'utf8'))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|collectConfig|projectStore|ensureRequestPanel|localStorage/);
  assert.match(source, /textContent/);
});
