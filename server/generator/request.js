// Codegen for one HTTP request block: http.request + status check +
// extractions + optional request logging + sleep.
import { interpolate } from "./interpolate.js";
import { buildExtractionLines } from "./extract.js";

export function buildRequestCode(req, index, prefix, setupVars, localVars, extractTarget, logRequests) {
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

  // Per-request log as JSON tagged {__r:1,...} — parsed by the server
  // (k6-runner.js) into req-log events for the "Request Details" table.
  if (logRequests) {
    lines.push(
      `  try { console.log(JSON.stringify({__r:1,vu:__VU,it:__ITER,i:${index},m:${JSON.stringify(method)},url:String(${urlCode}),s:${resVar}.status,d:+(${resVar}.timings.duration.toFixed(1)),ok:${resVar}.status>=200&&${resVar}.status<400,rb:String(${resVar}.body||'').slice(0,500)})); } catch(e) {}`
    );
  }

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}
