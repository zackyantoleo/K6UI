// Response checks of a request (`assertions`, editor part "Check the response"): what
// each value must be, so a check never compares with 0 or NaN (an empty or "2xx"
// status), never always passes (empty text) and never breaks the script (a regex that
// cannot be a literal). Shared by config.js (before Run) and
// server/generator/assertions.js (a 400) (pure, no DOM).
import { oneLine } from './basics.js';
import { regexProblem } from './regex.js';

const WHOLE = /^\d+$/;
const MILLISECONDS = /^\d+(?:\.\d+)?$/;
const given = value => value !== '';            // text and regexes: a space is something to look for
const named = value => value.trim() !== '';      // header names are trimmed

// type → [what the check is called, what its value must be, test of the value]
const RULES = {
  'status-eq': ['"status =="', 'a status code such as 200', value => WHOLE.test(value.trim())],
  'status-ne': ['"status !="', 'a status code such as 404', value => WHOLE.test(value.trim())],
  'status-lt': ['"status <"', 'a status code such as 500', value => WHOLE.test(value.trim())],
  'duration-lt': ['"response time under"', 'a number of milliseconds such as 500', value => MILLISECONDS.test(value.trim())],
  'body-contains': ['"body contains"', 'the text to look for', given],
  'body-not-contains': ['"body does not contain"', 'the text that must not be there', given],
  'header-exists': ['"header exists"', 'a header name', named],
  'header-eq': ['"header =="', 'a header name', named],
  'body-matches': ['"body matches regex"', 'a regex', given],
};

// One check → why it cannot run, or ''. `grpc`: the check of a gRPC request, where
// "response time under" is not written (gRPC responses carry no timings).
export function assertionProblem(assertion, { grpc = false } = {}) {
  const rule = RULES[assertion?.type];
  if (!rule || (grpc && assertion.type === 'duration-lt')) return '';
  const [name, needs, valid] = rule;
  const value = String(assertion.value ?? '');
  if (!valid(value)) {
    return `the ${name} check needs ${needs}${named(value) ? ` (it has "${oneLine(value).slice(0, 60)}")` : ''}.`;
  }
  if (assertion.type === 'body-matches') {
    const problem = regexProblem(value);
    if (problem) return `the ${name} check: "${oneLine(value).slice(0, 60)}" is not a regular expression: ${problem}.`;
  }
  return '';
}

// [{ label, type, assertions }] (the requests that run, numbered like the generator) →
// the first problem, as "<label>: ...", or ''.
export function assertionsProblem(requests) {
  for (const { label, type, assertions } of requests) {
    for (const assertion of Array.isArray(assertions) ? assertions : []) {
      const problem = assertionProblem(assertion, { grpc: type === 'grpc' });
      if (problem) return `${label}: ${problem}`;
    }
  }
  return '';
}
