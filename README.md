# K6UI

A simple UI for building and running [k6](https://k6.io) load tests **without writing code**. Fill in a form, click run, and watch the results — great for anyone not yet familiar with k6 scripting.

## Features

- **Request flow** — one or many sequential requests (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) with headers and body; each request can have optional *Before* and *After* sub-requests.
- **Extraction & variables** — pull values out of responses (JSON path, header, or regex), then use them in later requests with `{{variable_name}}` in the URL, headers, or body (e.g. a login token).
- **Per-request assertions** — validate status codes, body content, headers, or response time.
- **Load profile** — fixed VUs + duration, or staged (ramp up/down via stages).
- **Thresholds / SLA** — max p95 and max error rate targets; if unmet, k6 exits with a non-zero code (useful for CI/CD).
- **Script generation** — view & copy the generated k6 script; it can also be run standalone outside the UI.
- **Run & monitor** — k6 runs on the server; live log streaming, a per-request detail table (filter by errors/URL), and an automatic metrics summary.
- **Save / open projects** — the configuration is saved as a JSON file and can be loaded back.

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
2. Set the number of virtual users and the duration in **Load Profile** (or use stages to ramp up/down).
3. (Optional) set p95 and error-rate targets in **Thresholds / SLA**.
4. Click **View Script** to preview, or **Run Test** to execute directly.

For development: `npm run dev` (the server restarts automatically on file changes).

## Project structure

```
server/                 Express backend
├── index.js            Server entry point
├── routes.js           API endpoints
├── k6-runner.js        Runs the k6 process + streams its output
└── generator/          Turns the UI configuration into a k6 script

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
| `POST /api/generate` | Generate a k6 script from a configuration |
| `POST /api/run` | Run a test, results streamed via SSE |
