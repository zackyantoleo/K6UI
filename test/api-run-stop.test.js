import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server/index.js';

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

// Generation only: the fake k6 records its PID and sleeps; nothing is contacted.
test('closing the /api/run stream (UI Stop) terminates the k6 process', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  const pidFile = join(binDir, 'k6.pid');
  await writeFile(join(binDir, 'k6'), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, 'utf8');
  await chmod(join(binDir, 'k6'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  const server = createServer({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  let pid = 0;
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: { requests: [{ method: 'GET', url: 'http://127.0.0.1:9/never-contacted' }] },
        load: { mode: 'simple', vus: '1', duration: '1s' },
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    await response.body.getReader().read();
    pid = await waitFor(async () => Number(await readFile(pidFile, 'utf8').catch(() => '')) || 0, 3000);
    assert.ok(pid, 'fake k6 started');
    controller.abort();
    const stopped = await waitFor(() => !isAlive(pid), 3000);
    assert.equal(stopped, true, 'k6 is still running after the client closed the stream');
  } finally {
    if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    process.env.PATH = previousPath;
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await rm(binDir, { recursive: true, force: true });
  }
});
