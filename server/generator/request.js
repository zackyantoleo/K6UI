// Codegen for one HTTP request block: http.request + status check +
// extractions + optional request logging + sleep.
import { interpolate } from "./interpolate.js";
import { buildExtractionLines } from "./extract.js";
import { oneLine } from "./helpers.js";
import { expectedStatusTest, expectedStatusesName, expectedStatusesOf } from "./expected-statuses.js";

// ctx = { localVars, processorVars, dataVars, globalVars, hoistedVars, dynamicVars } — see interpolate.js.
// outcome = { code, name } of a request with outcome rules (outcomes.js): the lines that
// label this response, after the extractions, and the variable that holds the label.
// race = { before, after } of a race burst's race request (race.js raceRequestCode):
// `before` right before http.request, `after` after the outcome lines.
export function buildRequestCode(req, index, prefix, ctx, extractTarget, logRequests, outcome = null, race = null) {
  const method = (req.method || "GET").toUpperCase();
  const urlCode = interpolate(req.url, ctx);

  const headers = {};
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      const key = h && h.key ? String(h.key).trim() : "";
      if (key) headers[key] = String(h.value == null ? "" : h.value).trim();
    }
  }
  const headersCode = Object.entries(headers)
    .map(([k, v]) => `${JSON.stringify(k)}: ${interpolate(v, ctx)}`)
    .join(", ");
  // Expected statuses: k6 counts any other status in http_req_failed, and the
  // status check and the request record follow the same list.
  const expected = expectedStatusesOf(req);
  const params = [];
  if (headersCode) params.push(`headers: { ${headersCode} }`);
  if (expected) params.push(`responseCallback: ${expectedStatusesName(index)}`);
  const paramsCode = params.length ? `{ ${params.join(", ")} }` : "{}";

  const hasBody =
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    req.body != null &&
    String(req.body).trim() !== "";

  const resVar = `res_${prefix}_${index}`;
  const lines = [];

  lines.push(`  // Request ${index + 1}: ${oneLine(`${method} ${req.url}`)}`);

  if (hasBody) {
    const bodyCode = interpolate(req.body, ctx);
    lines.push(`  const body_${prefix}_${index} = ${bodyCode};`);
    if (race) lines.push(race.before);
    lines.push(
      `  const ${resVar} = http.request(${JSON.stringify(method)}, ${urlCode}, body_${prefix}_${index}, ${paramsCode});`
    );
  } else {
    if (race) lines.push(race.before);
    lines.push(
      `  const ${resVar} = http.request(${JSON.stringify(method)}, ${urlCode}, null, ${paramsCode});`
    );
  }

  if (req.checkStatus !== false) {
    const label = `status ${expected || "2xx"}: request ${index + 1}`;
    const test = expected ? expectedStatusTest(expected, "r.status") : "r.status >= 200 && r.status < 400";
    lines.push(`  check(${resVar}, { ${JSON.stringify(label)}: (r) => ${test} });`);
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
  if (outcome) lines.push(outcome.code);
  if (race) lines.push(race.after);

  // Per-request log: logHttpRequest() (helpers in generator/index.js) prints
  // one {__r:1,...} JSON line that k6-runner.js turns into a req-log event. A
  // request with outcome rules or expected statuses calls logHttpOutcome() with its
  // label and whether the status counts as a success.
  if (logRequests) {
    const args = `${index}, ${JSON.stringify(method)}, ${urlCode}, ${resVar}`;
    if (outcome || expected) {
      const ok = expected ? expectedStatusTest(expected, `${resVar}.status`) : `${resVar}.status >= 200 && ${resVar}.status < 400`;
      lines.push(`  try { logHttpOutcome(${args}, ${outcome ? outcome.name : "undefined"}, ${ok}); } catch (e) {}`);
    } else {
      lines.push(`  try { logHttpRequest(${args}); } catch (e) {}`);
    }
  }

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}
