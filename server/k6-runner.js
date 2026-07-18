// Runs k6 against a temporary script and forwards its output as events.
//
// startK6Run(script, { onEvent, onEnd }) writes the script to a temp folder,
// spawns `k6 run`, then emits events through onEvent(event, data):
//   status  — progress message, e.g. "Starting k6..."
//   log     — one raw line of k6 output
//   req-log — details of a single request (emitted by the script via console.log JSON {__r:1,...})
//   error   — failures (k6 not installed, failed to write the file, etc.)
//   done    — process finished: { code, summary } (summary from --summary-export)
// onEnd() is called once the process ends. Return value: { stop() } to
// terminate k6 (e.g. when the client closes the connection).
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Cap on req-log events per run so the UI doesn't get flooded.
const MAX_REQ_LOGS = 500;

export async function startK6Run(script, { onEvent, onEnd }) {
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

  const child = spawn("k6", ["run", "--summary-export", summaryPath, scriptPath], {
    cwd: workDir,
  });

  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      onEvent("error", { message: "k6 was not found on the server. Make sure k6 is installed (https://k6.io/docs/get-started/installation/)." });
    } else {
      onEvent("error", { message: `Failed to run k6: ${err.message}` });
    }
    cleanup();
    onEnd();
  });

  let reqLogCount = 0;

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
        if (raw.startsWith('{"__r":1,')) {
          const entry = JSON.parse(raw);
          if (reqLogCount < MAX_REQ_LOGS) {
            reqLogCount++;
            onEvent("req-log", entry);
          }
          return;
        }
      } catch { /* fall through to a plain log line */ }
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
      // the summary may be missing if the test failed very early
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
