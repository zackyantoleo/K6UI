# K6UI

A simple UI for building and running [k6](https://k6.io) load tests **without writing code**. Fill in a form, click run, and watch the results — great for anyone not yet familiar with k6 scripting.

## Features

- **Request flow** — one or many sequential requests (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) with headers and body; each request can have optional *Before* and *After* sub-requests.
- **Extraction & variables** — pull values out of responses (JSON path, header, or regex), then use them in later requests with `{{variable_name}}` in the URL, headers, or body (e.g. a login token).
- **Data files (CSV)** — give every iteration its own row from a CSV file (for example one login per user): choose a `.csv` file or paste its text, pick the delimiter, header row and column names, then use a column as `{{email}}` in any URL, header, or body. Rows are shared by all users (next row for every iteration) or fixed per user, and wrap around or stop when they run out. The rows are written into the generated script, so View Script and standalone runs need no extra file; they are also saved in the project file, so keep credentials in mind. Up to 5 MB per file; running it needs k6 0.38 or newer.
- **Per-request assertions** — validate status codes, body content, headers, or response time.
- **Load profile** — fixed VUs + duration, staged (ramp up/down via stages), or iterations (every VU runs the flow N times, then stops).
- **Thresholds / SLA** — max p95 and max error rate targets; if unmet, k6 exits with a non-zero code (useful for CI/CD).
- **Script generation** — view & copy the generated k6 script; it can also be run standalone outside the UI.
- **Run & monitor** — k6 runs on the server; live log streaming, a per-request detail table (filter by errors/URL), and an automatic metrics summary.
- **Save / open projects** — the configuration is saved as a JSON file and can be loaded back.
- **Import k6 scripts** — paste or open an existing k6 `.js` script and K6UI rebuilds the flow from it: load profile (including a single `per-vu-iterations` scenario), thresholds, requests, headers and bodies, `check()` assertions, values taken from responses, `sleep()`, and `group()`. The script is only read, never run. Anything K6UI cannot represent (loops, conditions, custom code, other `options`) is skipped and listed after the import.
- **Import JMeter test plans** — paste or open a `.jmx` file in the same dialog. K6UI reads one thread group (users, ramp-up, duration — also Concurrency Thread Group; a fixed "N loops per user" becomes the iterations load mode, without ramp-up), HTTP requests with HTTP Request Defaults and Header Managers, User Defined Variables and `${__P(name,default)}`, Transaction/Simple Controllers as request groups, Response/Duration Assertions, JSON/Regex/Boundary Extractors, and timers / Flow Control Action pauses. A CSV Data Set becomes a data file with its columns, header, delimiter and share mode; a `.jmx` does not contain the rows, so upload the CSV afterwards under Data & Rules (a warning says which file). The file is only read, never run; anything else (logic controllers, scripts, other samplers) is listed after the import.

## Simple and Advanced

A switch in the top bar picks the layout. Both show the same project:

- **Simple** — four steps (Build Flow, Data & Rules — variables, headers, data files, targets —, Load, Run & Results). If a flow has settings that are not obvious at a glance (scripts, extraction, Before/After requests, gRPC…), a notice lists them by category.
- **Advanced** (default) — direct categories, plus a request outline next to the selected request's editor.

Switching never changes what runs or what is saved; the choice is remembered in your browser only. Details: [docs/ui-modes.md](docs/ui-modes.md).

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [k6](https://k6.io/docs/get-started/installation/) installed on the server — required to run tests; script generation works without it.

## Getting started

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

1. Enter the URL and request details in **Request Flow** (add requests, extractions, or assertions as needed).
2. (Optional) under **Data & Rules → Data Files** (Advanced: **Data files**), add a CSV file and use its columns as `{{column}}`.
3. Set the number of virtual users and the duration in **Load Profile** (or use stages to ramp up/down, or iterations to run the flow a fixed number of times per user).
4. (Optional) set p95 and error-rate targets in **Thresholds / SLA**.
5. Click **View Script** to preview, or **Run Test** to execute directly.

For development: `npm run dev` (the server restarts automatically on file changes).

## Project structure

```
server/                 Express backend
├── index.js            Server entry point
├── routes.js           API endpoints
├── k6-runner.js        Runs the k6 process + streams its output
├── generator/          Turns the UI configuration into a k6 script
└── importer/           Reads a k6 script (or, in jmx/, a JMeter .jmx) into a UI configuration

public/                 Frontend (vanilla JS, no build step)
├── index.html          Markup for every view
├── css/style.css       Styling
└── js/                 One module per feature + components/ for DOM builders
```

Architecture notes, the configuration schema, and API details are in [CLAUDE.md](CLAUDE.md).

## How it works

1. The frontend reads the form into a single JSON configuration object.
2. The server generates a k6 script from that configuration (`POST /api/generate`).
3. On run (`POST /api/run`), the server writes the script to a temporary folder, executes `k6 run`, and streams live output to the browser via Server-Sent Events; the temporary folder is removed afterwards.
4. The k6 exit code determines whether the thresholds/SLA were met (0 = pass, 99 = thresholds failed).

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/k6-status` | Check whether the k6 binary is available |
| `POST /api/generate` | Generate a k6 script from a configuration (up to 24 MB, so it can carry CSV data files) |
| `POST /api/run` | Run a test, results streamed via SSE |
