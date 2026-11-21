// Text from a project never becomes code in the generated script: line breaks in
// values written into `//` comments, extraction names that are not plain identifiers,
// and regexes (server/generator/helpers.js oneLine() and buildRegex(), extract.js
// validateExtractionNames()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { generateScript } from '../server/generator/index.js';
import { regexParts } from '../server/generator/helpers.js';

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

// ── Regexes (helpers.js buildRegex): a check "Body matches regex" and a regex extraction ──

const PS = String.fromCharCode(0x2029);
// The two places a regex is written, each with an extraction default after it on the
// same line (a "]" or "/" there must not help a regex end later than its own "/").
const regexScript = (pattern, fallback = ']/)), 0);injected();//') => generateScript({
  scenario: { requests: [{
    method: 'GET', url: 'https://api.test/',
    assertions: [{ type: 'body-matches', value: pattern }],
    extractions: [
      { varName: 'plain', source: 'regex', selector: pattern },
      { varName: 'withDefault', source: 'regex', selector: pattern, default: fallback },
    ],
  }] },
  load,
});

// Every regex literal in the script's code.
function regexLiterals(script) {
  const found = [];
  const walk = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && node.regex) found.push(`/${node.regex.pattern}/${node.regex.flags}`);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
  return found;
}

test('a regex never ends early: text after its own "/" or a line break stays inside it', () => {
  for (const pattern of [
    '/(?:)/.test("") || injected() || /(?:)/',  // valid as a regex too (the JMeter importer accepts it)
    '/(?:)/; injected(); /a/',
    'a/.test(""); injected(); //',
    `a${'\r'}injected();`, `a${'\n'}injected();`, `a${LS}injected();`, `a${PS}injected();`,
    `a\\${'\n'}injected();`,
    '[/]/; injected(); //]',
  ]) {
    const script = regexScript(pattern);
    assert.deepEqual(injectedCalls(script), [], JSON.stringify(pattern));
    assert.equal(regexLiterals(script).length, 3, JSON.stringify(pattern));
  }
});

test('a regex that cannot be written into the script is a 400 naming the request', () => {
  for (const [pattern, reason] of [
    ['abc\\', /ends with a "\\" that escapes nothing/],
    ['x[', /a "\[" is never closed/],              // inside [...] its own "/" would not end it
    ['[a-z', /a "\[" is never closed/],
    ['*/injected();/*', /starts with "\*"/],      // "/*" would open a comment
    ['/x/gg', /repeat a flag/],
  ]) {
    assert.throws(
      () => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', assertions: [{ type: 'body-matches', value: pattern }] }] }, load }),
      (error) => /^Request 1: the "body matches regex" check: .* is not a regular expression: /.test(error.message) && reason.test(error.message),
      pattern,
    );
    assert.throws(
      () => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', extractions: [{ varName: 'token', source: 'regex', selector: pattern }] }] }, load }),
      (error) => /^Request 1: extraction "token": .* is not a regular expression: /.test(error.message) && reason.test(error.message),
      pattern,
    );
  }
});

test('regexes as typed keep their meaning: /.../flags, an escaped "/", a "/" in a path, k6-only syntax', () => {
  const literal = pattern => regexLiterals(regexScript(pattern))[0];
  assert.equal(literal('token=(\\w+)'), '/token=(\\w+)/');
  assert.equal(literal('/token=(\\w+)/gi'), '/token=(\\w+)/gi');
  assert.equal(literal('https:\\/\\/api\\.example\\.com'), '/https:\\/\\/api\\.example\\.com/');  // already escaped: kept
  assert.equal(literal('https://api.example.com/v1'), '/https:\\/\\/api.example.com\\/v1/');
  assert.equal(literal('/api/v1/'), '/api\\/v1/');                                 // /.../ is source + flags, as before
  assert.equal(literal('[/]'), '/[\\/]/');
  assert.equal(literal(`a${'\n'}b`), '/a\\nb/');
  // k6 reads "(?i)" (Node does not, so the script is checked as text here; regex-k6.test.js runs it).
  assert.match(regexScript('(?i)token=(\\w+)'), /\(r\) => \/\(\?i\)token=\(\\w\+\)\/\.test\(r\.body \?\? ""\)/);
});

// A small deterministic generator, so a failure always reproduces.
function* randomPatterns(count, seed = 7) {
  const pieces = ['/', '\\', '[', ']', '*', '(', ')', '|', '.', '"', "'", '`', '\n', '\r', LS, PS, 'a', ';', 'injected()', '//', '/*', '*/', '\\/', '${', '}'];
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < count; n++) {
    let pattern = '';
    for (let length = 1 + Math.floor(next() * 8); length > 0; length--) pattern += pieces[Math.floor(next() * pieces.length)];
    yield pattern;
  }
}

test('random regexes: either a 400, or exactly one regex literal per place and no code from them', () => {
  let checked = 0;
  for (const pattern of randomPatterns(1000)) {
    let script;
    try {
      script = regexScript(pattern);
    } catch (error) {
      assert.match(error.message, /is not a regular expression/, JSON.stringify(pattern));
      continue;
    }
    // Patterns JavaScript itself refuses (k6 may read them) cannot be parsed here.
    const { source, flags } = regexParts(pattern);
    try { new RegExp(source, flags); } catch { continue; }
    assert.deepEqual(injectedCalls(script), [], JSON.stringify(pattern));
    assert.equal(regexLiterals(script).length, 3, JSON.stringify(pattern));
    checked += 1;
  }
  assert.ok(checked >= 100, `only ${checked} random patterns were valid regexes`);
});

// ── Extraction names the script uses itself (extract.js isScriptName) ──

// A script with every feature that adds a name inside the default function.
const fullScriptConfig = (race, extractionName = 'tok') => ({
  variables: [{ key: 'G', value: '1' }],
  dataSets: [
    { id: 'd1', name: 'Global', content: 'col1\nA\n', skipHeader: true, columns: [] },
    { id: 'd2', name: 'Grouped', content: 'col2\nB\n', skipHeader: true, columns: [], groupId: 'g', onEnd: 'stop', share: 'per-vu' },
  ],
  scenario: {
    groups: [{ id: 'g', name: 'G', runIf: { variable: 'G', operator: 'equals', values: ['1'] } }],
    requests: [
      { id: 'r1', method: 'POST', url: 'https://api.test/a/{{col1}}', body: '{"x":"{{G}}"}',
        preScript: 'vars.t = crypto.sha256("x", "hex") + encoding.b64encode("y");', postScript: 'vars.u = res.status;',
        assertions: [{ type: 'body-contains', value: 'x' }, { type: 'header-eq', value: 'X', value2: 'y' }],
        extractions: [{ varName: extractionName, source: 'json', selector: 'a', default: 'NONE' }],
        outcomes: { rules: [{ label: 'ok', status: '200', source: 'json', selector: 'a', operator: 'equals', value: '1' }], fallback: 'other' },
        expectedStatuses: '200,4xx',
        exports: [{ file: 'out.csv', columns: [{ name: 'tok', value: `{{${extractionName}}}` }, { name: 'oc', value: '{{$outcome}}' }], skipMissing: true }],
        sleepAfter: '1' },
      { id: 'r2', method: 'GET', url: 'https://api.test/b/{{col2}}/{{$outcome}}', groupId: 'g', extractions: [{ varName: 'inGroup', source: 'regex', selector: 'y', default: 'D' }] },
      { id: 'r3', type: 'grpc', url: 'localhost:9', grpcMethod: 'pkg.Svc/Call', body: '{}', grpcPlaintext: true },
      { id: 'r4', method: 'GET', url: 'https://api.test/c/{{inGroup}}', preScript: 'vars.ts = Date.now();' },
    ],
  },
  options: { logRequests: true, logFilter: 'sample', logSampleEvery: 2, logRedact: true },
  load: race
    ? { mode: 'race', vus: '2', race: { request: 'r4', timing: 'spread', spreadMs: '10', leadMs: '100', warmup: true, warmupPath: '/' } }
    : { mode: 'simple', vus: '1', duration: '1s' },
});

// Every name the default function declares at its top or reads from outside it.
function namesUsedByDefaultFunction(script) {
  const ast = parse(script, { ecmaVersion: 'latest', sourceType: 'module' });
  const fn = ast.body.find(node => node.type === 'ExportDefaultDeclaration').declaration;
  const declare = (node, into) => {
    if (node?.type === 'Identifier') into.add(node.name);
  };
  const top = new Set();
  fn.params.forEach(param => declare(param, top));
  for (const stmt of fn.body.body) if (stmt.type === 'VariableDeclaration') stmt.declarations.forEach(d => declare(d.id, top));
  const inside = new Set(top);
  const read = new Set();
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator') declare(node.id, inside);
    if (node.params) node.params.forEach(param => declare(param, inside));
    if (node.type === 'CatchClause') declare(node.param, inside);
    const isKey = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key'));
    if (node.type === 'Identifier' && !isKey) read.add(node.name);
    for (const [k, value] of Object.entries(node)) {
      if (Array.isArray(value)) value.forEach(item => walk(item, node, k));
      else if (value && typeof value === 'object') walk(value, node, k);
    }
  };
  walk(fn.body, null, null);
  return new Set([...top, ...[...read].filter(name => !inside.has(name))]);
}

test('an extraction cannot take a name the script uses itself (it would fail before the first request)', () => {
  for (const race of [false, true]) {
    const used = namesUsedByDefaultFunction(generateScript(fullScriptConfig(race)));
    for (const name of ['tok', 'inGroup', '$outcome']) used.delete(name); // the project's own names
    assert.ok(used.has('http') && used.has('res_main_0') && used.has('vars'), [...used].join(' '));
    if (race) assert.ok(used.has('data') && used.has('race_at_3'), [...used].join(' '));
    for (const name of used) {
      assert.throws(() => generateScript(fullScriptConfig(race, name)), /Request 1: the script already uses the name/, `${name} (race: ${race})`);
    }
  }
});

test('"vars" and "data" are free while the script has no processor scripts / no race burst', () => {
  const plain = varName => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', extractions: [{ varName, source: 'json', selector: 'id' }] }] }, load });
  assert.match(plain('vars'), /let vars = /);
  assert.match(plain('data'), /let data = /);
  for (const name of ['options', 'RACE', 'Counter', 'res', 'res_main', 'DATA', 'body_main_x']) assert.match(plain(name), new RegExp(`let ${name} = `), name);
  assert.throws(
    () => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', preScript: 'vars.a = 1;', extractions: [{ varName: 'vars', source: 'json', selector: 'id' }] }] }, load }),
    /Request 1: the script already uses the name "vars" \(the pre\/post-processor scripts keep their values in it\)/,
  );
});
