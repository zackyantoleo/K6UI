// POST /api/run runs at most MAX_RUNS tests at once (server/routes.js): one more is a
// 429 before anything starts, and a place comes back once a run's k6 has exited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server/index.js';
import { MAX_RUNS } from '../server/routes.js';

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(done => setTimeout(done, 50));
  }
  return null;
}

// Generation only: each fake k6 records its PID and sleeps; nothing is contacted.
test(`a run beyond ${MAX_RUNS} at once is a 429, and a place comes back when a run ends`, async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  const pidFile = join(binDir, 'k6.pids');
  await writeFile(join(binDir, 'k6'), `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 30\n`, 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  const server = createServer({ port: 0, host: '127.0.0.1' });
  const controllers = [];
  const pids = async () => (await readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  try {
    await once(server, 'listening');
    const start = () => {
      const controller = new AbortController();
      controllers.push(controller);
      return fetch(`http://127.0.0.1:${server.address().port}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: { requests: [{ method: 'GET', url: 'http://127.0.0.1:9/never-contacted' }] },
          load: { mode: 'simple', vus: '1', duration: '1s' },
        }),
        signal: controller.signal,
      });
    };

    for (let i = 0; i < MAX_RUNS; i++) {
      const response = await start();
      assert.equal(response.status, 200);
      await response.body.getReader().read();
    }
    assert.ok(await waitFor(async () => (await pids()).length === MAX_RUNS, 3000), 'every run started k6');

    const refused = await start();
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /tests are already running/);
    assert.equal((await pids()).length, MAX_RUNS, 'no k6 for the refused run');

    // Stop the first run: once its k6 is gone, a new run is taken again.
    const [first] = await pids();
    controllers[0].abort();
    assert.ok(await waitFor(() => !isAlive(first), 3000), 'the stopped run ended');
    const again = await waitFor(async () => {
      const response = await start();
      if (response.status === 429) return null;
      return response;
    }, 3000);
    assert.equal(again?.status, 200);
  } finally {
    controllers.forEach(controller => controller.abort());
    for (const pid of await pids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    process.env.PATH = previousPath;
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await rm(binDir, { recursive: true, force: true });
  }
});
