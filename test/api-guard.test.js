// Only K6UI's own page may call the API (server/api-guard.js): a page on another site
// that makes the browser POST to localhost gets a 403 (Sec-Fetch-Site, Origin) or a
// 415 (a type it could send without a preflight); K6UI's own requests go through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createServer } from '../server/index.js';
import { crossSiteProblem } from '../server/api-guard.js';

test('Sec-Fetch-Site and Origin: same origin or typed by the user pass, another site does not', () => {
  const host = 'localhost:3000';
  for (const headers of [
    { host },                                                    // curl, a script, the tests
    { host, 'sec-fetch-site': 'same-origin' },
    { host, 'sec-fetch-site': 'none' },
    { host, origin: 'http://localhost:3000' },                   // a browser without Sec-Fetch-*
    { host: 'LocalHost:3000', origin: 'http://localhost:3000' },
  ]) assert.equal(crossSiteProblem(headers), null, JSON.stringify(headers));
  for (const headers of [
    { host, 'sec-fetch-site': 'cross-site' },
    { host, 'sec-fetch-site': 'same-site' },                     // another port of localhost
    { host, 'sec-fetch-site': 'cross-site', origin: 'http://localhost:3000' },
    { host, origin: 'https://evil.example' },
    { host, origin: 'http://localhost:4000' },
    { host, origin: 'null' },                                    // a sandboxed frame, a file:// page
  ]) assert.ok(crossSiteProblem(headers), JSON.stringify(headers));
});

// One request to the server, with exactly these headers.
function request(port, { method = 'POST', path, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a page on another site can neither start a run nor call any other endpoint', async () => {
  const server = createServer({ port: 0, host: '127.0.0.1' });
  try {
    await once(server, 'listening');
    const { port } = server.address();
    const json = JSON.stringify({ scenario: { requests: [] } });

    // The request that used to start k6 (empty configuration): a plain text/plain POST.
    const plain = await request(port, { path: '/api/run', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(plain.status, 415);
    assert.match(plain.body, /Content-Type: application\/json/);
    assert.equal((await request(port, { path: '/api/run', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status, 415);
    assert.equal((await request(port, { path: '/api/run', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' })).status, 415);
    assert.equal((await request(port, { path: '/api/send-once' })).status, 415, 'no body at all');
    assert.equal((await request(port, { path: '/api/import-jmx', headers: { 'content-type': 'text/plain' }, body: '<jmeterTestPlan/>' })).status, 415);

    for (const path of ['/api/run', '/api/generate', '/api/send-once', '/api/import-script']) {
      const crossSite = await request(port, { path, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, body: json });
      assert.equal(crossSite.status, 403, path);
      assert.match(crossSite.body, /only answers K6UI's own page/);
      const otherOrigin = await request(port, { path, headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: json });
      assert.equal(otherOrigin.status, 403, path);
    }
    assert.equal((await request(port, { method: 'GET', path: '/api/k6-status', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

    // K6UI's own page (same origin), and a tool without browser headers.
    const ownPage = await request(port, {
      path: '/api/generate',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: `http://localhost:${port}` },
      body: JSON.stringify({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/' }] }, load: { mode: 'simple', vus: '1', duration: '1s' } }),
    });
    assert.equal(ownPage.status, 200);
    assert.match(JSON.parse(ownPage.body).script, /http\.request\("GET"/);
    assert.equal((await request(port, { path: '/api/import-jmx', headers: { 'content-type': 'application/xml' }, body: '<jmeterTestPlan/>' })).status, 400, 'XML reaches the importer');
    assert.equal((await request(port, { path: '/', method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'the page itself is not an API call');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
