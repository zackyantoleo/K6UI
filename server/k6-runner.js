// Menjalankan k6 pada script sementara dan meneruskan output sebagai event.
//
// startK6Run(script, { onEvent, onEnd }) menulis script ke folder temp,
// spawn `k6 run`, lalu memancarkan event lewat onEvent(event, data):
//   status  — pesan progres, mis. "Memulai k6..."
//   log     — satu baris output mentah k6
//   req-log — detail satu request (dipancarkan script via console.log JSON {__r:1,...})
//   error   — kegagalan (k6 tidak terpasang, gagal tulis file, dll.)
//   done    — proses selesai: { code, summary } (summary dari --summary-export)
// onEnd() dipanggil sekali proses berakhir. Return value: { stop() } untuk
// menghentikan k6 (mis. saat klien menutup koneksi).
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Batas jumlah event req-log per run agar UI tidak kebanjiran.
const MAX_REQ_LOGS = 500;

export async function startK6Run(script, { onEvent, onEnd }) {
  const workDir = join(tmpdir(), `k6ui-${randomUUID()}`);
  const scriptPath = join(workDir, "test.js");
  const summaryPath = join(workDir, "summary.json");

  async function cleanup() {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // abaikan kegagalan cleanup
    }
  }

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(scriptPath, script, "utf8");
  } catch (err) {
    onEvent("error", { message: `Gagal menyiapkan file test: ${err.message}` });
    onEnd();
    return { stop() {} };
  }

  onEvent("status", { message: "Memulai k6..." });

  const child = spawn("k6", ["run", "--summary-export", summaryPath, scriptPath], {
    cwd: workDir,
  });

  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      onEvent("error", { message: "k6 tidak ditemukan di server. Pastikan k6 sudah terpasang (https://k6.io/docs/get-started/installation/)." });
    } else {
      onEvent("error", { message: `Gagal menjalankan k6: ${err.message}` });
    }
    cleanup();
    onEnd();
  });

  let reqLogCount = 0;

  // Pecah stream stdout/stderr menjadi baris utuh.
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
    // k6 membungkus console.log dalam format teks logrus: ...msg="<content>" source=console
    const consoleMatch = t.match(/ msg="(.*)" source=console$/);
    if (consoleMatch) {
      try {
        // Escaping logrus setara dengan escaping isi string JSON — balikkan
        const raw = JSON.parse('"' + consoleMatch[1] + '"');
        if (raw.startsWith('{"__r":1,')) {
          const entry = JSON.parse(raw);
          if (reqLogCount < MAX_REQ_LOGS) {
            reqLogCount++;
            onEvent("req-log", entry);
          }
          return;
        }
      } catch { /* jatuh ke log biasa */ }
    }
    onEvent("log", { line: line + "\n" });
  }

  child.stdout.on("data", makeLineSplitter(handleOutputLine));
  child.stderr.on("data", makeLineSplitter(handleOutputLine));

  child.on("close", async (code) => {
    let summary = null;
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // summary mungkin tidak tersedia jika test gagal sangat awal
    }
    onEvent("done", { code, summary });
    await cleanup();
    onEnd();
  });

  return {
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}
