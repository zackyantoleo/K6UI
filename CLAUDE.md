# K6UI — Project Guide

A web UI for building and running [k6](https://k6.io) load tests without writing code.
Stack: Express (ESM) + vanilla JS frontend. **No build step, no framework.** Tests use Node's
built-in runner (`npm test`); browser checks live in `scripts/` (see Verification).

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
├── generator/          JSON configuration → k6 script source (string)
│   ├── index.js        generateScript() — orchestration
│   ├── options.js      k6 options object (VUs/stages/per-vu-iterations scenario + thresholds)
│   ├── request.js      Code block for one HTTP request
│   ├── assertions.js   check() block from per-request assertions
│   ├── extract.js      Variable extraction from responses
│   ├── interpolate.js  {{varName}} interpolation → template literals
│   └── helpers.js      JSON selectors & regex literals
└── importer/           k6 script source → JSON configuration + warnings (reverse of generator/)
    ├── index.js        importK6Script() — acorn parse (never executes the script), imports, top-level consts
    ├── values.js       Static evaluation; textOf() renders expressions as text with {{var}} placeholders
    ├── options.js      `options` → load profile (VUs/duration, stages, one per-vu-iterations scenario) + thresholds (p95 / error rate only)
    ├── request.js      http.* calls → request (URL, headers, JSON/form body, tags.name → name)
    ├── checks.js       check() predicates → assertions (same set as generator/assertions.js)
    ├── flow.js         Default function walk: groups, sleep, extractions created on first use
    └── jmx/            JMeter .jmx → JSON configuration + warnings (same warning shape)
        ├── index.js    importJmx() — thread group pick, hashTree walk, JMeter scope rules, pauses
        ├── xml.js      Minimal XML parser with line numbers (no DOCTYPE, so no external entities)
        ├── props.js    JMeter property readers; ${var} → {{var}}, ${__P(name,default)} → global variable
        ├── load.js     ThreadGroup / ConcurrencyThreadGroup → load profile (fixed loop count → iterations mode)
        ├── sampler.js  HTTP Request (+ HTTP Request Defaults, Header Manager) → request
        └── rules.js    Response/Duration Assertion, JSON/Regex/Boundary Extractor, timers

public/                 Static frontend (ES modules, no bundler)
├── index.html          All markup: sidebar (Simple steps + Advanced categories) + one <section> per view
├── css/style.css       All styling
└── js/
    ├── app.js          Entry point: event wiring + initial render
    ├── ui-mode.js      Simple / Advanced layout switch (presentation only, see docs/ui-modes.md)
    ├── nav.js          View switching
    ├── dom.js          $ / $$ helpers
    ├── config.js       Read the form → config object + validation
    ├── project-store.js Versioned (schema v2), frozen project snapshot + migration
    ├── curl-parse.js   Parse a cURL command → { method, url, headers, body }
    ├── curl-import.js  "Import from cURL" modal: parse + fill a request card
    ├── runner.js       POST /api/run, parse the SSE stream, render logs/table/metrics
    ├── project-io.js   Save/load projects (JSON file = config object)
    ├── script-import.js "Import k6 script / JMeter .jmx" modal: text starting with "<" → POST /api/import-jmx, else /api/import-script; applyConfig, list warnings
    └── components/
        ├── req-card.js        Request card: lazy editor tabs + pre/post sub-requests
        ├── request-editor/    One module per editor tab (headers, body, extract, checks, scripts, advanced)
        ├── request-groups.js  One-level request groups with shared header defaults
        ├── flow-outline.js    Advanced: outline in execution order that selects the canonical card/group
        ├── advanced-notice.js Simple: "Advanced settings configured" notice (categories + counts only)
        ├── rows.js            Header & extraction form rows
        ├── counts.js          Count badges, renumbering, flow-changed events, focus after removal
        └── flow-view.js       "Main Scenario" zone + load-profile stage rows
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
| `POST /api/import-script` | `{ script }` (k6 source) | `{ config, warnings: [{ line, message }] }` or 400 `{ error, warnings }` |
| `POST /api/import-jmx` | raw .jmx XML (`Content-Type: application/xml`, ≤ 10 MB) | same as `/api/import-script` |
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
  // or: { "mode": "iterations", "vus": "5", "iterations": "2", "maxDuration": "1h" }
  //     every VU starts at once and runs the flow `iterations` times, then stops
  //     (k6 `per-vu-iterations` scenario); maxDuration is optional, default "1h"
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
- Assertion type list: `ASSERT_TYPES` in `public/js/components/request-editor/checks.js` — **must stay in sync** with the switch in `server/generator/assertions.js` and the recognized shapes in `server/importer/checks.js`.
- Script import (`importK6Script`) is a best-effort reverse of the generator: it reads straight-line request flows, never runs the script, and reports everything it skips as warnings. Imported requests start with `checkStatus: false` unless the script has K6UI's own 2xx/3xx check. Scripts written by K6UI import back to the same flow (covered by `test/script-import.test.js`), except pre/post scripts, Before/After sub-requests and gRPC, which come back as plain requests or warnings. When the generator gains a new construct, teach the importer the same shape (e.g. a single `per-vu-iterations` scenario in `options.scenarios` imports as iterations mode; other scenarios are skipped with a warning).
- JMeter import (`importJmx`) reads the first enabled thread group (setUp/tearDown and further thread groups become warnings) and follows JMeter scope: config elements, timers, assertions and extractors apply to every request at their level and below. Header Managers at test plan / thread group level → `globalHeaders`; a controller directly under the thread group → request group (deeper controllers are merged into it); other Header Managers → request headers. Requests keep JMeter's failure rule via `checkStatus: true` unless a Response Assertion has "Ignore status". Timers pause *before* a request, so the pause is added to the previous request's `sleepAfter` (the first request's wraps to the last). Variable names are renamed to valid, non-reserved identifiers everywhere they appear. A thread group with a fixed loop count and no scheduler duration ("N loops per user") becomes `{ mode: "iterations", vus: <threads>, iterations: <loops> }`; its ramp-up is not supported there (all VUs start at once, with a warning when more than one user ramps up). Forever loops, scheduler durations and Concurrency Thread Groups keep the duration/stages profile.

## Conventions

- UI text, code comments, and error messages: English.
- Kebab-case file names; the frontend stays vanilla JS (do not add a framework/bundler unless asked).
- Simple and Advanced are two layouts over one DOM: never clone, move, or re-render request cards per mode, and never store the mode in project data (rules in `docs/ui-modes.md`).
- Render project data (names, URLs, labels) with `textContent`, never `innerHTML`.

## Verification

1. `npm test` (Node's built-in runner; the run test uses a fake `k6`).
2. `node --check` every changed JS file and `git diff --check`.
3. UI changes: `PLAYWRIGHT_MODULE=file:///path/to/playwright/index.mjs node scripts/verify-ui-modes.mjs`
   — the full browser check for both modes, including the older stage checks. It needs Playwright and `k6`, and only
   talks to servers it starts on `127.0.0.1`.
4. Performance-sensitive changes: `npm run measure:baseline` and compare with `docs/baseline-performance.md`.
