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
      const declared = localVarSet && localVarSet.has(e.varName);
      lines.push(`  ${declared ? '' : 'let '}${e.varName} = ${rhs};`);
      if (localVarSet) localVarSet.add(e.varName);
    }
  }

  return lines.join("\n");
}

// ---- Single request block ----

function buildRequestCode(req, index, prefix, setupVars, localVars, extractTarget, logRequests) {
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

  if (logRequests) {
    lines.push(
      `  try { console.log(JSON.stringify({__r:1,vu:__VU,it:__ITER,i:${index},m:${JSON.stringify(method)},url:String(${urlCode}),s:${resVar}.status,d:+(${resVar}.timings.duration.toFixed(1)),ok:${resVar}.status>=200&&${resVar}.status<400,rb:String(${resVar}.body||'').slice(0,500)})); } catch(e) {}`
    );
  }

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}

// ---- Assertion codegen ----

function buildAssertionFn(type, val, val2) {
  const num  = Number(val);
  const sv   = JSON.stringify(val);
  const sv2  = JSON.stringify(val2);
  switch (type) {
    case 'status-2xx':        return `r.status >= 200 && r.status < 300`;
    case 'status-eq':         return `r.status === ${num}`;
    case 'status-ne':         return `r.status !== ${num}`;
    case 'status-lt':         return `r.status < ${num}`;
    case 'body-contains':     return `r.body.includes(${sv})`;
    case 'body-not-contains': return `!r.body.includes(${sv})`;
    case 'body-matches':      return `${buildRegex(val)}.test(r.body)`;
    case 'header-exists':     return `r.headers[${sv}] != null`;
    case 'header-eq':         return `r.headers[${sv}] === ${sv2}`;
    case 'duration-lt':       return `r.timings.duration < ${num}`;
    default:                  return '';
  }
}

function buildAssertionLabel(assertion) {
  const v = assertion.value || '', v2 = assertion.value2 || '';
  const labels = {
    'status-2xx':        'status sukses (2xx)',
    'status-eq':         `status == ${v}`,
    'status-ne':         `status != ${v}`,
    'status-lt':         `status < ${v}`,
    'body-contains':     `body mengandung "${v}"`,
    'body-not-contains': `body tidak mengandung "${v}"`,
    'body-matches':      `body cocok regex ${v}`,
    'header-exists':     `header ${v} ada`,
    'header-eq':         `header ${v} == "${v2}"`,
    'duration-lt':       `respons < ${v}ms`,
  };
  return labels[assertion.type] || assertion.type;
}

function buildAssertionsCode(assertions, resVar) {
  if (!Array.isArray(assertions) || !assertions.length) return '';
  const parts = assertions
    .map(a => {
      const fn = buildAssertionFn(a.type, a.value || '', a.value2 || '');
      if (!fn) return '';
      return `    ${JSON.stringify(buildAssertionLabel(a))}: (r) => ${fn}`;
    })
    .filter(Boolean);
  if (!parts.length) return '';
  return `  check(${resVar}, {\n${parts.join(',\n')}\n  });\n`;
}

// ---- Export utama ----

export function generateScript(config) {
  const scenario    = config.scenario || {};
  const options     = buildOptions(config);
  const logRequests = !!(config.options && config.options.logRequests);

  const mainReqs = (scenario.requests || []).filter((r) => r && String(r.url || "").trim());

  let out = "";
  out += `import http from 'k6/http';\n`;
  out += `import { check, sleep } from 'k6';\n\n`;
  out += `export const options = ${JSON.stringify(options, null, 2)};\n`;

  out += `\nexport default function() {\n`;

  // Variabel yang sudah dideklarasikan — cegah double `let`
  const declaredVars = new Set();

  for (let i = 0; i < mainReqs.length; i++) {
    const req = mainReqs[i];

    // ── Pre sub-request ──────────────────────────────────────
    const preReq = req.pre && String(req.pre.url || "").trim() ? req.pre : null;
    if (preReq) {
      out += `\n  // Pre: request ${i + 1}\n`;
      out += buildRequestCode(preReq, i, `pre${i}`, new Set(), declaredVars, null, false);
      out += "\n";
      for (const e of preReq.extractions || []) {
        if (e && e.varName) declaredVars.add(e.varName);
      }
    }

    // ── Main request ─────────────────────────────────────────
    out += "\n" + buildRequestCode(req, i, "main", declaredVars, declaredVars, null, logRequests);
    out += "\n";

    // ── Assertions ───────────────────────────────────────────
    const assertCode = buildAssertionsCode(req.assertions, `res_main_${i}`);
    if (assertCode) out += assertCode;

    // ── Post sub-request ─────────────────────────────────────
    const postReq = req.post && String(req.post.url || "").trim() ? req.post : null;
    if (postReq) {
      out += `\n  // Post: request ${i + 1}\n`;
      out += buildRequestCode(postReq, i, `post${i}`, new Set(), declaredVars, null, false);
      out += "\n";
      for (const e of postReq.extractions || []) {
        if (e && e.varName) declaredVars.add(e.varName);
      }
    }

    // Tambahkan variabel dari main request ke declared set
    for (const e of req.extractions || []) {
      if (e && e.varName) declaredVars.add(e.varName);
    }
  }

  out += `}\n`;
  return out;
}
