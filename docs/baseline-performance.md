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
