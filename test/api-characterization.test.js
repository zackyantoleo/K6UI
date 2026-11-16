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

const post = (path, body, headers = { 'content-type': 'application/json' }) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

const configWithData = dataSet => ({
  load: { mode: 'iterations', vus: 5, iterations: 1 },
  scenario: { requests: [{ type: 'http', method: 'GET', url: 'https://test.k6.io/?u={{email}}' }] },
  dataSets: [{ name: 'login.csv', skipHeader: true, columns: ['email', 'password'], share: 'next-row', onEnd: 'recycle', ...dataSet }],
});

test('POST /api/generate embeds data files, and takes bodies bigger than the default 1 MB', async () => {
  const small = await post('/api/generate', configWithData({ content: 'email,password\nuser1@example.com,pass1\n' }));
  assert.equal(small.status, 200);
  assert.match((await small.json()).script, /new SharedArray\("1: login\.csv"[\s\S]*"user1@example\.com","pass1"/);

  const rows = Array.from({ length: 60_000 }, (_, i) => `user${i}@example.com,pass${i}`);
  const content = `email,password\n${rows.join('\n')}\n`;
  assert.ok(content.length > 1.5 * 1024 * 1024);
  const big = await post('/api/generate', configWithData({ content }));
  assert.equal(big.status, 200);
  assert.match((await big.json()).script, /"user59999@example\.com","pass59999"/);
});

test('POST /api/generate rejects unusable data files: 400 for the content, 413 for the size', async () => {
  const unclosed = await post('/api/generate', configWithData({ content: 'email,password\n"user1,pass1\n' }));
  assert.equal(unclosed.status, 400);
  assert.match((await unclosed.json()).error, /Data file "login\.csv": A quoted value that starts on line 2 is never closed/);

  const tooBig = await post('/api/generate', configWithData({ content: `email\n${'x'.repeat(5 * 1024 * 1024)}` }));
  assert.equal(tooBig.status, 413);
  assert.match((await tooBig.json()).error, /Data file "login\.csv" is 5\.1 MB; the limit is 5\.0 MB per file/);

  const hugeBody = await post('/api/generate', `{"pad":"${'x'.repeat(25 * 1024 * 1024)}"}`);
  assert.equal(hugeBody.status, 413);
  assert.match((await hugeBody.json()).error, /The request is too large \(the limit is 24 MB\)/);
});

test('the import endpoints keep their own, smaller JSON limit', async () => {
  const response = await post('/api/import-script', { script: `// ${'x'.repeat(1.5 * 1024 * 1024)}` });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /The request is too large \(the limit is 1 MB\)/);
});
