import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateScript } from '../server/generator/index.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const featureModules = [
  'basic.js',
  'headers.js',
  'body.js',
  'checks.js',
  'extract.js',
  'scripts.js',
  'advanced.js',
];

test('request editor is split into focused feature modules', async () => {
  const requestCard = await read('public/js/components/req-card.js');

  for (const moduleName of featureModules) {
    const source = await read(`public/js/components/request-editor/${moduleName}`);
    assert.ok(source.trim(), `${moduleName} must contain a feature module`);
    assert.match(requestCard, new RegExp(`request-editor/${moduleName.replace('.', '\\.')}`));
  }
});

test('advanced request panels are registered lazily instead of rendered for every collapsed card', async () => {
  const requestCard = await read('public/js/components/req-card.js');

  assert.match(requestCard, /lazyPanelFactories/);
  assert.match(requestCard, /ensureRequestPanel/);
  assert.match(requestCard, /dataset\.panelReady/);
  assert.doesNotMatch(requestCard, /body\.append\(tabs,\s*pHeaders,\s*pBody,\s*pExt,\s*pAssert,\s*pScripts,\s*pOpts\)/);
});

test('request flow exposes naming, duplicate, reorder, disable, and compact expansion controls', async () => {
  const [requestCard, flowView] = await Promise.all([
    read('public/js/components/req-card.js'),
    read('public/js/components/flow-view.js'),
  ]);
  const source = `${requestCard}\n${flowView}`;

  for (const contract of [
    /request-name/,
    /request-duplicate/,
    /request-move-up/,
    /request-move-down/,
    /request-enabled/,
    /keep-request-editors-open/,
    /setRequestExpanded/,
  ]) assert.match(source, contract);
});

test('disabled requests are preserved in project state but omitted from generated k6 code', () => {
  const script = generateScript({
    load: { mode: 'simple', vus: 1, duration: '1s' },
    variables: [],
    globalHeaders: [],
    thresholds: {},
    options: {},
    scenario: {
      requests: [
        { id: 'req_enabled', enabled: true, name: 'Enabled', type: 'http', method: 'GET', url: 'https://enabled.example.test', headers: [], assertions: [] },
        { id: 'req_disabled', enabled: false, name: 'Disabled', type: 'http', method: 'GET', url: 'https://disabled.example.test', headers: [], assertions: [] },
      ],
    },
  });

  assert.match(script, /enabled\.example\.test/);
  assert.doesNotMatch(script, /disabled\.example\.test/);
});

test('project values hydrate through DOM properties, never innerHTML', async () => {
  const projectIO = await read('public/js/project-io.js');
  assert.doesNotMatch(projectIO, /innerHTML\s*=\s*(?:req|project|config|value)/);
  assert.match(projectIO, /hydrateRequestCard/);
});
