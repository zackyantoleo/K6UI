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
├── export-collector.js "Save to CSV" rows logged by the script → batched `export` events (memory only, size limits)
├── generator/          JSON configuration → k6 script source (string)
│   ├── index.js        generateScript() — orchestration
│   ├── options.js      k6 options object (VUs/stages/per-vu-iterations scenario + thresholds)
│   ├── request.js      Code block for one HTTP request
│   ├── assertions.js   check() block from per-request assertions
│   ├── extract.js      Variable extraction from responses; an extraction `default` → `extractOr(() => read, "default")`
│   ├── interpolate.js  {{varName}} interpolation → template literals
│   ├── data.js         Data files (CSV) → SharedArray literal + the row of each iteration (or of a group's start), size limits
│   ├── run-if.js       A group's "run only if" condition → the `if (...)` expression, 400 for a condition that cannot work
│   ├── csv-export.js   "Save to CSV" exports → one `console.log` row after the request, 400 for an export that cannot work
│   └── helpers.js      JSON selectors, regex literals & `jsLiteral()` (string literal, U+2028/U+2029 escaped)
└── importer/           k6 script source → JSON configuration + warnings (reverse of generator/)
    ├── index.js        importK6Script() — acorn parse (never executes the script), imports, top-level consts
    ├── values.js       Static evaluation; textOf() renders expressions as text with {{var}} placeholders
    ├── options.js      `options` → load profile (VUs/duration, stages, one per-vu-iterations scenario) + thresholds (p95 / error rate only)
    ├── request.js      http.* calls → request (URL, headers, JSON/form body, tags.name → name)
    ├── checks.js       check() predicates → assertions (same set as generator/assertions.js)
    ├── flow.js         Default function walk: groups, sleep, extractions created on first use (`x || "text"` / `?? "text"` and K6UI's `extractOr()` → `default`; warns about SharedArray data files; `DATA_n_ROW.col` → `{{col}}`)
    ├── run-if.js       K6UI's own `if (...) { ... }` around a conditional group → that group with its `runIf` (any other `if` is skipped with a warning)
    └── jmx/            JMeter .jmx → JSON configuration + warnings (same warning shape)
        ├── index.js    importJmx() — thread group pick, hashTree walk, JMeter scope rules, pauses
        ├── xml.js      Minimal XML parser with line numbers (no DOCTYPE, so no external entities)
        ├── props.js    JMeter property readers; ${var} → {{var}}, ${__P(name,default)} → global variable
        ├── load.js     ThreadGroup / ConcurrencyThreadGroup → load profile (fixed loop count → iterations mode)
        ├── sampler.js  HTTP Request (+ HTTP Request Defaults, Header Manager) → request
        ├── data.js     CSV Data Set Config → data file (no rows: a .jmx only names the file; `groupId` of the group it sits in), column/extraction clash warning
        ├── condition.js If Controller condition → a group's `runIf`: tokenized and matched against known shapes, never evaluated
        └── rules.js    Response/Duration Assertion, JSON/Regex/Boundary Extractor (Default Value → `default`), JSR223/BeanShell post-processor warning, timers

public/                 Static frontend (ES modules, no bundler)
├── index.html          All markup: sidebar (Simple steps + Advanced categories) + one <section> per view
├── css/style.css       All styling
└── js/
    ├── app.js          Entry point: event wiring + initial render
    ├── ui-mode.js      Simple / Advanced layout switch (presentation only, see docs/ui-modes.md)
    ├── nav.js          View switching
    ├── dom.js          $ / $$ helpers
    ├── config.js       Read the form → config object + validation
    ├── project-store.js Versioned (schema v2), frozen project snapshot + migration (incl. `dataSets` normalization, `runIf`, data set `groupId`, extraction `default`)
    ├── run-if.js       A group's "run only if" condition: validation, normalization, wording. Shared by the store, the group editor, the outline and server/generator/run-if.js (pure, no DOM)
    ├── csv-parse.js    CSV reader + data-file limits, shared by the Data files panel and server/generator/data.js (pure, no DOM)
    ├── csv-export.js   "Save to CSV": normalization, validation, limits, CSV writer, download name. Shared by the store, the editor, the results panel, server/generator/csv-export.js and server/export-collector.js (pure, no DOM)
    ├── export-results.js Run & Results "Saved to CSV": rows of `export` events (this tab's memory only), Download CSV, Use as data file
    ├── data-files.js   "Data files" view (Data & Rules): data file cards, preview, validation; state lives on each card; `useAsDataFile()` for saved rows
    ├── curl-parse.js   Parse a cURL command → { method, url, headers, body }
    ├── curl-import.js  "Import from cURL" modal: parse + fill a request card
    ├── runner.js       POST /api/run, parse the SSE stream, render logs/table/metrics
    ├── project-io.js   Save/load projects (JSON file = config object)
    ├── script-import.js "Import k6 script / JMeter .jmx" modal: text starting with "<" → POST /api/import-jmx, else /api/import-script; applyConfig, list warnings
    └── components/
        ├── req-card.js        Request card: lazy editor tabs + pre/post sub-requests
        ├── request-editor/    One module per editor tab (headers, body, extract, checks, scripts, advanced)
        ├── request-groups.js  One-level request groups with shared header defaults and a "Run only if" row (head badge + editor, `requestGroupProblem()` for validation)
        ├── flow-outline.js    Advanced: outline in execution order that selects the canonical card/group (a group shows its condition)
        ├── advanced-notice.js Simple: "Advanced settings configured" notice (categories + counts only, incl. Conditional groups and Data files)
        ├── rows.js            Header & extraction form rows (`extractionRow(extraction)` / `readExtractionRow(row)`, incl. the optional Default)
        ├── export-rows.js     "Save to CSV" blocks of the Extract tab (`exportBlock(exp)` / `readExportBlock(block)`)
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
(single request detail, max 500/run), `export` ("Save to CSV" rows: `{ file, columns, rows, truncated }`,
batched, all sent before `done`), `error`, `done` (`{ code, summary }` — summary
from `k6 --summary-export`). Exit code 0 = all thresholds met; 99 = thresholds failed.

## Configuration object schema

The same object is used for `/api/generate`, `/api/run`, and project save files.

```jsonc
{
  "scenario": {
    "groups": [{                       // optional (default []): one level, requests join through their groupId
      "id": "grp_order", "name": "Order flow", "enabled": true, "collapsed": false,
      "headers": [{ "key": "X-Service", "value": "orders" }],
      "runIf": {                       // optional; absent or null = always runs
        "variable": "EXECUTION_MODE",  // [A-Za-z_]\w*, read like {{EXECUTION_MODE}} when the group starts
        "operator": "one-of",          // "equals" | "not-equals" (one value) | "one-of" (one or more)
        "values": ["ORDER_FLOW", "ALL"]  // compared as strings, case-sensitive
      }
    }],
    "requests": [ /* request, see below; "groupId": "grp_order" puts it in a group */ ]
  },
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
    "onEnd": "recycle",                // "recycle" (default): wrap around; "stop": end the iteration early, one log line
    "groupId": "grp_order"             // optional: read the row, and apply "stop", only when this group starts (absent or "" = every iteration)
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
  "extractions": [{ "varName": "token", "source": "json", "selector": "data.token", "default": "TOKEN_NOT_FOUND" }],
  // source: "json" (JSON path), "header" (header name), "regex" (1st capture group)
  // default: optional fixed text used when nothing matches (absent or "" = none, see below)
  "exports": [{                  // optional "Save to CSV": after the request, add a row to a CSV file of the run
    "file": "orders_created.csv",  // file name (no / or \, ≤ 120 chars); one file keeps one set of columns
    "columns": [{ "name": "order_number", "value": "{{order_number}}" }, { "name": "auth", "value": "Bearer {{token}}" }],
    "skipMissing": true            // skip the row while an extracted value it uses is empty or still its default
  }],
  "assertions": [{ "type": "status-eq", "value": "200", "value2": "" }],
  "preScript":  "vars.ts = Date.now();",              // JS inlined before the request
  "postScript": "vars.id = JSON.parse(res.body).id;", // JS inlined after it; `res` = response
  "pre":  null,   // "Before" sub-request: same shape, but without assertions/pre/post
  "post": null    // "After" sub-request: same
}
```

- `{{varName}}` interpolation in url/headers/body uses global variables, data file columns, values extracted by earlier requests, and `vars.<name>` assignments made by earlier pre/post-processor scripts (precedence: extracted > processor > data column > global); unknown names are left as literal text. A column and an extraction with the same name therefore read the file until the extracting request has run, and the extracted value after it.
- Data files (`dataSets`, `server/generator/data.js`) embed the rows in the script as `new SharedArray(...)` built from a JSON literal (imports `k6/data` and `k6/execution` only when a data set is used), so View Script and a standalone run need no extra file and `k6-runner.js` is untouched. At the start of the default function each data set picks its row `DATA_n_ROW` (`next-row`: `exec.scenario.iterationInTest`; `per-vu`: `__VU - 1`; `recycle` = modulo; `stop` = `return` after a `sleep(1)` so duration tests do not spin, with one `console.warn`: once for the whole test with `next-row`, once per VU with `per-vu`). A global data set (no `groupId`) reads its row for every iteration, whether or not the requests that use it run; a data set tied to a group is read only when that group starts (see the conditional groups bullet). A data set with no content, no rows, or no valid column is ignored (its `{{placeholders}}` stay literal text); the first data set that has a column name wins. A file over 5 MB (or 10 MB in total) is a 413, an unclosed quote a 400. `express.json` takes 24 MB on `/api/generate` and `/api/run` only; the import endpoints keep 1 MB. The CSV reader (`public/js/csv-parse.js`: quotes, delimiter, CRLF, BOM, empty lines) is shared with the UI so the preview and the script always count the same rows. Needs k6 with `k6/execution` (v0.38+). The data is saved in the project file and written into the script, so a file with credentials makes both sensitive.
- `iterationInTest` is unique per iteration across all VUs of the scenario, also for the `per-vu-iterations` scenario of iterations mode (checked with k6 v2.4.0 in `test/data-files-k6.test.js`, which skips when `k6` is missing): 5 VUs x 1 iteration over 5 rows reads 5 different rows.
- Conditional groups (`runIf`, `server/generator/run-if.js` + `public/js/run-if.js`): a group's requests are wrapped in `if (...) { ... }` in the default function. The condition is data, never free JavaScript. The variable is read by the same precedence as `{{variable}}` (extracted > processor > data column > global) **when the group starts**, and values are compared as strings (`String(x) === "A"`, `!==`, or `["A","B"].includes(String(x))`; case-sensitive). The condition is checked once per *run* of the group: requests of one group that are not next to each other (Auth, Checkout, Auth) are separate runs, each with its own `if`. A variable that is not known when the group starts (not global, not a column of a file outside this group, not extracted or assigned by an earlier request) is a **400** naming the group and the variable, as is a condition that cannot work (bad name, operator or values); the UI blocks Run / View Script for a half-typed row. The block is not re-indented (a request body can hold raw newlines inside a template literal), so the generated `if` looks flat. Everything of a request stays inside it: Before/After requests, processors, assertions, request log, `sleep`, gRPC.
  - Variables hoisted out of the block: names extracted by the group's requests (main, Before, After) that are not declared yet get `let name = "";` above the `if` — or `let name = "<default>";` when an extraction of that name in the run has a default (the first one, in Before → main → After order) — so a request after the group can still use `{{name}}`; inside, they are assigned, never re-declared. The *precedence* rule is unchanged (a name counts as extracted only after the request that extracts it, in generate order). When the group does not run the value stays at that default, else `""`; a name already extracted before the group is not hoisted again and keeps its earlier value. Names a processor script assigns to `vars` inside the group start as `""` outside it.
  - Data files of a group (`groupId`): the row variable is declared up front (`let DATA_n_ROW = { column: "", ... }`), and the row is chosen, and `stop` applied (an early `return`), at the start of the group's run, inside the `if` when there is one. A data file of a **turned-off** group is not used at all (no SharedArray, no size-limit count, its `{{columns}}` stay literal text); a `groupId` that points nowhere means global. The row is picked by `exec.scenario.iterationInTest` (or `__VU - 1`), so the row index follows the iteration number, **not** how many times the group ran: if the condition holds in only some iterations, rows are skipped.
  - Importing: JMeter `IfController` directly under the thread group → a group with `runIf` (see the JMeter bullet); K6UI's own generated `if` is read back by `importer/run-if.js` (the group name comes from the `// Group "…" runs only if` comment above it); any other `if` in a k6 script is skipped with a warning that its requests were left out.
- Extraction defaults (`default`, `server/generator/extract.js`): fixed text only, never an expression. Without one (absent or `""`) the generated line is exactly as before: a regex with no match gives `""`, a missing JSON path or header gives `undefined`, and a body that is not JSON throws (k6 ends the iteration). With one, the read is wrapped in `extractOr(() => <read>, "<default>")`, a helper written once above the default function only when an extraction that runs has a default: the default is used when the read gives `undefined` or `null` or throws (missing path or header, no regex match, a body that is not JSON, no body). A match that is `""`, `0` or `false` is kept. The same default is the value a skipped conditional group leaves behind (see above). A number or boolean default in a project or API payload is read as text; strings are kept as typed (not trimmed), including in the UI, where an empty input means no default. Importing: JMeter's "Default Value" of JSON (`defaultValues`, one per variable, `;`-separated), Regex and Boundary extractors becomes `default`; an empty one, or one with `${...}` (a warning), gives none. In a k6 script, `x || "text"` and `x ?? "text"` (string, number or plain template literal) on a value read from a response become the default (`|| ""` stays "no default"; with nested fallbacks the inner one wins, as in JavaScript), as does K6UI's own `extractOr(...)` when the script declares the `extractOr` helper. JSR223 / BeanShell post-processors (custom fallback logic) are never imported: the warning names the variables they `vars.put`.
- Save to CSV (`exports`, `server/generator/csv-export.js` + `public/js/csv-export.js`): k6 cannot write files, so after the request (after its After request too) the script logs one row: `console.log(JSON.stringify({ k6uiExport: "<file>", columns: [...], row: [...] }))`, the values interpolated like a URL. `k6-runner.js` hands every console line that starts with `{"k6uiExport":` to `server/export-collector.js` and never to the live log (a broken one is dropped too, since it may hold a token). The collector keeps the rows in memory only, at most 5 MB of CSV per file, 10 MB in total and 10 files (later rows are dropped and the file is marked `truncated`), and sends them as `export` events every 250 ms and before `done`, so a stopped run keeps what reached the browser. The browser (`public/js/export-results.js`) keeps them in the tab until the next run, offers Download CSV (a Blob, nothing goes back to the server) and Use as data file (`useAsDataFile()`: fills the data file with that file name, for example the empty one a .jmx import created, after a confirm when it already has other rows, or adds one; header row on). `skipMissing` wraps the line in `if (![undefined, null, "", <every default of that extraction>].includes(name) && ...)` over the extracted variables the columns use; with none it has no effect and imports back as `false`. Column names are `[A-Za-z_]\w*` (they become `{{columns}}` of a data file), unique; two requests saving to one file must use the same columns; an export that breaks a rule is a 400 naming the request (and the UI reports it before Run). Turned-off requests and groups save nothing, a skipped conditional group saves no row. The k6 importer reads K6UI's own line (and its `if`) back into `exports`; the JMeter importer never translates a JSR223 post-processor that writes a file (Groovy), its warning points to Save to CSV.
- Pre/post-processor scripts are inlined as `{ ... }` blocks (post gets the response as `const res`) and share a per-iteration `vars` object. Referencing `crypto.` or `encoding.` in a script auto-adds the `k6/crypto` / `k6/encoding` import. Execution order per request: pre sub-request → pre-processor → request (+ check/extract) → assertions → post-processor → post sub-request. Scripts are syntax-checked at generate time (`new Function`) — invalid code returns a 400 with the request number.
- gRPC requests (`type: "grpc"`) generate `k6/net/grpc` unary calls with server reflection (`reflect: true` — the target server must support it; .proto upload is not implemented). The automatic check compares against `grpc.StatusOK`; extractions read the decoded `res.message`; assertions are remapped for gRPC (statuses = gRPC codes, body = `JSON.stringify(message)`, `duration-lt` is skipped). Pre/post sub-requests stay HTTP.
- Assertion type list: `ASSERT_TYPES` in `public/js/components/request-editor/checks.js` — **must stay in sync** with the switch in `server/generator/assertions.js` and the recognized shapes in `server/importer/checks.js`.
- Script import (`importK6Script`) is a best-effort reverse of the generator: it reads straight-line request flows, never runs the script, and reports everything it skips as warnings. Imported requests start with `checkStatus: false` unless the script has K6UI's own 2xx/3xx check. Scripts written by K6UI import back to the same flow (covered by `test/script-import.test.js`), except pre/post scripts, Before/After sub-requests and gRPC, which come back as plain requests or warnings. When the generator gains a new construct, teach the importer the same shape (e.g. a single `per-vu-iterations` scenario in `options.scenarios` imports as iterations mode; other scenarios are skipped with a warning). A `SharedArray` / `k6/data` import is not rebuilt into a data file: it is a warning, except that K6UI's own `DATA_n_ROW.column` references come back as `{{column}}`. An `if` is skipped with a warning that its requests were left out, except the exact shape the generator writes for a "Run only if" group (no `else`, not inside `group()`), which comes back as a group with that `runIf`.
- JMeter import (`importJmx`) reads the first enabled thread group (setUp/tearDown and further thread groups become warnings) and follows JMeter scope: config elements, timers, assertions and extractors apply to every request at their level and below. Header Managers at test plan / thread group level → `globalHeaders`; a controller directly under the thread group → request group (deeper controllers are merged into it); other Header Managers → request headers. Requests keep JMeter's failure rule via `checkStatus: true` unless a Response Assertion has "Ignore status". Timers pause *before* a request, so the pause is added to the previous request's `sleepAfter` (the first request's wraps to the last). Variable names are renamed to valid, non-reserved identifiers everywhere they appear. A thread group with a fixed loop count and no scheduler duration ("N loops per user") becomes `{ mode: "iterations", vus: <threads>, iterations: <loops> }`; its ramp-up is not supported there (all VUs start at once, with a warning when more than one user ramps up). Forever loops, scheduler durations and Concurrency Thread Groups keep the duration/stages profile. A `CSVDataSet` becomes a data file (`jmx/data.js`): `variableNames` → `columns` (renamed like other variables), `ignoreFirstLine` → `skipHeader`, `delimiter` (`\t` = tab), `shareMode.all` → `next-row` and any other share mode → `per-vu` (with a warning), `recycle` → `recycle` and otherwise `stop`; `${FILE_VAR}` file names resolve through User Defined Variables. A .jmx has no rows, so it is imported with empty `content` and a warning to upload the file; another warning names a column that is also extracted by a request (not for a data set of a turned-off group). A data set inside a controller gets the `groupId` of the group it sits in, so its row is read, and `stop` applies, only when that group runs; one in a controller nested deeper than the group warns (it is read when the group starts), and one below a disabled nested controller is skipped with a warning. A group is kept while a request or a data set refers to it. An **`IfController`** directly under the thread group becomes a group with `runIf` when its condition is a known shape (`condition.js`; the text is tokenized, never evaluated): with "Interpret Condition as Variable Expression" on, `${__groovy(...)}` / `${__jexl3(...)}` / `${__javaScript(...)}` around the body; with it off, the JavaScript expression itself. Bodies read: `def m = props.get('X') ?: vars.get('X'); return m == 'A' || m == 'B'` (groovy only, `props` or `vars`, also bare `vars.get('X') == 'A'`), and `${X} == "A"`, `"${X}" == "A"`, `'${X}' == 'A'`, with `!=` (a single comparison → `not-equals`) and `||` over the same variable (→ `equals` / `one-of`); parentheses are allowed. Anything else (an empty value, a value with a comma or surrounding spaces, `&&`, different variables, mixed `==` / `!=`, method calls) is not read: the group keeps running every iteration and the warning quotes the condition. The variable name goes through the usual renaming; one that the plan never defines becomes an empty global variable with a warning, and a condition that also reads a JMeter property (`props.get`) says that K6UI only reads the variable. "Evaluate for all children" warns (K6UI checks once, when the group starts). A disabled `IfController` stays a disabled group with its condition. An `IfController` nested deeper is merged into its group and its condition is ignored, with a warning. The "logic is not supported" warning remains only for logic controllers that are not read.

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
