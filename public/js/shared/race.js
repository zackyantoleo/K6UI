// Race burst load mode (config.load.mode "race", the settings in config.load.race):
// every VU runs the flow once (k6 `per-vu-iterations`, 1 iteration) and sends one
// request of it, the race request, at a planned time: T0 + the VU's offset in ms.
// T0 is set once for all VUs when setup() ends: now + the lead time. Requests before
// the race request run first (log in, create an order); the wait comes right before
// the race request's pre-processor, so values it computes (a timestamp, a signature)
// are fresh when the request leaves.
//
//   "race": {
//     "request": "req_redeem",        // request id; "" = the first request that runs
//     "timing": "offsets",            // "together" | "spread" | "offsets"
//     "spreadMs": "200",              // spread: VU i (from 0) at round(i × spread / (VUs − 1))
//     "offsets": "0,1000,1000,1030",  // offsets: one per VU in ms; VUs = how many there are
//     "leadMs": "2000",               // T0 = the end of setup() + lead
//     "warmup": true,                 // GET <origin of the race request><warmupPath> before the wait
//     "warmupPath": "/",
//     "failIfLate": false             // a late VU fails the run (k6ui_race_late count==0)
//   }
//
// k6 reads `options` (the VU count) before the test starts, so every number is a
// number or a {{global variable}} holding one, resolved when the script is generated,
// like an outcome target. A data file column, an extracted value or a `vars.x` of a
// script is only known during the run and cannot be one.
// Pure and DOM-free: shared by the store, the Load Profile view, its load chart,
// config.js, the Simple notice, the results panel, server/generator/race.js,
// server/routes.js and the importer.
import {
  THRESHOLD_NUMBER, THRESHOLD_VARIABLE, dataColumnNames, globalValues, requestTitle, runtimeNames,
  thresholdRequests,
} from './outcome-thresholds.js';
import { isObject, oneLine, text } from './basics.js';

export const RACE_MODE = 'race';
export const RACE_TIMINGS = [
  { value: 'together', label: 'Together: every VU at T0' },
  { value: 'spread', label: 'Spread: evenly over a window' },
  { value: 'offsets', label: 'Offsets: one time per VU' },
];
export const DEFAULT_RACE = Object.freeze({
  request: '',
  timing: 'together',
  spreadMs: '100',
  offsets: '',
  leadMs: '2000',
  warmup: true,
  warmupPath: '/',
  failIfLate: false,
});
// Sleep wakes up a few ms late, so the last few ms are a busy-wait on Date.now():
// 0–3 ms between the first and last send up to 500 VUs on a 14-core machine (k6
// v2.4.0). With more VUs, that many busy-waiting VUs fight over the cores and the
// spread grows (one run: 34 ms at 1000 VUs), so above it the VUs only sleep.
export const RACE_SPIN_MS = 3;
export const RACE_SPIN_MAX_VUS = 500;
// The k6 Counter of VUs that reached the race request at or after their planned time.
export const RACE_LATE_METRIC = 'k6ui_race_late';
export const RACE_WARMUP_TAG = 'warmup';

const TIMING_VALUES = new Set(RACE_TIMINGS.map(timing => timing.value));
const WHOLE = /^[1-9]\d*$/;
const WARMUP_PATH = /^\/\S*$/;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Offsets as one text: "0, 1000 ,1000" → "0,1000,1000" (a list is joined). Entries
// are trimmed, never dropped, so a mistyped one is still there to name.
export function normalizeRaceOffsets(raw) {
  const source = Array.isArray(raw) ? raw.map(text).join(',') : text(raw);
  if (!source.trim()) return '';
  return source.split(',').map(entry => entry.trim()).join(',');
}

// → the offset entries as typed ([] for none).
export const raceOffsetEntries = offsets => (normalizeRaceOffsets(offsets) ? normalizeRaceOffsets(offsets).split(',') : []);

// The settings in their canonical shape: every key present, numbers as text, unknown
// fields kept. A timing that is not one of the three is kept as typed, so Run names it.
export function normalizeRace(raw) {
  const source = isObject(raw) ? raw : {};
  const field = (key, fallback) => (source[key] === undefined || source[key] === null ? fallback : text(source[key]).trim());
  return {
    ...source,
    request: field('request', DEFAULT_RACE.request),
    timing: field('timing', DEFAULT_RACE.timing) || DEFAULT_RACE.timing,
    spreadMs: field('spreadMs', DEFAULT_RACE.spreadMs),
    offsets: normalizeRaceOffsets(source.offsets ?? DEFAULT_RACE.offsets),
    leadMs: field('leadMs', DEFAULT_RACE.leadMs),
    warmup: source.warmup === undefined ? DEFAULT_RACE.warmup : source.warmup !== false,
    warmupPath: field('warmupPath', DEFAULT_RACE.warmupPath) || DEFAULT_RACE.warmupPath,
    failIfLate: source.failIfLate === true,
  };
}

export const isRaceLoad = load => isObject(load) && load.mode === RACE_MODE;

// A number of the race settings → { resolved } or { problem }. `what` names the field
// in the message; `whole` asks for a whole number of at least 1 (the VU count).
function resolveNumber(value, what, context, { whole = false } = {}) {
  const typed = text(value).trim();
  const kind = whole ? 'a whole number of at least 1' : 'a number of milliseconds (0 or more)';
  const example = whole ? '{{RACERS}}' : '{{T2_MS}}';
  const valid = candidate => (whole ? WHOLE.test(candidate) : THRESHOLD_NUMBER.test(candidate));
  if (!typed) return { problem: `enter ${what}: ${kind}, or a global variable like ${example}.` };
  if (valid(typed)) return { resolved: Number(typed) };
  const variable = THRESHOLD_VARIABLE.exec(typed)?.[1];
  if (!variable) return { problem: `${what} "${oneLine(typed).slice(0, 60)}" is not ${kind}; use one, or a global variable like ${example}.` };
  const later = `but race times are set before the test starts; use ${whole ? 'a number' : 'a number of milliseconds'} or a global variable.`;
  context.runtime ??= runtimeNames(context.requests);
  if (context.runtime.has(variable)) return { problem: `${what}: {{${variable}}} ${context.runtime.get(variable)}, ${later}` };
  context.columns ??= dataColumnNames(context.config);
  if (context.columns.has(variable)) return { problem: `${what}: {{${variable}}} is a data file column, which changes per iteration, ${later}` };
  context.globals ??= globalValues(context.config?.variables);
  if (!context.globals.has(variable)) {
    return { problem: `${what}: {{${variable}}} is not a global variable; add it under Global variables, or enter a number.` };
  }
  const resolved = context.globals.get(variable).trim();
  if (!valid(resolved)) {
    return { problem: `${what}: the global variable ${variable} is "${oneLine(resolved).slice(0, 60)}", not ${kind}.` };
  }
  return { resolved: Number(resolved) };
}

// Planned offset of each VU (ms after T0), VU 1 first.
export function spreadOffsets(vus, spreadMs) {
  if (vus <= 1) return [0];
  return Array.from({ length: vus }, (_, i) => Math.round((i * spreadMs) / (vus - 1)));
}

// The timing of a race: { problem, timing, vus, offsets, leadMs } (problem without the
// "Race burst: " prefix). `context` = { config, requests } for {{global}} resolving.
function planTiming(load, typed, context) {
  const problem = why => ({ problem: why });
  if (!TIMING_VALUES.has(typed.timing)) {
    return problem(`"${oneLine(typed.timing).slice(0, 40)}" is not a timing; use together, spread or offsets.`);
  }

  let vus;
  let offsets;
  if (typed.timing === 'offsets') {
    const entries = raceOffsetEntries(typed.offsets);
    if (!entries.length) return problem('enter one offset per VU in milliseconds, separated by commas (for example 0,1000,1000,1030).');
    offsets = [];
    for (const [i, entry] of entries.entries()) {
      const value = resolveNumber(entry, `offset ${i + 1}`, context);
      if (value.problem) return problem(value.problem);
      offsets.push(value.resolved);
    }
    vus = offsets.length;
  } else {
    const count = resolveNumber(load.vus, 'the number of VUs', context, { whole: true });
    if (count.problem) return problem(count.problem);
    vus = count.resolved;
    if (typed.timing === 'spread') {
      const spread = resolveNumber(typed.spreadMs, 'the spread', context);
      if (spread.problem) return problem(spread.problem);
      offsets = spreadOffsets(vus, spread.resolved);
    } else {
      offsets = Array.from({ length: vus }, () => 0);
    }
  }

  const lead = resolveNumber(typed.leadMs, 'the lead time', context);
  if (lead.problem) return problem(lead.problem);
  return { problem: '', timing: typed.timing, vus, offsets, leadMs: lead.resolved };
}

const NOT_RUN = {
  'the request is turned off': 'it is turned off',
  'the request is in a turned-off group': 'it is in a turned-off group',
  'the request has no URL': 'it has no URL',
};

// A whole config → { problem, race }. `race` is null when the load mode is not race,
// else the plan: { rq, index, requestId, name, method, url, vus, timing, offsets,
// leadMs, spinMs, warmup, warmupPath, failIfLate, maxDuration, typed } — `rq` numbers
// the race request among the requests that run (from 1, like the generator), `index`
// is rq − 1, `offsets` has one number per VU, `typed` is the settings as typed
// (normalizeRace) plus `vus`. `problem` is the first reason the race cannot run
// ('' when none); `race` is then null.
export function planRace(config) {
  const load = isObject(config?.load) ? config.load : {};
  if (!isRaceLoad(load)) return { problem: '', race: null };
  const typed = normalizeRace(load.race);
  const fail = why => ({ problem: `Race burst: ${why}`, race: null });
  const requests = thresholdRequests(config);
  const context = { config, requests };

  // The race request: the one chosen, or the first that runs.
  let request;
  if (typed.request) {
    request = requests.find(entry => entry.id === typed.request && entry.rq) || requests.find(entry => entry.id === typed.request);
    if (!request) return fail('its request is no longer in the flow; choose another race request in Load Profile.');
    if (request.skipped) {
      return fail(`${requestTitle(request)} does not run (${NOT_RUN[request.skipped] || request.skipped}); turn it on or choose another race request.`);
    }
  } else {
    request = requests.find(entry => entry.rq);
    if (!request) return fail('add a request with a URL to the flow; the race sends one of them.');
  }
  if (request.type === 'grpc') return fail(`${requestTitle(request)} is a gRPC request; a race burst sends an HTTP request.`);

  const timing = planTiming(load, typed, context);
  if (timing.problem) return fail(timing.problem);
  const { vus, offsets, leadMs } = timing;
  if (typed.warmup && !WARMUP_PATH.test(typed.warmupPath)) {
    return fail(`the warm-up path "${oneLine(typed.warmupPath).slice(0, 60)}" must start with "/" and have no spaces (for example / or /health).`);
  }

  return {
    problem: '',
    race: {
      rq: request.rq,
      index: request.rq - 1,
      requestId: request.id,
      name: request.name,
      method: request.method,
      url: request.url,
      vus,
      timing: typed.timing,
      offsets,
      leadMs,
      spinMs: vus <= RACE_SPIN_MAX_VUS ? RACE_SPIN_MS : 0,
      warmup: typed.warmup,
      warmupPath: typed.warmupPath,
      failIfLate: typed.failIfLate,
      maxDuration: text(load.maxDuration).trim(),
      typed: { ...typed, vus: text(load.vus).trim() },
    },
  };
}

export const raceProblem = config => planRace(config).problem;

// The timing of a load form as typed, for the load chart (no request needed):
// { problem, timing, vus, offsets, leadMs }. `variables` = the global variables.
export function planRaceTiming(load, variables) {
  const config = { load, variables };
  const timing = planTiming(isObject(load) ? load : {}, normalizeRace(load?.race), { config, requests: [] });
  return timing.problem ? { ...timing, problem: `Race burst: ${timing.problem}` } : timing;
}

// "4 VUs each send Request 2 · Redeem once, 1 at T0, 2 at T0 + 1000 ms, 1 at T0 + 1030 ms.
// T0 = 2000 ms after setup." Without `rq` (the load chart): "the race request".
export function describeRacePlan(race) {
  if (!race) return '';
  const counts = new Map();
  for (const offset of race.offsets) counts.set(offset, (counts.get(offset) || 0) + 1);
  const times = [...counts].sort(([a], [b]) => a - b);
  const at = offset => (offset ? `T0 + ${offset} ms` : 'T0');
  const when = times.length === 1
    ? `all at ${at(times[0][0])}`
    : times.length <= 4
      ? times.map(([offset, count]) => `${count} at ${at(offset)}`).join(', ')
      : `from T0 to ${at(times.at(-1)[0])}`;
  const request = race.rq ? requestTitle(race) : 'the race request';
  return `${plural(race.vus, 'VU')} each send ${request} once, ${when}. T0 = ${race.leadMs} ms after setup.`;
}

// The plan + a k6 --summary-export + the records the script logged (k6-runner.js
// `raceRecords`: { records, dropped }, see server/race-collector.js) + the race
// request's outcome labels ({ labels, fallback } in rule order, or null) → the result:
//   { rq, name, method, url, vus, failIfLate, late,
//     timing, leadMs, labels, fallback, t0, sent, missing, dropped, records, stats }
// `late` = how many VUs reached the race request at or after their planned time: k6's
// count when there is a summary, else counted from the records, else null (a stopped run).
// `records` = one per VU that sent the race request, by planned time then VU, every time
// in ms after T0: { vu, offset (planned), arrived (reached the wait), sent, ms (how long
// the request took), late, status, errorCode, outcome, newConnection }. `sent` = how many
// records there are, `missing` = VUs that never sent it (null when nothing is known);
// `stats` = null without records, else see raceStats().
export function readRaceResult(race, summary, collected = null, outcome = null) {
  if (!isObject(race)) return null;
  const metric = isObject(summary?.metrics) ? summary.metrics[RACE_LATE_METRIC] : undefined;
  const count = Number(metric?.count);
  const vus = Number(race.vus) || 0;
  const raw = Array.isArray(collected?.records) ? collected.records : [];
  const records = raw.filter(isObject).map(entry => ({
    vu: entry.vu,
    offset: entry.at - entry.t0,
    arrived: entry.ar - entry.t0,
    sent: entry.sent - entry.t0,
    ms: Number(entry.ms) || 0,
    late: entry.ar >= entry.at,
    status: Number(entry.s) || 0,
    errorCode: Number(entry.ec) || 0,
    outcome: text(entry.oc),
    newConnection: entry.cn === true,
  })).sort((a, b) => a.offset - b.offset || a.vu - b.vu);
  const known = Boolean(collected) || isObject(summary);
  const recordLate = records.filter(entry => entry.late).length;
  let late = null;
  if (isObject(metric)) late = Number.isFinite(count) ? count : 0;
  else if (collected) late = recordLate;
  const labels = Array.isArray(outcome?.labels) ? outcome.labels.map(text).filter(Boolean) : [];
  return {
    rq: race.rq ?? null,
    name: text(race.name),
    method: text(race.method),
    url: text(race.url),
    vus,
    failIfLate: race.failIfLate === true,
    late,
    timing: text(race.timing),
    leadMs: Number(race.leadMs) || 0,
    labels,
    fallback: labels.length ? text(outcome?.fallback) : '',
    t0: Number.isFinite(raw[0]?.t0) ? raw[0].t0 : null,
    sent: known ? records.length : null,
    missing: known ? Math.max(0, vus - records.length - (Number(collected?.dropped) || 0)) : null,
    dropped: Number(collected?.dropped) || 0,
    records,
    stats: raceStats(records),
  };
}

// The concurrency figures of a result's records (null without records), in ms after T0:
//   spreadMs        first send → last send
//   offBy           { min, max } of sent − planned over the VUs that were on time
//                   (null when every VU was late)
//   peakInFlight    the most race requests in flight at once (k6 side: from the send
//                   time to the send time + how long it took; two that share a
//                   millisecond overlap) and peakAt, when it was first reached
//   newConnections  race requests that opened a connection (TCP connect or TLS > 0)
//   marginMs        the smallest planned − reached-the-wait: how much of the lead time
//                   the slowest VU had left (negative = that VU was late by that much)
export function raceStats(records) {
  if (!Array.isArray(records) || !records.length) return null;
  const sends = records.map(entry => entry.sent);
  const onTime = records.filter(entry => !entry.late).map(entry => entry.sent - entry.offset);
  // Sweep: +1 at each send, −1 at each end; at the same time a send counts first.
  const edges = records.flatMap(entry => [[entry.sent, 1], [entry.sent + entry.ms, -1]])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let current = 0, peak = 0, peakAt = 0;
  for (const [at, step] of edges) {
    current += step;
    if (current > peak) {
      peak = current;
      peakAt = at;
    }
  }
  return {
    spreadMs: Math.max(...sends) - Math.min(...sends),
    offBy: onTime.length ? { min: Math.min(...onTime), max: Math.max(...onTime) } : null,
    peakInFlight: peak,
    peakAt,
    newConnections: records.filter(entry => entry.newConnection).length,
    marginMs: Math.min(...records.map(entry => entry.offset - entry.arrived)),
  };
}

const signedMs = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US')} ms`;
const groupMs = value => `${Math.round(value).toLocaleString('en-US')} ms`;

// "HH:MM:SS.mmm" in the viewer's time zone ('' for no time).
export function clockTime(epochMs) {
  if (!Number.isFinite(epochMs)) return '';
  const date = new Date(epochMs);
  const two = value => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

// The figures above the Gantt chart: [{ label, value, hint }] ([] without records).
export function raceFigures(result) {
  const stats = result?.stats;
  if (!stats) return [];
  const { offBy } = stats;
  const sentVsPlan = !offBy ? 'every VU late'
    : offBy.min === offBy.max ? signedMs(offBy.min) : `${signedMs(offBy.min).replace(' ms', '')} to ${signedMs(offBy.max)}`;
  const margin = stats.marginMs > 0 ? `${groupMs(stats.marginMs)} to spare` : `late by ${groupMs(-stats.marginMs)}`;
  return [
    { label: 'T0', value: clockTime(result.t0), hint: `Every planned send time counts from here: ${result.leadMs} ms after setup() ended.` },
    { label: 'VUs that sent', value: `${result.sent} of ${result.vus}`, hint: `How many VUs sent Request ${result.rq}.` },
    { label: 'First to last send', value: groupMs(stats.spreadMs), hint: 'From the first send to the last, by the k6 clock (1 ms resolution).' },
    { label: 'Sent vs planned', value: sentVsPlan, hint: 'Send time minus planned time, over the VUs that were on time.' },
    { label: 'Peak in flight', value: `${stats.peakInFlight} at ${signedMs(Math.round(stats.peakAt))}`, hint: 'The most race requests on their way at once, from their send time to their response (k6 side).' },
    { label: 'New connections', value: `${stats.newConnections} of ${result.sent}`, hint: 'Race requests that had to connect (TCP or TLS) at race time. The warm-up keeps this at 0.' },
    { label: 'Tightest margin', value: margin, hint: 'Lead time the slowest VU had left when it reached the wait. Raise the lead time when it is small.' },
  ];
}

// One table row per record (text cells, in the order of RACE_RECORD_COLUMNS).
export const RACE_RECORD_COLUMNS = ['VU', 'Planned', 'Reached the wait', 'Sent', 'Sent vs planned', 'Took', 'Status', 'Outcome', 'New connection'];
export function raceRecordCells(entry) {
  const margin = entry.offset - entry.arrived;
  return [
    String(entry.vu),
    signedMs(entry.offset),
    entry.late ? `late by ${groupMs(-margin)}` : `${groupMs(margin)} before`,
    signedMs(entry.sent),
    signedMs(entry.sent - entry.offset),
    `${(Math.round(entry.ms * 10) / 10).toFixed(1)} ms`,
    entry.status ? String(entry.status) : `failed${entry.errorCode ? ` (k6 error ${entry.errorCode})` : ''}`,
    entry.outcome || '—',
    entry.newConnection ? 'Yes' : 'No',
  ];
}

const lateText = result => {
  const request = `Request ${result.rq}`;
  const what = result.late === 1
    ? `was late: it reached ${request} at or after its planned send time and sent it at once`
    : `were late: they reached ${request} at or after their planned send time and sent it at once`;
  return `Race burst: ${result.late} of ${plural(result.vus, 'VU')} ${what}, so the burst was not as planned. Raise the lead time in Load Profile.`;
};

const missingText = result => {
  const sent = result.sent ? `only ${result.sent} of ${plural(result.vus, 'VU')} sent Request ${result.rq}` : `none of the ${plural(result.vus, 'VU')} sent Request ${result.rq}`;
  return `Race burst: ${sent}. The others ended their iteration before it (an error in an earlier request or a script, or a group that did not run): see Errors and Live Log.`;
};

// The Overview note for a result ('' when nothing is known): the late VUs first, then
// VUs that never sent the race request, else "all in time".
export function raceResultText(result) {
  if (!isObject(result) || result.late == null) return '';
  if (result.late) return lateText(result);
  if (result.missing) return missingText(result);
  return `Race burst: all ${plural(result.vus, 'VU')} reached Request ${result.rq} in time and sent it at their planned time.`;
}

// The entries a result adds under Errors: late VUs, VUs that never sent the race request.
export function raceErrors(result) {
  if (!isObject(result)) return [];
  const errors = [];
  if (result.late) errors.push(lateText(result));
  if (result.missing) errors.push(missingText(result));
  return errors;
}

// Does the note read as a warning (amber)?
export const raceResultWarns = result => Boolean(result?.late || result?.missing);
