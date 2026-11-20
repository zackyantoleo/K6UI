// Live metrics of a running k6 test, read from k6's REST API from outside the
// process: the generated script is unchanged and no sample costs anything extra.
//
// k6-runner.js asks the OS for a free port (freePort), starts k6 with
// `--address 127.0.0.1:<port>` and polls `GET /v1/metrics` once a second
// (startMetricsPoller). Each answer becomes one `metrics` event (readLiveMetrics).
// A poll that fails (k6 still starting, a refused connection, an error status,
// a body that is not JSON, no answer in time) is skipped: the next one tries again,
// and the run itself never notices.
import http from "node:http";
import net from "node:net";
import { OUTCOME_METRIC } from "../public/js/shared/outcomes.js";

export const METRICS_INTERVAL_MS = 1000;
// The /v1/metrics answer is a few KB (one entry per metric and submetric); this only
// guards against something that is not k6 answering on the port.
const MAX_BODY_LENGTH = 4 * 1024 * 1024;
const OUTCOME_PREFIX = `${OUTCOME_METRIC}{`;

// A TCP port on 127.0.0.1 that the OS reports free right now.
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const numberOr = value => (typeof value === "number" && Number.isFinite(value) ? value : null);

// k6's /v1/metrics answer ({ data: [{ id, attributes: { sample } }] }) → what a
// `metrics` event carries; null when it is not that shape. Every value is the whole
// run so far (k6 keeps one sink per metric), null until k6 reports it:
//   vus          — VUs running now (`vus`)
//   requests     — HTTP requests so far (`http_reqs` count)
//   requestRate  — HTTP requests per second since the start (`http_reqs` rate)
//   durationAvg  — `http_req_duration` average, ms
//   durationP95  — `http_req_duration` p(95), ms
//   failedRate   — `http_req_failed` rate, 0 to 1
//   outcomeCounts — { "k6ui_outcome{rq:1,outcome:success}": 12, ... }: every outcome
//                   submetric (each label has one through its `count>=0` threshold)
export function readLiveMetrics(body) {
  const list = body && typeof body === "object" && Array.isArray(body.data) ? body.data : null;
  if (!list) return null;
  const samples = new Map();
  for (const item of list) {
    const sample = item?.attributes?.sample;
    if (typeof item?.id === "string" && sample && typeof sample === "object") samples.set(item.id, sample);
  }
  const outcomeCounts = {};
  for (const [id, sample] of samples) {
    const count = numberOr(sample.count);
    if (id.startsWith(OUTCOME_PREFIX) && count != null) outcomeCounts[id] = count;
  }
  const requests = samples.get("http_reqs");
  const duration = samples.get("http_req_duration");
  return {
    vus: numberOr(samples.get("vus")?.value),
    requests: numberOr(requests?.count),
    requestRate: numberOr(requests?.rate),
    durationAvg: numberOr(duration?.avg),
    durationP95: numberOr(duration?.["p(95)"]),
    failedRate: numberOr(samples.get("http_req_failed")?.rate),
    outcomeCounts,
  };
}

// GET url → parsed JSON. Rejects on a connection error, a status other than 200, a
// body that is not JSON or too big, and after timeoutMs. `onRequest` gets the
// request so the caller can cancel it.
function getJson(url, timeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", chunk => {
        body += chunk;
        if (body.length > MAX_BODY_LENGTH) request.destroy(new Error("answer too big"));
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("no answer in time")), timeoutMs);
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
    onRequest(request);
  });
}

// Polls `url` every intervalMs (the first poll one interval after the start) and
// calls onMetrics(readLiveMetrics(answer)) for every answer that reads. stop() ends
// it at once: an answer still on its way is dropped, so nothing arrives after stop().
export function startMetricsPoller({ url, onMetrics, intervalMs = METRICS_INTERVAL_MS }) {
  let stopped = false;
  let timer = null;
  let request = null;

  async function poll() {
    timer = null;
    const startedAt = Date.now();
    try {
      const metrics = readLiveMetrics(await getJson(url, intervalMs, current => { request = current; }));
      if (metrics && !stopped) onMetrics(metrics);
    } catch {
      // A failed poll is skipped; the next one tries again.
    }
    request = null;
    if (!stopped) timer = setTimeout(poll, Math.max(0, intervalMs - (Date.now() - startedAt)));
  }

  timer = setTimeout(poll, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      request?.destroy();
    },
  };
}
