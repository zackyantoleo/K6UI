// The server and the browser share only public/js/shared/: pure modules (no DOM)
// that import nothing outside that folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = join(root, 'public/js/shared');

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

// Every static import and re-export of a file, resolved to an absolute path.
function importsOf(file) {
  const ast = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  return ast.body
    .filter(node => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
    .map(node => node.source.value)
    .filter(spec => spec.startsWith('.'))
    .map(spec => resolve(dirname(file), spec));
}

test('the server imports frontend code only from public/js/shared/', () => {
  const outside = jsFiles(join(root, 'server')).flatMap(file => importsOf(file)
    .filter(target => target.startsWith(join(root, 'public')) && !target.startsWith(shared + '/'))
    .map(target => `${relative(root, file)} → ${relative(root, target)}`));
  assert.deepEqual(outside, []);
});

test('shared modules stay pure: no DOM, and no imports from outside the folder', () => {
  for (const file of jsFiles(shared)) {
    const name = relative(root, file);
    for (const target of importsOf(file)) {
      assert.ok(target.startsWith(shared + '/'), `${name} imports ${relative(root, target)}`);
    }
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\b(?:document|window|localStorage)\./, `${name} touches the DOM`);
  }
});
