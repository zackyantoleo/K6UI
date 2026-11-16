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
│   ├── data.js         Data files (CSV) → SharedArray literal + the row of each iteration, size limits
│   └── helpers.js      JSON selectors & regex literals
└── importer/           k6 script source → JSON configuration + warnings (reverse of generator/)
    ├── index.js        importK6Script() — acorn parse (never executes the script), imports, top-level consts
    ├── values.js       Static evaluation; textOf() renders expressions as text with {{var}} placeholders
    ├── options.js      `options` → load profile (VUs/duration, stages, one per-vu-iterations scenario) + thresholds (p95 / error rate only)
    ├── request.js      http.* calls → request (URL, headers, JSON/form body, tags.name → name)
    ├── checks.js       check() predicates → assertions (same set as generator/assertions.js)
    ├── flow.js         Default function walk: groups, sleep, extractions created on first use (warns about SharedArray data files; `DATA_n_ROW.col` → `{{col}}`)
    └── jmx/            JMeter .jmx → JSON configuration + warnings (same warning shape)
        ├── index.js    importJmx() — thread group pick, hashTree walk, JMeter scope rules, pauses
        ├── xml.js      Minimal XML parser with line numbers (no DOCTYPE, so no external entities)
        ├── props.js    JMeter property readers; ${var} → {{var}}, ${__P(name,default)} → global variable
        ├── load.js     ThreadGroup / ConcurrencyThreadGroup → load profile (fixed loop count → iterations mode)
        ├── sampler.js  HTTP Request (+ HTTP Request Defaults, Header Manager) → request
        ├── data.js     CSV Data Set Config → data file (no rows: a .jmx only names the file), column/extraction clash warning
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
    ├── project-store.js Versioned (schema v2), frozen project snapshot + migration (incl. `dataSets` normalization)
    ├── csv-parse.js    CSV reader + data-file limits, shared by the Data files panel and server/generator/data.js (pure, no DOM)
    ├── data-files.js   "Data files" view (Data & Rules): data file cards, preview, validation; state lives on each card
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
        ├── advanced-notice.js Simple: "Advanced settings configured" notice (categories + counts only, incl. Data files)
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
| `POST /api/generate` | config object (≤ 24 MB, to carry data files) | `{ script }`, 400 `{ error }`, or 413 `{ error }` (data file or body too big) |
| `POST /api/import-script` | `{ script }` (k6 source) | `{ config, warnings: [{ line, message }] }` or 400 `{ error, warnings }` |
| `POST /api/import-jmx` | raw .jmx XML (`Content-Type: application/xml`, ≤ 10 MB) | same as `/api/import-script` |
| `POST /api/run` | config object (≤ 24 MB) | SSE stream (events below), or the same 400 / 413 JSON before it starts |

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
  "dataSets": [{                       // CSV data files, optional (default []): one row per iteration
    "id": "ds_login", "name": "Users", "fileName": "login.csv",
    "delimiter": ",",                  // one character; "\t" = tab
    "skipHeader": true,                // the first row is a header, not data
    "columns": ["email", "password"],  // column i of the file → {{email}}; [A-Za-z_]\w* only, blank skips a column;
                                       // empty list + skipHeader = names from the header
    "content": "email,password\nuser1@example.com,pass1\n",  // the CSV text itself (≤ 5 MB per file, 10 MB total)
    "share": "next-row",               // "next-row" (default): exec.scenario.iterationInTest, shared by all VUs; "per-vu": __VU - 1
    "onEnd": "recycle"                 // "recycle" (default): wrap around; "stop": end the iteration early, one log line
  }],
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

- `{{varName}}` interpolation in url/headers/body uses global variables, data file columns, values extracted by earlier requests, and `vars.<name>` assignments made by earlier pre/post-processor scripts (precedence: extracted > processor > data column > global); unknown names are left as literal text. A column and an extraction with the same name therefore read the file until the extracting request has run, and the extracted value after it.
- Data files (`dataSets`, `server/generator/data.js`) embed the rows in the script as `new SharedArray(...)` built from a JSON literal (imports `k6/data` and `k6/execution` only when a data set is used), so View Script and a standalone run need no extra file and `k6-runner.js` is untouched. At the start of the default function each data set picks its row `DATA_n_ROW` (`next-row`: `exec.scenario.iterationInTest`; `per-vu`: `__VU - 1`; `recycle` = modulo; `stop` = `return` after a `sleep(1)` so duration tests do not spin, with one `console.warn`: once for the whole test with `next-row`, once per VU with `per-vu`). Rows are read for every iteration, whether or not the requests that use them run. A data set with no content, no rows, or no valid column is ignored (its `{{placeholders}}` stay literal text); the first data set that has a column name wins. A file over 5 MB (or 10 MB in total) is a 413, an unclosed quote a 400. `express.json` takes 24 MB on `/api/generate` and `/api/run` only; the import endpoints keep 1 MB. The CSV reader (`public/js/csv-parse.js`: quotes, delimiter, CRLF, BOM, empty lines) is shared with the UI so the preview and the script always count the same rows. Needs k6 with `k6/execution` (v0.38+). The data is saved in the project file and written into the script, so a file with credentials makes both sensitive.
- `iterationInTest` is unique per iteration across all VUs of the scenario, also for the `per-vu-iterations` scenario of iterations mode (checked with k6 v2.4.0 in `test/data-files-k6.test.js`, which skips when `k6` is missing): 5 VUs x 1 iteration over 5 rows reads 5 different rows.
- Pre/post-processor scripts are inlined as `{ ... }` blocks (post gets the response as `const res`) and share a per-iteration `vars` object. Referencing `crypto.` or `encoding.` in a script auto-adds the `k6/crypto` / `k6/encoding` import. Execution order per request: pre sub-request → pre-processor → request (+ check/extract) → assertions → post-processor → post sub-request. Scripts are syntax-checked at generate time (`new Function`) — invalid code returns a 400 with the request number.
- gRPC requests (`type: "grpc"`) generate `k6/net/grpc` unary calls with server reflection (`reflect: true` — the target server must support it; .proto upload is not implemented). The automatic check compares against `grpc.StatusOK`; extractions read the decoded `res.message`; assertions are remapped for gRPC (statuses = gRPC codes, body = `JSON.stringify(message)`, `duration-lt` is skipped). Pre/post sub-requests stay HTTP.
- Assertion type list: `ASSERT_TYPES` in `public/js/components/request-editor/checks.js` — **must stay in sync** with the switch in `server/generator/assertions.js` and the recognized shapes in `server/importer/checks.js`.
- Script import (`importK6Script`) is a best-effort reverse of the generator: it reads straight-line request flows, never runs the script, and reports everything it skips as warnings. Imported requests start with `checkStatus: false` unless the script has K6UI's own 2xx/3xx check. Scripts written by K6UI import back to the same flow (covered by `test/script-import.test.js`), except pre/post scripts, Before/After sub-requests and gRPC, which come back as plain requests or warnings. When the generator gains a new construct, teach the importer the same shape (e.g. a single `per-vu-iterations` scenario in `options.scenarios` imports as iterations mode; other scenarios are skipped with a warning). A `SharedArray` / `k6/data` import is not rebuilt into a data file: it is a warning, except that K6UI's own `DATA_n_ROW.column` references come back as `{{column}}`.
- JMeter import (`importJmx`) reads the first enabled thread group (setUp/tearDown and further thread groups become warnings) and follows JMeter scope: config elements, timers, assertions and extractors apply to every request at their level and below. Header Managers at test plan / thread group level → `globalHeaders`; a controller directly under the thread group → request group (deeper controllers are merged into it); other Header Managers → request headers. Requests keep JMeter's failure rule via `checkStatus: true` unless a Response Assertion has "Ignore status". Timers pause *before* a request, so the pause is added to the previous request's `sleepAfter` (the first request's wraps to the last). Variable names are renamed to valid, non-reserved identifiers everywhere they appear. A thread group with a fixed loop count and no scheduler duration ("N loops per user") becomes `{ mode: "iterations", vus: <threads>, iterations: <loops> }`; its ramp-up is not supported there (all VUs start at once, with a warning when more than one user ramps up). Forever loops, scheduler durations and Concurrency Thread Groups keep the duration/stages profile. A `CSVDataSet` becomes a data file (`jmx/data.js`): `variableNames` → `columns` (renamed like other variables), `ignoreFirstLine` → `skipHeader`, `delimiter` (`\t` = tab), `shareMode.all` → `next-row` and any other share mode → `per-vu` (with a warning), `recycle` → `recycle` and otherwise `stop`; `${FILE_VAR}` file names resolve through User Defined Variables. A .jmx has no rows, so it is imported with empty `content` and a warning to upload the file; another warning names a column that is also extracted by a request, and one flags a data set inside a controller (its row is read every iteration).

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
