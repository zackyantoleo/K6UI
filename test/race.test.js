// Race burst load mode (public/js/race.js, server/generator/race.js): normalization,
// planning and validation, the generated k6 code, `done.race`, the importer, the
// load chart and the Simple notice. Real k6 timing is in race-k6.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RACE, RACE_SPIN_MS, describeRacePlan, normalizeRace, normalizeRaceOffsets, planRace, planRaceTiming,
  raceOffsetEntries, raceResultText, readRaceResult, spreadOffsets,
} from '../public/js/race.js';
import { migrateProject } from '../public/js/project-store.js';
import { generateScript } from '../server/generator/index.js';
import { importK6Script } from '../server/importer/index.js';
import { loadShape } from '../public/js/components/load-chart.js';
import { summarizeAdvancedSettings } from '../public/js/components/advanced-notice.js';
import { loadScript } from './helpers/load-script.js';

const request = (id, extra = {}) => ({
  id, type: 'http', method: 'POST', url: `{{host}}/${id}`, body: '{}', checkStatus: true, sleepAfter: 0, ...extra,
});

// Log in, then redeem: the race request is the second one.
function raceProject(race = {}, load = {}, extra = {}) {
  return {
    variables: [{ key: 'host', value: 'http://127.0.0.1:9' }, { key: 'T2_MS', value: '1000' }, { key: 'NAME', value: 'x' }],
    load: { mode: 'race', vus: '3', ...load, race: { request: 'req_redeem', ...race } },
    scenario: {
      requests: [
        request('req_login', { extractions: [{ varName: 'token', source: 'json', selector: 'token' }] }),
        request('req_redeem', { name: 'Redeem voucher', preScript: 'vars.ts = Date.now();', body: '{"ts":"{{ts}}"}' }),
      ],
    },
    ...extra,
  };
}

const problemOf = config => planRace(config).problem;

test('normalizeRace fills every key, keeps numbers as text and offsets as typed entries', () => {
  assert.deepEqual(normalizeRace(undefined), { ...DEFAULT_RACE });
  assert.deepEqual(normalizeRace({
    request: ' req_a ', timing: 'offsets', spreadMs: 200, offsets: ' 0, 1000 ,{{T2_MS}}', leadMs: 1500,
    warmup: 0, warmupPath: '', failIfLate: 'yes', extra: 1,
  }), {
    request: 'req_a', timing: 'offsets', spreadMs: '200', offsets: '0,1000,{{T2_MS}}', leadMs: '1500',
    warmup: true, warmupPath: '/', failIfLate: false, extra: 1,
  });
  assert.equal(normalizeRace({ warmup: false }).warmup, false);
  assert.equal(normalizeRace({ failIfLate: true }).failIfLate, true);
  assert.equal(normalizeRace({ timing: 'Burst' }).timing, 'Burst', 'kept as typed so Run names it');
  assert.equal(normalizeRaceOffsets([0, '1000', 1030]), '0,1000,1030');
  assert.equal(normalizeRaceOffsets('0,,5'), '0,,5', 'an empty entry stays to be named');
  assert.deepEqual(raceOffsetEntries('  '), []);
});

test('the store normalizes race settings, follows a changed request id and leaves other load modes alone', () => {
  const project = migrateProject({
    load: { mode: 'race', vus: 4, race: { request: 'REQ_Redeem', offsets: '0, 5' } },
    scenario: { requests: [{ id: 'REQ_Redeem', url: 'http://x.test' }] },
  });
  assert.equal(project.scenario.requests[0].id, 'req_redeem');
  assert.equal(project.load.race.request, 'req_redeem');
  assert.equal(project.load.race.offsets, '0,5');
  assert.equal(project.load.race.leadMs, DEFAULT_RACE.leadMs);
  assert.deepEqual(migrateProject({ load: { mode: 'race' } }).load.race, { ...DEFAULT_RACE });
  assert.equal('race' in migrateProject({ load: { mode: 'simple', vus: 2 } }).load, false);
});

test('planRace: together, spread and offsets with global variables', () => {
  const together = planRace(raceProject({ timing: 'together' })).race;
  assert.deepEqual(
    { rq: together.rq, index: together.index, vus: together.vus, offsets: together.offsets, leadMs: together.leadMs, spinMs: together.spinMs },
    { rq: 2, index: 1, vus: 3, offsets: [0, 0, 0], leadMs: 2000, spinMs: RACE_SPIN_MS },
  );
  assert.deepEqual(planRace(raceProject({ timing: 'spread', spreadMs: '200' }, { vus: '5' })).race.offsets, [0, 50, 100, 150, 200]);
  assert.deepEqual(spreadOffsets(3, 100), [0, 50, 100]);
  assert.deepEqual(spreadOffsets(1, 100), [0]);
  const offsets = planRace(raceProject({ timing: 'offsets', offsets: '0,{{T2_MS}},{{T2_MS}},1030', leadMs: '{{T2_MS}}' }, { vus: '1' })).race;
  assert.equal(offsets.vus, 4, 'one VU per offset, whatever the VUs field says');
  assert.deepEqual(offsets.offsets, [0, 1000, 1000, 1030]);
  assert.equal(offsets.leadMs, 1000);
  assert.equal(offsets.typed.offsets, '0,{{T2_MS}},{{T2_MS}},1030');
  assert.equal(planRace(raceProject({ request: '' })).race.rq, 1, 'no request chosen: the first one that runs');
  assert.equal(planRace(raceProject({}, { vus: '500' })).race.spinMs, RACE_SPIN_MS);
  assert.equal(planRace(raceProject({}, { vus: '501' })).race.spinMs, 0, 'sleep only above 500 VUs');
  assert.deepEqual(planRace({ load: { mode: 'simple' } }), { problem: '', race: null });
  assert.match(describeRacePlan(offsets), /^4 VUs each send Request 2 · Redeem voucher once, 1 at T0, 2 at T0 \+ 1000 ms, 1 at T0 \+ 1030 ms\. T0 = 1000 ms after setup\.$/);
});

test('planRace names the field that cannot work', () => {
  const off = raceProject();
  off.scenario.requests[1].enabled = false;
  const grpc = raceProject();
  Object.assign(grpc.scenario.requests[1], { type: 'grpc', grpcMethod: 'a.B/C' });
  const column = raceProject({ timing: 'offsets', offsets: '0,{{code}}' }, {}, {
    dataSets: [{ id: 'ds_a', name: 'a', content: 'code\n5\n', skipHeader: true, columns: [] }],
  });
  const cases = [
    [raceProject({ request: 'req_gone' }), /^Race burst: its request is no longer in the flow/],
    [off, /^Race burst: Request · Redeem voucher does not run \(it is turned off\)/],
    [grpc, /is a gRPC request; a race burst sends an HTTP request\.$/],
    [raceProject({ timing: 'burst' }), /"burst" is not a timing; use together, spread or offsets\./],
    [raceProject({ timing: 'offsets', offsets: '' }), /enter one offset per VU in milliseconds/],
    [raceProject({ timing: 'offsets', offsets: '0,10,abc' }), /offset 3 "abc" is not a number of milliseconds/],
    [raceProject({ timing: 'offsets', offsets: '0,,10' }), /enter offset 2: a number of milliseconds/],
    [raceProject({ timing: 'offsets', offsets: '0,-5' }), /offset 2 "-5" is not a number of milliseconds \(0 or more\)/],
    [column, /offset 2: \{\{code\}\} is a data file column/],
    [raceProject({ timing: 'offsets', offsets: '0,{{token}}' }), /offset 2: \{\{token\}\} is extracted from a response during the run/],
    [raceProject({ timing: 'offsets', offsets: '0,{{ts}}' }), /offset 2: \{\{ts\}\} is set by a script during the run/],
    [raceProject({ timing: 'offsets', offsets: '{{NOPE}}' }), /offset 1: \{\{NOPE\}\} is not a global variable/],
    [raceProject({ timing: 'offsets', offsets: '{{NAME}}' }), /offset 1: the global variable NAME is "x"/],
    [raceProject({}, { vus: '0' }), /the number of VUs "0" is not a whole number of at least 1/],
    [raceProject({}, { vus: '' }), /enter the number of VUs/],
    [raceProject({ timing: 'spread', spreadMs: 'wide' }), /the spread "wide" is not a number of milliseconds/],
    [raceProject({ leadMs: '-1' }), /the lead time "-1" is not a number of milliseconds/],
    [raceProject({ warmupPath: 'health' }), /the warm-up path "health" must start with "\/"/],
  ];
  for (const [config, expected] of cases) assert.match(problemOf(config), expected);
  assert.equal(problemOf(raceProject({ warmup: false, warmupPath: 'health' })), '', 'the path is not used without the warm-up');
  assert.equal(problemOf(raceProject({ leadMs: '0' })), '', 'a lead of 0 is allowed (every VU is late)');
});

test('the generated race script: scenario, thresholds, setup T0, warm-up and wait before the pre-processor', () => {
  const meta = {};
  const script = generateScript(raceProject({ timing: 'offsets', offsets: '0,{{T2_MS}},1030', failIfLate: true }, { maxDuration: '2m' }), meta);
  const { options } = loadScript(script);
  assert.deepEqual(options.scenarios, { default: { executor: 'per-vu-iterations', vus: 3, iterations: 1, maxDuration: '2m' } });
  assert.deepEqual(options.thresholds, { k6ui_race_late: ['count>=0', 'count==0'] });
  assert.equal(meta.race.rq, 2);
  assert.match(script, /^import \{ Counter \} from 'k6\/metrics';$/m);
  assert.match(script, /^const RACE = \{"request":2,"offsets":\[0,1000,1030\],"leadMs":2000,"spinMs":3,"warmupPath":"\/","config":\{"timing":"offsets","vus":"3","spreadMs":"100","offsets":"0,\{\{T2_MS\}\},1030",/m);
  assert.match(script, /^export function setup\(\) \{\n {2}return \{ k6uiRaceT0: Date\.now\(\) \+ RACE\.leadMs \};\n\}$/m);
  assert.match(script, /^export default function\(data\) \{$/m);
  const order = [
    '// Request 1: POST',
    'k6uiRaceWarmup(`${GLOBALS.host}/req_redeem`);',
    'const race_at_1 = k6uiRaceWait(data.k6uiRaceT0);',
    '// Pre-processor: request 2',
    '// Request 2: POST',
  ].map(fragment => script.indexOf(fragment));
  assert.ok(order.every((at, i) => at > (order[i - 1] ?? -1)), `in order: ${order}`);

  const plain = generateScript(raceProject({ warmup: false }));
  assert.doesNotMatch(plain, /RACE_WARMUP|k6uiRaceWarmup/);
  assert.match(plain, /\/\/ Race burst: wait for this VU's send time\n {2}const race_at_1 = k6uiRaceWait/);
  assert.deepEqual(loadScript(plain).options.thresholds, { k6ui_race_late: ['count>=0'] });
  const thresholds = loadScript(generateScript(raceProject({}, {}, { thresholds: { p95: '300', errorRate: '1' } }))).options.thresholds;
  assert.deepEqual(Object.keys(thresholds), ['http_req_duration', 'http_req_failed', 'k6ui_race_late']);
});

test('the race script runs: warm-up first, then the race request; a VU past its time is counted late', () => {
  const k6 = loadScript(generateScript(raceProject({ timing: 'offsets', offsets: '0,5,10', leadMs: '0' })));
  const late = k6.iteration(1, 0, { k6uiRaceT0: Date.now() - 50 });
  assert.deepEqual(late.map(call => `${call.method} ${call.url}`), [
    'POST http://127.0.0.1:9/req_login', 'GET http://127.0.0.1:9/', 'POST http://127.0.0.1:9/req_redeem',
  ]);
  assert.deepEqual(late[1].params.tags, { k6ui: 'warmup' });
  assert.deepEqual(late[1].params.responseCallback, { expectedStatuses: [{ min: 100, max: 599 }] });
  assert.deepEqual(k6.metrics, [{ name: 'k6ui_race_late', value: 1, tags: {} }]);
  const t0 = Date.now() + 15;
  k6.iteration(3, 2, { k6uiRaceT0: t0 });
  assert.ok(Date.now() >= t0 + 10, 'VU 3 waits for its offset (10 ms)');
  assert.equal(k6.metrics.length, 1, 'on time: not counted');
  assert.equal(k6.sleeps.length, 1, 'slept until the last few ms');
  assert.ok(k6.sleeps[0] > 0 && k6.sleeps[0] <= 0.025);
  const custom = loadScript(generateScript(raceProject({ warmupPath: '/health?x=1' })));
  assert.equal(custom.iteration(1, 0, { k6uiRaceT0: 0 })[1].url, 'http://127.0.0.1:9/health?x=1');
});

test('generating a race that cannot work is a 400 naming the field', () => {
  assert.throws(() => generateScript(raceProject({ timing: 'offsets', offsets: '0,x' })), /^Error: Race burst: offset 2 "x"/);
  const own = raceProject();
  own.scenario.requests[1].url = 'http://{{shard}}.test/redeem';
  own.scenario.requests[1].preScript = 'vars.shard = "a";';
  assert.throws(() => generateScript(own), /the warm-up runs before the pre-processor of request 2, but its URL uses \{\{shard\}\}, which that pre-processor sets/);
  own.load.race.warmup = false;
  assert.doesNotThrow(() => generateScript(own));
  own.scenario.requests[1].url = '{{host}}/redeem?ts={{ts}}';
  own.scenario.requests[1].preScript = 'vars.ts = 1;';
  own.load.race.warmup = true;
  assert.throws(() => generateScript(own), /uses \{\{ts\}\}/, 'any {{name}} its own pre-processor sets');
});

test('done.race: the late count from the summary, and its wording', () => {
  const race = planRace(raceProject()).race;
  const summary = late => ({ metrics: { k6ui_race_late: { count: late, rate: 0, thresholds: { 'count>=0': false } } } });
  assert.deepEqual(readRaceResult(race, summary(2)), {
    rq: 2, name: 'Redeem voucher', method: 'POST', url: '{{host}}/req_redeem', vus: 3, failIfLate: false, late: 2,
  });
  assert.equal(readRaceResult(race, summary(0)).late, 0);
  assert.equal(readRaceResult(race, null).late, null, 'no summary: unknown');
  assert.equal(readRaceResult(null, summary(1)), null);
  assert.equal(raceResultText(readRaceResult(race, summary(0))), 'Race burst: all 3 VUs reached Request 2 in time and sent it at their planned time.');
  assert.equal(raceResultText(readRaceResult(race, summary(1))),
    'Race burst: 1 of 3 VUs was late: it reached Request 2 at or after its planned send time and sent it at once, so the burst was not as planned. Raise the lead time in Load Profile.');
  assert.match(raceResultText(readRaceResult(race, summary(2))), /^Race burst: 2 of 3 VUs were late: they reached Request 2 at or after their planned send time/);
  assert.equal(raceResultText(readRaceResult(race, null)), '');
});

test('the importer reads K6UI race code back into the race load mode, without warnings', () => {
  for (const race of [
    { timing: 'offsets', offsets: '0,{{T2_MS}},1030', leadMs: '{{T2_MS}}', failIfLate: true, warmupPath: '/health' },
    { timing: 'spread', spreadMs: '250', warmup: false },
    { timing: 'together', request: '' },
  ]) {
    const config = raceProject(race, { vus: '7', maxDuration: '5m' });
    config.scenario.requests[1].preScript = '';
    config.scenario.requests[1].body = '{}';
    const { config: imported, warnings } = importK6Script(generateScript(config));
    assert.deepEqual(warnings, [], race.timing);
    const expected = normalizeRace({ ...race, request: race.request === '' ? 'req_import_1' : 'req_import_2' });
    assert.deepEqual(imported.load, {
      mode: 'race', vus: race.timing === 'offsets' ? '3' : '7', maxDuration: '5m', race: expected,
    }, race.timing);
    assert.equal(imported.scenario.requests.length, 2, 'the warm-up is not a request');
    // Generating the imported project gives the same race again.
    assert.deepEqual(planRace({ ...imported, variables: config.variables }).race.offsets, planRace(config).race.offsets);
  }
  // Another script's setup() is still reported.
  const { warnings } = importK6Script(`import http from 'k6/http';
export const options = { vus: 1, duration: '1s' };
export function setup() { return { k6uiRaceT0: Date.now() }; }
export default function() { http.get('http://x.test/'); }`);
  assert.deepEqual(warnings.map(w => w.message), ['setup() is not imported.']);
});

test('the load chart plans the send times as typed, global variables included', () => {
  const shape = loadShape(
    { mode: 'race', vus: '9', maxDuration: '10m', race: { timing: 'offsets', offsets: '0,{{T2_MS}},1030', leadMs: '500' } },
    [{ key: 'T2_MS', value: '1000' }],
  );
  assert.deepEqual({ sends: shape.sends, last: shape.last, peak: shape.peak, total: shape.total, open: shape.open },
    { sends: [0, 1000, 1030], last: 1030, peak: 3, total: 600, open: true });
  assert.equal(shape.summary, '3 VUs each send the race request once, 1 at T0, 1 at T0 + 1000 ms, 1 at T0 + 1030 ms. T0 = 500 ms after setup.');
  assert.match(loadShape({ mode: 'race', vus: '2', race: { timing: 'offsets', offsets: '{{T2_MS}}' } }).problem,
    /^Race burst: offset 1: \{\{T2_MS\}\} is not a global variable/);
  assert.equal(planRaceTiming({ mode: 'race', vus: '4', race: {} }, []).vus, 4);
});

test('the Simple notice lists a race burst', () => {
  assert.deepEqual(summarizeAdvancedSettings([], [], 0, true).active, [{ id: 'race', label: 'Race burst (Load step)', count: 1, unit: 'request' }]);
  assert.equal(summarizeAdvancedSettings([], [], 0, false).visible, false);
});
