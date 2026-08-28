import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';

let server;
let baseUrl;

before(async () => {
  server = createServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;
  server.close();
  await once(server, 'close');
});

test('runtime smoke serves the UI and k6 status endpoint', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>K6UI/);

  const status = await fetch(`${baseUrl}/api/k6-status`);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(typeof body.installed, 'boolean');
});

test('POST /api/generate returns generated script and rejects invalid gRPC config', async () => {
  const valid = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      load: { mode: 'simple', vus: 1, duration: '1s' },
      scenario: { requests: [{ type: 'http', method: 'GET', url: 'https://test.k6.io' }] },
    }),
  });
  assert.equal(valid.status, 200);
  assert.match((await valid.json()).script, /https:\/\/test\.k6\.io/);

  const invalid = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: { requests: [{ type: 'grpc', url: 'localhost:50051', grpcMethod: '' }] } }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /enter the gRPC method/);
});
