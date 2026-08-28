import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScript } from '../server/generator/index.js';

function indexInOrder(source, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = source.indexOf(fragment);
    assert.ok(current > previous, `Expected ${JSON.stringify(fragment)} after the previous fragment`);
    previous = current;
  }
}

test('HTTP generation preserves load, thresholds, headers, extraction, assertions, and lifecycle order', () => {
  const script = generateScript({
    variables: [{ key: 'baseUrl', value: 'https://example.test' }],
    globalHeaders: [
      { key: 'Accept', value: 'application/json' },
      { key: 'X-Override', value: 'global' },
    ],
    load: { mode: 'simple', vus: 2, duration: '10s' },
    thresholds: { p95: 500, errorRate: 1 },
    scenario: {
      requests: [{
        type: 'http', method: 'POST', url: '{{baseUrl}}/login',
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'x-override', value: 'request' },
        ],
        body: '{"name":"zack"}', checkStatus: true, sleepAfter: 1,
        pre: { method: 'GET', url: '{{baseUrl}}/before', headers: [], body: '', extractions: [] },
        preScript: "vars.seed = 'x';",
        extractions: [{ varName: 'token', source: 'json', selector: 'token' }],
        assertions: [{ type: 'body-contains', value: 'ok', value2: '' }],
        postScript: 'vars.done = res.status;',
        post: { method: 'GET', url: '{{baseUrl}}/after', headers: [], body: '', extractions: [] },
      }],
    },
  });

  assert.match(script, /"vus": 2/);
  assert.match(script, /"duration": "10s"/);
  assert.match(script, /"p\(95\)<500"/);
  assert.match(script, /"rate<0\.01"/);
  assert.match(script, /"Accept": "application\/json"/);
  assert.match(script, /"x-override": "request"/i);
  const mainRequest = script.match(/const res_main_0 = http\.request\([^\n]+/u)?.[0] || '';
  assert.doesNotMatch(mainRequest, /"X-Override": "global"/);
  assert.match(script, /let token = JSON\.parse\(res_main_0\.body\)/);
  assert.match(script, /"body contains \\"ok\\""/);
  indexInOrder(script, [
    '// Pre: request 1',
    '// Pre-processor: request 1',
    '// Request 1: POST',
    'let token =',
    'sleep(1);',
    'body contains',
    '// Post-processor: request 1',
    '// Post: request 1',
  ]);
});

test('gRPC generation preserves connect, invoke, status, extraction, metadata, and close order', () => {
  const script = generateScript({
    load: { mode: 'simple', vus: 1, duration: '1s' },
    scenario: { requests: [{
      type: 'grpc', url: 'localhost:50051', grpcMethod: 'hello.Greeter/SayHello',
      grpcPlaintext: true, headers: [{ key: 'x-api-key', value: 'abc' }],
      body: '{"name":"Zack"}', checkStatus: true, sleepAfter: 0,
      extractions: [{ varName: 'message', source: 'json', selector: 'message' }],
      assertions: [{ type: 'status-2xx', value: '', value2: '' }],
    }] },
  });

  assert.match(script, /import grpc from 'k6\/net\/grpc'/);
  assert.match(script, /\.connect\("localhost:50051", \{ reflect: true, plaintext: true \}\)/);
  assert.match(script, /\.invoke\("hello\.Greeter\/SayHello", msg_main_0, \{ metadata: \{ "x-api-key": "abc" \} \}\)/);
  assert.match(script, /r && r\.status === grpc\.StatusOK/);
  assert.match(script, /let message = res_main_0\.message/);
  indexInOrder(script, ['.connect(', '.invoke(', 'grpc status OK', 'let message =', '.close();']);
});

test('invalid gRPC configuration is rejected with actionable validation', () => {
  assert.throws(
    () => generateScript({ scenario: { requests: [{ type: 'grpc', url: 'https://localhost:50051', grpcMethod: '' }] } }),
    /enter the gRPC method/,
  );
});
