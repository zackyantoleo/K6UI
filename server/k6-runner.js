// Runs k6 against a temporary script and forwards its output as events.
//
// startK6Run(script, { onEvent, onEnd, metricsIntervalMs }) writes the script to a temp folder,
// spawns `k6 run`, then emits events through onEvent(event, data):
//   status  — progress message, e.g. "Starting k6..."
//   log     — one raw line of k6 output
//   req-log — details of a single request: URL, status, timing, request and response
//             headers and bodies (redacted, capped), emitted by the script as console.log
//             JSON {__r:1,...}; rate-limited by request-log-throttle.js
//   req-log-skipped — { skipped }: records left out by that rate limit (running total)
//   export  — rows saved with "Save to CSV" (console.log JSON {"k6uiExport":...}, see
//             export-collector.js); never shown as a log line, flushed before done
//             (a race burst's per-VU records, {"k6uiRace":1,...}, are kept by
//             race-collector.js and go out with done as `raceRecords`)
//   metrics — live counts while k6 runs, about once a second (see live-metrics.js
//             readLiveMetrics); polled from k6's REST API, never after done
//   error   — failures (k6 not installed, failed to write the file, etc.)
//   done    — process finished: { code, outcome, summary } (summary from --summary-export),
//             plus raceRecords: { records, dropped } when the script logged race records
// onEnd() is called once the process ends. Return value: { stop() } to
// terminate k6 (e.g. when the client closes the connection).
//
// k6 gets `--address 127.0.0.1:<port>` with a port the OS reports free, so its REST
// API never clashes with another run (k6 exits with code 106 when the port is
// taken), and the runner polls `GET /v1/metrics` there until k6 exits or stop() is
// called. A poll that fails is skipped and never affects the run. Without a free port
// k6 starts as before (its own default address) and no metrics events are sent.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { K6_NOT_FOUND, createScriptFolder, spawnK6 } from "./k6-process.js";
import { consoleMessageOf } from "./k6-console.js";
import { createExportCollector } from "./export-collector.js";
import { createRaceCollector } from "./race-collector.js";
import { createRequestLogThrottle } from "./request-log-throttle.js";
import { METRICS_INTERVAL_MS, freePort, startMetricsPoller } from "./live-metrics.js";

export async function startK6Run(script, { onEvent, onEnd, metricsIntervalMs = METRICS_INTERVAL_MS }) {
  let folder;
  try {
    folder = await createScriptFolder("k6ui-run-", "test.js", script);
  } catch (err) {
    onEvent("error", { message: `Failed to prepare the test file: ${err.message}` });
    onEnd();
    return { stop() {} };
  }
  const summaryPath = join(folder.dir, "summary.json");

  onEvent("status", { message: "Starting k6..." });

  const requestLogs = createRequestLogThrottle(onEvent);
  const exportRows = createExportCollector(onEvent);
  const raceRecords = createRaceCollector();

  // K6UI's own console lines (Save to CSV rows, race records, request records) never
  // reach the live log, not even a broken one, since it may hold a token.
  function handleOutputLine(line) {
    const message = consoleMessageOf(line);
    if (message !== null) {
      if (exportRows.addLine(message)) return;
      if (raceRecords.addLine(message)) return;
      if (message.startsWith('{"__r":1,')) {
        try {
          requestLogs.add(JSON.parse(message));
        } catch { /* a broken record is dropped */ }
        return;
      }
    }
    onEvent("log", { line: line + "\n" });
  }

  const apiPort = await freePort().catch(() => null);
  const args = ["run", "--summary-export", summaryPath];
  if (apiPort) args.push("--address", `127.0.0.1:${apiPort}`);
  args.push(folder.path);
  const { child, flushOutput } = spawnK6(args, { cwd: folder.dir, onLine: handleOutputLine });
  const poller = apiPort
    ? startMetricsPoller({
      url: `http://127.0.0.1:${apiPort}/v1/metrics`,
      intervalMs: metricsIntervalMs,
      onMetrics: (metrics) => onEvent("metrics", metrics),
    })
    : null;

  // The run ends exactly once: after `close`, or after an `error` that means k6 never
  // started (a spawn failure is followed by a `close` too, which is then ignored).
  // A failure while the results are read or handed over becomes an `error` event, not
  // an unhandled rejection (that would stop the server); the folder is removed and
  // onEnd() runs either way.
  let finished = false;
  async function finish(readResults) {
    if (finished) return;
    finished = true;
    poller?.stop();
    try {
      if (readResults) onEvent("done", await readResults());
    } catch (err) {
      onEvent("error", { message: `Failed to read the results: ${err.message}` });
    } finally {
      await folder.remove();
      onEnd();
    }
  }

  child.on("error", (err) => {
    onEvent("error", { message: err.code === "ENOENT" ? K6_NOT_FOUND : `Failed to run k6: ${err.message}` });
    // Without a pid k6 never started; otherwise (a failed kill) `close` still follows.
    if (child.pid === undefined) finish(null);
  });

  child.on("close", (code) => finish(async () => {
    flushOutput();
    let summary = null;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // the summary may be missing if the test failed very early
    }
    const outcome = code === 0 ? "passed" : code === 99 ? "threshold-failed" : "failed";
    exportRows.flush();
    requestLogs.flush();
    return { code, outcome, summary, ...raceRecords.result() };
  }));

  return {
    stop() {
      poller?.stop();
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
