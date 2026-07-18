// Endpoint API. Logika proses k6 ada di k6-runner.js, codegen di generator/.
import { Router } from "express";
import { execFile } from "node:child_process";

import { generateScript } from "./generator/index.js";
import { startK6Run } from "./k6-runner.js";

export const apiRouter = Router();

// GET /api/k6-status — cek apakah binary k6 tersedia di server.
apiRouter.get("/k6-status", (_req, res) => {
  execFile("k6", ["version"], (err, stdout) => {
    if (err) {
      res.json({ installed: false });
    } else {
      res.json({ installed: true, version: String(stdout).trim() });
    }
  });
});

// POST /api/generate — hasilkan script k6 dari konfigurasi UI.
apiRouter.post("/generate", (req, res) => {
  try {
    const script = generateScript(req.body || {});
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/run — jalankan test k6 dan stream output live via Server-Sent Events.
// Event yang dikirim: status, log, req-log, error, done (lihat k6-runner.js).
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

  // Hentikan proses k6 jika klien menutup koneksi.
  req.on("close", () => run.stop());
});
