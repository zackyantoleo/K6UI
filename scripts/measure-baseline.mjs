import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateScript } from '../server/generator/index.js';

const root = new URL('..', import.meta.url);
const rootPath = root.pathname.replace(/\/$/, '');

async function filesUnder(dir, suffix) {
  const found = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(entryPath);
    }
  }
  await walk(join(rootPath, dir));
  return found.sort();
}

async function assetStats() {
  const paths = [
    join(rootPath, 'public/index.html'),
    ...(await filesUnder('public/js', '.js')),
    ...(await filesUnder('public/css', '.css')),
  ];
  const files = [];
  for (const path of paths) {
    const body = await readFile(path);
    files.push({
      path: relative(rootPath, path),
      bytes: body.length,
      gzip_bytes: gzipSync(body).length,
    });
  }
  return {
    files,
    totals: files.reduce(
      (acc, file) => ({ bytes: acc.bytes + file.bytes, gzip_bytes: acc.gzip_bytes + file.gzip_bytes }),
      { bytes: 0, gzip_bytes: 0 },
    ),
  };
}

async function startupStats() {
  const port = 31000 + Math.floor(Math.random() * 1000);
  const started = performance.now();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const samples = [];
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const requestStart = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/k6-status`);
        if (response.ok) {
          samples.push(performance.now() - requestStart);
          return {
            readiness_ms: Number((performance.now() - started).toFixed(2)),
            status_response_ms: Number(samples[0].toFixed(2)),
          };
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Server did not become ready within the measurement window');
  } finally {
    child.kill('SIGTERM');
  }
}

function requestFixture(index) {
  return {
    type: 'http',
    method: index % 3 === 0 ? 'POST' : 'GET',
    url: `https://api.example.test/items/${index}?run={{runId}}`,
    headers: [{ key: 'X-Request-ID', value: `req-${index}` }],
    body: index % 3 === 0 ? JSON.stringify({ index, value: `item-${index}` }) : '',
    checkStatus: true,
    sleepAfter: 0,
    extractions: index % 10 === 0 ? [{ varName: `value_${index}`, source: 'json', selector: 'data.value' }] : [],
    assertions: [{ type: 'status-2xx', value: '', value2: '' }],
    preScript: '', postScript: '', pre: null, post: null,
  };
}

function generatorStats() {
  const config = {
    variables: [{ key: 'runId', value: 'baseline' }],
    globalHeaders: [{ key: 'Accept', value: 'application/json' }],
    load: { mode: 'simple', vus: 10, duration: '30s' },
    thresholds: { p95: 500, errorRate: 1 },
    scenario: { requests: Array.from({ length: 100 }, (_, index) => requestFixture(index)) },
  };
  for (let i = 0; i < 5; i += 1) generateScript(config);
  const runs = [];
  let outputBytes = 0;
  for (let i = 0; i < 30; i += 1) {
    const started = performance.now();
    const script = generateScript(config);
    runs.push(performance.now() - started);
    outputBytes = Buffer.byteLength(script);
  }
  runs.sort((a, b) => a - b);
  return {
    requests: 100,
    iterations: runs.length,
    median_ms: Number(runs[Math.floor(runs.length / 2)].toFixed(3)),
    p95_ms: Number(runs[Math.floor(runs.length * 0.95)].toFixed(3)),
    min_ms: Number(runs[0].toFixed(3)),
    max_ms: Number(runs.at(-1).toFixed(3)),
    generated_script_bytes: outputBytes,
  };
}

const result = {
  measured_at: new Date().toISOString(),
  runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
  assets: await assetStats(),
  startup: await startupStats(),
  generator_100_requests: generatorStats(),
};

console.log(JSON.stringify(result, null, 2));
