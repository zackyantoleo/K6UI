// Running the k6 binary on a generated script, shared by a run (k6-runner.js) and
// Send once (send-once.js): the script goes to a fresh temp folder, k6 runs there,
// and its stdout and stderr arrive as whole lines.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineSplitter } from "./line-splitter.js";

export const K6_NOT_FOUND = "k6 was not found on the server. Make sure k6 is installed (https://k6.io/docs/get-started/installation/).";

// A new folder in the OS temp folder with `script` saved as `fileName`. remove()
// deletes the folder and never throws. A failed write removes the folder again.
export async function createScriptFolder(prefix, fileName, script) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const remove = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await writeFile(join(dir, fileName), script, "utf8");
  } catch (err) {
    await remove();
    throw err;
  }
  return { dir, path: join(dir, fileName), remove };
}

// Starts `command` (k6) with `args` in `cwd`. Every line of stdout and stderr goes
// to onLine, up to `maxBytes` of output in all (later output is not read; a line cut
// there is handed over as it is). Call flushOutput() once the process has closed:
// it hands over a last line that has no "\n".
export function spawnK6(args, { cwd, onLine, maxBytes = Infinity, command = "k6" }) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let readBytes = 0;
  const outputs = [child.stdout, child.stderr].map((stream) => {
    const lines = createLineSplitter(onLine);
    stream.on("data", (chunk) => {
      if (readBytes >= maxBytes) return;
      readBytes += chunk.length;
      lines.push(chunk);
    });
    return lines;
  });
  return { child, flushOutput: () => outputs.forEach((lines) => lines.end()) };
}
