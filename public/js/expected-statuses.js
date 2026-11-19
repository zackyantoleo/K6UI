// Expected statuses of a request (config.scenario.requests[].expectedStatuses):
// the HTTP statuses that count as a success, for example "200,400" in a race test
// where a 400 "quota reached" is the answer the test expects. Codes like 200 and
// classes like 4xx, separated by commas; empty or absent = k6's own rule (200–399).
// The generated script hands the list to k6 (`responseCallback:
// http.expectedStatuses(...)`, so other statuses count in http_req_failed), and the
// automatic status check and `ok` of a request record follow the same list.
// Pure and DOM-free: shared by the store, the editor, the notice, config.js,
// server/generator/expected-statuses.js and the importer.
import { activeOutcomeRules, parseOutcomeStatus } from './outcomes.js';

// k6's own rule when a request has no list.
export const DEFAULT_EXPECTED_STATUSES = '200–399';

const textOf = value => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

// "200, 4XX,200" → "200,4xx" (lower case, no spaces, repeats dropped, order kept).
// A list that does not parse is kept as typed (trimmed) so validation can name it;
// anything that is not text or a number is "" (no list).
export function normalizeExpectedStatuses(raw) {
  const text = textOf(raw).trim();
  if (!parseOutcomeStatus(text)) return text;
  const parts = [];
  for (const part of text.split(',')) {
    const token = part.trim().toLowerCase();
    if (token && !parts.includes(token)) parts.push(token);
  }
  return parts.join(',');
}

export const hasExpectedStatuses = raw => normalizeExpectedStatuses(raw) !== '';

// → { codes, classes } of a list ("" gives both empty), or null when it does not parse.
export const parseExpectedStatuses = raw => parseOutcomeStatus(normalizeExpectedStatuses(raw));

// → why this list cannot be used, or ''.
export function expectedStatusesProblem(raw) {
  if (parseExpectedStatuses(raw)) return '';
  return `expected statuses "${textOf(raw).trim()}" are not valid: use codes like 200 or classes like 4xx, `
    + `separated by commas (empty = ${DEFAULT_EXPECTED_STATUSES}).`;
}

// Requests that will run, in order, as [{ label, type, expectedStatuses }] → the first
// problem across them ('' when there is none).
export function expectedStatusesListProblem(requests) {
  for (const { label, type, expectedStatuses } of requests) {
    if (!hasExpectedStatuses(expectedStatuses)) continue;
    if (type === 'grpc') {
      return `${label}: expected statuses work on HTTP requests only; clear them or switch the request to HTTP.`;
    }
    const problem = expectedStatusesProblem(expectedStatuses);
    if (problem) return `${label}: ${problem}`;
  }
  return '';
}

// "Use statuses from outcome rules": the statuses the request's rules name, in rule
// order ("2xx,400"). A rule for any status names none. 5xx codes and classes are left
// out: a server error stays a failure unless it is typed in on purpose.
// → { statuses, skippedServerErrors }.
export function statusesFromOutcomeRules(outcomes) {
  const parts = [];
  let skippedServerErrors = false;
  for (const rule of activeOutcomeRules(outcomes)) {
    if (!parseOutcomeStatus(rule.status)) continue;
    for (const part of rule.status.split(',')) {
      const token = part.trim().toLowerCase();
      if (!token) continue;
      if (token.startsWith('5')) {
        skippedServerErrors = true;
        continue;
      }
      if (!parts.includes(token)) parts.push(token);
    }
  }
  return { statuses: parts.join(','), skippedServerErrors };
}
