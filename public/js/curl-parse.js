// Parse a cURL command line (e.g. browser DevTools "Copy as cURL") into
// { method, url, headers: [{key,value}], body }.
// Handles the bash and cmd copy variants: '…', "…" and $'…' quoting,
// backslash / caret line continuations, repeated -H and -d flags, and the
// common curl options. Unknown value-taking flags in FLAGS_WITH_VALUE get
// their value skipped; other unknown flags are ignored.

// Value-taking flags we deliberately ignore (skip flag + value).
const FLAGS_WITH_VALUE = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '--retry',
  '-w', '--write-out', '--cacert', '--capath', '-E', '--cert', '--key',
  '-x', '--proxy', '-U', '--proxy-user', '--ciphers', '--resolve',
  '-C', '--continue-at', '--limit-rate', '-c', '--cookie-jar',
  '-T', '--upload-file', '--max-redirs', '--dns-servers', '--interface',
  '-K', '--config', '-r', '--range',
]);

function ansiEscape(src, i) {
  // Returns [decoded char(s), source chars consumed] for $'…' escapes.
  const c = src[i];
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"' };
  if (c in simple) return [simple[c], 1];
  if (c === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(i + 1, i + 3)))
    return [String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)), 3];
  if (c === 'u' && /^[0-9a-fA-F]{4}/.test(src.slice(i + 1, i + 5)))
    return [String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)), 5];
  return ['\\' + c, 1]; // unknown escape: keep as-is
}

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    let tok = '';
    let sawQuote = false;
    while (i < n && !/\s/.test(src[i])) {
      const c = src[i];
      if (c === "'") {
        sawQuote = true;
        i++;
        while (i < n && src[i] !== "'") tok += src[i++];
        i++;
      } else if (c === '"') {
        sawQuote = true;
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < n && '\\"$`\n'.includes(src[i + 1])) { tok += src[i + 1]; i += 2; }
          else tok += src[i++];
        }
        i++;
      } else if (c === '$' && src[i + 1] === "'") {
        sawQuote = true;
        i += 2;
        while (i < n && src[i] !== "'") {
          if (src[i] === '\\' && i + 1 < n) {
            const [ch, adv] = ansiEscape(src, i + 1);
            tok += ch; i += 1 + adv;
          } else tok += src[i++];
        }
        i++;
      } else if (c === '\\') {
        // backslash-newline = line continuation; otherwise escapes next char
        if (src[i + 1] === '\n') i += 2;
        else if (src[i + 1] === '\r' && src[i + 2] === '\n') i += 3;
        else if (i + 1 < n) { tok += src[i + 1]; i += 2; }
        else i++;
      } else {
        tok += c; i++;
      }
    }
    if (tok !== '' || sawQuote) tokens.push(tok);
  }
  return tokens;
}

export function parseCurl(input) {
  // cmd-style line continuations; bash ones are handled by the tokenizer
  const text = String(input || '').trim().replace(/\^\r?\n/g, ' ');
  if (!text) throw new Error('Paste a cURL command first.');

  const tokens = tokenize(text);
  let i = 0;
  if (!tokens[i] || tokens[i].toLowerCase() !== 'curl')
    throw new Error('Not a cURL command — it should start with "curl".');
  i++;

  let method = null;
  let url = null;
  let user = null;
  let isHead = false;
  let isGet = false;
  let hasJsonFlag = false;
  const headers = [];
  const dataParts = [];

  const next = (flag) => {
    i++;
    if (i >= tokens.length) throw new Error(`Missing value after ${flag}.`);
    return tokens[i];
  };
  const addHeader = (raw) => {
    const m = /^([^:;]+):\s?(.*)$/.exec(raw);
    if (m) headers.push({ key: m[1].trim(), value: m[2] });
    else if (raw.endsWith(';')) headers.push({ key: raw.slice(0, -1).trim(), value: '' });
  };

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-X' || t === '--request') method = next(t).toUpperCase();
    else if (/^-X./.test(t)) method = t.slice(2).toUpperCase();
    else if (t === '-H' || t === '--header') addHeader(next(t));
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(t))
      dataParts.push(next(t));
    else if (t === '--json') { dataParts.push(next(t)); hasJsonFlag = true; }
    else if (t === '-u' || t === '--user') user = next(t);
    else if (t === '-b' || t === '--cookie') headers.push({ key: 'Cookie', value: next(t) });
    else if (t === '-A' || t === '--user-agent') headers.push({ key: 'User-Agent', value: next(t) });
    else if (t === '-e' || t === '--referer') headers.push({ key: 'Referer', value: next(t) });
    else if (t === '--url') url = next(t);
    else if (t === '-I' || t === '--head') isHead = true;
    else if (t === '-G' || t === '--get') isGet = true;
    else if (t === '-F' || t === '--form' || t === '--form-string')
      throw new Error('Multipart forms (-F/--form) are not supported — use a raw body (-d) instead.');
    else if (FLAGS_WITH_VALUE.has(t)) next(t);
    else if (t.startsWith('-') && t !== '-') { /* boolean flag — ignore */ }
    else if (!url) url = t;
    // extra positional arguments are ignored
  }

  if (!url) throw new Error('No URL found in the cURL command.');

  let body = dataParts.length ? dataParts.join('&') : '';
  if (isGet && body) {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  }

  if (user) {
    const b64 = typeof btoa === 'function'
      ? btoa(user)
      : Buffer.from(user).toString('base64');
    headers.push({ key: 'Authorization', value: `Basic ${b64}` });
  }
  if (hasJsonFlag && !headers.some((h) => h.key.toLowerCase() === 'content-type'))
    headers.push({ key: 'Content-Type', value: 'application/json' });

  if (!method) method = isHead ? 'HEAD' : (body ? 'POST' : 'GET');

  return { method, url, headers, body };
}
