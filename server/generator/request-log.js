// Request details (Run & Results → Requests, options.logRequests): the REQUEST_LOG
// constant and the helper functions a script with recording on gets.
import { LOG_BODY_LIMIT, MAX_REQUEST_RECORDS } from "../../public/js/shared/request-log.js";
import { REQ_LOG_RATE } from "../request-log-throttle.js";

// Request logging is opt-in because URLs, headers and bodies can contain
// credentials or personal data. These helpers run inside the generated k6
// script: they pick which requests to log (REQUEST_LOG, see
// public/js/shared/request-log.js), keep each VU within a record budget (REQUEST_LOG.rate /
// .burst, see requestLogBudget), redact common secrets when REQUEST_LOG.redact is
// on ("Hide secrets"; off by default: values are shown as sent), cap the bodies, and print
// one {__r:1,...} JSON line that k6-runner.js turns into a req-log event.
const REQUEST_LOG_HELPERS = String.raw`
// Bearer tokens first ("Authorization: Bearer x" would otherwise hide only the word Bearer).
// A secret field keeps its quotes ("password":"[REDACTED]"), so a JSON body stays JSON;
// a quoted value cut at the size cap (no closing quote) is redacted to its end.
function redactText(value) {
  if (!REQUEST_LOG.redact) return String(value == null ? '' : value);
  return String(value == null ? '' : value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|proxy-authorization|token|access_token|refresh_token|api[_-]?key|password|passwd|secret)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"?|'[^']*'?|[^,"'&\s}]+)/gi, function (match, key, secret) {
      const quote = secret.charAt(0) === '"' || secret.charAt(0) === "'" ? secret.charAt(0) : '';
      return key + quote + '[REDACTED]' + quote;
    });
}

function redactResponseSample(value, limit) {
  const text = String(value == null ? '' : value);
  const max = limit || 500;
  if (text.length <= max) return redactText(text);
  return redactText(text.slice(0, max)) + '\n… [' + (text.length - max) + ' more characters not shown]';
}

function redactRequestUrl(value) {
  const text = redactText(String(value == null ? '' : value).slice(0, 2048));
  if (!REQUEST_LOG.redact) return text;
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return text;
  return text.slice(0, queryStart + 1) + text.slice(queryStart + 1)
    .split('&')
    .map(function (part) {
      const separator = part.indexOf('=');
      if (separator < 0) return part;
      const key = part.slice(0, separator);
      let decodedKey = key;
      try { decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')); } catch (e) {}
      return /(?:authorization|token|api[_-]?key|password|passwd|secret)/i.test(decodedKey)
        ? key + '=[REDACTED]'
        : part;
    })
    .join('&');
}

// With "Hide secrets": header names whose value is not logged (Authorization, Cookie, Set-Cookie, X-Api-Key, ...).
const SECRET_HEADER_NAME = /authorization|cookie|token|secret|password|passwd|api[_-]?key|session|signature|credential/i;

function redactHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  Object.keys(headers).forEach(function (name) {
    const value = headers[name];
    const text = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
    out[name] = REQUEST_LOG.redact && SECRET_HEADER_NAME.test(name) ? '[REDACTED]' : redactResponseSample(text, 1024);
  });
  return out;
}

function errorText(error) {
  if (!error) return '';
  return redactResponseSample(typeof error === 'object' ? (error.message || JSON.stringify(error)) : error, 500);
}

function shouldLogRequest(ok) {
  if (REQUEST_LOG.filter === 'errors') return !ok;
  if (REQUEST_LOG.filter === 'sample') return !ok || __ITER % REQUEST_LOG.every === 0;
  return true;
}

// Budget of this VU (each VU runs its own copy of the script): REQUEST_LOG.burst records
// at first, then REQUEST_LOG.rate a second, for passed and for failed requests each. The
// server forwards only 50 + 50 a second to the browser, so building every record would
// only take time from the test. A record carries how many this VU left out before it (sk).
const LOG_BUDGET = { ok: { tokens: REQUEST_LOG.burst, at: 0 }, failed: { tokens: REQUEST_LOG.burst, at: 0 } };
let logSkipped = 0;

function takeLogBudget(ok) {
  const bucket = ok ? LOG_BUDGET.ok : LOG_BUDGET.failed;
  const now = Date.now();
  if (bucket.at) bucket.tokens = Math.min(REQUEST_LOG.burst, bucket.tokens + (now - bucket.at) * REQUEST_LOG.rate / 1000);
  bucket.at = now;
  if (bucket.tokens < 1) {
    logSkipped += 1;
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

function skippedBefore() {
  const count = logSkipped;
  logSkipped = 0;
  return count;
}

function logHttpRequest(i, method, url, res) {
  const ok = res.status >= 200 && res.status < 400;
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  printHttpRecord(i, method, url, res, ok, undefined);
}

// A request with outcome rules or expected statuses: oc = its outcome label (undefined
// without rules), ok = whether the status counts as a success (its expected statuses,
// else 200–399). Apart from logHttpRequest() so that one keeps its four arguments:
// k6's interpreter ran a six-parameter version called with four about 10% slower.
function logHttpOutcome(i, method, url, res, oc, ok) {
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  printHttpRecord(i, method, url, res, ok, oc);
}

function printHttpRecord(i, method, url, res, ok, oc) {
  const request = res.request || {};
  console.log(JSON.stringify({
    __r: 1, sk: skippedBefore(), vu: __VU, it: __ITER, i: i, m: method, url: redactRequestUrl(url),
    s: res.status, d: +(res.timings.duration.toFixed(1)), ok: ok, oc: oc, er: errorText(res.error),
    rqh: redactHeaders(request.headers), rq: redactResponseSample(request.body, REQUEST_LOG.bodyLimit),
    rh: redactHeaders(res.headers), rb: redactResponseSample(res.body, REQUEST_LOG.bodyLimit),
  }));
}`;

// Only in scripts with a gRPC request.
const GRPC_REQUEST_LOG_HELPER = String.raw`
function logGrpcRequest(i, address, method, message, metadata, res, duration) {
  const ok = !!res && res.status === 0;
  if (!shouldLogRequest(ok) || !takeLogBudget(ok)) return;
  console.log(JSON.stringify({
    __r: 1, sk: skippedBefore(), vu: __VU, it: __ITER, i: i, m: 'gRPC', url: redactRequestUrl(String(address) + '/' + String(method)),
    s: res ? res.status : null, d: duration, ok: ok, er: errorText(res && res.error),
    rqh: redactHeaders(metadata), rq: redactResponseSample(JSON.stringify(message || {}), REQUEST_LOG.bodyLimit),
    rh: redactHeaders(res && res.headers), rb: redactResponseSample(JSON.stringify((res && res.message) || {}), REQUEST_LOG.bodyLimit),
  }));
}`;

// Most VUs the load profile runs at once (k6 options from buildOptions).
function maxVusOf(options) {
  if (options.scenarios) return Math.max(1, ...Object.values(options.scenarios).map((s) => Number(s.vus) || 1));
  if (Array.isArray(options.stages) && options.stages.length) {
    return Math.max(1, ...options.stages.map((s) => Number(s.target) || 0));
  }
  return Math.max(1, Number(options.vus) || 1);
}

// Per-VU record budget (see takeLogBudget above), sized from the records the Requests
// tab keeps (MAX_REQUEST_RECORDS): all VUs together write about twice
// what the server forwards (REQ_LOG_RATE passed + as many failed a second), so the
// server limit still decides what is shown, and a short run with few VUs (a race test:
// every VU sends one burst of requests) still records all of them.
export function requestLogBudget(options) {
  const vus = maxVusOf(options);
  return {
    rate: Number(((2 * REQ_LOG_RATE) / vus).toPrecision(3)),
    burst: Math.min(10, Math.max(1, Math.ceil(MAX_REQUEST_RECORDS / vus))),
  };
}

export function requestLogSource(settings, withGrpc, options, bodyLimit = LOG_BODY_LIMIT) {
  const config = {
    filter: settings.logFilter, every: settings.logSampleEvery, redact: settings.logRedact, bodyLimit,
    ...requestLogBudget(options),
  };
  return `\n// Request details for K6UI (Run & Results → Requests)\nconst REQUEST_LOG = ${JSON.stringify(config)};\n`
    + REQUEST_LOG_HELPERS
    + (withGrpc ? `\n${GRPC_REQUEST_LOG_HELPER}` : "")
    + "\n";
}
