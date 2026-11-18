# PR-00 Baseline Tests and Performance

Measured on 2026-08-28 using Node.js `v22.23.2` on `linux/x64`.
These are characterization numbers, not release gates. Re-run with
`npm run measure:baseline` on the same host when comparing later PRs.

## Automated characterization

`npm test` covers:

- HTTP generation: load/options, thresholds, global/request header merge,
  extraction, assertion, and pre/main/post lifecycle order.
- gRPC generation: validation, connect/invoke/status/extraction/close order,
  metadata, and plaintext behavior.
- Project save/open source contracts, including all top-level config domains.
- Runtime smoke for the static UI, `/api/k6-status`, and `/api/generate`
  success/error responses.

## Baseline measurements

| Measurement | Baseline |
| --- | ---: |
| Browser assets, uncompressed | 105,896 bytes |
| Browser assets, gzip sum | 28,350 bytes |
| Cold server readiness | 985.66 ms |
| First `/api/k6-status` response | 435.39 ms |
| 100-request generator median (30 runs) | 1.421 ms |
| 100-request generator p95 | 4.199 ms |
| Generated 100-request script | 47,662 bytes |
| 100-request editor restore median (5 runs) | 275.0 ms |
| 100-request editor restore range | 214.4–492.1 ms |

The cold readiness measurement includes Node/Express startup and polling from a
separate process. `/api/k6-status` also invokes `k6 version`; therefore its first
response is not pure HTTP latency.

The editor measurement is a manual Playwright check in headless Chromium. It
calls the existing `applyConfig()` path five times with a realistic 100-request
project and verifies exactly 100 request cards are rendered. It is recorded
rather than enforced because browser and host variance would make a hard timing
assertion flaky.

## Asset detail

The reproducible script reports every HTML, JS, and CSS file separately. At
baseline, the largest source assets are:

- `public/css/style.css`: 32,251 bytes (5,994 gzip)
- `public/js/components/req-card.js`: 17,195 bytes (4,411 gzip)
- `public/index.html`: 15,688 bytes (3,900 gzip)
- `public/js/runner.js`: 9,978 bytes (3,290 gzip)

## Commands

```bash
npm ci
npm test
npm run measure:baseline
```

For the browser/editor check, start K6UI and run an external Playwright fixture
that imports `/js/project-io.js`, invokes `applyConfig()` with 100 requests, and
asserts `.req-card` count equals 100. No browser dependency is added to this PR.

## Simple / Advanced UI modes (November 2026)

Same host and Node.js `v22.23.2`, measured on 2026-11-15. Main = `ba41495`
(before the two UI modes). Timings are noisy on this host and recorded, not
enforced; see [ui-modes.md](ui-modes.md) for what the modes change.

| Measurement | Main | With UI modes |
| --- | ---: | ---: |
| First-party JS, uncompressed | 98,914 bytes | 124,498 bytes |
| CSS, uncompressed | 45,817 bytes | 54,000 bytes |
| HTML, uncompressed | 21,125 bytes | 23,702 bytes |
| 100-request generator median (30 runs) | 1.834 ms | 2.258 ms (generator unchanged; host noise) |
| 100-request editor restore, median of 6 alternating rounds × 5 runs | 709 ms | 571 ms |
| Switch to Simple / to Advanced with 100 requests, median of 5 | — | 135 ms / 68 ms |
| Simple notice recount, 100 requests, median | — | 1.3–1.9 ms |

Targets: first-party JS under 150 KB and CSS under 100 KB, both met. An earlier
three-round restore comparison read 674 ms (main) against 863 ms (UI modes),
with single rounds between 516 and 1,113 ms. The spread between rounds is
larger than the difference between versions, so these numbers show no
consistent slowdown.

Browser timings come from `scripts/verify-ui-modes.mjs` (restore and switch) and
a separate A/B script that serves each version from `127.0.0.1` in turn and
calls `applyConfig()` with the same 100-request, 3-group project.

## Load generator throughput (November 2026)

Measured on 2026-11-18 with k6 v2.4.0 and JMeter 5.6.3 on an Intel Core Ultra 5
125U laptop (14 threads, powersave governor). A local Go server on CPUs 8–13
served the flow; the load generator was pinned to CPUs 0–7 (`taskset`). Flow:
POST login (extract `data.token`, with a default) → GET product, a 4 KB JSON
body (extract `data.sku`) → POST cart (body assertion), every request with the
status check; 50 VUs, no pause, 10 s. JMeter ran in non-GUI mode with a 1 GB
heap, writing a CSV JTL, the same flow (JSON Extractors, Response Assertion).
Turbo and heat move results by about ±20% between runs, so each line is the
median of three interleaved rounds; the two runs below were at different
temperatures, so compare numbers within one run only.

| Load generator | Requests/s, run 1 | Requests/s, run 2 | Requests per CPU second, run 2 | Max RSS |
| --- | ---: | ---: | ---: | ---: |
| K6UI, old generator (`JSON.parse(res.body)`) | 26,515 | 19,512 | 2,822 | 128 MB |
| K6UI, new generator (`res.json(path)`) | — | 35,083 | 5,503 | 155 MB |
| Hand-written k6 script (`res.json(path)`) | 47,162 | 33,147 | 5,211 | 182 MB |
| JMeter | 37,882 | 25,643 | 3,178 | 830 MB |
| K6UI old generator, request details "all" (no per-VU budget) | — | 10,214 | 1,488 | 100 MB |
| K6UI new generator, request details "all" (per-VU budget) | — | 31,326 | 4,901 | 146 MB |

Run 1 measured the old generator, a hand-written script and JMeter; run 2
(a hotter machine: every number is lower) interleaved all six. In both, the old generator was slower
than JMeter; the new one matches the hand-written script.

Through `POST /api/run` (Node server and k6 on the same CPUs, 10 s): request
details off, Node used 0.06 CPU s while k6 used 64 CPU s. With "all", Node went
from 4.35 to 0.21 CPU s and the run from 11.9k to 28.5k requests/s; 500 records
reached the browser and the skipped count missed 53 of 181,929 in a 5 s run.

With a pause (500 VUs, `sleep(1)` after the flow, about 1,490 requests/s for
every tool): K6UI with `res.json(path)` 3.9 CPU s and 208 MB, the old generator
6.5 CPU s and 245 MB, JMeter 14.0 CPU s and 821 MB. At 2,000 VUs: 15.8 CPU s and
741 MB against JMeter's 25.8 CPU s and 1,180 MB. With a fixed pause and every VU
starting together, k6 measured p95 18.9 ms (the VUs fire in waves); a random
pause (`sleep(0.5 + Math.random())`) gave 1.1 ms.

`responseType: "none"` on a request whose 4 KB body is not read added about 3%;
`K6_SYSTEM_TAGS` and `GOGC=400` stayed inside the noise.

## Outcome rules (November 2026)

Same machine and flow, 2026-11-18, 50 VUs, 8 s runs, four rounds with the order
of the variants rotated (the first run after a pause gets the most turbo), median
of the middle two. Every one of the three requests had the same rules. Requests per
CPU second of k6:

| Variant | Requests per CPU second | Change |
| --- | ---: | ---: |
| No outcome rules | 6,646–6,790 | — |
| 4 rules (2xx status, two error codes at one JSON path, a body regex); every response matches the first | 6,105 | −10% |
| The same with a JSON `exists` on `data` (an object of the 4 KB body) first | 4,792 | −28% |
| First prototype: one helper looping over rule objects, status rule first | 5,396 | −18% |
| First prototype, JSON `exists` first | 4,159 | −36% |
| First prototype without the `Counter.add` | 5,904 | −10% |

About 8 points of the 10% are k6's own cost of one metric sample (`Counter.add`),
the same with or without tags. The rest is the function call and its `if`s:
`outcomeOf_<n>()` with one `if` per rule cost about half of the generic loop.
Reading a JSON path that holds an object converts that object to JavaScript, as an
extraction of it would; a path to a single value (`error.code`) is cheap, and a
status-only rule placed first answers most responses without reading the body.
