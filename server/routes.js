// API endpoints. k6 process logic lives in k6-runner.js, codegen in generator/.
import { Router } from "express";
import { execFile } from "node:child_process";

import { generateScript } from "./generator/index.js";
import { startK6Run } from "./k6-runner.js";

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
apiRouter.post("/generate", (req, res) => {
  try {
    const script = generateScript(req.body || {});
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/run — run a k6 test and stream live output via Server-Sent Events.
// Emitted events: status, log, req-log, error, done (see k6-runner.js).
apiRouter.post("/run", async (req, res) => {
  let script;
  try {
    script = generateScript(req.body || {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const run = await startK6Run(script, {
    onEvent: (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    onEnd: () => res.end(),
  });

  // Kill the k6 process if the client closes the connection.
  req.on("close", () => run.stop());
});
