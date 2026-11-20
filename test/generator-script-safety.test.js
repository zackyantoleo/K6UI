// Text from a project never becomes code in the generated script: line breaks in
// values written into `//` comments, and extraction names that are not plain
// identifiers (server/generator/helpers.js oneLine(), extract.js validateExtractionNames()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { generateScript } from '../server/generator/index.js';

const LS = String.fromCharCode(0x2028); // a JavaScript line terminator, like \n
const load = { mode: 'simple', vus: '1', duration: '1s' };

// Every call to injected() anywhere in the script's code (comments and strings do not count).
function injectedCalls(script) {
  const found = [];
  const walk = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'injected') found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
  return found;
}

test('line breaks in a URL, method, gRPC address or group name stay inside their comment', () => {
  for (const breakChar of ['\n', '\r', LS]) {
    const script = generateScript({
      scenario: {
        groups: [{ id: 'g', name: `Group${breakChar}injected()` }],
        requests: [
          { method: 'GET', url: `https://api.test/a${breakChar}injected()`, groupId: 'g' },
          { method: `POST${breakChar}injected()`, url: 'https://api.test/b', body: '{}' },
          { type: 'grpc', url: `grpc.test:443${breakChar}injected()`, grpcMethod: 'pkg.Svc/Call', body: '{}' },
        ],
      },
      load,
    });
    assert.deepEqual(injectedCalls(script), [], JSON.stringify(breakChar));
  }
});

test('an extraction name that is not a plain identifier is a 400 naming the request', () => {
  for (const varName of ['a;injected();let b', 'user-id', '1st', 'class', 'let', 'eval', 'await']) {
    assert.throws(
      () => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', extractions: [{ varName, source: 'json', selector: 'id' }] }] }, load }),
      /Request 1: ".*" cannot be the name of an extracted value/,
      varName,
    );
  }
});

test('ordinary extraction names still generate', () => {
  for (const varName of ['token', '_id', 'order_2', 'data', 'undefinedValue']) {
    const script = generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', extractions: [{ varName, source: 'json', selector: 'id' }] }] }, load });
    assert.match(script, new RegExp(`let ${varName} = `), varName);
  }
});
