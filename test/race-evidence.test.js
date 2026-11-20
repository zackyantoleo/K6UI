// Race burst, phase 2 PR 2: the per-VU records that prove the requests went out
// together. The generated lines (send time + k6uiRaceRecord), the collector, the
// result and its figures, the Gantt layout, the importer and the report. Real k6 runs
// are in race-k6.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RACE_RECORD_COLUMNS, clockTime, planRace, raceErrors, raceFigures, raceRecordCells, raceResultText, raceResultWarns,
  raceStats, readRaceResult,
} from '../public/js/shared/race.js';
import { GANTT_SLOTS, outcomeTones, raceGantt, tickStep } from '../public/js/race-gantt.js';
import { buildRunReport, reportToHtml } from '../public/js/run-report.js';
import { generateScript } from '../server/generator/index.js';
import { importK6Script } from '../server/importer/index.js';
import { MAX_RACE_RECORDS, RACE_LINE_PREFIX, createRaceCollector } from '../server/race-collector.js';
import { loadScript } from './helpers/load-script.js';

const request = (id, extra = {}) => ({
  id, type: 'http', method: 'POST', url: `{{host}}/${id}`, body: '{}', checkStatus: true, sleepAfter: 0, ...extra,
});

function raceProject(race = {}, redeem = {}, extra = {}) {
  return {
    variables: [{ key: 'host', value: 'http://127.0.0.1:9' }],
    load: { mode: 'race', vus: '3', race: { request: 'req_redeem', ...race } },
    scenario: {
      requests: [
        request('req_login'),
        request('req_redeem', { name: 'Redeem voucher', ...redeem }),
        request('req_after', { method: 'GET', body: '' }),
      ],
    },
    ...extra,
  };
}

const RULES = { rules: [{ label: 'success', status: '200', source: 'none' }, { label: 'quota', status: '400', source: 'none' }], fallback: 'other' };

// A raw record as the script logs it (times in epoch ms).
const raw = (vu, { t0 = 10_000, offset = 0, early = 500, sentAfter = 0, ms = 10, cn = false, s = 200, oc } = {}) => ({
  vu, t0, at: t0 + offset, ar: t0 + offset - early, sent: t0 + offset + sentAfter, ms, cn, s, ...(oc ? { oc } : {}),
});

test('the race request gets its send time right before http.request and one record after its outcome', () => {
  const script = generateScript(raceProject({}, { outcomes: RULES, preScript: 'vars.ts = Date.now();' }, { options: { logRequests: true } }));
  const lines = script.split('\n').map(line => line.trim());
  const sentAt = lines.indexOf('const race_sent_1 = Date.now();');
  assert.ok(sentAt > lines.indexOf('const race_at_1 = k6uiRaceWait(data.k6uiRaceT0);'));
  assert.ok(sentAt > lines.indexOf('// Pre-processor: request 2'), 'after the pre-processor');
  assert.match(lines[sentAt + 1], /^const res_main_1 = http\.request\("POST",/, 'right before the request');
  assert.equal(lines[sentAt - 1], 'const body_main_1 = "{}";', 'after the body is built');
  const record = lines.indexOf('try { k6uiRaceRecord(data.k6uiRaceT0, race_at_1, race_sent_1, res_main_1, outcome_main_1); } catch (e) {}');
  assert.ok(record > lines.indexOf('OUTCOME.add(1, OUTCOME_TAGS_2[outcome_main_1]);'), 'after the outcome label');
  assert.ok(record < lines.findIndex(line => line.startsWith('try { logHttpOutcome(1,')), 'before the request record');
  assert.equal(script.match(/race_sent_/g).length, 2, 'only the race request');
  assert.match(script, /^let k6uiRaceArrived = 0;$/m);

  const plain = generateScript(raceProject({}, { method: 'GET', body: '' }));
  assert.match(plain, /const race_sent_1 = Date\.now\(\);\n {2}const res_main_1 = http\.request\("GET"/);
  assert.match(plain, /k6uiRaceRecord\(data\.k6uiRaceT0, race_at_1, race_sent_1, res_main_1, undefined\)/, 'no outcome rules: undefined');
  assert.doesNotMatch(generateScript({ ...raceProject(), load: { mode: 'simple', vus: '1', duration: '1s' } }), /k6uiRace/);
});

test('the script logs one record per VU: planned, arrived, sent, how long, connection, status, label', () => {
  const respond = call => (call.url.endsWith('/req_redeem') ? { status: 400, timings: { blocked: 0.5, connecting: 1.25, tls_handshaking: 0, duration: 8 } } : {});
  const k6 = loadScript(generateScript(raceProject({ timing: 'offsets', offsets: '0,5,10' }, { outcomes: RULES })), { respond });
  const t0 = Date.now() + 20;
  k6.iteration(2, 1, { k6uiRaceT0: t0 });
  const lines = k6.logs.filter(line => line.startsWith(RACE_LINE_PREFIX));
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record), ['k6uiRace', 'vu', 't0', 'at', 'ar', 'sent', 'ms', 'cn', 's', 'oc']);
  assert.equal(record.vu, 2);
  assert.equal(record.t0, t0);
  assert.equal(record.at, t0 + 5);
  assert.ok(record.ar < record.at, 'arrived before its time');
  assert.ok(record.sent >= record.at && record.sent <= record.at + 2);
  assert.equal(record.ms, 9.75, 'blocked + connecting + TLS + duration');
  assert.equal(record.cn, true);
  assert.equal(record.s, 400);
  assert.equal(record.oc, 'quota');

  const late = loadScript(generateScript(raceProject()));
  late.iteration(1, 0, { k6uiRaceT0: Date.now() - 50 });
  const lateRecord = JSON.parse(late.logs.find(line => line.startsWith(RACE_LINE_PREFIX)));
  assert.ok(lateRecord.ar >= lateRecord.at, 'a late VU arrived at or after its time');
  assert.equal('oc' in lateRecord, false);
  assert.equal(lateRecord.cn, false);
});

test('the collector keeps valid records, drops broken ones and counts past the limit', () => {
  const collector = createRaceCollector({ maxRecords: 2 });
  assert.deepEqual(collector.result(), {}, 'no race line: nothing for done');
  assert.equal(collector.addLine('hello'), false);
  assert.equal(collector.addLine('{"k6uiExport":"a.csv"}'), false);
  assert.equal(collector.addLine(`${RACE_LINE_PREFIX}broken`), true, 'broken: dropped, never logged');
  assert.equal(collector.addLine(JSON.stringify({ k6uiRace: 1, vu: 0, t0: 1, at: 1, ar: 1, sent: 1 })), true);
  assert.equal(collector.addLine(JSON.stringify({ k6uiRace: 1, vu: 1, t0: 1, at: 'x', ar: 1, sent: 1 })), true);
  assert.deepEqual(collector.result(), { raceRecords: { records: [], dropped: 0 } }, 'race lines came, none valid');
  collector.addLine(JSON.stringify({ k6uiRace: 1, ...raw(1), ms: -1, ec: 1211, oc: 'x'.repeat(100), extra: 'gone' }));
  collector.addLine(JSON.stringify({ k6uiRace: 1, ...raw(2), ms: null, s: 'oops' }));
  collector.addLine(JSON.stringify({ k6uiRace: 1, ...raw(3) }));
  const { records, dropped } = collector.result().raceRecords;
  assert.equal(dropped, 1);
  assert.deepEqual(records[0], { vu: 1, t0: 10_000, at: 10_000, ar: 9_500, sent: 10_000, ms: 0, cn: false, s: 200, ec: 1211, oc: 'x'.repeat(64) });
  assert.deepEqual(records[1], { vu: 2, t0: 10_000, at: 10_000, ar: 9_500, sent: 10_000, ms: 0, cn: false, s: 0 });
  assert.equal(MAX_RACE_RECORDS, 10_000);
});

test('readRaceResult: records relative to T0, by planned time, with the concurrency figures', () => {
  const race = planRace(raceProject({ timing: 'offsets', offsets: '0,1000,1000,1030' })).race;
  const collected = {
    records: [
      raw(4, { offset: 1030, sentAfter: 1, ms: 40, early: 970 }),
      raw(2, { offset: 1000, ms: 50, oc: 'success' }),
      raw(1, { offset: 0, ms: 20, cn: true, oc: 'success' }),
      raw(3, { offset: 1000, ms: 45, oc: 'quota' }),
    ],
    dropped: 0,
  };
  const result = readRaceResult(race, null, collected, { labels: ['success', 'quota', 'other'], fallback: 'other' });
  assert.equal(result.late, 0, 'no summary: counted from the records');
  assert.equal(result.t0, 10_000);
  assert.equal(result.sent, 4);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.records.map(entry => entry.vu), [1, 2, 3, 4]);
  assert.deepEqual(result.records[3], {
    vu: 4, offset: 1030, arrived: 60, sent: 1031, ms: 40, late: false, status: 200, errorCode: 0, outcome: '', newConnection: false,
  });
  assert.deepEqual(result.stats, {
    spreadMs: 1031, offBy: { min: 0, max: 1 }, peakInFlight: 3, peakAt: 1031, newConnections: 1, marginMs: 500,
  });
  assert.deepEqual(result.labels, ['success', 'quota', 'other']);

  const summary = { metrics: { k6ui_race_late: { count: 1 } } };
  const partly = readRaceResult({ ...race, vus: 5 }, summary, { records: [raw(1, { early: -3 })], dropped: 1 });
  assert.equal(partly.late, 1, "k6's count wins");
  assert.equal(partly.missing, 3, 'a dropped record still sent');
  assert.equal(partly.records[0].late, true);
  assert.equal(partly.stats.offBy, null, 'every VU late');
  assert.equal(partly.stats.marginMs, -3);
});

test('raceStats: peak in flight with a send counting before an end at the same ms', () => {
  const entry = (sent, ms) => ({ sent, ms, offset: 0, arrived: -10, late: false, newConnection: false });
  assert.equal(raceStats([]), null);
  assert.deepEqual(raceStats([entry(0, 10), entry(5, 10), entry(20, 5)]).peakInFlight, 2);
  assert.equal(raceStats([entry(0, 5), entry(5, 5)]).peakInFlight, 2, 'sharing a millisecond overlaps');
  assert.equal(raceStats([entry(0, 4.9), entry(5, 5)]).peakInFlight, 1);
  const stats = raceStats([entry(0, 1), entry(0, 1), entry(0, 1)]);
  assert.deepEqual([stats.peakInFlight, stats.peakAt, stats.spreadMs], [3, 0, 0]);
});

test('figures, table cells and the wording of late and missing VUs', () => {
  const race = planRace(raceProject({}, {}, { load: { mode: 'race', vus: '4', race: { request: 'req_redeem', leadMs: '2000' } } })).race;
  const result = readRaceResult(race, null, { records: [raw(1, { ms: 12.34 }), raw(2, { sentAfter: 1, cn: true }), raw(3, { early: -12, sentAfter: 12, s: 0 })] });
  const figures = Object.fromEntries(raceFigures(result).map(figure => [figure.label, figure.value]));
  assert.deepEqual(figures, {
    T0: clockTime(10_000),
    'VUs that sent': '3 of 4',
    'First to last send': '12 ms',
    'Sent vs planned': '+0 to +1 ms',
    'Peak in flight': '2 at +1 ms',
    'New connections': '1 of 3',
    'Tightest margin': 'late by 12 ms',
  });
  assert.match(clockTime(Date.UTC(2026, 0, 1, 1, 2, 3, 45)), /^\d\d:02:03\.045$/);
  assert.equal(clockTime(null), '');
  assert.deepEqual(raceFigures(readRaceResult(race, null)), []);

  assert.equal(RACE_RECORD_COLUMNS.length, 9);
  assert.deepEqual(raceRecordCells(result.records[0]), ['1', '+0 ms', '500 ms before', '+0 ms', '+0 ms', '12.3 ms', '200', '—', 'No']);
  const failed = result.records.find(entry => entry.vu === 3);
  assert.deepEqual(raceRecordCells({ ...failed, errorCode: 1211 }).slice(2, 7), ['late by 12 ms', '+12 ms', '+12 ms', '10.0 ms', 'failed (k6 error 1211)']);

  assert.equal(raceResultText(result),
    'Race burst: 1 of 4 VUs was late: it reached Request 2 at or after its planned send time and sent it at once, so the burst was not as planned. Raise the lead time in Load Profile.');
  assert.deepEqual(raceErrors(result).map(message => message.slice(0, 40)), [
    'Race burst: 1 of 4 VUs was late: it reac', 'Race burst: only 3 of 4 VUs sent Request',
  ]);
  const missing = readRaceResult(race, null, { records: [raw(1)] });
  assert.match(raceResultText(missing), /^Race burst: only 1 of 4 VUs sent Request 2\. The others ended their iteration before it/);
  assert.equal(raceResultWarns(missing), true);
  const none = readRaceResult(race, { metrics: { k6ui_race_late: { count: 0 } } });
  assert.match(raceResultText(none), /^Race burst: none of the 4 VUs sent Request 2\./);
  const fine = readRaceResult(race, null, { records: [1, 2, 3, 4].map(vu => raw(vu)) });
  assert.deepEqual(raceErrors(fine), []);
  assert.equal(raceResultWarns(fine), false);
  assert.deepEqual(raceErrors(null), []);
});

test('the Gantt layout: one row per VU, ticks, a peak line and colours that follow the outcome rules', () => {
  assert.equal(tickStep(1030), 200);
  assert.equal(tickStep(3), 1);
  assert.equal(tickStep(0), 1);
  const tones = outcomeTones(['a', 'b', 'other', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'other');
  assert.deepEqual([...tones.values()], ['tone-1', 'tone-2', 'tone-other', 'tone-3', 'tone-4', 'tone-5', 'tone-6', 'tone-7', 'tone-8', 'tone-other']);
  assert.equal(GANTT_SLOTS, 8, 'never cycled: the ninth label is the neutral');

  const race = planRace(raceProject({ timing: 'offsets', offsets: '0,1000,1000,1030' })).race;
  const result = readRaceResult(race, null, {
    records: [raw(1, { oc: 'success' }), raw(2, { offset: 1000, oc: 'quota' }), raw(3, { offset: 1000, oc: 'other' }), raw(4, { offset: 1030, early: -2, sentAfter: 2 })],
  }, { labels: ['success', 'quota', 'other'], fallback: 'other' });
  const layout = raceGantt(result);
  assert.equal(layout.rows.length, 4);
  assert.deepEqual(layout.rows.map(row => row.tone), ['tone-1', 'tone-2', 'tone-other', 'tone-other']);
  assert.deepEqual(layout.legend, [{ label: 'success', tone: 'tone-1', count: 1 }, { label: 'quota', tone: 'tone-2', count: 1 }, { label: 'other', tone: 'tone-other', count: 1 }]);
  assert.deepEqual(layout.ticks.map(tick => tick.label), ['T0', '+200 ms', '+400 ms', '+600 ms', '+800 ms', '+1,000 ms', '+1,200 ms']);
  assert.equal(layout.ticks[0].x, layout.left);
  assert.equal(layout.ticks.at(-1).x, layout.right);
  assert.ok(layout.rows.every(row => row.w >= 2 && row.x >= layout.left && row.x + row.w <= layout.right));
  assert.equal(layout.rows[1].planX, layout.rows[2].planX, 'same planned time, same tick');
  assert.equal(layout.rows[3].late, true);
  assert.equal(layout.rows[0].label, 'VU 1');
  assert.match(layout.rows[1].title, /^VU 2 · planned \+1,000 ms · sent \+1,000 ms \(\+0 ms\) · took 10\.0 ms · status 200 · outcome quota$/);
  const unused = raceGantt({ ...result, labels: ['success', 'never', 'quota', 'other'] });
  assert.deepEqual(unused.legend.map(item => `${item.label}:${item.tone}`), ['success:tone-1', 'quota:tone-3', 'other:tone-other'], 'a label with no response is left out and keeps the others in place');
  assert.deepEqual(layout.peak, { x: layout.rows[1].x, label: '2 in flight', labelX: layout.rows[1].x - 4, anchor: 'end' }, 'near the right edge: left of the line');
  assert.deepEqual(layout.ticks.map(tick => tick.anchor), ['middle', 'middle', 'middle', 'middle', 'middle', 'middle', 'end']);

  const plain = raceGantt(readRaceResult(race, null, { records: [raw(1), raw(2, { offset: 50 })] }));
  assert.deepEqual(plain.rows.map(row => row.tone), ['tone-1', 'tone-1'], 'no outcome rules: one colour');
  assert.deepEqual(plain.legend, []);
  assert.equal(plain.peak, null, 'never more than one in flight');
  assert.equal(raceGantt(readRaceResult(race, null)), null);

  const many = readRaceResult({ ...race, vus: 300 }, null, { records: Array.from({ length: 300 }, (_, i) => raw(i + 1)) });
  const capped = raceGantt(many, { maxRows: 100 });
  assert.deepEqual([capped.shown, capped.total, capped.rows.length], [100, 300, 100]);
  assert.equal(capped.rows[0].label, '', 'rows too thin for a VU label');
});

test('the importer reads a race script with records, outcome rules and request records back without warnings', () => {
  const config = raceProject({}, { outcomes: RULES }, { options: { logRequests: true } });
  const { config: imported, warnings } = importK6Script(generateScript(config));
  assert.deepEqual(warnings, []);
  assert.equal(imported.load.mode, 'race');
  assert.equal(imported.load.race.request, 'req_import_2');
  assert.equal(imported.scenario.requests.length, 3);
  assert.deepEqual(imported.scenario.requests[1].outcomes.rules.map(rule => rule.label), ['success', 'quota']);
});

test('the report has a Race burst section: note, figures, the Gantt as inline SVG and every VU', () => {
  const race = planRace(raceProject()).race;
  const result = readRaceResult(race, { metrics: { k6ui_race_late: { count: 0 } } }, {
    records: [raw(1, { oc: 'success' }), raw(2, { oc: 'quota' }), raw(3, { oc: 'quota', cn: true })],
  }, { labels: ['success', 'quota', 'other'], fallback: 'other' });
  const report = buildRunReport({ config: raceProject(), verdict: { status: 'passed' }, race: result });
  assert.equal(report.race, result);
  const html = reportToHtml(report);
  assert.match(html, /<h2>Race burst<\/h2>\n<p class="note ok" role="note">Race burst: all 3 VUs reached Request 2 in time/);
  assert.match(html, /<div class="figure-label">Peak in flight<\/div><div class="figure-value small">3 at \+0 ms<\/div>/);
  assert.match(html, /<svg class="gantt" viewBox="0 0 720 \d+" role="img"/);
  assert.equal((html.match(/<rect class="bar tone-/g) || []).length, 3);
  assert.match(html, /<li><span class="key tone-2"><\/span>quota <span class="muted">2<\/span><\/li>/);
  assert.match(html, /<th scope="col" class="num">Sent vs planned<\/th>/);
  assert.match(html, /<td>quota<\/td><td>Yes<\/td><\/tr>/);
  assert.doesNotMatch(html, /<script/);
  assert.ok(html.indexOf('<h2>Race burst</h2>') < html.indexOf('<h2>Checks</h2>'));
  assert.match(html, /<dt>Load<\/dt><dd>Race burst: 3 VUs, together/);

  const nobody = reportToHtml(buildRunReport({ config: raceProject(), race: readRaceResult(race, { metrics: { k6ui_race_late: { count: 0 } } }) }));
  assert.match(nobody, /<p class="note" role="note">Race burst: none of the 3 VUs sent Request 2\./);
  assert.match(nobody, /No VU sent the race request, so there is nothing to chart\./);
  assert.doesNotMatch(reportToHtml(buildRunReport({ config: raceProject() })), /<h2>Race burst<\/h2>/);
});
