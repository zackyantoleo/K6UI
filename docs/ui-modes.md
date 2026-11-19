# Simple and Advanced UI modes

K6UI has two layouts over **one** project, form, generator, and runner. The
switch in the top bar changes only what is shown and how it is arranged. It
never changes what a test sends, how it runs, or what is saved.

| | Simple | Advanced |
|---|---|---|
| Navigation | Four steps: Build Flow, Data & Rules, Load, Run & Results | Direct categories: Request Flow, Variables, Headers, Data files, Load Profile, Thresholds / SLA, k6 Script, Run & Results |
| Request flow | Request cards in execution order, click one to edit; request groups sit below the list | Outline on the left (execution order + group label; a group also shows its condition), the selected request or group editor on the right |
| Hidden settings | An **Advanced settings configured** notice lists categories and counts (never values) | Every setting is reachable from the outline and editor tabs |
| Load | Presets first, **Customize** opens the editor | The custom editor is always open; presets are optional and ask before replacing custom values |
| Results | Overview first, detail tabs available | Same panel plus shortcuts to Requests, Metrics, Errors, Live log |

The default is **Advanced** until the user picks a mode.

## What the switch must never do

These rules are why one project behaves the same in both layouts. Keep them
when changing either mode.

1. **One DOM.** Request cards stay in `#reqs-main` and groups in
   `#request-groups`. The outline only shows summaries and selects the
   canonical card or group. Do not clone, move, or re-render forms per mode.
2. **No reload or re-apply.** Switching does not call `applyConfig()`,
   `collectConfig()`, or `/api/generate`, and does not hydrate lazy panels.
   Unsaved input, including whitespace and raw textarea text, stays as typed.
3. **Order is execution order.** Group labels annotate requests and never
   reorder them (Auth, Checkout, Auth stays #1, #2, #3).
4. **Not serialized.** The mode is not part of the project JSON, the
   `/api/generate` or `/api/run` payloads, or `schemaVersion`. The only stored
   value is the enum in `localStorage['k6ui.uiMode']` (`simple` or
   `advanced`). An invalid value or a storage error falls back to Advanced, and
   the switch still works for the session. This is a preference, not autosave.
5. **One run.** Run/Stop, the SSE stream, and the results panel have one owner
   (`runner.js`). Switching mid-run does not start, stop, or clear anything.
   The selected results tab, filter, rows, elapsed time, and verdict persist.
6. **Text only.** Names, URLs, and group labels from a project are rendered
   with `textContent` or DOM properties, never `innerHTML`.

## Code map

| File | Role |
|---|---|
| `public/js/ui-mode.js` | Read/write the mode enum, apply `html[data-ui-mode]`, show the matching nav, emit `k6ui:ui-mode-changed` |
| `public/js/nav.js` | View switching and `aria-current` for steps (Simple) or categories (Advanced) |
| `public/js/components/flow-outline.js` | Advanced outline: pure `outlineModel()` / `resolveSelection()` plus a DOM adapter that reads card and group heads only |
| `public/js/components/request-groups.js` | The group editor, one DOM for both modes: the "Run only if" row (variable, operator, comma-separated values) lives in the group body, and a badge with its summary in the always-visible head. The outline and the notice read that badge, never the inputs of a hidden panel |
| `public/js/data-files.js` | The Data files view (`#view-datafiles`): one DOM for both modes, reached from the Data & Rules step (Simple) or its own category (Advanced). Cards keep their state in `card.dataSet`; file text is rendered with `textContent` only and nothing here reads the mode |
| `public/js/components/export-rows.js` | "Save to CSV" blocks in the Extract tab, one DOM for both modes; values are DOM properties |
| `public/js/components/outcome-target-rows.js` | Outcome Targets in the Thresholds / SLA view (`#view-sla`), one DOM for both modes, reached from the Data & Rules step (Simple) or its own category (Advanced), so the Simple notice does not list them. The request and label lists are read from the cards with `readRequestSettings()` (never hydrating a lazy panel), refreshed when the view is shown or the flow changes; values are DOM properties |
| `public/js/export-results.js` | "Saved to CSV" in the Overview of Run & Results, shown in both modes; rows live in this tab's memory until the next run, names are rendered with `textContent` |
| `public/js/components/advanced-notice.js` | Simple notice: pure `summarizeAdvancedSettings()` plus a DOM adapter that reads live panels when hydrated, otherwise `card.requestState` |
| `public/css/base.css`, `flow.css`, `views.css` | `[data-ui-only="simple|advanced"]` hides one-mode pieces (`base.css`); `html[data-ui-mode="advanced"]` rules lay out the outline and editor (`flow.css`) and keep the load editor open (`views.css`) |
| `public/js/components/load-chart.js` | "Load shape" on the Load view, shown in both modes; it reads the load inputs as typed (and, for a race burst, the global variable rows) and never the store or the mode |
| `public/js/race-results.js` | The "Race burst" card in the Overview of Run & Results, shown in both modes; it renders the `race` of `done` (note, figures, Gantt, table) into one DOM with `textContent` only |
| `public/js/components/race-settings.js` | The "Race burst" fields of the Load view, one DOM for both modes (inside the custom load editor). The race request list is read from the cards with `readRequestSettings()` (never hydrating a lazy panel) and refreshed when the view is shown or the flow changes; names are DOM text |

Structural edits (add, duplicate, move, delete, cURL import, group changes)
call `notifyFlowChanged()` from `components/counts.js`. The outline and notice
listen to `k6ui:flow-changed`, `k6ui:project-applied`,
`k6ui:request-group-changed`, and `k6ui:ui-mode-changed`. Removing the focused
request or group calls `focusAfterRemoval()`, so keyboard focus moves to the
selected outline entry (Advanced) or the next visible neighbour (Simple).

## The Advanced settings notice

Shown in Simple only, under the Build Flow hint. It counts requests (or groups)
that will run with:

- gRPC protocol
- response extraction
- Save to CSV (requests that save rows; never the file name)
- custom checks
- outcome rules (requests with at least one rule; empty rows do not count)
- pre/post scripts (whitespace-only scripts do not count)
- a pause other than the default 1 second
- the automatic 2xx check turned off
- expected statuses (requests with a list in the Advanced tab; never the statuses themselves)
- group header defaults (groups only)
- conditional groups: groups with a "Run only if" row filled in (groups only; a turned-off group counts under "configured but not run")
- data files that will be used (a count of files; the notice is not per request)
- a race burst load profile ("Race burst (Load step)": the one request it sends at a planned time; read from the Load view's mode, never its values)

Disabled requests and requests in a turned-off group are reported separately as
"configured but not run". The notice never shows names, URLs, header values,
condition variables or values, or script text.

## Verification

```bash
npm test
PLAYWRIGHT_MODULE=file:///path/to/playwright/index.mjs node scripts/verify-ui-modes.mjs
```

`verify-ui-modes.mjs` is the one browser check for both modes. It needs a
Playwright install (local package or `PLAYWRIGHT_MODULE`) and, for its run
checks, the `k6` binary on `PATH`. It starts K6UI and a synthetic HTTP target
on `127.0.0.1`, blocks every request that leaves that origin, and fails on any
page error, console error, or unexpected dialog. It covers:

- config and generated-script parity across switches and selections for a rich
  project (interleaved groups, collapsed and disabled items, gRPC,
  lazy scripts, stages, thresholds), plus header precedence
  `global < group < request`
- Save in Simple → Open in Advanced → Save → Open in Simple, v1 migration, and
  an unknown `schemaVersion`
- one action per click after many switches (Add Request, k6 Script, Save)
- focus after deleting a request or group
- a real local run: request rows capped at 500 (the server sends at most 50
  passed records a second and reports the rest), sorting by a column heading
  while records stream in, request and response detail
  with headers, live log capped at 1,500 lines, secrets redacted, response
  markup shown as text, request details opt-in (the run uses Hide secrets, so
  redaction is checked; it is off by default)
- a layout and accessibility audit of every view in both modes at 1440×900,
  1024×768, 768×1024, 375×812 and zoom 200% (720×450 CSS pixels at 2× device
  scale). It checks sideways scroll, duplicate IDs, clipped or overlapping
  controls, the URL field width, unstyled buttons, and WCAG AA text contrast,
  plus empty and 100-request projects
- every Tab stop visible with a focus indicator
- only `k6ui.uiMode` in browser storage
- 100-request restore and switch timings (recorded, not enforced)

It then runs the older stage checks (`verify-ui-mode-shell.mjs`,
`verify-advanced-flow.mjs`, `verify-mode-lifecycle.mjs`). Set
`K6UI_VERIFY_SKIP_STAGE_CHECKS=1` to skip them, or
`K6UI_VERIFY_SECTIONS=layout,keyboard` to run a subset. Evidence (JSON and
screenshots) goes to `K6UI_VERIFY_OUTPUT`, by default the git-ignored
`.hermes/plans/k6ui-ui-revamp-preview/stage5`.

Not covered: real gRPC execution (no gRPC server fixture), the browser's own
zoom control, placeholder text contrast, and screen-reader output.

## Rolling back

For a user, picking **Simple** restores the step-by-step layout. Any data or
security problem needs a code rollback instead: revert the feature commits on a
new branch. Older versions ignore the `k6ui.uiMode` key.
