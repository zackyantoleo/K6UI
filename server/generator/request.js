// Codegen for one HTTP request block: http.request + status check +
// extractions + optional request logging + sleep.
import { interpolate } from "./interpolate.js";
import { buildExtractionLines } from "./extract.js";

// ctx = { localVars, processorVars, dataVars, globalVars, hoistedVars } — see interpolate.js.
export function buildRequestCode(req, index, prefix, ctx, extractTarget, logRequests) {
  const method = (req.method || "GET").toUpperCase();
  const urlCode = interpolate(req.url, ctx);

  const headers = {};
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      if (h && h.key) headers[h.key] = String(h.value == null ? "" : h.value);
    }
  }
  const headersCode = Object.entries(headers)
    .map(([k, v]) => `${JSON.stringify(k)}: ${interpolate(v, ctx)}`)
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
    const bodyCode = interpolate(req.body, ctx);
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
    extractTarget ? null : ctx && ctx.localVars,
    "http",
    ctx && ctx.hoistedVars
  );
  if (extractCode) lines.push(extractCode);

  // Per-request log: logHttpRequest() (helpers in generator/index.js) prints
  // one {__r:1,...} JSON line that k6-runner.js turns into a req-log event.
  if (logRequests) {
    lines.push(`  try { logHttpRequest(${index}, ${JSON.stringify(method)}, ${urlCode}, ${resVar}); } catch (e) {}`);
  }

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}
