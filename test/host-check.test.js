// Local-only server: loopback listen address by default, and a Host header check
// against DNS rebinding (server/host-check.js, server/index.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createServer } from '../server/index.js';
import { hostnameOf, isLocalHostHeader, isLoopbackAddress } from '../server/host-check.js';

test('loopback listen addresses are recognised, network ones are not', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '', undefined]) assert.equal(isLoopbackAddress(address), false, String(address));
});

test('Host headers: local names pass, anything else (a rebinding domain) does not', () => {
  assert.equal(hostnameOf('LocalHost:3000'), 'localhost');
  assert.equal(hostnameOf('[::1]:3000'), '[::1]');
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'k6ui.localhost:3000']) {
    assert.equal(isLocalHostHeader(host), true, host);
  }
  for (const host of ['evil.example:3000', 'localhost.evil.example', '192.168.1.10:3000', '', undefined]) {
    assert.equal(isLocalHostHeader(host), false, String(host));
  }
});

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers: { host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

test('the server listens on 127.0.0.1 by default and answers only local Host headers', async () => {
  const previous = process.env.HOST;
  delete process.env.HOST;
  const server = createServer({ port: 0 });
  try {
    await once(server, 'listening');
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');

    assert.equal((await get(port, '/api/k6-status', `localhost:${port}`)).status, 200);
    assert.equal((await get(port, '/', `127.0.0.1:${port}`)).status, 200);
    const rebound = await get(port, '/api/k6-status', `evil.example:${port}`);
    assert.equal(rebound.status, 403);
    assert.match(rebound.body, /only answers on localhost/);
  } finally {
    if (previous === undefined) delete process.env.HOST; else process.env.HOST = previous;
    server.close();
    await once(server, 'close');
  }
});
