// Request log settings ("Record request details"): which requests a run logs.
// Shared by the store, the Requests tab controls and server/generator/ (plan.js, request-log.js)
// (pure, no DOM).
//
//   logRequests    — on/off (off by default: payloads can hold secrets)
//   logFilter      — "all": every request; "errors": failed requests only;
//                    "sample": every Nth iteration of each VU, plus every failed request
//   logSampleEvery — N for "sample" (whole number, 1 to MAX_SAMPLE_EVERY)
//   logMaxRecords  — how many records (the most recent) Run & Results → Requests keeps
//                    (whole number, 1 to MAX_RECORDS_LIMIT; default DEFAULT_MAX_RECORDS)
//   logRedact      — "Hide secrets": replace Authorization, cookies, tokens, passwords, API keys
//                    with [REDACTED] (off by default: the records show what was sent and received)

export const LOG_FILTERS = ['all', 'errors', 'sample'];
export const DEFAULT_SAMPLE_EVERY = 10;
export const MAX_SAMPLE_EVERY = 10000;
// Request and response bodies are cut to this many characters per record.
export const LOG_BODY_LIMIT = 4096;
// The Requests tab keeps logMaxRecords records (the most recent), this many unless the
// project says otherwise; the script's per-VU record budget is sized from it
// (server/generator/request-log.js). Each record holds up to two 4 KB bodies, so the
// limit keeps the browser tab's memory in check.
export const DEFAULT_MAX_RECORDS = 500;
export const MAX_RECORDS_LIMIT = 10000;

export function normalizeMaxRecords(value) {
  const count = Number(String(value ?? '').trim());
  return Number.isInteger(count) && count >= 1 ? Math.min(count, MAX_RECORDS_LIMIT) : DEFAULT_MAX_RECORDS;
}

export function normalizeRequestLog(options) {
  const source = options && typeof options === 'object' ? options : {};
  const logFilter = LOG_FILTERS.includes(source.logFilter) ? source.logFilter : 'all';
  const every = Number(String(source.logSampleEvery ?? '').trim());
  const logSampleEvery = Number.isInteger(every) && every >= 1
    ? Math.min(every, MAX_SAMPLE_EVERY)
    : DEFAULT_SAMPLE_EVERY;
  return {
    logRequests: !!source.logRequests, logFilter, logSampleEvery,
    logMaxRecords: normalizeMaxRecords(source.logMaxRecords), logRedact: source.logRedact === true,
  };
}
