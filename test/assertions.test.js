// Response checks (public/js/shared/assertions.js, server/generator/assertions.js):
// values that cannot work are refused before Run and by the generator (a 400); a
// response without a body is read as ""; header names are written as k6 keys them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertionProblem, assertionsProblem } from '../public/js/shared/assertions.js';
import { canonicalHeaderName } from '../server/generator/helpers.js';
import { generateScript } from '../server/generator/index.js';

const load = { mode: 'simple', vus: '1', duration: '1s' };
const script = (request) => generateScript({ scenario: { requests: [{ method: 'GET', url: 'https://api.test/', ...request }] }, load });

test('a status or time check needs a number; text checks need text; header checks a name', () => {
  for (const [assertion, problem] of [
    [{ type: 'status-eq', value: '' }, 'the "status ==" check needs a status code such as 200.'],
    [{ type: 'status-ne', value: '2xx' }, 'the "status !=" check needs a status code such as 404 (it has "2xx").'],
    [{ type: 'status-lt', value: '{{limit}}' }, 'the "status <" check needs a status code such as 500 (it has "{{limit}}").'],
    [{ type: 'duration-lt', value: '-1' }, 'the "response time under" check needs a number of milliseconds such as 500 (it has "-1").'],
    [{ type: 'body-contains', value: '' }, 'the "body contains" check needs the text to look for.'],
    [{ type: 'body-not-contains' }, 'the "body does not contain" check needs the text that must not be there.'],
    [{ type: 'header-exists', value: '  ' }, 'the "header exists" check needs a header name.'],
    [{ type: 'header-eq', value: '', value2: 'x' }, 'the "header ==" check needs a header name.'],
    [{ type: 'body-matches', value: '' }, 'the "body matches regex" check needs a regex.'],
    [{ type: 'body-matches', value: 'a[' }, 'the "body matches regex" check: "a[" is not a regular expression: a "[" is never closed with "]".'],
  ]) assert.equal(assertionProblem(assertion), problem, JSON.stringify(assertion));

  for (const assertion of [
    { type: 'status-2xx', value: '' }, { type: 'status-eq', value: ' 200 ' }, { type: 'status-eq', value: 200 },
    { type: 'duration-lt', value: '12.5' }, { type: 'body-contains', value: ' ' }, { type: 'body-matches', value: '\\s+' },
    { type: 'header-eq', value: 'X-Id', value2: '' }, { type: 'unknown-type', value: '' },
  ]) assert.equal(assertionProblem(assertion), '', JSON.stringify(assertion));
  // gRPC writes no response time check, so its value is not read.
  assert.equal(assertionProblem({ type: 'duration-lt', value: '' }, { grpc: true }), '');
  assert.equal(assertionsProblem([
    { label: 'Request 1', assertions: [{ type: 'status-eq', value: '200' }] },
    { label: 'Request 2', type: 'grpc', assertions: [{ type: 'duration-lt', value: '' }, { type: 'status-eq', value: 'OK' }] },
  ]), 'Request 2: the "status ==" check needs a status code such as 200 (it has "OK").');
});

test('the generator refuses such a check with a 400 naming the request, and writes numbers as numbers', () => {
  assert.throws(() => script({ assertions: [{ type: 'status-eq', value: '' }] }), /^Error: Request 1: the "status ==" check needs a status code such as 200\.$/);
  assert.throws(() => script({ assertions: [{ type: 'duration-lt', value: 'fast' }] }), /Request 1: the "response time under" check needs a number/);
  const s = script({ assertions: [{ type: 'status-eq', value: ' 201 ' }, { type: 'duration-lt', value: '250' }] });
  assert.match(s, /\(r\) => r\.status === 201,/);
  assert.match(s, /\(r\) => r\.timings\.duration < 250/);
  assert.doesNotMatch(s, /NaN/);
});

test('a response without a body is read as "" by checks and regex extractions', () => {
  const s = script({
    assertions: [{ type: 'body-contains', value: 'ok' }, { type: 'body-not-contains', value: 'err' }, { type: 'body-matches', value: 'nul+' }],
    extractions: [{ varName: 'sid', source: 'regex', selector: 'sid=(\\w+)' }],
  });
  assert.match(s, /\(r\) => \(r\.body \?\? ""\)\.includes\("ok"\)/);
  assert.match(s, /\(r\) => !\(r\.body \?\? ""\)\.includes\("err"\)/);
  assert.match(s, /\(r\) => \/nul\+\/\.test\(r\.body \?\? ""\)/);
  assert.match(s, /let sid = \(\(res_main_0\.body \?\? ""\)\.match\(\/sid=\(\\w\+\)\/\) \|\| \[\]\)\[1\] \|\| "";/);
});

test('HTTP header names are written in the form k6 keys them (Go canonical), gRPC metadata as typed', () => {
  assert.equal(canonicalHeaderName('x-request-id'), 'X-Request-Id');
  assert.equal(canonicalHeaderName(' CONTENT-TYPE '), 'Content-Type');
  assert.equal(canonicalHeaderName('x_trace'), 'X_trace');
  assert.equal(canonicalHeaderName('www-authenticate'), 'Www-Authenticate');
  assert.equal(canonicalHeaderName('has space'), 'has space');  // not a header name: Go leaves it, so does K6UI
  const http = script({
    assertions: [{ type: 'header-exists', value: 'x-request-id' }, { type: 'header-eq', value: 'content-type', value2: 'application/json' }],
    extractions: [{ varName: 'rid', source: 'header', selector: 'x-request-id' }],
  });
  assert.match(http, /\(r\) => r\.headers\["X-Request-Id"\] != null/);
  assert.match(http, /\(r\) => r\.headers\["Content-Type"\] === "application\/json"/);
  assert.match(http, /let rid = res_main_0\.headers\["X-Request-Id"\];/);
  const grpc = generateScript({ scenario: { requests: [{ type: 'grpc', url: 'localhost:9', grpcMethod: 'pkg.Svc/Call', body: '{}', assertions: [{ type: 'header-exists', value: 'x-trace' }], extractions: [{ varName: 'trace', source: 'header', selector: 'x-trace' }] }] }, load });
  assert.match(grpc, /r\.headers\["x-trace"\] != null/);
  assert.match(grpc, /res_main_0\.headers\["x-trace"\]/);
});
