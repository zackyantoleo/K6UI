// Race burst records (see server/generator/race.js k6uiRaceRecord): every VU that sends
// the race request logs one line
//   {"k6uiRace":1,"vu":3,"t0":…,"at":…,"ar":…,"sent":…,"ms":12.4,"cn":false,"s":200,"oc":"success"}
// k6-runner.js hands those lines here instead of the live log. The records stay in
// memory and go out with `done` (`raceRecords`, read by public/js/race.js
// readRaceResult); a race run is one short burst, so nothing is sent while it runs.
// At most MAX_RACE_RECORDS are kept; later ones are only counted (`dropped`).
export const RACE_LINE_PREFIX = '{"k6uiRace":1,';
export const MAX_RACE_RECORDS = 10_000;
const MAX_LABEL = 64;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

// One parsed line → a record, or null when it is not one K6UI wrote.
function readRecord(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { vu, t0, at, ar, sent, ms, cn, s, ec, oc } = entry;
  if (!Number.isInteger(vu) || vu < 1) return null;
  if (![t0, at, ar, sent].every(finite)) return null;
  return {
    vu,
    t0,
    at,
    ar,
    sent,
    ms: finite(ms) && ms >= 0 ? ms : 0,
    cn: cn === true,
    s: Number.isInteger(s) ? s : 0,
    ...(Number.isInteger(ec) && ec ? { ec } : {}),
    ...(typeof oc === "string" && oc ? { oc: oc.slice(0, MAX_LABEL) } : {}),
  };
}

export function createRaceCollector({ maxRecords = MAX_RACE_RECORDS } = {}) {
  const records = [];
  let dropped = 0;
  let seen = false;

  // One logged line (already unwrapped from k6's log format). → true when it was a
  // race record line (kept, counted or dropped), false for any other text.
  function addLine(raw) {
    if (!raw.startsWith(RACE_LINE_PREFIX)) return false;
    seen = true;
    let record = null;
    try {
      record = readRecord(JSON.parse(raw));
    } catch {
      return true;
    }
    if (!record) return true;
    if (records.length >= maxRecords) dropped++;
    else records.push(record);
    return true;
  }

  // What `done` carries: {} when no race line came (not a race run), else
  // { raceRecords: { records, dropped } }.
  function result() {
    return seen ? { raceRecords: { records, dropped } } : {};
  }

  return { addLine, result };
}
