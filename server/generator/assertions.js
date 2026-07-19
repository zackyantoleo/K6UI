// Per-request assertion codegen → k6 check() block with descriptive labels.
import { buildRegex } from "./helpers.js";

// mode = 'grpc' adapts the predicates to a k6 gRPC response: statuses are
// gRPC status codes (0 = OK), "body" is JSON.stringify(r.message), and
// duration-lt is skipped (gRPC responses carry no timings).
function buildAssertionFn(type, val, val2, mode) {
  const num  = Number(val);
  const sv   = JSON.stringify(val);
  const sv2  = JSON.stringify(val2);
  const body = mode === 'grpc' ? 'JSON.stringify(r.message || {})' : 'r.body';
  switch (type) {
    case 'status-2xx':
      return mode === 'grpc' ? `r.status === grpc.StatusOK` : `r.status >= 200 && r.status < 300`;
    case 'status-eq':         return `r.status === ${num}`;
    case 'status-ne':         return `r.status !== ${num}`;
    case 'status-lt':         return `r.status < ${num}`;
    case 'body-contains':     return `${body}.includes(${sv})`;
    case 'body-not-contains': return `!${body}.includes(${sv})`;
    case 'body-matches':      return `${buildRegex(val)}.test(${body})`;
    case 'header-exists':     return `r.headers[${sv}] != null`;
    case 'header-eq':         return mode === 'grpc' ? `String(r.headers[${sv}]) === ${sv2}` : `r.headers[${sv}] === ${sv2}`;
    case 'duration-lt':       return mode === 'grpc' ? '' : `r.timings.duration < ${num}`;
    default:                  return '';
  }
}

function buildAssertionLabel(assertion, mode) {
  const v = assertion.value || '', v2 = assertion.value2 || '';
  const labels = {
    'status-2xx':        mode === 'grpc' ? 'grpc status OK' : 'status success (2xx)',
    'status-eq':         `status == ${v}`,
    'status-ne':         `status != ${v}`,
    'status-lt':         `status < ${v}`,
    'body-contains':     `body contains "${v}"`,
    'body-not-contains': `body does not contain "${v}"`,
    'body-matches':      `body matches regex ${v}`,
    'header-exists':     `header ${v} exists`,
    'header-eq':         `header ${v} == "${v2}"`,
    'duration-lt':       `response < ${v}ms`,
  };
  return labels[assertion.type] || assertion.type;
}

export function buildAssertionsCode(assertions, resVar, mode = 'http') {
  if (!Array.isArray(assertions) || !assertions.length) return '';
  const parts = assertions
    .map(a => {
      const fn = buildAssertionFn(a.type, a.value || '', a.value2 || '', mode);
      if (!fn) return '';
      return `    ${JSON.stringify(buildAssertionLabel(a, mode))}: (r) => ${fn}`;
    })
    .filter(Boolean);
  if (!parts.length) return '';
  return `  check(${resVar}, {\n${parts.join(',\n')}\n  });\n`;
}
