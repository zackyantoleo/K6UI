// k6 `options` object → K6UI load profile + thresholds. Only what K6UI can
// represent is imported; every other option is reported as ignored.
import { keyOf, resolveConst, tryStatic, Unresolvable } from "./values.js";
import { DEFAULT_MAX_DURATION } from "../generator/options.js";

const P95 = /^p\(\s*95\s*\)\s*<\s*(\d+(?:\.\d+)?)$/;
const RATE = /^rate\s*<\s*(\d+(?:\.\d+)?)$/;

// A threshold entry is "p(95)<500" or { threshold: "p(95)<500", abortOnFail }.
function thresholdExpressions(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? item.threshold : null))
    .filter((expr) => typeof expr === "string");
}

function readThresholds(node, thresholds, ctx) {
  const obj = resolveConst(node, ctx);
  if (obj?.type !== "ObjectExpression") {
    ctx.warn(node, "options.thresholds could not be read and was ignored.");
    return;
  }
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    let metric;
    try {
      metric = String(keyOf(prop.key, prop.computed, ctx));
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
      continue;
    }
    const exprs = thresholdExpressions(tryStatic(prop.value, ctx));
    for (const expr of exprs.map((e) => e.trim())) {
      let match;
      if (metric === "http_req_duration" && (match = P95.exec(expr))) {
        thresholds.p95 ||= match[1];
      } else if (metric === "http_req_failed" && (match = RATE.exec(expr))) {
        thresholds.errorRate ||= String(+(Number(match[1]) * 100).toFixed(6));
      } else {
        ctx.warn(prop, `Threshold ${metric}: "${expr}" is not supported (K6UI imports p(95) on http_req_duration and rate on http_req_failed) and was ignored.`);
      }
    }
  }
}

function readStages(value, node, ctx) {
  if (!Array.isArray(value)) {
    ctx.warn(node, "options.stages could not be read and was ignored.");
    return [];
  }
  const stages = [];
  for (const stage of value) {
    const target = Number(stage?.target);
    if (stage && typeof stage.duration === "string" && stage.target !== "" && Number.isFinite(target)) {
      stages.push({ duration: stage.duration, target: String(target) });
    } else {
      ctx.warn(node, "A stage without a text duration and a numeric target was skipped.");
    }
  }
  return stages;
}

// `scenarios: { name: { executor: "per-vu-iterations", vus, iterations, maxDuration } }`
// (what K6UI's iterations mode generates) → the iterations load profile. Only a
// single plain per-vu-iterations scenario fits; anything else is skipped.
const SCENARIO_KEYS = new Set(["executor", "vus", "iterations", "maxDuration"]);

function readScenarios(value, node, ctx) {
  const names = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (!names.length) {
    ctx.warn(node, "options.scenarios could not be read and was ignored.");
    return null;
  }
  if (names.length > 1) {
    ctx.warn(node, "options.scenarios has more than one scenario; K6UI imports a single per-vu-iterations scenario, so they were ignored.");
    return null;
  }
  const scenario = value[names[0]];
  if (scenario?.executor !== "per-vu-iterations") {
    ctx.warn(node, `Scenario "${names[0]}" does not use the per-vu-iterations executor, the only one K6UI imports, so it was ignored.`);
    return null;
  }

  // k6 defaults for this executor: 1 VU, 1 iteration, 10m maxDuration.
  const whole = (key) => {
    if (scenario[key] === undefined) return "1";
    if (Number.isInteger(scenario[key]) && scenario[key] > 0) return String(scenario[key]);
    ctx.warn(node, `Scenario "${names[0]}" ${key} is not a positive whole number; 1 was used.`);
    return "1";
  };
  const load = { mode: "iterations", vus: whole("vus"), iterations: whole("iterations") };
  const maxDuration = scenario.maxDuration === undefined ? "10m" : scenario.maxDuration;
  if (typeof maxDuration === "string" && maxDuration.trim()) {
    if (maxDuration.trim() !== DEFAULT_MAX_DURATION) load.maxDuration = maxDuration.trim();
  } else {
    ctx.warn(node, `Scenario "${names[0]}" maxDuration is not a text like "1h"; the default was used.`);
  }
  for (const key of Object.keys(scenario)) {
    if (!SCENARIO_KEYS.has(key)) ctx.warn(node, `Scenario "${names[0]}" option ${key} is not supported and was ignored.`);
  }
  return load;
}

export function importOptions(optionsNode, ctx) {
  const load = { mode: "simple", vus: "1", duration: "30s", stages: [] };
  const thresholds = { p95: "", errorRate: "" };

  const obj = optionsNode ? resolveConst(optionsNode, ctx) : null;
  if (obj?.type !== "ObjectExpression") {
    ctx.warn(optionsNode ?? null, "No `options` object found; the load profile was set to 1 VU for 30s.");
    return { load, thresholds };
  }

  let sawDuration = false;
  let sawVus = false;
  let stages = [];
  let scenarioLoad = null;
  for (const prop of obj.properties) {
    if (prop.type !== "Property") {
      ctx.warn(prop, "A spread in `options` was ignored.");
      continue;
    }
    let key;
    try {
      key = String(keyOf(prop.key, prop.computed, ctx));
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
      continue;
    }

    if (key === "thresholds") {
      readThresholds(prop.value, thresholds, ctx);
    } else if (key === "scenarios") {
      scenarioLoad = readScenarios(tryStatic(prop.value, ctx), prop, ctx);
    } else if (key === "stages") {
      stages = readStages(tryStatic(prop.value, ctx), prop, ctx);
    } else if (key === "vus") {
      const vus = tryStatic(prop.value, ctx);
      if (Number.isInteger(vus) && vus > 0) { load.vus = String(vus); sawVus = true; }
      else ctx.warn(prop, "options.vus is not a positive whole number and was ignored.");
    } else if (key === "duration") {
      const duration = tryStatic(prop.value, ctx);
      if (typeof duration === "string" && duration.trim()) { load.duration = duration.trim(); sawDuration = true; }
      else ctx.warn(prop, "options.duration is not a text like \"30s\" and was ignored.");
    } else {
      ctx.warn(prop, `options.${key} is not supported and was ignored.`);
    }
  }

  if (scenarioLoad) {
    if (stages.length || sawDuration || sawVus) {
      ctx.warn(obj, "options.vus, duration and stages are ignored when scenarios are set.");
    }
    return { load: scenarioLoad, thresholds };
  }
  if (stages.length) {
    load.mode = "stages";
    load.stages = stages;
    if (sawVus) ctx.warn(obj, "options.vus is ignored when stages are set (k6 uses it as the starting VU count).");
  } else if (!sawDuration) {
    ctx.warn(obj, "options has no duration or stages; K6UI needs one, so it was set to 30s.");
  }
  return { load, thresholds };
}
