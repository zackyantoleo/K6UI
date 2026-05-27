// Mengubah konfigurasi dari UI menjadi script k6 (JavaScript) yang siap dijalankan.

function jsString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

function buildOptions(config) {
  const load = config.load || {};
  const options = {};

  if (load.mode === "stages" && Array.isArray(load.stages) && load.stages.length > 0) {
    options.stages = load.stages
      .filter((s) => s && s.duration && s.target !== "" && s.target != null)
      .map((s) => ({ duration: String(s.duration), target: Number(s.target) }));
  } else {
    options.vus = Number(load.vus) > 0 ? Number(load.vus) : 1;
    options.duration = load.duration ? String(load.duration) : "30s";
  }

  const t = config.thresholds || {};
  const thresholds = {};
  if (t.p95 !== "" && t.p95 != null && !Number.isNaN(Number(t.p95))) {
    thresholds.http_req_duration = [`p(95)<${Number(t.p95)}`];
  }
  if (t.errorRate !== "" && t.errorRate != null && !Number.isNaN(Number(t.errorRate))) {
    // errorRate dari UI dalam persen (mis. 1 = 1%)
    thresholds.http_req_failed = [`rate<${Number(t.errorRate) / 100}`];
  }
  if (Object.keys(thresholds).length > 0) {
    options.thresholds = thresholds;
  }

  return options;
}

function buildRequest(req, index) {
  const method = (req.method || "GET").toUpperCase();
  const url = jsString(req.url);

  const headers = {};
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      if (h && h.key) headers[h.key] = String(h.value == null ? "" : h.value);
    }
  }

  const params = Object.keys(headers).length > 0
    ? `{ headers: ${JSON.stringify(headers)} }`
    : "{}";

  const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    req.body != null && String(req.body).trim() !== "";

  const lines = [];
  const resVar = `res${index}`;

  if (hasBody) {
    lines.push(`  const body${index} = ${jsString(req.body)};`);
    lines.push(`  const ${resVar} = http.request(${jsString(method)}, ${url}, body${index}, ${params});`);
  } else {
    lines.push(`  const ${resVar} = http.request(${jsString(method)}, ${url}, null, ${params});`);
  }

  if (req.checkStatus !== false) {
    const label = `status 2xx untuk request ${index + 1}`;
    lines.push(`  check(${resVar}, { ${jsString(label)}: (r) => r.status >= 200 && r.status < 400 });`);
  }

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) {
    lines.push(`  sleep(${sleepAfter});`);
  }

  return lines.join("\n");
}

export function generateScript(config) {
  const scenario = config.scenario || {};
  const requests = Array.isArray(scenario.requests) && scenario.requests.length > 0
    ? scenario.requests
    : [{ method: "GET", url: "https://test.k6.io", headers: [], checkStatus: true }];

  const options = buildOptions(config);

  const requestBlocks = requests
    .filter((r) => r && r.url && String(r.url).trim() !== "")
    .map((r, i) => buildRequest(r, i))
    .join("\n\n");

  return `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = ${JSON.stringify(options, null, 2)};

export default function () {
${requestBlocks}
}
`;
}
