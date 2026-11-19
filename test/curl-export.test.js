import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { curlFromRecord, shellQuote } from '../public/js/curl-export.js';
import { parseCurl } from '../public/js/curl-parse.js';
import { buildRunReport, reportToHtml } from '../public/js/run-report.js';

const record = (extra = {}) => ({
  vu: 1, it: 0, i: 0, m: 'POST', url: 'https://api.example.com/orders?x=1&y=2', s: 201, d: 5, ok: true,
  rqh: { 'Content-Type': 'application/json', Authorization: 'Bearer abc', 'Content-Length': '27', 'User-Agent': 'k6/2.4.0' },
  rq: `{"note":"it's \\"quoted\\" $HOME \`id\`"}`,
  ...extra,
});

// What bash hands to curl: each argument on its own NUL-separated field.
function bashArgs(command) {
  const out = execFileSync('bash', ['-c', `curl() { printf '%s\\0' "$@"; }\n${command}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

test('an HTTP record becomes a cURL command with its method, URL, headers and body', () => {
  const { command, notes } = curlFromRecord(record());
  assert.deepEqual(notes, []);
  assert.match(command, /^curl 'https:\/\/api\.example\.com\/orders\?x=1&y=2' \\\n {2}-H /);
  assert.doesNotMatch(command, /Content-Length/i, 'curl computes the length itself');
  assert.doesNotMatch(command, /-X/, 'POST with a body is curl\'s default');
  const parsed = parseCurl(command);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.url, 'https://api.example.com/orders?x=1&y=2');
  assert.equal(parsed.body, record().rq);
  assert.deepEqual(parsed.headers, [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Authorization', value: 'Bearer abc' },
    { key: 'User-Agent', value: 'k6/2.4.0' },
  ]);
});

test('bash passes every value through untouched (quotes, $, backticks, newlines)', () => {
  const body = 'line 1\nit\'s $HOME `id` "x" \\n';
  const args = bashArgs(curlFromRecord(record({ m: 'PUT', rq: body })).command);
  assert.deepEqual(args, [
    'https://api.example.com/orders?x=1&y=2',
    '-X', 'PUT',
    '-H', 'Content-Type: application/json',
    '-H', 'Authorization: Bearer abc',
    '-H', 'User-Agent: k6/2.4.0',
    '--data-raw', body,
  ]);
});

test('method flags: GET plain, HEAD --head, GET with a body and DELETE get -X', () => {
  const cmd = extra => curlFromRecord(record({ rqh: {}, ...extra })).command;
  assert.equal(cmd({ m: 'GET', rq: '' }), "curl 'https://api.example.com/orders?x=1&y=2'");
  assert.equal(cmd({ m: 'HEAD', rq: '' }), "curl 'https://api.example.com/orders?x=1&y=2' \\\n  --head");
  assert.equal(parseCurl(cmd({ m: 'GET', rq: 'a=1' })).method, 'GET');
  assert.equal(parseCurl(cmd({ m: 'delete', rq: '' })).method, 'DELETE');
  assert.equal(parseCurl(cmd({ m: 'POST', rq: '' })).method, 'POST');
});

test('a URL with brackets turns curl globbing off', () => {
  assert.match(curlFromRecord(record({ url: 'https://x/a?ids[0]=1' })).command, /\\\n {2}-g \\/);
});

test('notes: cut body and header, redacted values, headers not recorded', () => {
  const cut = curlFromRecord(record({
    rq: '{"a":1\n… [5000 more characters not shown]',
    rqh: { Authorization: '[REDACTED]', 'X-Long': 'abc\n… [10 more characters not shown]' },
  }));
  assert.equal(parseCurl(cut.command).body, '{"a":1', 'the size-cap note is not sent');
  assert.equal(parseCurl(cut.command).headers[1].value, 'abc');
  assert.equal(cut.notes.length, 3);
  assert.match(cut.notes[0], /5,000 characters are missing/);
  assert.match(cut.notes[1], /A header value was cut/);
  assert.match(cut.notes[2], /Hide secrets/);
  assert.match(curlFromRecord(record({ rqh: undefined })).notes[0], /not recorded/);
});

test('gRPC records and records without a URL have no cURL command', () => {
  assert.equal(curlFromRecord(record({ m: 'gRPC', url: 'host:443/pkg.Svc/Do' })), null);
  assert.equal(curlFromRecord(record({ url: '' })), null);
  assert.equal(curlFromRecord(null), null);
});

test('shellQuote closes and reopens around a single quote', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(null), "''");
});

test('the report shows the cURL command of each HTTP record, escaped', () => {
  const report = buildRunReport({
    verdict: { status: 'passed' },
    requests: [record({ rq: '<b>x</b>' }), record({ m: 'gRPC', url: 'h:1/p.S/M' })],
  });
  assert.equal('curl' in report.requests[0], false, 'the JSON report keeps its shape');
  const html = reportToHtml(report);
  assert.equal((html.match(/<details class="curl">/g) || []).length, 1, 'only the HTTP record');
  assert.match(html, /--data-raw &#39;&lt;b&gt;x&lt;\/b&gt;&#39;/);
});
