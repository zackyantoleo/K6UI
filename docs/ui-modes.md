# Simple and Advanced UI modes

K6UI has two layouts over **one** project, form, generator, and runner. The
switch in the top bar changes only what is shown and how it is arranged. It
never changes what a test sends, how it runs, or what is saved.

| | Simple | Advanced |
|---|---|---|
| Navigation | Four steps: Build Flow, Test data (optional), Load & goals, Run & Results; each says what it holds ("3 requests · 1 group", "Smoke · 1 user · 30s · 2 goals") | Direct categories: Request Flow, Variables, Headers, Data files, Load Profile, Thresholds / SLA, k6 Script, Run & Results |
| Test data | One page: Variables (with "Used in"), Shared headers, CSV data files, each folding | One block per category (Variables, Headers, Data files), always open |
| Pass/fail goals | Below the load on the Load & goals page | Their own category, Thresholds / SLA |
| Request flow | Request cards in execution order, click one to edit; request groups sit below the list | Outline on the left: requests in execution order inside their group, each group a head (name, Off, count, condition) that folds its requests; a group split by other requests shows once per part ("Part 1 of 2"), as the script runs it. The selected request or group editor on the right |
| Hidden settings | An **Advanced settings configured** notice lists categories and counts (never values) | Every setting is reachable from the outline and the request editor |
| Load | "What do you want to find out?": Smoke (Start here), Load, Stress, Race burst, Custom; a preset shows its steps, Custom the kind of load; a race burst folds lead time, warm-up, fail if late and max duration under **Advanced timing** | The same goals; the custom editor is always open (the kind of load under a preset too, Advanced timing unfolded); presets ask before replacing custom values |
| Pass/fail goals as sentences | "95% of requests finish within [500] ms", "Less than [1]% of requests fail", each with a switch; **Add goal** for outcome targets | The same, plus the k6 expression of each goal |
| Run & Results | "Before you run" (what will happen, a checklist with fix buttons, recording options), then Overview: verdict sentence, key figures against the goals, each request (slowest marked), what to do next, All k6 metrics folded; tabs Requests, Errors, Raw k6 output | Same panel plus shortcuts to Requests, Errors, Raw k6 output |

The default is **Simple** (the guided layout, for people new to load testing) until the user picks a mode. The default itself is never written to storage.

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
   the switch still works for the session. This is a preference, not autosave:
   the project itself is kept apart, as the browser draft
   (`localStorage['k6ui.draft']`, `public/js/draft.js`), which never holds the
   mode either.
5. **One run.** Run/Stop, the SSE stream, and the results panel have one owner
   (`runner.js`). Switching mid-run does not start, stop, or clear anything.
   The selected results tab, filter, rows, elapsed time, and verdict persist.
6. **Text only.** Names, URLs, and group labels from a project are rendered
   with `textContent` or DOM properties, never `innerHTML`.

## Code map

Stage 8: `components/send-once.js` (Send once response in the open request, one DOM, text only, never saved) and `components/first-run.js` (`#flow-empty-state`, the same screen in both modes).

| File | Role |
|---|---|
| `public/js/ui-mode.js` | Read/write the mode enum, apply `html[data-ui-mode]`, show the matching nav, emit `k6ui:ui-mode-changed` |
| `public/js/nav.js` | View switching and `aria-current` for steps (Simple) or categories (Advanced). A page of blocks (`#view-data`, `#view-load`, `.view-block[data-block]`) is one Simple step; in Advanced each block is a category and the others are hidden (class `hidden`, never moved). A Simple link to one block (`navigate('datafiles')`) opens the page there and unfolds it |
| `public/js/components/view-blocks.js` | Folding the Test data blocks, Simple only: the toggle carries `data-ui-only="simple"` and Advanced shows a folded body anyway (`views.css`), so a block folded in Simple is never stuck closed in Advanced and comes back folded |
| `public/js/components/step-summary.js` | The summary under each Simple step and the counts in the block headings; reads the forms as typed, the run badge's class, never a lazy panel or the mode |
| `public/js/components/flow-arrange.js` | Simple only: drag and drop inside `#reqs-main` (the card moves, never leaves it; a drop next to a card takes that card's group, the keyboard way is the card's ⋯ → Move up / Move down / Group) and group bands, a header inside the first card of each run of one group, read from the group heads (name, on/off, the "Run only if" badge). Hidden in Advanced, where the outline shows groups |
| `public/js/glossary.js`, `public/js/components/help-tips.js` | The "?" help buttons (`data-help="<key>"` in markup, `helpButton(key)` in JS-built panels), their one shared tooltip and the Glossary panel; the same in both modes. A help button sits next to a label, never inside one (a radio card names its radio with `aria-labelledby`) |
| `public/js/components/flow-outline.js` | Advanced outline: pure `outlineModel()` (`sections`: runs of one group, in execution order; groups without requests last) / `resolveSelection()` plus a DOM adapter that reads card and group heads only. A head's fold toggle presses the group's own collapse button (hidden in Advanced), so folding is the group's saved `collapsed` flag, shared with Simple. A folded head that holds the selected request is marked; a request chosen by an action (add, duplicate, moved into a group) unfolds its group, opening a project does not |
| `public/js/components/request-groups.js` | The group editor, one DOM for both modes: the "Run only if" row (variable, operator, comma-separated values) lives in the group body, and a badge with its summary in the always-visible head. The outline and the notice read that badge, never the inputs of a hidden panel |
| `public/js/data-files.js` | The CSV data files block of Test data (`#data-block-datafiles`): one DOM for both modes, on the Test data page (Simple) or its own category (Advanced). Files come from the drop zone, a drop on a card, the pickers or pasted text. Cards keep their state in `card.dataSet`; file text is rendered with `textContent` only and nothing here reads the mode |
| `public/js/components/variables-panel.js`, `public/js/components/var-suggest.js`, `public/js/variables.js` | "Variables you can use" (`#flow-vars`), one DOM for both modes: beside the request list on a wide Simple screen (≥ 1280 px), above it when narrower, above the selected editor in Advanced (CSS only). The warnings sit in each card (`.req-var-warnings`) and the `{{` suggestions in one listbox for the page. All read the cards without hydrating a lazy panel and never write to the project; picking a suggestion types text into the field like the user would |
| `public/js/components/req-card.js` | The request editor, one DOM for both modes: a Postman-style tab bar (Headers, Body, Checks with Success statuses above the response checks, Extract, Save CSV, Outcomes, Scripts, Settings with "Wait after"), one panel at a time. Each tab fills its part lazily the first time it is shown; a count or a dot marks a tab whose part is in use. Switching tabs never changes a value |
| `public/js/components/export-rows.js` | "Save to CSV" blocks in the "Save values to a CSV file" part of a request, one DOM for both modes; values are DOM properties |
| `public/js/components/outcome-target-rows.js` | Outcome targets in the pass/fail goals block (`#load-block-goals`), added from its "Add goal" menu, one DOM for both modes, on the Load & goals page (Simple) or its own category, Thresholds / SLA (Advanced), so the Simple notice does not list them. The request and label lists are read from the cards with `readRequestSettings()` (never hydrating a lazy panel), refreshed when the view is shown or the flow changes; values are DOM properties |
| `public/js/export-results.js` | "Saved to CSV" in the Overview of Run & Results, shown in both modes; rows live in this tab's memory until the next run, names are rendered with `textContent` |
| `public/js/components/advanced-notice.js` | Simple notice: pure `summarizeAdvancedSettings()` plus a DOM adapter that reads live panels when hydrated, otherwise `card.requestState` |
| `public/css/base.css`, `flow.css`, `views.css` | `[data-ui-only="simple|advanced"]` hides one-mode pieces (`base.css`); `html[data-ui-mode="advanced"]` rules lay out the outline and editor (`flow.css`) and keep the custom load editor open: the kind of load under a preset, Advanced timing of a race burst (`views.css`) |
| `public/js/components/load-goals.js` | "What do you want to find out?" on the Load view, one DOM for both modes. The chosen goal is presentation only (never saved, never the mode); the load mode is read from the form (`readLoadMode()`: the Race burst goal, else the kind of load). An opened project shows as Custom (Race burst for a race), and its values count as custom, so a preset asks first |
| `public/js/components/load-chart.js` | "What will happen" on the Load view, shown in both modes: a sentence, the chart and three figures; it reads the load inputs as typed (and, for a race burst, the global variable rows) and never the store or the mode |
| `public/js/components/pass-fail-goals.js` | "Pass or fail" goals as sentences with a switch, one DOM for both modes; a switch that is off sends `""` (not used), so a project without a threshold keeps none until a switch is turned on. The k6 expression is `data-ui-only="advanced"` |
| `public/js/components/run-check.js`, `public/js/run-summary.js`, `public/js/result-overview.js` | "Before you run" and the plain-language reading of a run in Run & Results, one DOM for both modes. The checklist reads the forms as typed (never a lazy panel) and only navigates; the recording options moved here from the Requests tab (same IDs, same project fields). Cards, the per-request table and "What to do next" are written with `textContent`; a card's "?" sits beside its label |
| `public/js/race-results.js` | The "Race burst" card in the Overview of Run & Results, shown in both modes; it renders the `race` of `done` (note, figures, Gantt, table) into one DOM with `textContent` only |
| `public/js/components/race-settings.js` | The "Race burst" fields of the Load view, one DOM for both modes; "Advanced timing" folds in Simple (the open state lives in this tab's DOM only) and is always open in Advanced. The race request list is read from the cards with `readRequestSettings()` (never hydrating a lazy panel) and refreshed when the view is shown or the flow changes; names are DOM text |

Structural edits (add, duplicate, move, delete, cURL import, group changes)
call `notifyFlowChanged()` from `components/counts.js`. The outline and notice
listen to `k6ui:flow-changed`, `k6ui:project-applied`,
`k6ui:request-group-changed`, and `k6ui:ui-mode-changed`. Removing the focused
request or group calls `focusAfterRemoval()`, so keyboard focus moves to the
selected outline entry (Advanced; its group head when that group is folded) or
the next visible neighbour (Simple).

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
- expected statuses (requests with a list under Success statuses; never the statuses themselves)
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
- only `k6ui.uiMode` and the project draft `k6ui.draft` in browser storage
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
