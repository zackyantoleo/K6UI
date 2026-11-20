// Before/After sub-requests (`pre` / `post` on a request) were a second way to
// order requests. The editor no longer has them: a project file or API payload
// that still carries them is read as ordinary requests in the same order
// (before, the request, after), so it keeps running the same calls.
// Pure (no DOM): shared by project-store.js and server/generator/index.js.

const isRequest = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasUrl = sub => isRequest(sub) && String(sub.url || '').trim() !== '';

function fromSubRequest(sub, parent, suffix, label) {
  const parentName = typeof parent.name === 'string' && parent.name.trim() ? parent.name.trim() : 'Request';
  const request = {
    name: `${parentName} (${label})`.slice(0, 120),
    type: 'http',
    method: sub.method || 'GET',
    url: sub.url,
    headers: Array.isArray(sub.headers) ? sub.headers : [],
    body: sub.body ?? '',
    extractions: Array.isArray(sub.extractions) ? sub.extractions : [],
    // A sub-request always had the automatic status check and no pause of its own.
    checkStatus: true,
    sleepAfter: '0',
  };
  if (typeof parent.id === 'string' && parent.id) request.id = `${parent.id}_${suffix}`;
  if (parent.groupId !== undefined) request.groupId = parent.groupId;
  if (parent.enabled !== undefined) request.enabled = parent.enabled;
  return request;
}

// requests → the same list with every `pre` / `post` that has a URL turned into
// its own request. The pause and the "Save to CSV" rows of a request came after
// its After request, so they move to it. Entries without sub-requests are kept
// as they are (minus empty `pre` / `post` keys); non-objects pass through.
export function expandSubRequests(requests) {
  if (!Array.isArray(requests)) return requests;
  const expanded = [];
  for (const item of requests) {
    if (!isRequest(item) || (!('pre' in item) && !('post' in item))) {
      expanded.push(item);
      continue;
    }
    const { pre, post, ...request } = item;
    if (hasUrl(pre)) expanded.push(fromSubRequest(pre, request, 'before', 'before'));
    if (hasUrl(post)) {
      const after = fromSubRequest(post, request, 'after', 'after');
      if (request.sleepAfter !== undefined) after.sleepAfter = request.sleepAfter;
      else delete after.sleepAfter;
      if (request.exports !== undefined) after.exports = request.exports;
      const { exports: _moved, ...kept } = request;
      expanded.push({ ...kept, sleepAfter: '0' }, after);
    } else {
      expanded.push(request);
    }
  }
  return expanded;
}
