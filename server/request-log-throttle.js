// Request records ({__r:1,...} lines, see generator/request-log.js) → `req-log` events,
// at most REQ_LOG_RATE per second for passed requests and as many again for
// failed ones, so a fast run cannot flood the browser and a burst of passed
// requests never hides the errors. The browser keeps the most recent records
// (public/js/runner.js), so the Requests tab follows the run while it goes.
//
// Records over the budget are counted, not sent: a `req-log-skipped` event
// `{ skipped }` (running total) goes out at most once a second and on flush().
// The script has its own per-VU budget (generator/request-log.js, takeLogBudget): a
// record's `sk` is how many that VU left out before it, added to the total and
// removed from the record. What a VU leaves out after its last record is not
// counted, so the total is a lower bound.
export const REQ_LOG_RATE = 50;
const WINDOW_MS = 1000;

export function createRequestLogThrottle(onEvent, { rate = REQ_LOG_RATE, now = Date.now } = {}) {
  let windowStart = now();
  let sentOk = 0;
  let sentFailed = 0;
  let skipped = 0;
  let reportedSkipped = 0;
  let lastReport = -Infinity;

  function report(force) {
    if (skipped === reportedSkipped) return;
    const time = now();
    if (!force && time - lastReport < WINDOW_MS) return;
    lastReport = time;
    reportedSkipped = skipped;
    onEvent("req-log-skipped", { skipped });
  }

  return {
    add(entry) {
      const time = now();
      if (time - windowStart >= WINDOW_MS) {
        windowStart = time;
        sentOk = 0;
        sentFailed = 0;
      }
      if (entry && typeof entry === "object") {
        const before = Number(entry.sk);
        if (Number.isFinite(before) && before > 0) skipped += Math.floor(before);
        delete entry.sk;
      }
      const failed = !entry || entry.ok !== true;
      if ((failed ? sentFailed : sentOk) >= rate) {
        skipped += 1;
        report(false);
        return;
      }
      if (failed) sentFailed += 1;
      else sentOk += 1;
      onEvent("req-log", entry);
      report(false);
    },
    flush() {
      report(true);
    },
  };
}
