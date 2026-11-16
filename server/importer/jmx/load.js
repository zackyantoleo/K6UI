// JMeter thread group → K6UI load profile. JMeter settings are in seconds;
// a ramp-up becomes a stage that ramps to the thread count, then one that holds.
// A thread group that loops a fixed number of times (no duration) becomes the
// iterations mode: every user runs that many iterations, then stops.
import { jmxNumber, bool, prop, str, titleOf } from "./props.js";

const FALLBACK_HOLD = 30;
const seconds = (n) => `${+n.toFixed(3)}s`;

function profile(vus, ramp, total) {
  if (ramp > 0 && vus > 1) {
    const stages = [{ duration: seconds(ramp), target: String(vus) }];
    if (total > ramp) stages.push({ duration: seconds(total - ramp), target: String(vus) });
    return { mode: "stages", vus: String(vus), duration: seconds(total), stages };
  }
  return { mode: "simple", vus: String(vus), duration: seconds(Math.max(total, 1)), stages: [] };
}

const iterationsProfile = (vus, iterations) => ({ mode: "iterations", vus: String(vus), iterations: String(iterations) });

function reader(tg, ctx) {
  const where = `thread group "${titleOf(tg)}"`;
  return (key, fallback, owner = tg) => {
    const raw = str(owner, key);
    const value = jmxNumber(raw, ctx, tg, where);
    if (value == null && raw.trim()) ctx.warn(tg, `${key} "${raw}" in ${where} is not a number; ${fallback} was used.`);
    return value ?? fallback;
  };
}

function wholeUsers(value, tg, ctx) {
  if (Number.isInteger(value) && value >= 1) return value;
  ctx.warn(tg, `Thread group "${titleOf(tg)}" has ${value} users; K6UI needs at least 1, so 1 was used.`);
  return 1;
}

function threadGroup(tg, ctx) {
  const num = reader(tg, ctx);
  const name = titleOf(tg);
  const vus = wholeUsers(num("ThreadGroup.num_threads", 1), tg, ctx);
  const ramp = Math.max(num("ThreadGroup.ramp_time", 0), 0);
  const scheduler = bool(tg, "ThreadGroup.scheduler");
  let total = scheduler ? num("ThreadGroup.duration", 0) : 0;

  let iterations = 0;
  if (!(total > 0)) {
    const loops = num("LoopController.loops", 1, prop(tg, "ThreadGroup.main_controller"));
    if (loops < 0) {
      ctx.warn(tg, `Thread group "${name}" loops until it is stopped; K6UI needs a duration, so the test holds for ${FALLBACK_HOLD}s after the ramp-up.`);
      total = ramp + FALLBACK_HOLD;
    } else if (Number.isInteger(loops) && loops >= 1) {
      iterations = loops;
    } else {
      ctx.warn(tg, `Thread group "${name}" has ${loops} loops; K6UI needs a whole number of at least 1, so 1 was used.`);
      iterations = 1;
    }
  }
  if (scheduler && num("ThreadGroup.delay", 0) > 0) {
    ctx.warn(tg, `The startup delay of thread group "${name}" is not supported and was ignored.`);
  }
  const onError = str(tg, "ThreadGroup.on_sample_error");
  if (onError && onError !== "continue") {
    ctx.warn(tg, `"Action after a sampler error" (${onError}) is not supported; k6 continues with the next request.`);
  }
  if (iterations) {
    if (ramp > 0 && vus > 1) {
      ctx.warn(tg, `Thread group "${name}" ramps up its ${vus} users over ${seconds(ramp)}; in iterations mode K6UI starts all users at once, so the ramp-up was ignored.`);
    }
    return iterationsProfile(vus, iterations);
  }
  return profile(vus, ramp, total);
}

// BlazeMeter Concurrency Thread Group (jmeter-plugins): TargetLevel users,
// RampUp then Hold, in minutes unless Unit is "S".
function concurrencyThreadGroup(tg, ctx) {
  const num = reader(tg, ctx);
  const unit = str(tg, "Unit") === "S" ? 1 : 60;
  const vus = wholeUsers(num("TargetLevel", 1), tg, ctx);
  const ramp = Math.max(num("RampUp", 0), 0) * unit;
  let hold = Math.max(num("Hold", 0), 0) * unit;
  if (ramp > 0 && num("Steps", 0) > 0) {
    ctx.warn(tg, `The stepped ramp-up of "${titleOf(tg)}" was imported as a smooth ramp-up.`);
  }
  if (!hold) {
    ctx.warn(tg, `"${titleOf(tg)}" has no hold time; the test holds for ${FALLBACK_HOLD}s after the ramp-up.`);
    hold = FALLBACK_HOLD;
  }
  return profile(vus, ramp, ramp + hold);
}

export function importLoad(tg, ctx) {
  const kind = tg.name.split(".").pop();
  if (kind === "ThreadGroup") return threadGroup(tg, ctx);
  if (kind === "ConcurrencyThreadGroup") return concurrencyThreadGroup(tg, ctx);
  ctx.warn(tg, `The load settings of ${kind} "${titleOf(tg)}" cannot be read; the load profile was set to 1 VU for ${FALLBACK_HOLD}s.`);
  return profile(1, 0, FALLBACK_HOLD);
}
