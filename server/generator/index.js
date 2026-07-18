// Turns the UI configuration into a ready-to-run k6 script.
// Main orchestration — codegen details live in sibling modules:
//   options.js     → k6 options object (load + thresholds)
//   request.js     → code block for one HTTP request
//   assertions.js  → check() block for per-request assertions
//   extract.js     → variable extraction from responses
//   interpolate.js → {{varName}} interpolation
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

  // Variables already declared — prevents a double `let`
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

    // Add variables extracted by the main request to the declared set
    for (const e of req.extractions || []) {
      if (e && e.varName) declaredVars.add(e.varName);
    }
  }

  out += `}\n`;
  return out;
}
