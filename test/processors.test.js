// Pre/post-processor scripts are checked like k6 reads them (server/generator/processors.js):
// the script is a module, so strict mode, and code only sloppy mode accepts is a 400
// at generate time instead of a script k6 cannot compile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { generateScript } from '../server/generator/index.js';

const load = { mode: 'simple', vus: '1', duration: '1s' };
const withScripts = (preScript, postScript = '') => generateScript({
  scenario: { requests: [{ method: 'GET', url: 'https://api.test/', preScript, postScript }] },
  load,
});

test('code that only sloppy mode accepts is refused, naming the request', () => {
  for (const code of ['let x = 010;', 'with (Math) { vars.x = PI; }', 'let eval = 1;', 'var arguments = 2;', 'delete vars;', 'function f(a, a) {}']) {
    assert.throws(() => withScripts(code), /^Error: Pre-processor of request 1 is not valid JavaScript: /, code);
    assert.throws(() => withScripts('', code), /^Error: Post-processor of request 1 is not valid JavaScript: /, code);
  }
});

test('strict-mode code still generates, and the script parses as a module', () => {
  const script = withScripts('vars.ts = Date.now(); const n = 0o10;', 'vars.id = JSON.parse(res.body || "{}").id;');
  assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
  assert.match(script, /vars\.ts = Date\.now\(\);/);
});
