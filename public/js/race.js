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

const text = value => (typeof value === 'string' ? value : value == null ? '' : String(value));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const oneLine = value => text(value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
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

// The plan + a k6 --summary-export → { rq, name, method, url, vus, failIfLate, late }.
// `late` = how many VUs reached the race request at or after their planned time;
// null without a summary (a stopped run).
export function readRaceResult(race, summary) {
  if (!isObject(race)) return null;
  const metric = isObject(summary?.metrics) ? summary.metrics[RACE_LATE_METRIC] : undefined;
  const count = Number(metric?.count);
  return {
    rq: race.rq ?? null,
    name: text(race.name),
    method: text(race.method),
    url: text(race.url),
    vus: Number(race.vus) || 0,
    failIfLate: race.failIfLate === true,
    late: isObject(metric) ? (Number.isFinite(count) ? count : 0) : null,
  };
}

// The Overview note and the Errors entry for a result ('' when nothing is known).
export function raceResultText(result) {
  if (!isObject(result) || result.late == null) return '';
  const request = `Request ${result.rq}`;
  if (!result.late) return `Race burst: all ${plural(result.vus, 'VU')} reached ${request} in time and sent it at their planned time.`;
  const what = result.late === 1
    ? `was late: it reached ${request} at or after its planned send time and sent it at once`
    : `were late: they reached ${request} at or after their planned send time and sent it at once`;
  return `Race burst: ${result.late} of ${plural(result.vus, 'VU')} ${what}, so the burst was not as planned. Raise the lead time in Load Profile.`;
}
