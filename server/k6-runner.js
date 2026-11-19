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
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createExportCollector } from "./export-collector.js";
import { createRaceCollector } from "./race-collector.js";
import { createRequestLogThrottle } from "./request-log-throttle.js";
import { METRICS_INTERVAL_MS, freePort, startMetricsPoller } from "./live-metrics.js";

export async function startK6Run(script, { onEvent, onEnd, metricsIntervalMs = METRICS_INTERVAL_MS }) {
  const workDir = join(tmpdir(), `k6ui-${randomUUID()}`);
  const scriptPath = join(workDir, "test.js");
  const summaryPath = join(workDir, "summary.json");

  async function cleanup() {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(scriptPath, script, "utf8");
  } catch (err) {
    onEvent("error", { message: `Failed to prepare the test file: ${err.message}` });
    onEnd();
    return { stop() {} };
  }

  onEvent("status", { message: "Starting k6..." });

  const apiPort = await freePort().catch(() => null);
  const args = ["run", "--summary-export", summaryPath];
  if (apiPort) args.push("--address", `127.0.0.1:${apiPort}`);
  args.push(scriptPath);
  const child = spawn("k6", args, { cwd: workDir });
  const poller = apiPort
    ? startMetricsPoller({
      url: `http://127.0.0.1:${apiPort}/v1/metrics`,
      intervalMs: metricsIntervalMs,
      onMetrics: (metrics) => onEvent("metrics", metrics),
    })
    : null;

  child.on("error", (err) => {
    poller?.stop();
    if (err.code === "ENOENT") {
      onEvent("error", { message: "k6 was not found on the server. Make sure k6 is installed (https://k6.io/docs/get-started/installation/)." });
    } else {
      onEvent("error", { message: `Failed to run k6: ${err.message}` });
    }
    cleanup();
    onEnd();
  });

  const requestLogs = createRequestLogThrottle(onEvent);
  const exportRows = createExportCollector(onEvent);
  const raceRecords = createRaceCollector();

  // Split the stdout/stderr streams into whole lines.
  function makeLineSplitter(onLine) {
    let buf = "";
    return (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    };
  }

  function handleOutputLine(line) {
    const t = line.trim();
    // k6 wraps console.log in logrus text format: ...msg="<content>" source=console
    const consoleMatch = t.match(/ msg="(.*)" source=console$/);
    if (consoleMatch) {
      try {
        // logrus escaping is equivalent to JSON string body escaping — reverse it
        const raw = JSON.parse('"' + consoleMatch[1] + '"');
        if (exportRows.addLine(raw)) return;
        if (raceRecords.addLine(raw)) return;
        if (raw.startsWith('{"__r":1,')) {
          requestLogs.add(JSON.parse(raw));
          return;
        }
      } catch { /* fall through to a plain log line */ }
    }
    onEvent("log", { line: line + "\n" });
  }

  child.stdout.on("data", makeLineSplitter(handleOutputLine));
  child.stderr.on("data", makeLineSplitter(handleOutputLine));

  child.on("close", async (code) => {
    poller?.stop();
    let summary = null;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // the summary may be missing if the test failed very early
    }
    const outcome = code === 0 ? "passed" : code === 99 ? "threshold-failed" : "failed";
    exportRows.flush();
    requestLogs.flush();
    onEvent("done", { code, outcome, summary, ...raceRecords.result() });
    await cleanup();
    onEnd();
  });

  return {
    stop() {
      poller?.stop();
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
