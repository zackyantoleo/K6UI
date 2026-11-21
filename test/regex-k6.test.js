// Regexes of checks and extractions with the real k6 binary (skipped when `k6` is not
// on PATH): written as safe literals (server/generator/helpers.js buildRegex), they
// keep their meaning, including syntax k6 reads and Node does not, such as "(?i)".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { generateScript } from '../server/generator/index.js';

const run = promisify(execFile);

function hasK6() {
  try {
    execFileSync('k6', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Synthetic response only: no credentials, no real service.
const BODY = 'Token=ABC123 see https://api.example.com/v1/items\nnext line';

const CHECKS = [
  '(?i)token=(\\w+)',              // inline flag: k6 only
  'https://api.example.com/v1',    // "/" in a path
  'https:\\/\\/api\\.example\\.com', // already escaped "/"
  '/API\\.EXAMPLE/i',              // /.../flags
  '[/]v1[/]',                      // "/" in a class
  'items\nnext',                   // a line break
];

test('k6 reads every regex as typed: checks pass and extractions find their values', { skip: !hasK6() && 'the k6 binary is not on PATH' }, async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    res.end(BODY);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = await mkdtemp(join(tmpdir(), 'k6ui-regex-'));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const script = generateScript({
      scenario: { requests: [
        {
          method: 'GET', url: `${base}/body`,
          assertions: CHECKS.map(value => ({ type: 'body-matches', value })),
          extractions: [
            { varName: 'token', source: 'regex', selector: '(?i)token=(\\w+)' },
            { varName: 'version', source: 'regex', selector: 'example\\.com/(\\w+)/' },
          ],
        },
        { method: 'GET', url: `${base}/seen/{{token}}/{{version}}` },
      ] },
      load: { mode: 'iterations', vus: '1', iterations: '1' },
    });
    const file = join(dir, 'test.js');
    const summary = join(dir, 'summary.json');
    await writeFile(file, script);
    await run('k6', ['run', '--quiet', '--summary-export', summary, file], {
      timeout: 60_000, env: { ...process.env, K6_NO_USAGE_REPORT: 'true' },
    });
    assert.deepEqual(paths, ['/body', '/seen/ABC123/v1']);
    const { metrics } = JSON.parse(await readFile(summary, 'utf8'));
    assert.equal(metrics.checks.fails, 0, 'every regex check passed');
    assert.ok(metrics.checks.passes >= CHECKS.length);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
