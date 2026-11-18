// Extraction defaults: the optional `default` of an extraction is used when nothing
// matches, and is the value a skipped "Run only if" group leaves behind. Covers the
// generator (golden + execution with the k6 stubs), both importers, and the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';

import { generateScript } from '../server/generator/index.js';
import { EXTRACT_OR_SOURCE } from '../server/generator/extract.js';
import { importK6Script } from '../server/importer/index.js';
import { importJmx } from '../server/importer/jmx/index.js';
import { migrateProject } from '../public/js/project-store.js';
import { loadScript } from './helpers/load-script.js';

const assertSyntax = script => assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));

const request = (overrides = {}) => ({ method: 'GET', url: 'https://api.test/x', checkStatus: false, sleepAfter: '0', ...overrides });
const inGroup = (overrides = {}) => request({ groupId: 'grp_a', ...overrides });
const json = (varName, selector, extra = {}) => ({ varName, source: 'json', selector, ...extra });

function configOf(requests, { groups = [], variables = [], ...extra } = {}) {
  return { load: { mode: 'simple', vus: 1, duration: '1s' }, variables, scenario: { groups, requests }, ...extra };
}

// One group "Address" that runs only if MODE is ON.
const conditional = (requests, mode, variables = []) => configOf(requests, {
  variables: [{ key: 'MODE', value: mode }, ...variables],
  groups: [{ id: 'grp_a', name: 'Address', enabled: true, runIf: { variable: 'MODE', operator: 'equals', values: ['ON'] } }],
});

const bodyOf = script => script.slice(script.indexOf('export default function() {'));
const urls = calls => calls.map(call => call.url);
const generated = config => {
  const script = generateScript(config);
  assertSyntax(script);
  return script;
};

// ── Generator: golden output ──────────────────────────────────

const LOGIN = request({
  url: 'https://api.test/login',
  extractions: [
    json('token', 'data.token', { default: 'TOKEN_NOT_FOUND' }),
    { varName: 'trace', source: 'header', selector: 'X-Trace', default: 'none' },
    { varName: 'sid', source: 'regex', selector: 'sid=(\\w*)', default: 'NO_SID' },
    json('plain', 'plain'),
  ],
});
const USE = request({ url: 'https://api.test/use/{{token}}/{{trace}}/{{sid}}/{{plain}}' });

test('golden output: a default wraps the read in extractOr(); without one the line is unchanged', () => {
  const script = generated(configOf([LOGIN, USE]));
  assert.equal(bodyOf(script), `export default function() {

  // Request 1: GET https://api.test/login
  const res_main_0 = http.request("GET", "https://api.test/login", null, {});
  let token = extractOr(() => res_main_0.json("data.token"), "TOKEN_NOT_FOUND");
  let trace = extractOr(() => res_main_0.headers["X-Trace"], "none");
  let sid = extractOr(() => (res_main_0.body.match(/sid=(\\w*)/) || [])[1], "NO_SID");
  let plain = res_main_0.json("plain");

  // Request 2: GET https://api.test/use/{{token}}/{{trace}}/{{sid}}/{{plain}}
  const res_main_1 = http.request("GET", \`https://api.test/use/\${token}/\${trace}/\${sid}/\${plain}\`, null, {});
}
`);
  // The helper is written once, right before the default function.
  assert.equal(script.split('function extractOr(').length, 2);
  assert.ok(script.includes(`${EXTRACT_OR_SOURCE}\n\nexport default function() {`));
});

test('no default (absent, "" or not text): no helper, and the script is what it was before defaults', () => {
  const extractions = [
    json('token', 'data.token'),
    { varName: 'sid', source: 'regex', selector: 'sid=(\\w*)', default: '' },
    { varName: 'h', source: 'header', selector: 'X-H', default: null },
    json('o', 'o', { default: { text: 'x' } }),
  ];
  const script = generated(configOf([request({ extractions }), USE]));
  assert.doesNotMatch(script, /extractOr/);
  assert.match(script, /let token = res_main_0\.json\("data\.token"\);/);
  assert.match(script, /let sid = \(res_main_0\.body\.match\(\/sid=\(\\w\*\)\/\) \|\| \[\]\)\[1\] \|\| "";/);
  assert.match(script, /let h = res_main_0\.headers\["X-H"\];/);
  assert.match(script, /let o = res_main_0\.json\("o"\);/);
});

test('a number or boolean default is text; quotes and line separators are escaped', () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const script = generated(configOf([request({
    extractions: [json('n', 'n', { default: 0 }), json('b', 'b', { default: false }), json('q', 'q', { default: `say "hi"${lineSeparator}\`\${x}\`` })],
  }), request({ url: 'https://api.test/{{n}}/{{b}}/{{q}}' })]));
  assert.match(script, /extractOr\(\(\) => res_main_0\.json\("n"\), "0"\)/);
  assert.match(script, /extractOr\(\(\) => res_main_0\.json\("b"\), "false"\)/);
  assert.ok(!script.includes(lineSeparator), 'no raw U+2028 in the script');
  assert.ok(script.includes(`"say \\"hi\\"${'\\'}u2028\`\${x}\`"`));
  const k6 = loadScript(script);
  assert.equal(urls(k6.iteration(1, 0)).at(-1), `https://api.test/0/false/say "hi"${lineSeparator}\`\${x}\``);
});

// ── Generator: execution with the k6 stubs ────────────────────

test('nothing matched: a missing JSON path, header, or regex match gives the default', () => {
  const k6 = loadScript(generated(configOf([LOGIN, USE])), {
    respond: call => (call.url.endsWith('/login') ? { body: '{"data":{}}', headers: {} } : {}),
  });
  assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use/TOKEN_NOT_FOUND/none/NO_SID/undefined');
});

test('a body that is not JSON, or no body at all, gives the default instead of ending the iteration', () => {
  for (const body of ['<html>502 Bad Gateway</html>', null]) {
    const k6 = loadScript(generated(configOf([request({ ...LOGIN, extractions: LOGIN.extractions.slice(0, 3) }), request({ url: 'https://api.test/use/{{token}}/{{sid}}' })])), {
      respond: call => (call.url.endsWith('/login') ? { body } : {}),
    });
    assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use/TOKEN_NOT_FOUND/NO_SID', String(body));
  }
});

test('a match wins over the default, also an empty string, 0, or false (only "not found" falls back)', () => {
  const respond = body => call => (call.url.endsWith('/login') ? { body, headers: { 'X-Trace': 't-1' } } : {});
  const config = configOf([LOGIN, USE]);
  let k6 = loadScript(generated(config), { respond: respond('{"data":{"token":"T1"},"plain":"p","s":"sid=abc"}') });
  assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use/T1/t-1/abc/p');
  k6 = loadScript(generated(config), { respond: respond('{"data":{"token":""},"plain":0,"s":"sid="}') });
  assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use//t-1//0');
  k6 = loadScript(generated(config), { respond: respond('{"data":{"token":0}}') });
  assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use/0/t-1/NO_SID/undefined');
  k6 = loadScript(generated(config), { respond: respond('{"data":{"token":false}}') });
  assert.equal(urls(k6.iteration(1, 0))[1], 'https://api.test/use/false/t-1/NO_SID/undefined');
});

test('Before / After requests and gRPC use their defaults too', () => {
  const config = configOf([
    request({
      url: 'https://api.test/main',
      pre: { method: 'GET', url: 'https://api.test/pre', extractions: [json('csrf', 'csrf', { default: 'NO_CSRF' })] },
      post: { method: 'GET', url: 'https://api.test/post', extractions: [{ varName: 'loc', source: 'header', selector: 'Location', default: '/home' }] },
    }),
    { type: 'grpc', url: 'localhost:50051', grpcMethod: 'shop.Orders/Get', checkStatus: false, sleepAfter: '0', extractions: [json('order', 'order.id', { default: 'NO_ORDER' })] },
    request({ url: 'https://api.test/use/{{csrf}}/{{loc}}/{{order}}' }),
  ]);
  const k6 = loadScript(generated(config), { grpcResponse: { message: {} } });
  assert.deepEqual(urls(k6.iteration(1, 0)), [
    'https://api.test/pre', 'https://api.test/main', 'https://api.test/post', 'https://api.test/use/NO_CSRF//home/NO_ORDER',
  ]);
});

test('the helper is only written when an extraction that runs has a default', () => {
  const unusedBefore = request({ pre: { method: 'GET', url: ' ', extractions: [json('a', 'a', { default: 'A' })] } });
  assert.doesNotMatch(generated(configOf([unusedBefore])), /extractOr/, 'a Before request without a URL does not run');
  const disabled = request({ enabled: false, extractions: [json('a', 'a', { default: 'A' })] });
  assert.doesNotMatch(generated(configOf([disabled, request()])), /extractOr/, 'a disabled request does not run');
  const onlyBefore = request({ pre: { method: 'GET', url: 'https://api.test/pre', extractions: [json('a', 'a', { default: 'A' })] } });
  assert.match(generated(configOf([onlyBefore])), /function extractOr\(read, fallback\)/);
});

// ── Conditional groups ────────────────────────────────────────

const ADDRESS = inGroup({ url: 'https://api.test/addr', extractions: [json('address_id', 'data.address.id', { default: 'ADDRESS_ID_NOT_FOUND' }), json('zone', 'zone')] });
const AFTER = request({ url: 'https://api.test/after/{{address_id}}/{{zone}}' });

test('golden output: a skipped group leaves the default behind (hoisted), else ""', () => {
  const script = generated(conditional([ADDRESS, AFTER], 'OFF'));
  assert.ok(bodyOf(script).startsWith(`export default function() {

  // Extracted inside a conditional group: declared here so later requests can read them (their default, or empty, if the group does not run)
  let address_id = "ADDRESS_ID_NOT_FOUND";
  let zone = "";

  // Group "Address" runs only if MODE is ON
  if (String(GLOBALS.MODE) === "ON") {
`), bodyOf(script));
  assert.match(script, /^ {2}address_id = extractOr\(\(\) => res_main_0\.json\("data\.address\.id"\), "ADDRESS_ID_NOT_FOUND"\);$/m);
  // Without any default the comment and the hoist stay as they were.
  const plain = generated(conditional([inGroup({ extractions: [json('zone', 'zone')] }), AFTER], 'OFF'));
  assert.match(plain, /read them \(empty if the group does not run\)\n {2}let zone = "";\n/);
});

test('skipped group → default; running group → the value, or the default when it is missing', () => {
  let k6 = loadScript(generated(conditional([ADDRESS, AFTER], 'OFF')));
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/after/ADDRESS_ID_NOT_FOUND/']);

  const respond = body => call => (call.url.endsWith('/addr') ? { body } : {});
  k6 = loadScript(generated(conditional([ADDRESS, AFTER], 'ON')), { respond: respond('{"data":{"address":{"id":42}},"zone":"Z1"}') });
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/addr', 'https://api.test/after/42/Z1']);
  k6 = loadScript(generated(conditional([ADDRESS, AFTER], 'ON')), { respond: respond('{"data":{"addresses":[]}}') });
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/addr', 'https://api.test/after/ADDRESS_ID_NOT_FOUND/undefined']);
});

test('precedence of {{name}} is unchanged: a global of the same name is read until the extracting request', () => {
  const before = request({ url: 'https://api.test/before/{{address_id}}' });
  const k6 = loadScript(generated(conditional([before, ADDRESS, AFTER], 'OFF', [{ key: 'address_id', value: 'GLOBAL' }])));
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/before/GLOBAL', 'https://api.test/after/ADDRESS_ID_NOT_FOUND/']);
});

test('a name already extracted before the group keeps its value when the group is skipped', () => {
  const first = request({ url: 'https://api.test/first', extractions: [json('address_id', 'id', { default: 'FIRST_DEFAULT' })] });
  const script = generated(conditional([first, ADDRESS, AFTER], 'OFF'));
  assert.doesNotMatch(script, /let address_id = "ADDRESS_ID_NOT_FOUND"/, 'not declared twice');
  const k6 = loadScript(script, { respond: call => (call.url.endsWith('/first') ? { body: '{"id":"A7"}' } : {}) });
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/first', 'https://api.test/after/A7/']);
});

test('the hoisted value is the first default of that name in the run (Before, main, After order)', () => {
  const both = inGroup({
    pre: { method: 'GET', url: 'https://api.test/pre', extractions: [json('token', 'token')] },
    extractions: [json('token', 'data.token', { default: 'MAIN_DEFAULT' })],
  });
  const script = generated(conditional([both, request({ url: 'https://api.test/after/{{token}}' })], 'OFF'));
  assert.match(script, /\n {2}let token = "MAIN_DEFAULT";\n/);
  assert.deepEqual(urls(loadScript(script).iteration(1, 0)), ['https://api.test/after/MAIN_DEFAULT']);
});

// ── k6 script importer ────────────────────────────────────────

const extractionsOf = config => config.scenario.requests.map(r => r.extractions);

test('k6 import: K6UI scripts with defaults import back to the same extractions', () => {
  const config = conditional([LOGIN, USE, ADDRESS, AFTER], 'OFF');
  const { config: imported, warnings } = importK6Script(generateScript(config));
  assert.deepEqual(warnings, []);
  assert.deepEqual(imported.scenario.requests[0].extractions.toSorted((a, b) => a.varName.localeCompare(b.varName)),
    LOGIN.extractions.toSorted((a, b) => a.varName.localeCompare(b.varName)));
  assert.deepEqual(imported.scenario.requests[2].extractions, ADDRESS.extractions);
  assert.deepEqual(imported.scenario.groups[0].runIf, { variable: 'MODE', operator: 'equals', values: ['ON'] });
});

test('k6 import: `x || "literal"` and `x ?? "literal"` become the default; `|| ""` stays "no default"', () => {
  const { config, warnings } = importK6Script(`import http from 'k6/http';
export const options = { vus: 1, duration: '1s' };
export default function () {
  const res = http.get('https://api.test/login');
  const token = res.json('data.token') || 'TOKEN_NOT_FOUND';
  const trace = res.headers['X-Trace'] ?? \`none\`;
  const sid = (res.body.match(/sid=(\\w+)/) || [])[1] || 0;
  const plain = res.json('plain') || '';
  const nested = (res.json('n') ?? 'INNER') || 'OUTER';
  http.get(\`https://api.test/use/\${token}/\${trace}/\${sid}/\${plain}/\${nested}/\${res.json('q') ?? 'Q'}/\${res.json('q') ?? 'Q'}\`);
}
`);
  assert.deepEqual(warnings, []);
  assert.deepEqual(extractionsOf(config)[0], [
    json('token', 'data.token', { default: 'TOKEN_NOT_FOUND' }),
    { varName: 'trace', source: 'header', selector: 'X-Trace', default: 'none' },
    { varName: 'sid', source: 'regex', selector: 'sid=(\\w+)', default: '0' },
    json('plain', 'plain'),
    json('nested', 'n', { default: 'INNER' }),
    json('q', 'q', { default: 'Q' }),
  ]);
  assert.equal(config.scenario.requests[1].url, 'https://api.test/use/{{token}}/{{trace}}/{{sid}}/{{plain}}/{{nested}}/{{q}}/{{q}}');
});

test('k6 import: a fallback that is not fixed text, or extractOr() without K6UI\'s helper, is not a default', () => {
  const { config, warnings } = importK6Script(`import http from 'k6/http';
export const options = { vus: 1, duration: '1s' };
export default function () {
  const res = http.get('https://api.test/login');
  const token = res.json('data.token') || __ENV.TOKEN;
  const other = extractOr(() => res.json('id'), 'NONE');
  http.get(\`https://api.test/use/\${token}/\${other}\`);
}
`);
  assert.deepEqual(extractionsOf(config)[0], []);
  assert.match(warnings.map(w => w.message).join('\n'), /Could not convert URL/);
});

// ── JMeter importer ───────────────────────────────────────────

const jmx = children => `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan testname="Plan"/>
    <hashTree>
      <ThreadGroup testname="Users">
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">10</stringProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy testname="04 - Get Address">
          <stringProp name="HTTPSampler.domain">api.test</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/address</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree>${children}</hashTree>
        <HTTPSamplerProxy testname="05 - Use">
          <stringProp name="HTTPSampler.domain">api.test</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/use/\${address_id}</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

test('JMeter import: the Default Value of JSON, Regex and Boundary extractors becomes the default', () => {
  const { config, warnings } = importJmx(jmx(`
    <JSONPostProcessor testname="JSON Extractor - Address ID">
      <stringProp name="JSONPostProcessor.referenceNames">address_id;city;zip</stringProp>
      <stringProp name="JSONPostProcessor.jsonPathExprs">$.data.address.id;$.data.city;$.data.zip</stringProp>
      <stringProp name="JSONPostProcessor.match_numbers">1;1;1</stringProp>
      <stringProp name="JSONPostProcessor.defaultValues">ADDRESS_ID_NOT_FOUND;;\${fallback_zip}</stringProp>
    </JSONPostProcessor><hashTree/>
    <RegexExtractor testname="session">
      <stringProp name="RegexExtractor.refname">session</stringProp>
      <stringProp name="RegexExtractor.regex">sess=(\\w+)</stringProp>
      <stringProp name="RegexExtractor.template">$1$</stringProp>
      <stringProp name="RegexExtractor.default">NO_SESSION</stringProp>
    </RegexExtractor><hashTree/>
    <RegexExtractor testname="empty default">
      <stringProp name="RegexExtractor.refname">step</stringProp>
      <stringProp name="RegexExtractor.regex">step=(\\d+)</stringProp>
      <stringProp name="RegexExtractor.template">$1$</stringProp>
      <stringProp name="RegexExtractor.default"></stringProp>
      <boolProp name="RegexExtractor.default_empty_value">true</boolProp>
    </RegexExtractor><hashTree/>
    <BoundaryExtractor testname="csrf">
      <stringProp name="BoundaryExtractor.refname">csrf</stringProp>
      <stringProp name="BoundaryExtractor.lboundary">csrf="</stringProp>
      <stringProp name="BoundaryExtractor.rboundary">"</stringProp>
      <stringProp name="BoundaryExtractor.default">NO_CSRF</stringProp>
    </BoundaryExtractor><hashTree/>`));
  assert.deepEqual(config.scenario.requests[0].extractions, [
    json('address_id', 'data.address.id', { default: 'ADDRESS_ID_NOT_FOUND' }),
    json('city', 'data.city'),
    json('zip', 'data.zip'),
    { varName: 'session', source: 'regex', selector: 'sess=(\\w+)', default: 'NO_SESSION' },
    { varName: 'step', source: 'regex', selector: 'step=(\\d+)' },
    { varName: 'csrf', source: 'regex', selector: 'csrf="([\\s\\S]*?)"', default: 'NO_CSRF' },
  ]);
  const text = warnings.map(w => w.message).join('\n');
  assert.match(text, /JSONPostProcessor "JSON Extractor - Address ID" default value "\$\{fallback_zip\}" for "zip" uses a JMeter variable or function; K6UI defaults are fixed text, so the extraction has no default\./);
  assert.doesNotMatch(text, /ADDRESS_ID_NOT_FOUND|NO_SESSION|NO_CSRF/, 'a default that was read is not a warning');

  // …and it is used by the generated script.
  const k6 = loadScript(generated(config), { respond: () => ({ body: '{"data":{}}' }) });
  assert.deepEqual(urls(k6.iteration(1, 0)), ['https://api.test/address', 'https://api.test/use/ADDRESS_ID_NOT_FOUND']);
});

test('JMeter import: a JSR223 / BeanShell post-processor is skipped with a warning naming what it sets', () => {
  const { config, warnings } = importJmx(jmx(`
    <JSONPostProcessor testname="JSON Extractor - Address ID">
      <stringProp name="JSONPostProcessor.referenceNames">address_id</stringProp>
      <stringProp name="JSONPostProcessor.jsonPathExprs">$.data.address.id</stringProp>
      <stringProp name="JSONPostProcessor.defaultValues">ADDRESS_ID_NOT_FOUND</stringProp>
    </JSONPostProcessor><hashTree/>
    <JSR223PostProcessor testname="Address ID Fallback">
      <stringProp name="scriptLanguage">groovy</stringProp>
      <stringProp name="script">def addrId = vars.get(&quot;address_id&quot;)
if (addrId == &quot;ADDRESS_ID_NOT_FOUND&quot;) { vars.put(&quot;address_id&quot;, &quot;1&quot;); vars.put('source', 'fallback') }</stringProp>
    </JSR223PostProcessor><hashTree/>
    <BeanShellPostProcessor testname="Log only">
      <stringProp name="script">log.info(&quot;done&quot;);</stringProp>
    </BeanShellPostProcessor><hashTree/>`));
  assert.deepEqual(config.scenario.requests[0].extractions, [json('address_id', 'data.address.id', { default: 'ADDRESS_ID_NOT_FOUND' })]);
  const text = warnings.map(w => w.message).join('\n');
  assert.match(text, /JSR223PostProcessor "Address ID Fallback" runs groovy code, which K6UI cannot import, so it was skipped\. It sets "address_id", "source": in K6UI a variable gets only what its extraction reads, or the extraction's fixed Default when nothing matches\./);
  assert.match(text, /BeanShellPostProcessor "Log only" runs BeanShell code, which K6UI cannot import, so it was skipped\.$/m);
  assert.doesNotMatch(text, /has no K6UI equivalent/);
});

// ── Project store ─────────────────────────────────────────────

test('store: a default is kept as text, "" and non-text are dropped, and nothing is added to old projects', () => {
  const project = migrateProject({
    scenario: {
      requests: [
        {
          id: 'req_a', url: 'https://api.test/a',
          extractions: [
            json('a', 'a', { default: ' spaced ' }),
            json('b', 'b', { default: '' }),
            json('c', 'c', { default: 0 }),
            json('d', 'd', { default: null }),
            json('e', 'e', { default: ['x'], note: 'kept' }),
            json('f', 'f'),
          ],
          pre: { url: 'https://api.test/pre', extractions: [json('g', 'g', { default: true })] },
          post: { url: 'https://api.test/post', extractions: [json('h', 'h', { default: 'H' })] },
        },
        { id: 'req_b', url: 'https://api.test/b' },
      ],
    },
  });
  // The Before/After sub-requests of an older project are ordinary requests now.
  const [before, a, after, b] = project.scenario.requests;
  assert.deepEqual(a.extractions, [
    json('a', 'a', { default: ' spaced ' }),
    json('b', 'b'),
    json('c', 'c', { default: '0' }),
    json('d', 'd'),
    json('e', 'e', { note: 'kept' }),
    json('f', 'f'),
  ]);
  assert.deepEqual(before.extractions, [json('g', 'g', { default: 'true' })]);
  assert.deepEqual(after.extractions, [json('h', 'h', { default: 'H' })]);
  assert.equal('pre' in a || 'post' in a, false);
  assert.equal(Object.hasOwn(b, 'extractions'), false, 'a request without extractions gets none');
  assert.deepEqual(migrateProject(project), project, 'migration is stable');
});
