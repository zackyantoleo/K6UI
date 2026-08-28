import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

test('project save persists normalized collectConfig as readable versioned JSON', async () => {
  const js = await source('public/js/project-io.js');
  assert.match(js, /const cfg\s*=\s*collectConfig\(\)/);
  assert.match(js, /serializeProject\(cfg\)/);
  assert.match(js, /type:\s*'application\/json'/);
  assert.match(js, /download:\s*'k6-project\.json'/);
});

test('project open restores all top-level config domains and request flow', async () => {
  const js = await source('public/js/project-io.js');
  for (const fragment of [
    'cfg.load',
    'cfg.variables',
    'cfg.globalHeaders',
    'cfg.thresholds',
    'cfg.options',
    'cfg.scenario?.requests',
    'restoreZone',
  ]) {
    assert.ok(js.includes(fragment), `Expected project restore contract to include ${fragment}`);
  }
  assert.match(js, /navigate\('flow'\)/);
});

test('the exported project format is the same config collected for API generation', async () => {
  const config = await source('public/js/config.js');
  const projectIo = await source('public/js/project-io.js');
  assert.match(config, /export function collectConfig\(\)/);
  assert.match(projectIo, /import \{ collectConfig \} from '.\/config\.js'/);
});
