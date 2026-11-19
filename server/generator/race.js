// Race burst load mode (config.load.mode "race", see public/js/race.js) → k6 code:
//   options     per-vu-iterations, 1 iteration per VU; k6ui_race_late gets count>=0
//               (so k6 reports it) and, with "fail if late", count==0
//   top level   const RACE (the plan; `config` is the form as typed, for the importer),
//               RACE_LATE (Counter k6ui_race_late), RACE_WARMUP (every status expected),
//               setup() → { k6uiRaceT0 }, k6uiRaceWait(), k6uiRaceWarmup()
//   flow        right before the race request's pre-processor:
//                 k6uiRaceWarmup(<its URL>);            (with the warm-up)
//                 const race_at_<i> = k6uiRaceWait(data.k6uiRaceT0);
// The wait sits before the pre-processor, so what it computes (a timestamp, a
// signature) is fresh when the request leaves. A script without race mode is unchanged.
import { DEFAULT_MAX_DURATION } from "./options.js";
import { interpolate } from "./interpolate.js";
import { RACE_LATE_METRIC, RACE_WARMUP_TAG, planRace } from "../../public/js/race.js";

// → the plan (public/js/race.js planRace), or null when the load mode is not race.
// A race that cannot work is a 400 naming the field.
export function planRaceScript(config) {
  const { problem, race } = planRace(config);
  if (problem) throw new Error(problem);
  return race;
}

// k6 options of a race: every VU starts at once and runs the flow once.
export function raceScenario(race) {
  return {
    default: {
      executor: "per-vu-iterations",
      vus: race.vus,
      iterations: 1,
      maxDuration: race.maxDuration || DEFAULT_MAX_DURATION,
    },
  };
}

// k6 reports a metric in --summary-export only when it has a threshold.
export function raceThresholds(race) {
  return race.failIfLate ? ["count>=0", "count==0"] : ["count>=0"];
}

const RACE_HELPERS = String.raw`
// Race burst: T0, the time every planned send counts from, set once for all VUs when
// setup() ends: now + the lead time.
export function setup() {
  return { k6uiRaceT0: Date.now() + RACE.leadMs };
}

// Race burst: sleeps until this VU's planned send time (T0 + its offset), busy-waits the
// last RACE.spinMs ms (sleep wakes up a few ms late), and returns that time. A VU that
// gets here at or after it is late: it is counted in k6ui_race_late and sends at once.
function k6uiRaceWait(t0) {
  const at = t0 + RACE.offsets[(__VU - 1) % RACE.offsets.length];
  const wait = at - Date.now();
  if (wait <= 0) {
    RACE_LATE.add(1);
    return at;
  }
  if (wait > RACE.spinMs) sleep((wait - RACE.spinMs) / 1000);
  while (Date.now() < at) { /* busy-wait */ }
  return at;
}`;

const WARMUP_HELPER = String.raw`
// Race burst: one GET to the race request's origin before the wait, so the race request
// reuses an open connection instead of connecting at race time. Every status counts as
// expected; it is still counted in http_reqs and the response times.
function k6uiRaceWarmup(url) {
  const origin = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\/?#]+/.exec(String(url));
  if (origin) http.get(origin[0] + RACE.warmupPath, { tags: { k6ui: "${RACE_WARMUP_TAG}" }, responseCallback: RACE_WARMUP });
}`;

// Top-level code of a race (after `options`).
export function buildRaceSource(race) {
  const data = {
    request: race.rq,
    offsets: race.offsets,
    leadMs: race.leadMs,
    spinMs: race.spinMs,
    warmupPath: race.warmupPath,
    config: {
      timing: race.typed.timing,
      vus: race.typed.vus,
      spreadMs: race.typed.spreadMs,
      offsets: race.typed.offsets,
      leadMs: race.typed.leadMs,
      warmup: race.typed.warmup,
      warmupPath: race.typed.warmupPath,
      failIfLate: race.typed.failIfLate,
    },
  };
  let out = `\n// Race burst (Load Profile): every VU sends request ${race.rq} once, at T0 + its offset in ms.\n`;
  out += `const RACE = ${JSON.stringify(data)};\n`;
  out += `const RACE_LATE = new Counter(${JSON.stringify(RACE_LATE_METRIC)});\n`;
  if (race.warmup) out += `const RACE_WARMUP = http.expectedStatuses({ min: 100, max: 599 });\n`;
  out += `${RACE_HELPERS}\n`;
  if (race.warmup) out += `${WARMUP_HELPER}\n`;
  return out;
}

const PLACEHOLDER = /\{\{(\$?\w+)\}\}/g;

// The lines before the race request's pre-processor. `assigned` = the names its own
// pre-processor sets (vars.<name>): the warm-up runs before that script, so a URL
// that reads one of them (and no extracted value of that name) has no origin yet.
export function buildRaceWaitCode(race, req, ctx, assigned) {
  let out = "";
  if (race.warmup) {
    const late = [...String(req.url || "").matchAll(PLACEHOLDER)]
      .map((match) => match[1])
      .find((name) => assigned.has(name) && !ctx.localVars.has(name));
    if (late) {
      throw new Error(`Race burst: the warm-up runs before the pre-processor of request ${race.rq}, but its URL uses {{${late}}}, which that pre-processor sets. Turn off "Open the connection first", or build the URL from a global variable.`);
    }
    out += `\n  // Race burst: open the connection first (warm-up), then wait for this VU's send time\n`;
    out += `  k6uiRaceWarmup(${interpolate(req.url, ctx)});\n`;
  } else {
    out += `\n  // Race burst: wait for this VU's send time\n`;
  }
  out += `  const race_at_${race.index} = k6uiRaceWait(data.k6uiRaceT0);\n`;
  return out;
}
