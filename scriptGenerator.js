// Mengubah konfigurasi dari UI menjadi script k6 yang siap dijalankan.
// Mendukung pre-processor (setup), post-processor (teardown), ekstraksi variabel,
// dan interpolasi {{varName}} di URL/header/body.

// ---- Options ----

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
    thresholds.http_req_failed = [`rate<${Number(t.errorRate) / 100}`];
  }
  if (Object.keys(thresholds).length > 0) {
    options.thresholds = thresholds;
  }

  return options;
}

// ---- Variable interpolation ----
// Mengubah "https://api/{{userId}}" menjadi template literal `https://api/${data.userId}`
// setupVars → diakses sebagai data.varName
// localVars → diakses langsung sebagai varName

function interpolate(str, setupVars, localVars) {
  if (str == null) return '""';
  const s = String(str);
  if (!s.includes("{{")) return JSON.stringify(s);

  const pattern = /\{\{(\w+)\}\}/g;
  let result = "`";
  let last = 0;
  let m;

  while ((m = pattern.exec(s)) !== null) {
    const literal = s
      .slice(last, m.index)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    result += literal;

    const name = m[1];
    if (setupVars && setupVars.has(name)) {
      result += `\${data.${name}}`;
    } else if (localVars && localVars.has(name)) {
      result += `\${${name}}`;
    } else {
      result += m[0].replace(/`/g, "\\`");
    }
    last = m.index + m[0].length;
  }

  const tail = s
    .slice(last)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  result += tail + "`";
  return result;
}

// ---- JSON path → optional-chain accessor ----
// "data.token"   → ?.['data']?.['token']
// "items[0].id"  → ?.['items']?.[0]?.['id']
// "[0]"          → ?.[0]

function buildJsonAccessor(selector) {
  if (!selector || !String(selector).trim()) return "";
  return String(selector)
    .split(".")
    .map((part) => {
      const rootArr = part.match(/^\[(\d+)\]$/);
      if (rootArr) return `?.[${rootArr[1]}]`;
      const keyArr = part.match(/^(.+?)\[(\d+)\]$/);
      if (keyArr) return `?.[${JSON.stringify(keyArr[1])}]?.[${keyArr[2]}]`;
      return `?.[${JSON.stringify(part)}]`;
    })
    .join("");
}

// ---- Regex helper ----

function buildRegex(selector) {
  if (!selector) return "/(?:)/";
  const s = String(selector);
  if (/^\/.+\/[gimsuy]*$/.test(s)) return s;
  return `/${s.replace(/\//g, "\\/").replace(/\n/g, "\\n")}/`;
}

// ---- Extraction lines ----
// targetPrefix = 'data' → data.varName = ...  (untuk setup, disimpan ke return value)
// targetPrefix = null   → let varName = ...   (untuk default/teardown)

function buildExtractionLines(extractions, resVar, targetPrefix, localVarSet) {
  if (!Array.isArray(extractions)) return "";
  const lines = [];

  for (const e of extractions) {
    if (!e || !e.varName || !e.source) continue;

    let rhs;
    const sel = e.selector || "";
    if (e.source === "json") {
      rhs = `JSON.parse(${resVar}.body)${buildJsonAccessor(sel)}`;
    } else if (e.source === "header") {
      rhs = `${resVar}.headers[${JSON.stringify(sel)}]`;
    } else if (e.source === "regex") {
      rhs = `(${resVar}.body.match(${buildRegex(sel)}) || [])[1] || ""`;
    } else {
      continue;
    }

    if (targetPrefix) {
      lines.push(`  ${targetPrefix}.${e.varName} = ${rhs};`);
    } else {
      lines.push(`  let ${e.varName} = ${rhs};`);
      if (localVarSet) localVarSet.add(e.varName);
    }
  }

  return lines.join("\n");
}

// ---- Single request block ----

function buildRequestCode(req, index, prefix, setupVars, localVars, extractTarget) {
  const method = (req.method || "GET").toUpperCase();
  const urlCode = interpolate(req.url, setupVars, localVars);

  const headers = {};
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      if (h && h.key) headers[h.key] = String(h.value == null ? "" : h.value);
    }
  }
  const headersCode = Object.entries(headers)
    .map(([k, v]) => `${JSON.stringify(k)}: ${interpolate(v, setupVars, localVars)}`)
    .join(", ");
  const paramsCode = headersCode ? `{ headers: { ${headersCode} } }` : "{}";

  const hasBody =
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    req.body != null &&
    String(req.body).trim() !== "";

  const resVar = `res_${prefix}_${index}`;
  const lines = [];

  lines.push(`  // Request ${index + 1}: ${method} ${req.url}`);

  if (hasBody) {
    const bodyCode = interpolate(req.body, setupVars, localVars);
    lines.push(`  const body_${prefix}_${index} = ${bodyCode};`);
    lines.push(
      `  const ${resVar} = http.request(${JSON.stringify(method)}, ${urlCode}, body_${prefix}_${index}, ${paramsCode});`
    );
  } else {
    lines.push(
      `  const ${resVar} = http.request(${JSON.stringify(method)}, ${urlCode}, null, ${paramsCode});`
    );
  }

  if (req.checkStatus !== false) {
    const label = `status 2xx: request ${index + 1}`;
    lines.push(
      `  check(${resVar}, { ${JSON.stringify(label)}: (r) => r.status >= 200 && r.status < 400 });`
    );
  }

  const extractCode = buildExtractionLines(
    req.extractions,
    resVar,
    extractTarget,
    extractTarget ? null : localVars
  );
  if (extractCode) lines.push(extractCode);

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}

// ---- Kumpulkan nama variabel dari semua ekstraksi ----

function collectExtractedVars(requests) {
  const vars = new Set();
  for (const req of requests || []) {
    for (const e of req.extractions || []) {
      if (e && e.varName) vars.add(e.varName);
    }
  }
  return vars;
}

// ---- Export utama ----

export function generateScript(config) {
  const pre = config.preprocessor || {};
  const post = config.postprocessor || {};
  const scenario = config.scenario || {};
  const options = buildOptions(config);

  const preReqs = (pre.requests || []).filter((r) => r && String(r.url || "").trim());
  const postReqs = (post.requests || []).filter((r) => r && String(r.url || "").trim());
  const mainReqs = (scenario.requests || []).filter((r) => r && String(r.url || "").trim());

  // Semua variabel dari setup — diakses sebagai data.* di default() dan teardown()
  const allSetupVars = collectExtractedVars(preReqs);

  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { check, sleep } from 'k6';\n\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;

  // setup() — sekali sebelum VU mulai
  if (preReqs.length > 0) {
    out += `\n// Pre-processor: dijalankan sekali sebelum test dimulai\n`;
    out += `export function setup() {\n`;
    out += `  const data = {};\n`;
    const progressiveSetupVars = new Set();
    for (let i = 0; i < preReqs.length; i++) {
      out += "\n" + buildRequestCode(preReqs[i], i, "pre", progressiveSetupVars, new Set(), "data");
      out += "\n";
      for (const e of preReqs[i].extractions || []) {
        if (e && e.varName) progressiveSetupVars.add(e.varName);
      }
    }
    out += `\n  return data;\n`;
    out += `}\n`;
  }

  // default function — tiap VU
  out += `\nexport default function(data = {}) {\n`;
  const localVars = new Set();
  for (let i = 0; i < mainReqs.length; i++) {
    out += "\n" + buildRequestCode(mainReqs[i], i, "main", allSetupVars, localVars, null);
    out += "\n";
  }
  out += `}\n`;

  // teardown() — sekali setelah semua VU selesai
  if (postReqs.length > 0) {
    out += `\n// Post-processor: dijalankan sekali setelah test selesai\n`;
    out += `export function teardown(data) {\n`;
    const teardownLocalVars = new Set();
    for (let i = 0; i < postReqs.length; i++) {
      out += "\n" + buildRequestCode(postReqs[i], i, "post", allSetupVars, teardownLocalVars, null);
      out += "\n";
    }
    out += `}\n`;
  }

  return out;
}
