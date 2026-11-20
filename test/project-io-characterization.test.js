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
  assert.match(js, /navigate\('flow'[,)]/);
});

test('project open resets the load modes the project does not use', async () => {
  const js = await source('public/js/project-io.js');
  const app = await source('public/js/app.js');
  const flowView = await source('public/js/components/flow-view.js');
  // Fixed VUs and Iterations fields go back to their index.html value, stages to the starting ones.
  assert.match(js, /const LOAD_FIELD_IDS = \['vus', 'duration', 'iter-vus', 'iterations', 'max-duration'\]/);
  assert.match(js, /function resetLoadFields\(\)[\s\S]*field\.value = field\.defaultValue[\s\S]*defaultStageRows\(\)/);
  // Reset before the project's own mode is filled in.
  assert.match(js, /resetLoadFields\(\);\s*if \(mode === 'simple'\)/);
  // A fresh page and a reset start from the same stages.
  assert.match(flowView, /export const DEFAULT_STAGES/);
  assert.match(app, /\$\('#stages'\)\.replaceChildren\(\.\.\.defaultStageRows\(\)\)/);
  // Race burst fields are reset to the defaults when the project is not a race burst.
  assert.match(js, /restoreRaceSettings\(mode === 'race' \? cfg\.load : \{\}\)/);
});

test('the exported project format is the same config collected for API generation', async () => {
  const config = await source('public/js/config.js');
  const projectIo = await source('public/js/project-io.js');
  assert.match(config, /export function collectConfig\(\)/);
  assert.match(projectIo, /import \{ collectConfig \} from '.\/config\.js'/);
});
