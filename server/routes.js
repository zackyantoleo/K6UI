// API endpoints. k6 process logic lives in k6-runner.js, codegen in generator/.
import express, { Router } from "express";
import { execFile } from "node:child_process";

import { generateScript } from "./generator/index.js";
import { ScriptImportError, importK6Script } from "./importer/index.js";
import { importJmx } from "./importer/jmx/index.js";
import { startK6Run } from "./k6-runner.js";
import { readOutcomeResults } from "../public/js/outcomes.js";

export const apiRouter = Router();

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

// POST /api/run — run a k6 test and stream live output via Server-Sent Events.
// Emitted events: status, log, req-log, req-log-skipped, export, error, done (see k6-runner.js);
// `done` also has `outcomes` when a request has outcome rules (public/js/outcomes.js readOutcomeResults).
apiRouter.post("/run", async (req, res) => {
  let script;
  const meta = {};
  try {
    script = generateScript(req.body || {}, meta);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }

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

  run = await startK6Run(script, {
    onEvent: (event, data) => {
      // Outcome rules: `done` also carries what each label counted (from the summary).
      if (event === "done" && meta.outcomes?.length) {
        data = { ...data, outcomes: readOutcomeResults(meta.outcomes, data?.summary) };
      }
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    onEnd: () => res.end(),
  });
  if (clientClosed) run.stop();
});
