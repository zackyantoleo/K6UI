# Changelog

All notable changes to K6UI are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **License notices:** a `NOTICE` file (copyright, AGPL-3.0-only, commercial
  licenses, the k6 / Grafana trademark note), a `REUSE.toml` that declares the
  copyright and license of every file (with the license text in `LICENSES/`), and a
  `.mailmap` that shows the author's commit identities as one.

## [1.1.0] - 2026-11-25

Everything since `v1` (pull requests #16–#59).

### Upgrade notes

- **License:** K6UI is now licensed under **AGPL-3.0-only** (was MIT). Versions
  published before the change stay MIT. If you share or host a modified version,
  read the License section of the README. (#56)
- **Local-only server:** the server now listens on `127.0.0.1` and answers only
  requests addressed to `localhost` / `127.0.0.1`. To reach it from other machines on
  purpose, start it with `HOST=0.0.0.0 npm start`, on a trusted network only. (#53)
- **Project files:** projects are saved as schema version 2. Older files open and
  migrate on their own; nothing to do. (#17)
- **Request editor:** it is a tab bar again (Headers, Body, Checks, Extract,
  Save CSV, Outcomes, Scripts, Settings). "Wait after" lives in Settings, and success
  statuses live in Checks. (#59)

### Added

- **Simple and Advanced modes:** one project, two layouts. Advanced adds a request
  outline with groups next to the editor. (#23, #52)
- **Import:** k6 scripts (#25) and JMeter `.jmx` test plans (#26, #27) open as
  editable projects.
- **Test data:** CSV data files that feed one row per iteration, with drag and drop
  onto one Test data page (#27, #46), plus a variables panel with `{{` suggestions
  and "not available yet" warnings (#45).
- **Flow control:** request groups (#22) with "run only if" conditions,
  extraction defaults, and an iterations load mode (#27).
- **Save to CSV:** save values during a run, then download them or use them as
  a data file. (#27)
- **Send once:** send one request and click a JSON value to extract it as
  `{{name}}`. (#49)
- **Outcomes:** label every response with outcome rules (#35), set limits on the
  label counts that become k6 thresholds (#36), and follow the counts live during a
  run (#38). Also expected statuses per request and `{{$outcome}}` (#37).
- **Race burst load mode:** a planned send time per VU, warm-up and late-VU
  tracking (#39), with evidence in the results: per-VU send records, a Race card and
  a Gantt chart (#40).
- **Run & Results:**
  - a check before the run and a verdict in plain words (#48)
  - recorded request payloads and responses (#28)
  - "Hide secrets" for recorded requests (#29)
  - a Requests table you can sort (#31)
  - "Copy as cURL" for a recorded request (#41)
  - a run report download as HTML or JSON (#32)
- **Configurable request record limit:** "Keep the newest N records" (1–10,000,
  default 500) in Before you run. (#59)
- **Guided start:** load presets, starter checks, beginner help and a first-run
  screen (#19, #43, #47, #49).
- **Nothing lost on refresh:** the project is kept in the browser, so a refresh or
  a closed tab loses nothing. (#51)

### Changed

- A UI revamp with near-black surfaces and a k6UI wordmark logo (#28, #58). Text
  contrast now meets WCAG AA (#23).
- Before/After sub-requests are replaced by plain request ordering. Older projects
  convert on their own. (#28)
- CSV data file values and request headers are trimmed. (#30)
- JSON is read with `res.json()`, and request logs are budgeted per VU. (#34)
- The Requests table, live log, browser draft and data files are lighter on memory
  and CPU. (#55)

### Fixed

- **Stop** now stops k6 on the server; before, a run kept going until its duration
  ended. (#23)
- Opening a project resets unused load modes. (#42)
- In generated scripts:
  - a response without a body no longer ends the iteration with a `TypeError`
  - header names use Go's canonical form
  - extraction names the script already uses are rejected, instead of breaking the
    script (#55)
- The k6 output parser keeps request records that hold special characters, and
  keeps UTF-8 text that is split across chunks. (#53)

### Security

- The server is local-only and checks the `Host` header, which blocks DNS
  rebinding. (#53)
- `/api` refuses cross-site requests, allows at most 2 runs at once, and caps
  buffered output. (#55)
- Generated scripts can no longer be broken into by URLs, names or regexes that
  contain code. (#53, #55)
- Express dependencies were updated to clear npm audit advisories. (#24)

## [1.0.0] - 2026-08-28

The first tagged release (`v1`): a web UI that builds and runs k6 load tests without
code. It covers HTTP and gRPC requests, global variables and headers,
pre-processor and post-processor scripts, cURL import, a live log, and a baseline
of characterization tests.

[1.1.0]: https://github.com/zackyantoleo/K6UI/compare/v1...v1.1.0
[1.0.0]: https://github.com/zackyantoleo/K6UI/releases/tag/v1
