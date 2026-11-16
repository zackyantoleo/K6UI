// Executes a generated k6 script in Node. The k6 modules are stubs and
// `http.request` records its calls; no network, no k6 binary. The caller sets
// exec.scenario.iterationInTest and globalThis.__VU before each iteration — the
// way k6 does — so a test fixes the numbering it assumes (unique and sequential
// per scenario iteration). Shared by the data file and "run only if" tests.
//
//   respond(call) → the response of one http.request (default: 200 with body "{}")
//   grpcResponse  → what a gRPC invoke returns (default: status 0, message {})
export function loadScript(script, { respond, grpcResponse } = {}) {
  const calls = [];
  const grpcCalls = [];
  const logs = [];
  const sleeps = [];
  const exec = { scenario: { iterationInTest: 0 } };
  class SharedArray {
    constructor(name, init) {
      const items = init();
      this.length = items.length;
      items.forEach((item, i) => { this[i] = structuredClone(item); });
    }
  }
  class GrpcClient {
    connect(address) { grpcCalls.push({ step: 'connect', address }); }
    invoke(method, message) {
      grpcCalls.push({ step: 'invoke', method, message });
      return { status: 0, timings: { duration: 1 }, ...(grpcResponse ?? { message: {} }) };
    }
    close() { grpcCalls.push({ step: 'close' }); }
  }
  const modules = {
    'k6/http': {
      request: (method, url, body, params) => {
        const call = { method, url, body, params };
        calls.push(call);
        return { status: 200, body: '{}', headers: {}, timings: { duration: 1 }, ...respond?.(call) };
      },
    },
    k6: { sleep: seconds => sleeps.push(seconds), check: () => true },
    'k6/data': { SharedArray },
    'k6/execution': exec,
    'k6/net/grpc': { Client: GrpcClient, StatusOK: 0 },
  };
  const code = script
    .replace(/^import (\w+) from '([^']+)';$/gm, (_, name, from) => `const ${name} = __k6[${JSON.stringify(from)}];`)
    .replace(/^import (\{[^}]+\}) from '([^']+)';$/gm, (_, names, from) => `const ${names} = __k6[${JSON.stringify(from)}];`)
    .replace('export const options =', 'const options =')
    .replace('export default function()', 'const __main = function()');
  const factory = new Function('__k6', 'console', `${code}\nreturn { options, main: __main };`);
  const { options, main } = factory(modules, { warn: message => logs.push(message), log: message => logs.push(message) });
  return {
    options, calls, grpcCalls, logs, sleeps,
    iteration(vu, iterationInTest) {
      globalThis.__VU = vu;
      globalThis.__ITER = iterationInTest;
      exec.scenario.iterationInTest = iterationInTest;
      const before = calls.length;
      main();
      return calls.slice(before);
    },
  };
}
