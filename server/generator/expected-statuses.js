// Expected statuses (see public/js/expected-statuses.js) → k6 code. A request with a
// list gets `responseCallback: EXPECTED_STATUSES_<n>` in its params (built once per
// VU at the top level with http.expectedStatuses(), so k6 counts any other status
// in http_req_failed), and its automatic status check and request record test the
// same list instead of 200–399. <n> is the request number of the run, from 1.
import {
  expectedStatusesListProblem, hasExpectedStatuses, normalizeExpectedStatuses, parseExpectedStatuses,
} from "../../public/js/expected-statuses.js";

// Requests that will run → a 400 naming the request for a list that cannot work.
export function validateExpectedStatuses(requests) {
  const problem = expectedStatusesListProblem(requests.map((req, i) => ({
    label: `Request ${i + 1}`, type: req.type, expectedStatuses: req.expectedStatuses,
  })));
  if (problem) {
    const err = new Error(problem);
    err.status = 400;
    throw err;
  }
}

// The list of an HTTP request, normalized ("200,4xx"), or "" for k6's own rule.
export const expectedStatusesOf = (req) =>
  (req.type === "grpc" || !hasExpectedStatuses(req.expectedStatuses) ? "" : normalizeExpectedStatuses(req.expectedStatuses));

export const expectedStatusesName = (index) => `EXPECTED_STATUSES_${index + 1}`;

// "200,4xx" + "r.status" → `r.status === 200 || (r.status >= 400 && r.status < 500)`.
export function expectedStatusTest(text, subject) {
  const { codes, classes } = parseExpectedStatuses(text);
  return [
    ...codes.map((code) => `${subject} === ${code}`),
    ...classes.map((digit) => `(${subject} >= ${digit * 100} && ${subject} < ${digit * 100 + 100})`),
  ].join(" || ");
}

// Top-level constants of every request with a list (requests = the ones that run).
export function buildExpectedStatusesSource(requests) {
  let out = "";
  requests.forEach((req, index) => {
    const text = expectedStatusesOf(req);
    if (!text) return;
    const { codes, classes } = parseExpectedStatuses(text);
    const args = [...codes.map(String), ...classes.map((digit) => `{ min: ${digit * 100}, max: ${digit * 100 + 99} }`)];
    out += `\n// Expected statuses of request ${index + 1} (Request → Advanced): ${text}; any other status counts in http_req_failed\n`;
    out += `const ${expectedStatusesName(index)} = http.expectedStatuses(${args.join(", ")});\n`;
  });
  return out;
}
