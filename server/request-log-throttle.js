// Request records ({__r:1,...} lines, see generator/index.js) → `req-log` events,
// at most REQ_LOG_RATE per second for passed requests and as many again for
// failed ones, so a fast run cannot flood the browser and a burst of passed
// requests never hides the errors. The browser keeps the most recent records
// (public/js/runner.js), so the Requests tab follows the run while it goes.
//
// Records over the budget are counted, not sent: a `req-log-skipped` event
// `{ skipped }` (running total) goes out at most once a second and on flush().
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
      const failed = !entry || entry.ok !== true;
      if ((failed ? sentFailed : sentOk) >= rate) {
        skipped += 1;
        report(false);
        return;
      }
      if (failed) sentFailed += 1;
      else sentOk += 1;
      onEvent("req-log", entry);
    },
    flush() {
      report(true);
    },
  };
}
