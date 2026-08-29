import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startK6Run } from '../server/k6-runner.js';

async function withFakeK6({ exitCode, summary }, callback) {
  const binDir = await mkdtemp(join(tmpdir(), 'k6ui-fake-bin-'));
  const fakeK6 = join(binDir, 'k6');
  await writeFile(fakeK6, `#!/bin/sh\nsummary=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--summary-export' ]; then summary="$2"; shift 2; else shift; fi\ndone\nprintf '%s' '${JSON.stringify(summary)}' > "$summary"\nexit ${exitCode}\n`, 'utf8');
  await chmod(fakeK6, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    await callback();
  } finally {
    process.env.PATH = previousPath;
  }
}

function runWithFakeK6(options) {
  return new Promise((resolve, reject) => {
    const events = [];
    withFakeK6(options, async () => {
      await startK6Run('export default function() {}', {
        onEvent: (event, data) => events.push({ event, data }),
        onEnd: () => resolve(events),
      });
    }).catch(reject);
  });
}

test('k6 runner exposes threshold-crossed outcome separately from runtime failure', async () => {
  const thresholdEvents = await runWithFakeK6({
    exitCode: 99,
    summary: { metrics: { http_reqs: { count: 12 } } },
  });
  const failedEvents = await runWithFakeK6({
    exitCode: 107,
    summary: { metrics: {} },
  });

  assert.equal(thresholdEvents.find(item => item.event === 'done')?.data.outcome, 'threshold-failed');
  assert.equal(failedEvents.find(item => item.event === 'done')?.data.outcome, 'failed');
});
