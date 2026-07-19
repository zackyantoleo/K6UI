# K6UI — Project Guide

A web UI for building and running [k6](https://k6.io) load tests without writing code.
Stack: Express (ESM) + vanilla JS frontend. **No build step, no framework, no automated tests.**

## Running

```bash
npm start        # http://localhost:3000
npm run dev      # auto-restart on server file changes
```

Prerequisites: Node 18+, and the `k6` binary on PATH (only needed to run tests; script generation works without it).

## Code map

```
server/                 Backend (Node/Express, ESM)
├── index.js            Express bootstrap: static public/ + mount /api
├── routes.js           API endpoints (see API section)
├── k6-runner.js        Write script to a temp folder, spawn `k6 run`, parse output → events
└── generator/          JSON configuration → k6 script source (string)
    ├── index.js        generateScript() — orchestration
    ├── options.js      k6 options object (VUs/stages + thresholds)
    ├── request.js      Code block for one HTTP request
    ├── assertions.js   check() block from per-request assertions
    ├── extract.js      Variable extraction from responses
    ├── interpolate.js  {{varName}} interpolation → template literals
    └── helpers.js      JSON selectors & regex literals

public/                 Static frontend (ES modules, no bundler)
├── index.html          All markup: sidebar + one <section> per view
├── css/style.css       All styling
└── js/
    ├── app.js          Entry point: event wiring + initial render
    ├── nav.js          View switching
    ├── dom.js          $ / $$ helpers
    ├── config.js       Read the form → config object + validation
    ├── curl-parse.js   Parse a cURL command → { method, url, headers, body }
    ├── curl-import.js  "Import from cURL" modal: parse + fill a request card
    ├── runner.js       POST /api/run, parse the SSE stream, render logs/table/metrics
    ├── project-io.js   Save/load projects (JSON file = config object)
    └── components/
        ├── req-card.js  Request card: Headers/Body/Extract/Assertions/Options tabs + pre/post sub-requests
        ├── rows.js      Header & extraction form rows
        ├── counts.js    Extraction/assertion count badges + card renumbering
        └── flow-view.js "Main Scenario" zone + load-profile stage rows
```

## Data flow

UI form → `collectConfig()` (js/config.js) → `POST /api/generate` or `/api/run`
→ `generateScript()` (server/generator) → [run only] `k6-runner.js` spawns k6
→ SSE events → `js/runner.js` renders the live log, request detail table, and metrics.

## API

| Endpoint | Body | Response |
|---|---|---|
| `GET /api/k6-status` | — | `{ installed, version? }` |
| `POST /api/generate` | config object | `{ script }` or 400 `{ error }` |
| `POST /api/run` | config object | SSE stream (events below) |

SSE events from `/api/run`: `status` (progress), `log` (raw k6 output line), `req-log`
(single request detail, max 500/run), `error`, `done` (`{ code, summary }` — summary
from `k6 --summary-export`). Exit code 0 = all thresholds met; 99 = thresholds failed.

## Configuration object schema

The same object is used for `/api/generate`, `/api/run`, and project save files.

```jsonc
{
  "scenario": { "requests": [ /* request, see below */ ] },
  "variables": [{ "key": "base_url", "value": "https://api.example.com" }],
  // global variables, usable as {{base_url}} in any url/header/body;
  // keys must be valid JS identifiers ([A-Za-z_]\w*) — others are ignored
  "globalHeaders": [{ "key": "Accept", "value": "application/json" }],
  // headers merged into every request (incl. pre/post); a request-level
  // header with the same name (case-insensitive) overrides the global one
  "load": { "mode": "simple", "vus": "10", "duration": "30s" },
  // or: { "mode": "stages", "stages": [{ "duration": "30s", "target": "20" }] }
  "thresholds": { "p95": "500", "errorRate": "1" },   // empty string = unused
  "options": { "logRequests": true }                   // enables req-log events
}
```

Shape of one request:

```jsonc
{
  "type": "http",                // "http" (default) or "grpc"
  "method": "GET",
  "url": "https://api.example.com/{{id}}",
  // gRPC requests: url = "host:port", body = request message JSON,
  // headers = metadata, plus:
  "grpcMethod": "",              // "package.Service/Method"
  "grpcPlaintext": false,        // true = connect without TLS
  "headers": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
  "body": "",                    // only used for POST/PUT/PATCH/DELETE
  "checkStatus": true,           // add the automatic 2xx status check
  "sleepAfter": "1",             // seconds to pause after the request
  "extractions": [{ "varName": "token", "source": "json", "selector": "data.token" }],
  // source: "json" (JSON path), "header" (header name), "regex" (1st capture group)
  "assertions": [{ "type": "status-eq", "value": "200", "value2": "" }],
  "preScript":  "vars.ts = Date.now();",              // JS inlined before the request
  "postScript": "vars.id = JSON.parse(res.body).id;", // JS inlined after it; `res` = response
  "pre":  null,   // "Before" sub-request: same shape, but without assertions/pre/post
  "post": null    // "After" sub-request: same
}
```

- `{{varName}}` interpolation in url/headers/body uses global variables, values extracted by earlier requests, and `vars.<name>` assignments made by earlier pre/post-processor scripts (precedence: extracted > processor > global); unknown names are left as literal text.
- Pre/post-processor scripts are inlined as `{ ... }` blocks (post gets the response as `const res`) and share a per-iteration `vars` object. Referencing `crypto.` or `encoding.` in a script auto-adds the `k6/crypto` / `k6/encoding` import. Execution order per request: pre sub-request → pre-processor → request (+ check/extract) → assertions → post-processor → post sub-request. Scripts are syntax-checked at generate time (`new Function`) — invalid code returns a 400 with the request number.
- gRPC requests (`type: "grpc"`) generate `k6/net/grpc` unary calls with server reflection (`reflect: true` — the target server must support it; .proto upload is not implemented). The automatic check compares against `grpc.StatusOK`; extractions read the decoded `res.message`; assertions are remapped for gRPC (statuses = gRPC codes, body = `JSON.stringify(message)`, `duration-lt` is skipped). Pre/post sub-requests stay HTTP.
- Assertion type list: `ASSERT_TYPES` in `public/js/components/req-card.js` — **must stay in sync** with the switch in `server/generator/assertions.js`.

## Conventions

- UI text, code comments, and error messages: English.
- Kebab-case file names; the frontend stays vanilla JS (do not add a framework/bundler unless asked).
- Sidebar items marked "Soon" are placeholders for unimplemented features.

## Verification (no automated tests)

1. `node --check` every changed JS file.
2. `npm start`, then `curl localhost:3000/api/k6-status` and `curl -X POST localhost:3000/api/generate` with a sample configuration.
3. Open the UI: enter a URL → "View Script" → "Run Test" (short duration, localhost target).
