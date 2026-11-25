// "Send once" in the request editor, the parts without a DOM: which JSON values
// can become an extraction (`selectorFor()`, the selector syntax of
// server/generator/helpers.js), the name a taken value gets (`variableNameFor()`),
// reading the response body as JSON, and the plain words of the result. The
// result itself comes from POST /api/send-once (server/send-once.js); the panel
// is components/send-once.js. Pure, no DOM.

// A response with more values than this is still shown, but only the first ones
// can be clicked (each is a button).
export const MAX_VALUE_BUTTONS = 2000;

// A key the selector can name: `data.token`, `items[0].id`. A key with ".", "["
// or "]", an empty key, or one with spaces at either end (the editor trims the
// selector) cannot be written as a selector.
const NAMEABLE_KEY = /^[^.[\]\s](?:[^.[\]]*[^.[\]\s])?$/;

// Path parts (object keys as strings, array positions as numbers) → the selector
// "Take a value from the response" reads (data.items[0].id), or null when it
// cannot be written. The root itself has no selector. A gRPC message is read with
// one [n] per key (server/generator/helpers.js buildJsonAccessor), so `grpc` refuses
// an array inside an array.
export function selectorFor(parts, { grpc = false } = {}) {
  if (!Array.isArray(parts) || !parts.length) return null;
  let selector = '';
  for (const [index, part] of parts.entries()) {
    if (typeof part === 'number') {
      if (!Number.isInteger(part) || part < 0) return null;
      if (grpc && typeof parts[index - 1] === 'number') return null;
      selector += `[${part}]`;
    } else if (typeof part === 'string' && NAMEABLE_KEY.test(part)) {
      selector += selector ? `.${part}` : part;
    } else {
      return null;
    }
  }
  return selector;
}

// The name of a taken value: its own key (the last key of the path), as a variable
// name ([A-Za-z_]\w*), never one of `taken` (token, token_2, token_3, ...).
export function variableNameFor(parts, taken = new Set()) {
  const key = [...(parts || [])].reverse().find(part => typeof part === 'string') ?? '';
  let base = key.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
  if (/^\d/.test(base)) base = `value_${base}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

const headerValue = (headers, name) => {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name);
  return key === undefined ? '' : String(headers[key]);
};

// The body as JSON: { json } or { reason } ('empty', 'cut': only the start came
// back, 'not-json').
export function responseJson(response) {
  const body = typeof response?.body === 'string' ? response.body : '';
  if (!body.trim()) return { reason: 'empty' };
  if (response.truncated) return { reason: 'cut' };
  try {
    return { json: JSON.parse(body) };
  } catch {
    return { reason: 'not-json' };
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

// How big the body is: Content-Length when the server sent one, else what came back.
export function responseSize(response) {
  const declared = headerValue(response?.headers, 'content-length').trim();
  if (/^\d+$/.test(declared)) return formatBytes(Number(declared));
  const body = typeof response?.body === 'string' ? response.body : '';
  if (response?.truncated) return `${formatBytes(new TextEncoder().encode(body).length)} shown of ${Number(response.totalChars).toLocaleString('en-US')} characters`;
  return formatBytes(new TextEncoder().encode(body).length);
}

const list = names => {
  const shown = names.map(name => `{{${name}}}`);
  return shown.length < 3 ? shown.join(' and ') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
};

// The head of the panel: the status and its tone, and short facts.
export function resultSummary(result) {
  const response = result?.response || {};
  const status = response.status;
  const facts = [];
  if (Number.isFinite(response.durationMs)) facts.push(`${Math.round(response.durationMs * 10) / 10} ms`);
  if (status) facts.push(responseSize(response));
  if (!status) {
    return { status: 'No response', tone: 'bad', verdict: 'The request got no response.', facts };
  }
  return {
    status: String(status),
    tone: result.ok ? 'ok' : 'bad',
    verdict: result.ok ? 'Counts as a success in a run.' : 'Counts as a failure in a run.',
    facts,
  };
}

// {{names}} that went out as typed text, in plain words.
export function unresolvedText(names) {
  if (!Array.isArray(names) || !names.length) return '';
  const one = names.length === 1;
  return `${list(names)} ${one ? 'has' : 'have'} no value before this request, so ${one ? 'it was' : 'they were'} sent as typed. `
    + 'In a run, an earlier request or Test data gives the value.';
}

// Why the body cannot be clicked, or '' when it can.
export function bodyNote(reason, response) {
  if (reason === 'empty') return 'The response has no body.';
  if (reason === 'cut') return `The response is ${Number(response?.totalChars).toLocaleString('en-US')} characters long; only the start is shown, as text. To keep a value, type its path in the Extract tab.`;
  if (reason === 'not-json') return 'The body is not JSON, so values cannot be clicked. To keep a value, use a header or a regex in the Extract tab.';
  return 'Click a value to take it for later requests.';
}
