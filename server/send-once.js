// "Send once" (POST /api/send-once): send one request of the project a single time
// and return what went out and what came back, so the editor can show the response
// and turn a clicked JSON value into an extraction.
//
// The request is sent by k6, from a script the generator writes for that request
// alone (sendOnceConfig: 1 VU, 1 iteration, request details on), so it goes out
// exactly as in a run: global variables, the first row of each data file, shared,
// group and request headers, expected statuses and the pre-processor script all
// apply. Values that only earlier requests give ({{token}}) stay literal text, and
// the result names them (`unresolved`). Nothing runs in this Node process: no
// project code is evaluated here, the script is only written to a temp folder.
//
// Limits (SEND_ONCE_LIMITS): bodies are cut inside k6 at `bodyChars` characters
// (`truncated` + `totalChars`), header values at 1,024; at most `outputBytes` of
// k6 output are read; k6 is killed after `timeoutMs` (504); at most `concurrent`
// sends at a time (429). The result is JSON and the browser renders every value
// as text (public/js/components/send-once.js).
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateScript } from "./generator/index.js";
import { createLineSplitter } from "./line-splitter.js";
import { expandSubRequests } from "../public/js/shared/sub-requests.js";

export const SEND_ONCE_LIMITS = Object.freeze({
  bodyChars: 256 * 1024,
  outputBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  maxDurationS: 20,
  concurrent: 2,
  messages: 10,
  messageChars: 500,
});

export class SendOnceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The project → a project with only that request: on, in its group (on, without its
// "Run only if"), no pause, nothing read from or saved after the response (checks,
// extractions, outcome rules, Save to CSV, post-processor), 1 VU × 1 iteration, every
// detail of the request recorded. Throws SendOnceError (400) when it cannot be sent.
export function sendOnceConfig(config, requestId, { maxDurationS = SEND_ONCE_LIMITS.maxDurationS } = {}) {
  if (!isObject(config)) throw new SendOnceError("Send the project with the request.");
  if (typeof requestId !== "string" || !requestId) throw new SendOnceError("Choose the request to send.");
  const scenario = isObject(config.scenario) ? config.scenario : {};
  const requests = expandSubRequests(Array.isArray(scenario.requests) ? scenario.requests : []);
  const request = requests.find(item => isObject(item) && item.id === requestId);
  if (!request) throw new SendOnceError("This request is not in the project.");
  if (!String(request.url || "").trim()) throw new SendOnceError("Type a URL first.");
  const groups = (Array.isArray(scenario.groups) ? scenario.groups : [])
    .map(group => (isObject(group) && group.id && group.id === request.groupId ? { ...group, enabled: true, runIf: null } : group));
  const { outcomes: _outcomes, exports: _exports, ...kept } = request;
  return {
    scenario: {
      groups,
      requests: [{ ...kept, enabled: true, sleepAfter: "0", extractions: [], assertions: [], postScript: "" }],
    },
    variables: config.variables,
    dataSets: config.dataSets,
    globalHeaders: config.globalHeaders,
    load: { mode: "iterations", vus: "1", iterations: "1", maxDuration: `${maxDurationS}s` },
    thresholds: {},
    options: { logRequests: true, logFilter: "all", logRedact: false },
  };
}

// The cut note the script adds to a body over its cap (redactResponseSample()).
const CUT_NOTE = /\n… \[(\d+) more characters not shown\]$/;

function readBody(text) {
  const value = typeof text === "string" ? text : "";
  const cut = CUT_NOTE.exec(value);
  if (!cut) return { body: value, truncated: false, totalChars: value.length };
  const body = value.slice(0, cut.index);
  return { body, truncated: true, totalChars: body.length + Number(cut[1]) };
}

const textHeaders = headers => (isObject(headers)
  ? Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value ?? "")]))
  : {});

// {{name}} still in what was sent: no value before this request (an earlier response,
// a script), or a name nothing defines. Sorted, each once.
export function unresolvedNames(record) {
  const sent = [record.url, ...Object.values(record.rqh || {}), record.rq].map(value => String(value ?? "")).join("\n");
  return [...new Set([...sent.matchAll(/\{\{\s*(\$?[A-Za-z_]\w*)\s*\}\}/g)].map(match => match[1]))].sort();
}

// The script's temp path means nothing to the user.
const tidy = (text, limit) => String(text ?? "")
  .replace(/file:\/\/\S*?\/script\.js/g, "script.js")
  .replace(/\s+$/, "")
  .slice(0, limit);

// One k6 output line (--log-format json) → the request record, a message, or nothing.
export function readOutputLine(line, limits = SEND_ONCE_LIMITS) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(entry) || typeof entry.msg !== "string") return null;
  if (entry.source === "console" && entry.msg.startsWith('{"__r":1,')) {
    try {
      return { record: JSON.parse(entry.msg) };
    } catch {
      return null;
    }
  }
  const text = entry.error ? `${entry.msg}: ${entry.error}` : entry.msg;
  return { message: { level: String(entry.level || "info"), text: tidy(text, limits.messageChars) } };
}

// The request record (see printHttpRecord in generator/index.js) → the result.
export function sendOnceResult(record, log = []) {
  const request = readBody(record.rq);
  const response = readBody(record.rb);
  return {
    sent: true,
    ok: record.ok === true,
    error: record.er ? String(record.er) : "",
    request: {
      method: String(record.m || ""),
      url: String(record.url || ""),
      headers: textHeaders(record.rqh),
      body: request.body,
      truncated: request.truncated,
    },
    response: {
      status: typeof record.s === "number" ? record.s : null,
      durationMs: typeof record.d === "number" ? record.d : null,
      headers: textHeaders(record.rh),
      body: response.body,
      truncated: response.truncated,
      totalChars: response.totalChars,
    },
    unresolved: unresolvedNames(record),
    log,
  };
}

let running = 0;

// Sends the request once. Resolves with sendOnceResult() (or { sent: false, error,
// log } when k6 ended without sending it, e.g. a pre-processor error); rejects with
// a SendOnceError for a request that cannot be sent (400), too many at once (429),
// no k6 (503) or no answer in time (504). `signal` aborts (the client went away).
export async function sendOnce(config, requestId, { signal, limits = SEND_ONCE_LIMITS, k6 = "k6" } = {}) {
  const oneConfig = sendOnceConfig(config, requestId, limits);
  let script;
  try {
    script = generateScript(oneConfig, null, { logBodyLimit: limits.bodyChars });
  } catch (err) {
    throw new SendOnceError(err.message, err.status || 400);
  }
  if (running >= limits.concurrent) {
    throw new SendOnceError("Another Send once is still running. Try again in a moment.", 429);
  }
  running++;
  try {
    return await runOnce(script, { signal, limits, k6 });
  } finally {
    running--;
  }
}

async function runOnce(script, { signal, limits, k6 }) {
  const workDir = await mkdtemp(join(tmpdir(), "k6ui-send-once-"));
  try {
    await writeFile(join(workDir, "script.js"), script, "utf8");
    return await new Promise((resolve, reject) => {
      const child = spawn(k6, ["run", "--quiet", "--no-usage-report", "--no-thresholds", "--log-format", "json", "script.js"], {
        cwd: workDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let record = null;
      let readBytes = 0;
      let timedOut = false;
      let settled = false;
      const log = [];
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      const kill = () => { if (child.exitCode === null) child.kill("SIGKILL"); };
      const timer = setTimeout(() => { timedOut = true; kill(); }, limits.timeoutMs);
      const abort = () => kill();
      signal?.addEventListener("abort", abort, { once: true });

      const onLine = line => {
        const read = readOutputLine(line, limits);
        if (read?.record && !record) record = read.record;
        else if (read?.message && log.length < limits.messages) log.push(read.message);
      };
      // Past `outputBytes` nothing more is read; a line cut there does not parse and is skipped.
      const outputs = [child.stdout, child.stderr].map(stream => {
        const lines = createLineSplitter(onLine);
        stream.on("data", chunk => {
          if (readBytes >= limits.outputBytes) return;
          readBytes += chunk.length;
          lines.push(chunk);
        });
        return lines;
      });
      child.on("error", err => {
        finish(reject, err.code === "ENOENT"
          ? new SendOnceError("k6 was not found on the server. Make sure k6 is installed (https://k6.io/docs/get-started/installation/).", 503)
          : new SendOnceError(`Could not start k6: ${err.message}`, 500));
      });
      child.on("close", () => {
        for (const lines of outputs) lines.end();
        if (timedOut) {
          finish(reject, new SendOnceError(`No answer within ${Math.round(limits.timeoutMs / 1000)} s, so the request was stopped.`, 504));
        } else if (record) {
          finish(resolve, sendOnceResult(record, log));
        } else {
          const problem = log.find(entry => entry.level === "error") || log.find(entry => entry.level === "warning");
          finish(resolve, { sent: false, error: problem?.text || "k6 ended without sending the request.", log });
        }
      });
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
