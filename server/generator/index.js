// Mengubah konfigurasi dari UI menjadi script k6 yang siap dijalankan.
// Orkestrasi utama — detail codegen ada di modul saudara:
//   options.js     → objek options k6 (beban + threshold)
//   request.js     → blok kode satu request HTTP
//   assertions.js  → blok check() untuk assertion per request
//   extract.js     → ekstraksi variabel dari respons
//   interpolate.js → interpolasi {{varName}}
import { buildOptions } from "./options.js";
import { buildRequestCode } from "./request.js";
import { buildAssertionsCode } from "./assertions.js";

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
