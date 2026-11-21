// API endpoints. k6 process logic lives in k6-runner.js, codegen in generator/.
import express, { Router } from "express";
import { execFile } from "node:child_process";

import { generateScript } from "./generator/index.js";
import { ScriptImportError, importK6Script } from "./importer/index.js";
import { importJmx } from "./importer/jmx/index.js";
import { startK6Run } from "./k6-runner.js";
import { SendOnceError, sendOnce } from "./send-once.js";
import { createSseWriter } from "./sse-writer.js";
import { readOutcomeResults } from "../public/js/shared/outcomes.js";
import { readLiveOutcomeThresholdResults, readOutcomeThresholdResults } from "../public/js/shared/outcome-thresholds.js";
import { readRaceResult } from "../public/js/shared/race.js";

export const apiRouter = Router();

// Live outcome counts ({ "<submetric>": n }) in the shape of a --summary-export, so
// readOutcomeResults() reads them like the final summary.
const liveSummary = counts => ({
  metrics: Object.fromEntries(Object.entries(counts || {}).map(([key, count]) => [key, { count }])),
});

// GET /api/k6-status — check whether the k6 binary is available on the server.
apiRouter.get("/k6-status", (_req, res) => {
  execFile("k6", ["version"], (err, stdout) => {
    if (err) {
      res.json({ installed: false });
    } else {
      res.json({ installed: true, version: String(stdout).trim() });
    }
  });
});

// POST /api/generate — generate a k6 script from the UI configuration.
// 400 { error } for an invalid configuration, 413 when its data files are too big.
apiRouter.post("/generate", (req, res) => {
  try {
    const script = generateScript(req.body || {});
    res.json({ script });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST /api/import-script — read a k6 script (never executed) into a UI configuration.
// Body: { script }. Response: { config, warnings: [{ line, message }] } or 400 { error, warnings }.
apiRouter.post("/import-script", (req, res) => {
  try {
    res.json(importK6Script(req.body?.script));
  } catch (err) {
    if (!(err instanceof ScriptImportError)) throw err;
    res.status(400).json({ error: err.message, warnings: err.warnings });
  }
});

// POST /api/import-jmx — read a JMeter test plan (raw .jmx XML body, never run) into a UI configuration.
// Response: { config, warnings: [{ line, message }] } or 400 { error, warnings }.
apiRouter.post("/import-jmx", express.text({ type: ["application/xml", "text/xml"], limit: "10mb" }), (req, res) => {
  try {
    res.json(importJmx(typeof req.body === "string" ? req.body : ""));
  } catch (err) {
    if (!(err instanceof ScriptImportError)) throw err;
    res.status(400).json({ error: err.message, warnings: err.warnings });
  }
});

// POST /api/send-once — send one request of the project a single time with k6 (see
// send-once.js). Body: { config, requestId }. Response: { sent, ok, error, request,
// response, unresolved, log } (or { sent: false, error, log }); 400 { error } for a
// request that cannot be sent, 413 for a body over 24 MB, 429 while two are running,
// 503 without k6, 504 after 30 s. The browser renders every value as text.
apiRouter.post("/send-once", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const controller = new AbortController();
  // The client went away (closed tab, a new Send once): stop k6.
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  try {
    const result = await sendOnce(req.body?.config, req.body?.requestId, { signal: controller.signal });
    if (!controller.signal.aborted) res.json(result);
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof SendOnceError) res.status(err.status).json({ error: err.message });
    else res.status(500).json({ error: `Send once failed: ${err.message}` });
  }
});

// The outcome labels of the race request, in rule order (the Gantt colours follow it).
function raceLabels(meta) {
  const target = (meta.outcomes || []).find((item) => item.rq === meta.race?.rq);
  return target ? { labels: target.labels, fallback: target.fallback } : null;
}

// Load tests running at once (two tabs may each run one). A run takes its place before k6
// starts and gives it back when k6 has exited (onEnd), so a stopped run still counts
// until its process is gone. One more is a 429.
export const MAX_RUNS = 2;
let runningRuns = 0;

// POST /api/run — run a k6 test and stream live output via Server-Sent Events.
// Emitted events: status, log, req-log, req-log-skipped, export, metrics, error, done (see k6-runner.js);
// `done` also has `outcomes` when a request has outcome rules (public/js/shared/outcomes.js readOutcomeResults),
// `outcomeThresholds` when outcome targets are set (public/js/shared/outcome-thresholds.js), and `race` in
// race burst mode (public/js/shared/race.js readRaceResult: how many VUs were late, and every VU's
// planned and actual send time from the script's records). Each live
// `metrics` event gets the same two outcome fields from its `outcomeCounts`, with live target statuses.
// Before the stream: 400 / 413 for the configuration, 429 while MAX_RUNS tests run. k6 output lines
// that come faster than the browser reads them are left out and counted (sse-writer.js).
apiRouter.post("/run", async (req, res) => {
  if (runningRuns >= MAX_RUNS) {
    res.status(429).json({ error: `${MAX_RUNS} tests are already running. Stop one, or wait for it to finish.` });
    return;
  }
  let script;
  const meta = {};
  try {
    script = generateScript(req.body || {}, meta);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

  // Taken before the first await, so two requests at once cannot both get the last place.
  runningRuns += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    runningRuns -= 1;
  };
  const write = createSseWriter(res);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Kill the k6 process if the client closes the connection (UI Stop, tab
  // closed). Listen on the response: `req` "close" has already fired once the
  // JSON body was read, so it never reports a later disconnect. Attached before
  // the await so a disconnect during start-up is not missed.
  let run = null;
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
    run?.stop();
  });

  try {
    run = await startK6Run(script, {
      onEvent: (event, data) => {
        // Outcome rules: `done` also carries what each label counted (from the summary).
        if (event === "done" && meta.outcomes?.length) {
          data = { ...data, outcomes: readOutcomeResults(meta.outcomes, data?.summary) };
        }
        // Outcome targets: met, not met, or not checked, each with its label's count.
        if (event === "done" && meta.outcomeThresholds?.length) {
          data = { ...data, outcomeThresholds: readOutcomeThresholdResults(meta.outcomeThresholds, data?.summary) };
        }
        // Race burst: how many VUs were late (from the summary) and the per-VU records
        // the script logged (k6-runner.js `raceRecords`, which is not sent as such).
        if (event === "done" && data?.raceRecords) {
          const { raceRecords, ...rest } = data;
          data = meta.race ? { ...rest, race: readRaceResult(meta.race, rest.summary, raceRecords, raceLabels(meta)) } : rest;
        } else if (event === "done" && meta.race) {
          data = { ...data, race: readRaceResult(meta.race, data?.summary, null, raceLabels(meta)) };
        }
        // Live: the same two fields while k6 runs, from the counts read so far.
        if (event === "metrics" && meta.outcomes?.length) {
          data = { ...data, outcomes: readOutcomeResults(meta.outcomes, liveSummary(data.outcomeCounts)) };
        }
        if (event === "metrics" && meta.outcomeThresholds?.length) {
          data = { ...data, outcomeThresholds: readLiveOutcomeThresholdResults(meta.outcomeThresholds, data.outcomeCounts) };
        }
        write(event, data);
      },
      onEnd: () => {
        release();
        res.end();
      },
    });
  } catch (err) {
    // startK6Run reports its own failures as events; this is only what it cannot.
    release();
    write("error", { message: `Failed to start k6: ${err.message}` });
    res.end();
    return;
  }
  if (clientClosed) run.stop();
});
