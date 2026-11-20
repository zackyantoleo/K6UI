// Request record (Run & Results › Requests) → a cURL command that sends the same
// request again: method, URL, request headers and body as k6 recorded them.
// Shared by the Requests tab ("Copy as cURL") and the report (pure, no DOM).
//
// The record is what the script logged, so the command can only be as complete as
// the record: a body cut at the size cap sends just the recorded part, and with
// "Hide secrets" the [REDACTED] values are copied as they are. `notes` says so.

// The note redactResponseSample() in server/generator/request-log.js puts after a cut value.
const CUT_NOTE = /\n… \[(\d+) more characters not shown\]$/;
// curl computes it from the body it sends; a recorded one is wrong for a cut body.
const SKIPPED_HEADERS = new Set(['content-length']);

// Bash / zsh single quotes: everything literal, a ' closes, escapes and reopens.
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function uncut(value) {
  const text = String(value ?? '');
  const match = CUT_NOTE.exec(text);
  return match ? { text: text.slice(0, match.index), cut: Number(match[1]) } : { text, cut: 0 };
}

// null for a record that is not HTTP (gRPC) or has no URL.
export function curlFromRecord(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const method = String(entry.m ?? '').trim().toUpperCase() || 'GET';
  const url = String(entry.url ?? '');
  if (method === 'GRPC' || !url) return null;

  const notes = [];
  const body = uncut(entry.rq);
  const lines = [`curl ${shellQuote(url)}`];
  // [ ] { } in a URL are curl's globbing syntax (?ids[0]=1) unless -g.
  if (/[[\]{}]/.test(url)) lines.push('-g');

  if (method === 'HEAD') lines.push('--head');
  else if (!(method === 'GET' && !body.text) && !(method === 'POST' && body.text)) lines.push(`-X ${shellQuote(method)}`);

  const headers = entry.rqh && typeof entry.rqh === 'object' ? entry.rqh : null;
  let cutHeaders = 0;
  for (const [name, rawValue] of Object.entries(headers || {})) {
    if (SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    const value = uncut(rawValue);
    if (value.cut) cutHeaders += 1;
    lines.push(`-H ${shellQuote(`${name}: ${value.text}`)}`);
  }
  if (body.text) lines.push(`--data-raw ${shellQuote(body.text)}`);

  if (!headers) notes.push('Request headers were not recorded, so the command has none.');
  if (body.cut) notes.push(`The body was cut at the size cap: the command sends the recorded part only (${body.cut.toLocaleString('en-US')} characters are missing).`);
  if (cutHeaders) notes.push(`${cutHeaders === 1 ? 'A header value was' : `${cutHeaders} header values were`} cut at the size cap.`);
  const all = [url, body.text, ...Object.values(headers || {}).map(String)].join('\n');
  if (all.includes('[REDACTED]')) notes.push('"Hide secrets" was on: [REDACTED] values are copied as they are.');

  return { command: lines.join(' \\\n  '), notes };
}
