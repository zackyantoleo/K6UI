// Builds the k6 `options` object (load + thresholds) from the UI configuration.
import { raceScenario, raceThresholds } from "./race.js";
import { RACE_LATE_METRIC } from "../../public/js/shared/race.js";

// k6 aborts a per-vu-iterations scenario after maxDuration (its own default is
// only 10m), so slower flows need a roomier cap.
export const DEFAULT_MAX_DURATION = "1h";

const wholeNumber = (value) => (Math.floor(Number(value)) >= 1 ? Math.floor(Number(value)) : 1);

// `race` = the race burst plan (generator/race.js planRaceScript), null otherwise.
export function buildOptions(config, race = null) {
  const load = config.load || {};
  const options = {};

  if (race) {
    options.scenarios = raceScenario(race);
  } else if (load.mode === "iterations") {
    options.scenarios = {
      default: {
        executor: "per-vu-iterations",
        vus: wholeNumber(load.vus),
        iterations: wholeNumber(load.iterations),
        maxDuration: String(load.maxDuration ?? "").trim() || DEFAULT_MAX_DURATION,
      },
    };
  } else if (load.mode === "stages" && Array.isArray(load.stages) && load.stages.length > 0) {
    options.stages = load.stages
      .filter((s) => s && s.duration && s.target !== "" && s.target != null)
      .map((s) => ({ duration: String(s.duration), target: Number(s.target) }));
  } else {
    options.vus = Number(load.vus) > 0 ? Number(load.vus) : 1;
    options.duration = load.duration ? String(load.duration) : "30s";
  }

  const t = config.thresholds || {};
  const thresholds = {};
  if (t.p95 !== "" && t.p95 != null && !Number.isNaN(Number(t.p95))) {
    thresholds.http_req_duration = [`p(95)<${Number(t.p95)}`];
  }
  if (t.errorRate !== "" && t.errorRate != null && !Number.isNaN(Number(t.errorRate))) {
    thresholds.http_req_failed = [`rate<${Number(t.errorRate) / 100}`];
  }
  if (race) thresholds[RACE_LATE_METRIC] = raceThresholds(race);
  if (Object.keys(thresholds).length > 0) {
    options.thresholds = thresholds;
  }

  return options;
}
