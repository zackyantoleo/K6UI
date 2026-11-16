import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from '../server/index.js';
import { generateScript } from '../server/generator/index.js';
import { ScriptImportError } from '../server/importer/index.js';
import { importJmx } from '../server/importer/jmx/index.js';
import { parse } from 'acorn';
import { migrateProject } from '../public/js/project-store.js';
import { loadScript } from './helpers/load-script.js';

const SHOP_FLOW = readFileSync(new URL('./fixtures/shop-flow.jmx', import.meta.url), 'utf8');

const TG = `<ThreadGroup testname="Users">
  <stringProp name="ThreadGroup.num_threads">5</stringProp>
  <boolProp name="ThreadGroup.scheduler">true</boolProp>
  <stringProp name="ThreadGroup.duration">60</stringProp>
</ThreadGroup>`;

// `variables`: [[name, value], ...] → the plan's User Defined Variables.
const plan = (threadChildren, { threadGroup = TG, planChildren = '', variables = [] } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    ${variables.length ? planVariables(...variables) : '<TestPlan testname="Plan"/>'}
    <hashTree>${planChildren}${threadGroup}<hashTree>${threadChildren}</hashTree></hashTree>
  </hashTree>
</jmeterTestPlan>`;

const sampler = (name, path, { method = 'GET', children = '', props = '', enabled = true } = {}) => `
<HTTPSamplerProxy testname="${name}"${enabled ? '' : ' enabled="false"'}>
  <stringProp name="HTTPSampler.domain">api.test</stringProp>
  <stringProp name="HTTPSampler.protocol">https</stringProp>
  <stringProp name="HTTPSampler.path">${path}</stringProp>
  <stringProp name="HTTPSampler.method">${method}</stringProp>${props}
</HTTPSamplerProxy>
<hashTree>${children}</hashTree>`;

const messages = (warnings) => warnings.map((w) => w.message).join('\n');

test('imports a JMeter test plan: load, variables, headers, groups, extractors, assertions, and pauses', () => {
  const { config, warnings } = importJmx(SHOP_FLOW);

  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.load, {
    mode: 'stages', vus: '20', duration: '120s',
    stages: [{ duration: '30s', target: '20' }, { duration: '90s', target: '20' }],
  });
  // ${__P(host,…)} becomes a variable with the default; ${user-name} is renamed;
  // ${__P(threads,20)} only feeds the VU count.
  assert.deepEqual(config.variables, [{ key: 'host', value: 'shop.example.com' }, { key: 'user_name', value: 'zack' }]);
  assert.deepEqual(config.globalHeaders, [{ key: 'Accept', value: 'application/json' }]);
  assert.deepEqual(config.scenario.groups.map(({ name, headers }) => ({ name, headers })), [
    { name: 'Login', headers: [{ key: 'Content-Type', value: 'application/json' }] },
    { name: 'Has product', headers: [] },
  ]);

  const [login, search, cart, old] = config.scenario.requests;
  assert.equal(config.scenario.requests.length, 4);
  assert.equal(login.url, 'https://{{host}}/api/login');
  assert.equal(login.method, 'POST');
  assert.equal(login.groupId, config.scenario.groups[0].id);
  assert.match(login.body, /"user": "\{\{user_name\}\}"/);
  // The JSON Extractor's "Default Value" (NOT_FOUND) is kept as the extraction's default.
  assert.deepEqual(login.extractions, [{ varName: 'token', source: 'json', selector: 'data.token', default: 'NOT_FOUND' }]);
  assert.deepEqual(login.assertions, [{ type: 'status-eq', value: '200', value2: '' }]);
  assert.equal(login.checkStatus, true);

  assert.equal(search.url, 'https://{{host}}/api/products?q=red%20shoes&page=1');
  assert.equal(search.groupId, '');
  assert.deepEqual(search.headers, [{ key: 'Authorization', value: 'Bearer {{token}}' }]);
  assert.deepEqual(search.extractions, [{ varName: 'productId', source: 'regex', selector: '"id":(\\d+)' }]);
  assert.deepEqual(search.assertions, [
    { type: 'body-contains', value: '"items"', value2: '' },
    { type: 'duration-lt', value: '800', value2: '' },
  ]);

  // Form parameters → urlencoded body; "Ignore status" turns the 2xx check off.
  assert.equal(cart.body, 'productId={{productId}}&qty=2');
  assert.deepEqual(cart.headers, [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  assert.equal(cart.checkStatus, false);
  assert.equal(old.enabled, false);

  // The 500 ms think time runs before every request; the 2 s Flow Control Action
  // (plus its own think time) lands after the cart request; the one before the
  // first request wraps to the end of the iteration.
  assert.deepEqual(config.scenario.requests.map((r) => r.sleepAfter), ['0.5', '0.5', '3', '0']);

  const text = messages(warnings);
  assert.match(text, /"user-name" was renamed to \{\{user_name\}\}/);
  assert.match(text, /Thread group "Admins" was skipped/);
  assert.match(text, /IfController "Has product": its logic is not supported/);
  assert.match(text, /JSR223Sampler "Compute signature" is not an HTTP request/);
  assert.doesNotMatch(text, /Cookie|View Results/);
  assert.ok(warnings.every((w) => Number.isInteger(w.line)));

  // The result is a valid project and generates a script.
  assert.equal(migrateProject(config).scenario.requests.length, 4);
  const script = generateScript(config);
  assert.match(script, /JSON\.parse\(res_main_0\.body\)\?\.\["data"\]\?\.\["token"\]/);
  assert.match(script, /Bearer \$\{token\}/);
  assert.doesNotMatch(script, /checkout-v1/);
});

test('maps response assertion modes, extractor variants, and timers', () => {
  const assertion = (name, field, type, strings, extra = '') => `
    <ResponseAssertion testname="${name}">
      <collectionProp name="Asserion.test_strings">${strings.map((s, i) => `<stringProp name="${i}">${s}</stringProp>`).join('')}</collectionProp>
      <stringProp name="Assertion.test_field">Assertion.${field}</stringProp>
      <intProp name="Assertion.test_type">${type}</intProp>${extra}
    </ResponseAssertion><hashTree/>`;
  const children = [
    assertion('not error', 'response_data', 16 | 4, ['error']),
    assertion('regex', 'response_data', 2, ['ok\\d+']),
    assertion('whole', 'response_data', 1, ['done']),
    assertion('equals', 'response_data', 8, ['a.b']),
    assertion('not 500', 'response_code', 8 | 4, ['500']),
    assertion('any 2xx', 'response_code', 1, ['2\\d\\d']),
    assertion('header', 'response_headers', 16, ['X-Trace']),
    assertion('header value', 'response_headers', 16, ['Content-Type: text/html']),
    assertion('either', 'response_data', 16 | 32, ['a', 'b']),
    assertion('dynamic', 'response_data', 16, ['${expected}']),
    assertion('message', 'response_message', 16, ['OK']),
    assertion('not regex', 'response_data', 2 | 4, ['x+']),
    `<JSONPostProcessor testname="ids">
      <stringProp name="JSONPostProcessor.referenceNames">first;all;bad</stringProp>
      <stringProp name="JSONPostProcessor.jsonPathExprs">$['items'][0].id;$.items[*].id;$..id</stringProp>
      <stringProp name="JSONPostProcessor.match_numbers">1;-1;1</stringProp>
    </JSONPostProcessor><hashTree/>`,
    `<RegexExtractor testname="whole match">
      <stringProp name="RegexExtractor.refname">session</stringProp>
      <stringProp name="RegexExtractor.regex">(?i)sess-\\w+/x</stringProp>
      <stringProp name="RegexExtractor.template">$0$</stringProp>
      <stringProp name="RegexExtractor.match_number">1</stringProp>
    </RegexExtractor><hashTree/>`,
    `<RegexExtractor testname="from headers">
      <stringProp name="RegexExtractor.useHeaders">true</stringProp>
      <stringProp name="RegexExtractor.refname">loc</stringProp>
      <stringProp name="RegexExtractor.regex">Location: (.+)</stringProp>
      <stringProp name="RegexExtractor.template">$1$</stringProp>
    </RegexExtractor><hashTree/>`,
    `<BoundaryExtractor testname="csrf">
      <stringProp name="BoundaryExtractor.refname">csrf</stringProp>
      <stringProp name="BoundaryExtractor.lboundary">name="csrf" value="</stringProp>
      <stringProp name="BoundaryExtractor.rboundary">"</stringProp>
      <stringProp name="BoundaryExtractor.match_number">1</stringProp>
    </BoundaryExtractor><hashTree/>`,
    `<UniformRandomTimer testname="jitter">
      <stringProp name="ConstantTimer.delay">1000</stringProp>
      <stringProp name="RandomTimer.range">500</stringProp>
    </UniformRandomTimer><hashTree/>`,
  ].join('');
  const { config, warnings } = importJmx(plan(sampler('Page', '/page', { children })));
  const [req] = config.scenario.requests;

  assert.deepEqual(req.assertions, [
    { type: 'body-not-contains', value: 'error', value2: '' },
    { type: 'body-matches', value: 'ok\\d+', value2: '' },
    { type: 'body-matches', value: '^(?:done)$', value2: '' },
    { type: 'body-matches', value: '^a\\.b$', value2: '' },
    { type: 'status-ne', value: '500', value2: '' },
    { type: 'status-2xx', value: '', value2: '' },
    { type: 'header-exists', value: 'X-Trace', value2: '' },
    { type: 'header-eq', value: 'Content-Type', value2: 'text/html' },
  ]);
  assert.deepEqual(req.extractions, [
    { varName: 'first', source: 'json', selector: 'items[0].id' },
    { varName: 'session', source: 'regex', selector: '/(sess-\\w+\\/x)/i' },
    { varName: 'csrf', source: 'regex', selector: 'name="csrf" value="([\\s\\S]*?)"' },
  ]);
  // A single request: the pause before it wraps to after it.
  assert.equal(req.sleepAfter, '1.25');

  const text = messages(warnings);
  for (const expected of [
    /"header value" now requires header Content-Type to be exactly "text\/html"/,
    /"either" passes when any one of several patterns matches/,
    /"dynamic" compares against a variable/,
    /"message" checks the response message/,
    /"not regex" pattern "x\+" has no K6UI equivalent/,
    /variable "all" uses match number -1/,
    /JSON path "\$\.\.id" for "bad" is not supported/,
    /"from headers" reads the response headers/,
    /Random timer "jitter" was imported as a fixed pause of its average, 1250 ms/,
  ]) {
    assert.match(text, expected);
  }

  // The regex selectors survive code generation.
  const script = generateScript(config);
  assert.match(script, /match\(\/\(sess-\\w\+\\\/x\)\/i\)/);
  assert.match(script, /\/\^\(\?:done\)\$\/\.test\(r\.body\)/);
});

test('reads loops, concurrency thread groups, nested controllers, and scoped extractors', () => {
  const loops = plan(sampler('A', '/a'), {
    threadGroup: `<ThreadGroup testname="Loops">
      <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
        <stringProp name="LoopController.loops">10</stringProp>
      </elementProp>
      <stringProp name="ThreadGroup.num_threads">3</stringProp>
      <stringProp name="ThreadGroup.ramp_time">0</stringProp>
      <boolProp name="ThreadGroup.scheduler">false</boolProp>
    </ThreadGroup>`,
  });
  // A fixed loop count without a duration is "every user runs N iterations".
  const fromLoops = importJmx(loops);
  assert.deepEqual(fromLoops.config.load, { mode: 'iterations', vus: '3', iterations: '10' });
  assert.doesNotMatch(messages(fromLoops.warnings), /iteration|ramp-up/);
  assert.match(generateScript(fromLoops.config), /"executor": "per-vu-iterations",\s+"vus": 3,\s+"iterations": 10,\s+"maxDuration": "1h"/);

  // Ramp-up is not supported there: all users start at once, with a warning (not for a single user).
  const ramped = importJmx(plan(sampler('A', '/a'), { threadGroup: loops.match(/<ThreadGroup[\s\S]*<\/ThreadGroup>/)[0].replace('ramp_time">0<', 'ramp_time">5<') }));
  assert.deepEqual(ramped.config.load, { mode: 'iterations', vus: '3', iterations: '10' });
  assert.match(messages(ramped.warnings), /ramps up its 3 users over 5s; in iterations mode K6UI starts all users at once/);

  // Forever loops and a scheduler duration keep the duration-based profile.
  const threadGroupWith = (loopsValue, extra = '') => `<ThreadGroup testname="Loops">
      <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
        <stringProp name="LoopController.loops">${loopsValue}</stringProp>
      </elementProp>
      <stringProp name="ThreadGroup.num_threads">3</stringProp>${extra}
    </ThreadGroup>`;
  const forever = importJmx(plan(sampler('A', '/a'), { threadGroup: threadGroupWith('-1') }));
  assert.deepEqual(forever.config.load, { mode: 'simple', vus: '3', duration: '30s', stages: [] });
  assert.match(messages(forever.warnings), /loops until it is stopped/);
  const timed = importJmx(plan(sampler('A', '/a'), {
    threadGroup: threadGroupWith('10', '<boolProp name="ThreadGroup.scheduler">true</boolProp><stringProp name="ThreadGroup.duration">90</stringProp>'),
  }));
  assert.deepEqual(timed.config.load, { mode: 'simple', vus: '3', duration: '90s', stages: [] });
  const noLoops = importJmx(plan(sampler('A', '/a'), { threadGroup: threadGroupWith('0') }));
  assert.deepEqual(noLoops.config.load, { mode: 'iterations', vus: '3', iterations: '1' });
  assert.match(messages(noLoops.warnings), /has 0 loops; K6UI needs a whole number of at least 1/);

  const concurrency = plan(sampler('A', '/a'), {
    threadGroup: `<com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup testname="Ramp">
      <stringProp name="TargetLevel">50</stringProp>
      <stringProp name="RampUp">2</stringProp>
      <stringProp name="Hold">5</stringProp>
      <stringProp name="Unit">M</stringProp>
    </com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup>`,
  });
  assert.deepEqual(importJmx(concurrency).config.load.stages, [
    { duration: '120s', target: '50' }, { duration: '300s', target: '50' },
  ]);

  const nested = plan(`
    <JSONPostProcessor testname="shared id">
      <stringProp name="JSONPostProcessor.referenceNames">id</stringProp>
      <stringProp name="JSONPostProcessor.jsonPathExprs">$.id</stringProp>
    </JSONPostProcessor><hashTree/>
    <TransactionController testname="Outer"/>
    <hashTree>
      <GenericController testname="Inner" enabled="false"/>
      <hashTree>
        <HeaderManager testname="h">
          <collectionProp name="HeaderManager.headers">
            <elementProp name="" elementType="Header">
              <stringProp name="Header.name">X-Inner</stringProp>
              <stringProp name="Header.value">\${__UUID()}</stringProp>
            </elementProp>
          </collectionProp>
        </HeaderManager><hashTree/>
        ${sampler('B', '/b?x=1', { props: `
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
            <collectionProp name="Arguments.arguments">
              <elementProp name="y" elementType="HTTPArgument">
                <stringProp name="Argument.name">y</stringProp>
                <stringProp name="Argument.value">2</stringProp>
              </elementProp>
            </collectionProp>
          </elementProp>` })}
      </hashTree>
      ${sampler('C', '/c')}
    </hashTree>
    <ModuleController testname="Reuse"/><hashTree/>
    <CSVDataSet testname="Users">
      <stringProp name="filename">users.csv</stringProp>
      <stringProp name="variableNames">email,password</stringProp>
    </CSVDataSet><hashTree/>`);
  const { config, warnings } = importJmx(nested);
  const [b, c] = config.scenario.requests;
  assert.equal(config.scenario.groups.length, 1);
  assert.equal(b.groupId, config.scenario.groups[0].id);
  assert.equal(c.groupId, b.groupId);
  assert.equal(b.enabled, false);
  assert.equal(c.enabled, true);
  assert.equal(b.url, 'https://api.test/b?x=1&y=2');
  assert.deepEqual(b.headers, [{ key: 'X-Inner', value: '${__UUID()}' }]);
  assert.deepEqual(b.extractions, [{ varName: 'id', source: 'json', selector: 'id' }]);
  assert.deepEqual(c.extractions, []);

  const text = messages(warnings);
  assert.match(text, /Nested controller "Inner" was merged into group "Outer"/);
  assert.match(text, /JMeter function \$\{__UUID\(\)\} in header "X-Inner" has no K6UI equivalent/);
  assert.match(text, /"shared id" applies to every request in its scope in JMeter; K6UI attached it to the first one, "B"/);
  assert.match(text, /ModuleController "Reuse" is not supported/);
  assert.doesNotMatch(text, /is not supported; \$\{email\}/, 'the old "not supported" warning is gone');
  assert.match(text, /CSV Data Set "Users" was imported without data.*Upload "users\.csv" under Data & Rules/);
  assert.deepEqual(config.dataSets, [{
    id: 'ds_jmx_1', name: 'Users', fileName: 'users.csv', delimiter: ',', skipHeader: false,
    columns: ['email', 'password'], content: '', share: 'next-row', onEnd: 'recycle',
  }]);
});

test('keeps the case of a ${VAR} protocol, so the URL placeholder matches its variable', () => {
  const udv = (name, value) => `<elementProp name="${name}" elementType="Argument">
    <stringProp name="Argument.name">${name}</stringProp>
    <stringProp name="Argument.value">${value}</stringProp>
  </elementProp>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan testname="Plan">
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments">
        <collectionProp name="Arguments.arguments">
          ${udv('BASE_URL', 'api.test')}${udv('PROTOCOL', 'https')}${udv('PORT', '443')}
        </collectionProp>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ConfigTestElement testname="HTTP Request Defaults">
        <stringProp name="HTTPSampler.domain">\${BASE_URL}</stringProp>
        <stringProp name="HTTPSampler.port">\${PORT}</stringProp>
        <stringProp name="HTTPSampler.protocol">\${PROTOCOL}</stringProp>
      </ConfigTestElement><hashTree/>
      ${TG}<hashTree>
        <HTTPSamplerProxy testname="Ping">
          <stringProp name="HTTPSampler.path">/ping</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy><hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

  const { config } = importJmx(xml);
  assert.equal(config.scenario.requests[0].url, '{{PROTOCOL}}://{{BASE_URL}}:{{PORT}}/ping');

  const script = generateScript(config);
  assert.match(script, /`\$\{GLOBALS\.PROTOCOL\}:\/\/\$\{GLOBALS\.BASE_URL\}:\$\{GLOBALS\.PORT\}\/ping`/);
  assert.doesNotMatch(script, /`[^`]*\{\{/); // no unresolved placeholder inside a URL template
});

test('rejects files that cannot be imported, with a readable reason', () => {
  assert.throws(() => importJmx('  '), ScriptImportError);
  assert.throws(() => importJmx('<jmeterTestPlan><hashTree>'), /not a valid \.jmx file: <hashTree> is never closed/);
  assert.throws(() => importJmx('<a>&bogus;</a>'), /Unknown entity &bogus;/);
  assert.throws(() => importJmx('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'), /DOCTYPE/);
  assert.throws(() => importJmx('<project></project>'), /root element is <project>/);
  assert.throws(
    () => importJmx(plan('', { threadGroup: TG.replace('<ThreadGroup', '<ThreadGroup enabled="false"') })),
    /No enabled thread group/,
  );
  assert.throws(
    () => importJmx(plan('<JDBCSampler testname="db"/><hashTree/>')),
    (err) => err instanceof ScriptImportError && /has no HTTP requests/.test(err.message) && /JDBCSampler "db"/.test(messages(err.warnings)),
  );
});

let server;
let baseUrl;

before(async () => {
  server = createServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
});

test('POST /api/import-jmx takes the raw .jmx and returns the configuration, or a 400 with the reason', async () => {
  const post = (body) => fetch(`${baseUrl}/api/import-jmx`, {
    method: 'POST', headers: { 'content-type': 'application/xml' }, body,
  });

  const ok = await post(SHOP_FLOW);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.config.scenario.requests.length, 4);
  assert.ok(body.warnings.length > 0);

  const bad = await post('<jmeterTestPlan>');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not a valid \.jmx file/);

  const empty = await post('');
  assert.equal(empty.status, 400);
});

// ── CSV Data Set Config → data files ───────────────────────────

const udv = (name, value) => `<elementProp name="${name}" elementType="Argument">
  <stringProp name="Argument.name">${name}</stringProp>
  <stringProp name="Argument.value">${value}</stringProp>
</elementProp>`;

const planVariables = (...pairs) => `<TestPlan testname="Plan">
  <elementProp name="TestPlan.user_defined_variables" elementType="Arguments">
    <collectionProp name="Arguments.arguments">${pairs.map(([name, value]) => udv(name, value)).join('')}</collectionProp>
  </elementProp>
</TestPlan>`;

const csvSet = (testname, props, { enabled = true } = {}) => `
<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="${testname}"${enabled ? '' : ' enabled="false"'}>
  ${Object.entries(props).map(([key, value]) => (typeof value === 'boolean'
    ? `<boolProp name="${key}">${value}</boolProp>`
    : `<stringProp name="${key}">${value}</stringProp>`)).join('\n  ')}
</CSVDataSet><hashTree/>`;

test('CSV Data Sets become data files: columns, header, delimiter, share mode, and end of file', () => {
  const xml = plan(`
    ${csvSet('Users Login', {
      delimiter: ',', filename: '${LOGIN_CSV_FILE}', ignoreFirstLine: true, recycle: false,
      shareMode: 'shareMode.all', stopThread: true, variableNames: 'email,password',
    })}
    ${sampler('Login', '/login?u=${email}&amp;p=${password}')}
    ${csvSet('Orders', {
      filename: '${ORDER_CSV_FILE}', variableNames: 'order_number,auth', ignoreFirstLine: true,
      recycle: false, stopThread: true, shareMode: 'shareMode.all',
    })}
    ${sampler('Create Order', '/orders', {
      method: 'POST',
      children: `<JSONPostProcessor testname="order"><stringProp name="JSONPostProcessor.referenceNames">order_number</stringProp><stringProp name="JSONPostProcessor.jsonPathExprs">$.id</stringProp></JSONPostProcessor><hashTree/>`,
    })}
    ${sampler('Redeem', '/redeem/${order_number}?t=${auth}')}`, {
    planChildren: '',
  }).replace('<TestPlan testname="Plan"/>', planVariables(['LOGIN_CSV_FILE', 'login.csv'], ['ORDER_CSV_FILE', 'orders_created.csv']));

  const { config, warnings } = importJmx(xml);
  assert.deepEqual(config.dataSets, [
    {
      id: 'ds_jmx_1', name: 'Users Login', fileName: 'login.csv', delimiter: ',', skipHeader: true,
      columns: ['email', 'password'], content: '', share: 'next-row', onEnd: 'stop',
    },
    {
      id: 'ds_jmx_2', name: 'Orders', fileName: 'orders_created.csv', delimiter: ',', skipHeader: true,
      columns: ['order_number', 'auth'], content: '', share: 'next-row', onEnd: 'stop',
    },
  ]);
  // The file names are not kept as global variables; ${email} is the same {{email}} the file feeds.
  assert.deepEqual(config.variables.map((v) => v.key), ['LOGIN_CSV_FILE', 'ORDER_CSV_FILE']);
  assert.equal(config.scenario.requests[0].url, 'https://api.test/login?u={{email}}&p={{password}}');

  const text = messages(warnings);
  assert.match(text, /CSV Data Set "Users Login" was imported without data.*Upload "login\.csv" under Data & Rules/);
  assert.match(text, /CSV Data Set "Orders" was imported without data.*Upload "orders_created\.csv" under Data & Rules/);
  assert.match(text, /Column "order_number" of "orders_created\.csv" has the same name as a variable extracted by "Create Order"/);
  assert.doesNotMatch(text, /Column "(?:email|password|auth)"/);
  assert.doesNotMatch(text, /is not supported/);

  // With rows filled in, the project generates a script that feeds the placeholders.
  const filled = {
    ...config,
    dataSets: [
      { ...config.dataSets[0], content: 'email,password\nuser1@example.com,pass1\nuser2@example.com,pass2\n' },
      { ...config.dataSets[1], content: 'order_number,auth\nA-1,tok1\n' },
    ],
  };
  const script = generateScript(migrateProject(filled));
  assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
  assert.match(script, /DATA_1\[exec\.scenario\.iterationInTest\]/);
  assert.match(script, /login\?u=\$\{DATA_1_ROW\.email\}&p=\$\{DATA_1_ROW\.password\}/);
  assert.match(script, /redeem\/\$\{order_number\}\?t=\$\{DATA_2_ROW\.auth\}/, 'after Create Order, the extracted order_number wins');
});

test('CSV Data Set details: tab delimiter, share modes, recycle, paths, and file name variables', () => {
  const xml = plan(`
    ${csvSet('Tabbed', { delimiter: '\\t', filename: 'C:\\data\\users.tsv', variableNames: 'user-id,name', ignoreFirstLine: true, recycle: true, stopThread: false, shareMode: 'shareMode.thread' })}
    ${csvSet('Param file', { filename: '${__P(rows_file,/tmp/rows.csv)}', variableNames: 'a,,c,', recycle: false, stopThread: false, shareMode: 'shareMode.group' })}
    ${csvSet('Missing', { filename: '${MISSING_FILE}', variableNames: 'x' })}
    ${csvSet('No names', { filename: 'plain.csv', variableNames: '' })}
    ${csvSet('Off', { filename: 'off.csv', variableNames: 'off_col' }, { enabled: false })}
    ${sampler('Home', '/')}`);
  const { config, warnings } = importJmx(xml);
  const [tabbed, param, missing, noNames] = config.dataSets;
  assert.equal(config.dataSets.length, 4, 'a disabled CSV Data Set is not imported');

  assert.deepEqual({ ...tabbed, id: undefined }, {
    id: undefined, name: 'Tabbed', fileName: 'users.tsv', delimiter: '\t', skipHeader: true,
    columns: ['user_id', 'name'], content: '', share: 'per-vu', onEnd: 'recycle',
  });
  assert.equal(param.fileName, 'rows.csv', 'the path is dropped; the property default names the file');
  assert.deepEqual(param.columns, ['a', '', 'c'], 'blank names keep the file column positions');
  assert.equal(param.share, 'per-vu');
  assert.equal(param.onEnd, 'stop');
  assert.ok(!config.variables.some((v) => v.key === 'rows_file'), 'the property default is not kept as a variable');
  assert.equal(missing.fileName, '${MISSING_FILE}');
  assert.deepEqual(noNames, { ...noNames, columns: [], skipHeader: true });

  const text = messages(warnings);
  assert.match(text, /JMeter variable "user-id" was renamed to \{\{user_id\}\}/);
  assert.match(text, /"Tabbed" uses the share mode "shareMode\.thread".*one row per VU/);
  assert.match(text, /"Param file" keeps running with "<EOF>" values.*ends the iteration instead/);
  assert.match(text, /file name of CSV Data Set "Missing" uses \$\{MISSING_FILE\}/);
  assert.match(text, /"No names" has no variable names.*first line of the file; upload "plain\.csv"/);
  assert.doesNotMatch(text, /off\.csv|off_col/);
});

test('a CSV Data Set directly inside a controller belongs to that group and needs no warning', () => {
  const xml = plan(`<TransactionController testname="Checkout"/><hashTree>
    ${csvSet('Cards', { filename: 'cards.csv', variableNames: 'card' })}
    ${sampler('Pay', '/pay?c=${card}')}
  </hashTree>`);
  const { config, warnings } = importJmx(xml);
  assert.equal(config.dataSets.length, 1);
  assert.equal(config.dataSets[0].groupId, config.scenario.groups[0].id);
  assert.doesNotMatch(messages(warnings), /sits inside/);
});

// ── If Controller → a group's "run only if" ────────────────────

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const ifController = (testname, condition, children, { useExpression = true, evaluateAll = false, enabled = true } = {}) => `
<IfController guiclass="IfControllerPanel" testclass="IfController" testname="${testname}"${enabled ? '' : ' enabled="false"'}>
  <stringProp name="IfController.condition">${escapeXml(condition)}</stringProp>
  <boolProp name="IfController.evaluateAll">${evaluateAll}</boolProp>
  <boolProp name="IfController.useExpression">${useExpression}</boolProp>
</IfController><hashTree>${children}</hashTree>`;

// The condition the eratech flow uses, exactly as JMeter writes it.
const ERATECH = (modes) => `\${__groovy(def m = props.get('EXECUTION_MODE') ?: vars.get('EXECUTION_MODE'); return ${modes.map((mode) => `m == '${mode}'`).join(' || ')})}`;

const groupsOf = (xml) => importJmx(xml).config.scenario.groups;
const conditionOf = (condition) => groupsOf(plan(
  `${ifController('Branch', condition, sampler('Inside', '/inside'))}${sampler('Outside', '/outside')}`,
  { variables: [['X', 'A']] },
))[0]?.runIf;

test('an If Controller with an EXECUTION_MODE condition becomes a group with "run only if"; a disabled one stays disabled', () => {
  const xml = plan(`
    ${ifController('Order Flow', ERATECH(['ORDER_FLOW', 'ALL']), `
      ${csvSet('Users Login', { filename: '${LOGIN_CSV_FILE}', ignoreFirstLine: true, recycle: false, shareMode: 'shareMode.all', stopThread: true, variableNames: 'email,password' })}
      ${sampler('Login', '/login?u=${email}&amp;p=${password}')}`)}
    ${ifController('Redeem Flow', ERATECH(['REDEEM_FLOW', 'ALL']), `
      ${csvSet('Orders CSV', { filename: '${ORDER_CSV_FILE}', ignoreFirstLine: true, recycle: false, shareMode: 'shareMode.all', stopThread: true, variableNames: 'order_number,auth' })}
      ${sampler('Redeem', '/redeem/${order_number}?t=${auth}')}`, { enabled: false })}`,
  { variables: [['LOGIN_CSV_FILE', 'login.csv'], ['ORDER_CSV_FILE', 'orders_created.csv'], ['EXECUTION_MODE', 'ORDER_FLOW']] });
  const { config, warnings } = importJmx(xml);

  assert.deepEqual(config.scenario.groups.map(({ id, name, enabled, runIf }) => ({ id, name, enabled, runIf })), [
    { id: 'grp_jmx_1', name: 'Order Flow', enabled: true, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['ORDER_FLOW', 'ALL'] } },
    { id: 'grp_jmx_2', name: 'Redeem Flow', enabled: false, runIf: { variable: 'EXECUTION_MODE', operator: 'one-of', values: ['REDEEM_FLOW', 'ALL'] } },
  ]);
  assert.deepEqual(config.scenario.requests.map((r) => r.groupId), ['grp_jmx_1', 'grp_jmx_2']);
  assert.deepEqual(config.variables.find((v) => v.key === 'EXECUTION_MODE'), { key: 'EXECUTION_MODE', value: 'ORDER_FLOW' });
  // Each CSV remembers the group it sits in; nothing about it is global.
  assert.deepEqual(config.dataSets.map((d) => [d.fileName, d.groupId]), [['login.csv', 'grp_jmx_1'], ['orders_created.csv', 'grp_jmx_2']]);

  const text = messages(warnings);
  assert.doesNotMatch(text, /logic is not supported/);
  assert.doesNotMatch(text, /sits inside a controller/);
  assert.match(text, /group "Order Flow" also reads the JMeter property "EXECUTION_MODE" \(-JEXECUTION_MODE=\.\.\.\); K6UI only reads the global variable/);
  // A column of a data file whose group is off cannot clash with anything.
  assert.doesNotMatch(text, /Column "order_number"/);

  // With synthetic rows the project generates: ORDER_FLOW runs the first group only.
  const generate = (mode) => generateScript(migrateProject({
    ...config,
    variables: config.variables.map((v) => (v.key === 'EXECUTION_MODE' ? { ...v, value: mode } : v)),
    dataSets: [
      { ...config.dataSets[0], content: 'email,password\nuser1@example.com,pass1\n' },
      { ...config.dataSets[1], content: 'order_number,auth\nA-1,tok1\n' },
    ],
  }));
  const script = generate('ORDER_FLOW');
  assert.doesNotThrow(() => parse(script, { ecmaVersion: 'latest', sourceType: 'module' }));
  assert.doesNotMatch(script, /redeem/);
  assert.doesNotMatch(script, /DATA_2/, 'the data file of a turned-off group is not in the script');
  assert.deepEqual(urls(loadScript(script).iteration(1, 0)), ['https://api.test/login?u=user1@example.com&p=pass1']);
  assert.deepEqual(urls(loadScript(generate('REDEEM_FLOW')).iteration(1, 0)), []);
});

const urls = (calls) => calls.map((call) => call.url);

test('the condition shapes that are read: groovy lookups, ${X} forms, != and ||, in the right mode', () => {
  const eq = (...values) => ({ variable: 'X', operator: values.length > 1 ? 'one-of' : 'equals', values });
  // Variable expression mode (the default): the condition is a function call.
  assert.deepEqual(conditionOf(`\${__groovy(vars.get('X') == 'A')}`), eq('A'));
  assert.deepEqual(conditionOf(`\${__groovy(props.get("X") == "A")}`), eq('A'));
  assert.deepEqual(conditionOf(`\${__groovy(vars.get('X') != 'A')}`), { variable: 'X', operator: 'not-equals', values: ['A'] });
  assert.deepEqual(conditionOf(`\${__groovy(def m = vars.get('X'); m == 'A')}`), eq('A'));
  assert.deepEqual(conditionOf(`\${__groovy(String m = props.get('X') ?: vars.get('X'); return (m == 'A' || m == 'B') || m == 'A';)}`), eq('A', 'B'));
  assert.deepEqual(conditionOf(`\${__groovy('A' == vars.get('X'))}`), eq('A'));
  assert.deepEqual(conditionOf(`\${__jexl3("\${X}" == "A")}`), eq('A'));
  assert.deepEqual(conditionOf(`\${__javaScript('\${X}' != 'A')}`), { variable: 'X', operator: 'not-equals', values: ['A'] });
  // JavaScript mode: the condition is the expression itself.
  const jsOf = (condition) => groupsOf(plan(
    ifController('Branch', condition, sampler('Inside', '/inside'), { useExpression: false }),
    { variables: [['X', 'A']] },
  ))[0]?.runIf;
  assert.deepEqual(jsOf('${X} == "A"'), eq('A'));
  assert.deepEqual(jsOf('"${X}" == "A"'), eq('A'));
  assert.deepEqual(jsOf("'${X}' == 'A'"), eq('A'));
  assert.deepEqual(jsOf('"${X}" != "A"'), { variable: 'X', operator: 'not-equals', values: ['A'] });
  assert.deepEqual(jsOf('"${X}" == "A" || "${X}" == "B" || "${X}" == "C"'), eq('A', 'B', 'C'));
  assert.deepEqual(jsOf('"${X}"==="A"'), eq('A'));
});

test('a condition that is not one of those shapes keeps the group always running, quotes the text, and keeps the requests', () => {
  const unreadable = [
    ['an empty value', `\${__jexl3("\${X}" != "")}`],
    ['two different variables', `\${__groovy(vars.get('X') == 'A' || vars.get('Y') == 'B')}`],
    ['and', `\${__groovy(vars.get('X') == 'A' && vars.get('Y') == 'B')}`],
    ['!= joined by ||', `\${__groovy(vars.get('X') != 'A' || vars.get('X') != 'B')}`],
    ['mixed == and !=', `\${__groovy(vars.get('X') == 'A' || vars.get('X') != 'B')}`],
    ['a bound name of another variable', `\${__groovy(def m = props.get('X') ?: vars.get('Y'); m == 'A')}`],
    ['a value with a comma', `\${__groovy(vars.get('X') == 'A,B')}`],
    ['a value with spaces around it', `\${__groovy(vars.get('X') == ' A')}`],
    ['a method call', `\${__groovy(vars.get('X').startsWith('A'))}`],
    ['plain text', 'true'],
    ['a function that is not a comparison', '${__P(run,true)}'],
    ['a bare comparison in variable expression mode', '"${X}" == "A"'],
    ['a function in JavaScript mode', `\${__groovy(vars.get('X') == 'A')}`, { useExpression: false }],
    ['groovy lookups in JavaScript mode', "vars.get('X') == 'A'", { useExpression: false }],
  ];
  for (const [label, condition, options] of unreadable) {
    const xml = plan(`${ifController('Branch', condition, sampler('Inside', '/inside'), options)}`, { variables: [['X', 'A']] });
    const { config, warnings } = importJmx(xml);
    assert.equal(config.scenario.groups[0].runIf, undefined, label);
    assert.equal(config.scenario.requests[0].groupId, config.scenario.groups[0].id, label);
    assert.equal(config.scenario.groups[0].enabled, true, label);
    const text = messages(warnings);
    assert.match(text, /IfController "Branch": its logic is not supported \(condition: /, label);
    assert.ok(text.includes(condition.trim().slice(0, 30)), `${label}: the warning quotes the condition`);
    assert.match(text, /imported to run once per iteration, in order/, label);
  }
});

test('a long condition is shortened in the warning', () => {
  const long = `\${__groovy(${Array.from({ length: 30 }, (_, i) => `vars.get('V${i}') == 'A'`).join(' || ')})}`;
  const { warnings } = importJmx(plan(ifController('Branch', long, sampler('Inside', '/inside'))));
  assert.match(messages(warnings), /\(condition: \$\{__groovy\(vars\.get\('V0'\) == 'A'.*\.\.\.\)/);
});

test('"Evaluate for all children" is noted; the condition is still imported', () => {
  const { config, warnings } = importJmx(plan(
    ifController('Branch', `\${__groovy(vars.get('X') == 'A')}`, sampler('Inside', '/inside'), { evaluateAll: true }),
    { variables: [['X', 'A']] },
  ));
  assert.deepEqual(config.scenario.groups[0].runIf, { variable: 'X', operator: 'equals', values: ['A'] });
  assert.match(messages(warnings), /IfController "Branch" checks its condition before every child in JMeter.*K6UI checks it once, when the group starts/);
});

test('a condition variable with no value in the plan becomes an empty global variable, with a warning', () => {
  const { config, warnings } = importJmx(plan(ifController('Branch', `\${__groovy(vars.get('MODE') == 'A')}`, sampler('Inside', '/inside'))));
  assert.deepEqual(config.variables, [{ key: 'MODE', value: '' }]);
  assert.match(messages(warnings), /The condition of group "Branch" reads "MODE", which has no value in the plan; it became an empty global variable\. Set its value/);
  // A variable the plan does define is left alone, and no warning is made up.
  const defined = importJmx(plan(ifController('Branch', `\${__groovy(vars.get('MODE') == 'A')}`, sampler('Inside', '/inside')), { variables: [['MODE', 'A']] }));
  assert.deepEqual(defined.config.variables, [{ key: 'MODE', value: 'A' }]);
  assert.doesNotMatch(messages(defined.warnings), /no value in the plan/);
});

test('a condition variable is renamed like any other JMeter variable', () => {
  const { config, warnings } = importJmx(plan(
    ifController('Branch', '"${run-mode}" == "A"', sampler('Inside', '/inside'), { useExpression: false }),
    { variables: [['run-mode', 'A']] },
  ));
  assert.deepEqual(config.scenario.groups[0].runIf, { variable: 'run_mode', operator: 'equals', values: ['A'] });
  assert.deepEqual(config.variables, [{ key: 'run_mode', value: 'A' }]);
  assert.match(messages(warnings), /JMeter variable "run-mode" was renamed to \{\{run_mode\}\}/);
});

test('an If Controller deeper than the thread group is merged into its group and its condition is ignored', () => {
  const xml = plan(`<TransactionController testname="Checkout"/><hashTree>
    ${ifController('Inner', `\${__groovy(vars.get('X') == 'A')}`, sampler('Pay', '/pay'))}
    ${sampler('Receipt', '/receipt')}
  </hashTree>`, { variables: [['X', 'A']] });
  const { config, warnings } = importJmx(xml);
  assert.equal(config.scenario.groups.length, 1);
  assert.equal(config.scenario.groups[0].runIf, undefined);
  assert.deepEqual(config.scenario.requests.map((r) => r.groupId), ['grp_jmx_1', 'grp_jmx_1']);
  const text = messages(warnings);
  assert.match(text, /IfController "Inner" sits inside group "Checkout": its condition was ignored, so its requests run whenever that group runs/);
  assert.doesNotMatch(text, /logic is not supported/);
  assert.equal(config.variables.some((v) => v.key === 'X' && v.value === 'A'), true);
  // A nested If Controller that is turned off keeps its requests disabled.
  const off = importJmx(plan(`<TransactionController testname="Checkout"/><hashTree>
    ${ifController('Inner', 'true', sampler('Pay', '/pay'), { enabled: false })}
  </hashTree>`)).config;
  assert.equal(off.scenario.requests[0].enabled, false);
});

test('a CSV Data Set in a nested controller reads with its group; one in a disabled nested controller is dropped', () => {
  const xml = plan(`<TransactionController testname="Checkout"/><hashTree>
    <GenericController testname="Deeper"/><hashTree>
      ${csvSet('Cards', { filename: 'cards.csv', variableNames: 'card' })}
      ${sampler('Pay', '/pay?c=${card}')}
    </hashTree>
    <GenericController testname="Dead" enabled="false"/><hashTree>
      ${csvSet('Ghosts', { filename: 'ghosts.csv', variableNames: 'ghost' })}
      ${sampler('Haunt', '/haunt')}
    </hashTree>
    ${csvSet('Direct', { filename: 'direct.csv', variableNames: 'direct' })}
  </hashTree>`);
  const { config, warnings } = importJmx(xml);
  assert.deepEqual(config.dataSets.map((d) => [d.fileName, d.groupId]).sort(), [['cards.csv', 'grp_jmx_1'], ['direct.csv', 'grp_jmx_1']]);
  const text = messages(warnings);
  assert.match(text, /"Cards" sits inside a controller nested in group "Checkout"; K6UI reads its row when that group starts/);
  assert.match(text, /"Ghosts" sits inside a disabled controller inside group "Checkout" and was skipped/);
  assert.doesNotMatch(text, /"Direct" sits inside/);
});

test('a group that only holds a CSV Data Set stays, so the data file keeps pointing at it', () => {
  const xml = plan(`${ifController('Only data', `\${__groovy(vars.get('X') == 'A')}`, csvSet('Users', { filename: 'u.csv', variableNames: 'u' }))}
    ${sampler('Home', '/')}`, { variables: [['X', 'A']] });
  const { config } = importJmx(xml);
  assert.deepEqual(config.scenario.groups.map((g) => g.id), ['grp_jmx_1']);
  assert.equal(config.dataSets[0].groupId, 'grp_jmx_1');
  assert.equal(migrateProject(config).dataSets[0].groupId, 'grp_jmx_1');
});
