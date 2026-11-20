// Request log settings ("Record request details"): which requests a run logs.
// Shared by the store, the Requests tab controls and server/generator/ (plan.js, request-log.js)
// (pure, no DOM).
//
//   logRequests    — on/off (off by default: payloads can hold secrets)
//   logFilter      — "all": every request; "errors": failed requests only;
//                    "sample": every Nth iteration of each VU, plus every failed request
//   logSampleEvery — N for "sample" (whole number, 1 to MAX_SAMPLE_EVERY)
//   logRedact      — "Hide secrets": replace Authorization, cookies, tokens, passwords, API keys
//                    with [REDACTED] (off by default: the records show what was sent and received)

export const LOG_FILTERS = ['all', 'errors', 'sample'];
export const DEFAULT_SAMPLE_EVERY = 10;
export const MAX_SAMPLE_EVERY = 10000;
// Request and response bodies are cut to this many characters per record.
export const LOG_BODY_LIMIT = 4096;
// The Requests tab keeps this many records (the most recent); the script's per-VU
// record budget is sized from it (server/generator/request-log.js).
export const MAX_REQUEST_RECORDS = 500;

export function normalizeRequestLog(options) {
  const source = options && typeof options === 'object' ? options : {};
  const logFilter = LOG_FILTERS.includes(source.logFilter) ? source.logFilter : 'all';
  const every = Number(String(source.logSampleEvery ?? '').trim());
  const logSampleEvery = Number.isInteger(every) && every >= 1
    ? Math.min(every, MAX_SAMPLE_EVERY)
    : DEFAULT_SAMPLE_EVERY;
  return { logRequests: !!source.logRequests, logFilter, logSampleEvery, logRedact: source.logRedact === true };
}
