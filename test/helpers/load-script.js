// Executes a generated k6 script in Node. The k6 modules are stubs and
// `http.request` records its calls; no network, no k6 binary. The caller sets
// exec.scenario.iterationInTest and globalThis.__VU before each iteration — the
// way k6 does — so a test fixes the numbering it assumes (unique and sequential
// per scenario iteration). Shared by the data file and "run only if" tests.
//
//   respond(call) → the response of one http.request (default: 200 with body "{}")
//   grpcResponse  → what a gRPC invoke returns (default: status 0, message {})
// `metrics` records every Counter.add() as { name, value, tags } (outcome rules).
// `checks` records every check() as { name, ok } (the predicate run on the response).
// `http.expectedStatuses(...)` returns { expectedStatuses: [...its arguments] }.
// `http.get(url, params)` is recorded as a GET call like http.request. A race burst
// script's `setup()` is returned as `setup`; pass its data to iteration(vu, i, data).
// k6's `res.json(path)` as the generator uses it: a gjson path ("." between keys,
// "\" makes the next character literal, a number indexes an array) gives undefined
// when the path, the body or valid JSON is missing; without a path the whole body
// is parsed and a body that is not JSON throws.
function jsonRead(path) {
  if (path === undefined || path === '') return JSON.parse(this.body);
  let value;
  try {
    value = JSON.parse(this.body);
  } catch {
    return undefined;
  }
  for (const key of path.match(/(?:\\.|[^.\\])+/g) ?? []) {
    const literal = key.replace(/\\(.)/g, '$1');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, literal)) return undefined;
    value = value[literal];
  }
  return value;
}

export function loadScript(script, { respond, grpcResponse } = {}) {
  const calls = [];
  const grpcCalls = [];
  const logs = [];
  const sleeps = [];
  const metrics = [];
  const checks = [];
  const exec = { scenario: { iterationInTest: 0 } };
  class SharedArray {
    constructor(name, init) {
      const items = init();
      this.length = items.length;
      items.forEach((item, i) => { this[i] = structuredClone(item); });
    }
  }
  class Counter {
    constructor(name) { this.name = name; }
    add(value, tags) { metrics.push({ name: this.name, value, tags: { ...tags } }); }
  }
  class GrpcClient {
    connect(address) { grpcCalls.push({ step: 'connect', address }); }
    invoke(method, message) {
      grpcCalls.push({ step: 'invoke', method, message });
      return { status: 0, timings: { blocked: 0, connecting: 0, tls_handshaking: 0, duration: 1 }, ...(grpcResponse ?? { message: {} }) };
    }
    close() { grpcCalls.push({ step: 'close' }); }
  }
  const request = (method, url, body, params) => {
    const call = { method, url, body, params };
    calls.push(call);
    return { status: 200, body: '{}', headers: {}, timings: { blocked: 0, connecting: 0, tls_handshaking: 0, duration: 1 }, ...respond?.(call), json: jsonRead };
  };
  const modules = {
    'k6/http': {
      expectedStatuses: (...statuses) => ({ expectedStatuses: statuses }),
      request,
      get: (url, params) => request('GET', url, null, params),
    },
    k6: {
      sleep: seconds => sleeps.push(seconds),
      check: (res, sets) => {
        for (const [name, predicate] of Object.entries(sets)) {
          let ok = false;
          try { ok = predicate(res) === true; } catch { ok = false; }
          checks.push({ name, ok });
        }
        return true;
      },
    },
    'k6/data': { SharedArray },
    'k6/execution': exec,
    'k6/net/grpc': { Client: GrpcClient, StatusOK: 0 },
    'k6/metrics': { Counter },
  };
  const code = script
    .replace(/^import (\w+) from '([^']+)';$/gm, (_, name, from) => `const ${name} = __k6[${JSON.stringify(from)}];`)
    .replace(/^import (\{[^}]+\}) from '([^']+)';$/gm, (_, names, from) => `const ${names} = __k6[${JSON.stringify(from)}];`)
    .replace('export const options =', 'const options =')
    .replace('export function setup()', 'function setup()')
    .replace(/export default function\((data)?\)/, (_, data) => `const __main = function(${data || ''})`);
  const setupName = /^function setup\(\)/m.test(code) ? 'setup' : 'null';
  const factory = new Function('__k6', 'console', `${code}\nreturn { options, main: __main, setup: ${setupName} };`);
  const { options, main, setup } = factory(modules, { warn: message => logs.push(message), log: message => logs.push(message) });
  return {
    options, calls, grpcCalls, logs, sleeps, metrics, checks, setup,
    iteration(vu, iterationInTest, data) {
      globalThis.__VU = vu;
      globalThis.__ITER = iterationInTest;
      exec.scenario.iterationInTest = iterationInTest;
      const before = calls.length;
      main(data);
      return calls.slice(before);
    },
  };
}
