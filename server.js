import express from "express";
import { spawn, execFile } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { generateScript } from "./scriptGenerator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "public")));

// Cek apakah binary k6 tersedia di server.
app.get("/api/k6-status", (req, res) => {
  execFile("k6", ["version"], (err, stdout) => {
    if (err) {
      res.json({ installed: false });
    } else {
      res.json({ installed: true, version: String(stdout).trim() });
    }
  });
});

// Hasilkan script k6 dari konfigurasi UI.
app.post("/api/generate", (req, res) => {
  try {
    const script = generateScript(req.body || {});
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Jalankan test k6 dan streaming output secara live via Server-Sent Events.
app.post("/api/run", async (req, res) => {
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

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const workDir = join(tmpdir(), `k6ui-${randomUUID()}`);
  const scriptPath = join(workDir, "test.js");
  const summaryPath = join(workDir, "summary.json");

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(scriptPath, script, "utf8");
  } catch (err) {
    send("error", { message: `Gagal menyiapkan file test: ${err.message}` });
    res.end();
    return;
  }

  send("status", { message: "Memulai k6..." });

  const child = spawn("k6", ["run", "--summary-export", summaryPath, scriptPath], {
    cwd: workDir,
  });

  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      send("error", { message: "k6 tidak ditemukan di server. Pastikan k6 sudah terpasang (https://k6.io/docs/get-started/installation/)." });
    } else {
      send("error", { message: `Gagal menjalankan k6: ${err.message}` });
    }
    cleanup();
    res.end();
  });

  child.stdout.on("data", (chunk) => send("log", { line: chunk.toString() }));
  child.stderr.on("data", (chunk) => send("log", { line: chunk.toString() }));

  child.on("close", async (code) => {
    let summary = null;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(summaryPath, "utf8");
      summary = JSON.parse(raw);
    } catch {
      // summary mungkin tidak tersedia jika test gagal sangat awal
    }
    send("done", { code, summary });
    cleanup();
    res.end();
  });

  // Hentikan proses k6 jika klien menutup koneksi.
  req.on("close", () => {
    if (!child.killed) child.kill("SIGTERM");
  });

  async function cleanup() {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // abaikan kegagalan cleanup
    }
  }
});

app.listen(PORT, () => {
  console.log(`K6UI berjalan di http://localhost:${PORT}`);
});
