# K6UI project schema v2

PR-02 introduces a lightweight, versioned project state without adding a tree or framework.

## Compatibility

- Files without `schemaVersion` are treated as v1 and migrated when opened.
- Saving always emits `schemaVersion: 2`.
- Existing valid request IDs are preserved.
- Missing or duplicate request IDs are assigned deterministic, unique `req_*` IDs.
- Request groups remain one level deep, use stable `grp_*` IDs, and requests
  reference them through `groupId` without changing global execution order.
- Unknown schema versions fail with an actionable compatibility error instead of being applied partially.
- Imported objects are cloned; migration does not mutate caller-owned data.

## Minimal shape

```json
{
  "schemaVersion": 2,
  "scenario": {
    "groups": [
      {
        "id": "grp_auth",
        "name": "Auth flow",
        "enabled": true,
        "collapsed": false,
        "headers": [
          { "key": "X-Service", "value": "auth" }
        ]
      }
    ],
    "requests": [
      {
        "id": "req_login",
        "groupId": "grp_auth",
        "type": "http",
        "method": "POST",
        "url": "https://example.test/login"
      }
    ]
  },
  "variables": [],
  "globalHeaders": [],
  "load": {
    "mode": "simple",
    "vus": 10,
    "duration": "30s",
    "stages": []
  },
  "thresholds": {},
  "options": {}
}
```

Additional existing request fields remain supported and pass through migration unchanged.

## Load modes

`load.mode` is `simple` (VUs + duration), `stages`, or `iterations`. Iterations mode
adds two optional fields and is purely additive: older projects have none of them,
migration does not add them, and unknown fields pass through unchanged.

```json
"load": { "mode": "iterations", "vus": "5", "iterations": "2", "maxDuration": "1h" }
```

Every VU starts at once and runs the flow `iterations` times, then stops (a k6
`per-vu-iterations` scenario). `maxDuration` is a safety limit and defaults to
`1h` when empty (k6's own default is only 10m). `duration` and `stages` are not
used in this mode.
Group header defaults are applied during generation with precedence
`global < group < request`; disabling a group skips its member requests.

## Data files

`dataSets` holds CSV data files. It is purely additive: older projects have none, migration
only gives them `dataSets: []`, and unknown fields on a data set pass through unchanged.

```json
"dataSets": [{
  "id": "ds_login", "name": "Users", "fileName": "login.csv",
  "delimiter": ",", "skipHeader": true, "columns": ["email", "password"],
  "content": "email,password\nuser1@example.com,pass1\nuser2@example.com,pass2\n",
  "share": "next-row", "onEnd": "recycle"
}]
```

| Field | Meaning |
|---|---|
| `id` | `ds_*`, unique; missing or duplicate ids are repaired on open |
| `name`, `fileName` | Labels only (the name also labels the data in the script) |
| `delimiter` | One character (`,` default); `"\t"` or a real tab = tab |
| `skipHeader` | The first row is a header, not data (default `false`) |
| `columns` | Variable name of file column *i*: `[A-Za-z_]\w*`; blank skips a column, invalid or repeated names are ignored; empty list + `skipHeader` takes the names from the header |
| `content` | The CSV text (quotes, CRLF, BOM and empty lines are handled). At most 5 MB per file and 10 MB in total, or generation fails with a 413 |
| `share` | `next-row` (default): row = `exec.scenario.iterationInTest`, shared by every VU. `per-vu`: row = `__VU - 1` |
| `onEnd` | `recycle` (default): start over after the last row. `stop`: end the iteration early (after a `sleep(1)`), with one log line |
| `groupId` | Optional. A request group: the row is chosen, and `stop` applies, only when that group starts (see Conditional groups). Absent or `""` = every iteration. An id that matches no group means the same |

Each iteration reads one row and `{{column}}` resolves to it. Precedence of `{{name}}`:
extracted from a response > `vars.name` set by a processor script > data column > global
variable. A data set with no content, no rows or no valid column is ignored and its
placeholders stay literal text; when two data sets share a column name the first wins.
Because the rows are part of the project, the saved file (and the generated script) holds
whatever the CSV holds, passwords and tokens included.

## Conditional groups (`runIf`)

A group can carry a "run only if" condition. It is purely additive: older projects have
none, migration does not add the field, and a group without it (absent or `null`) always runs.

```json
{
  "id": "grp_order", "name": "Order flow", "enabled": true,
  "runIf": { "variable": "EXECUTION_MODE", "operator": "one-of", "values": ["ORDER_FLOW", "ALL"] }
}
```

| Field | Meaning |
|---|---|
| `variable` | `[A-Za-z_]\w*`. Read with the precedence of `{{variable}}` (extracted from a response > `vars.x` of a processor > data column > global variable), **when the group starts** |
| `operator` | `equals` and `not-equals` compare one value; `one-of` is true when the variable equals any of the values |
| `values` | Strings (trimmed, no blanks, no repeats), compared exactly: case-sensitive, as text (a number extracted from JSON compares as its text) |

The store turns a condition that cannot work (bad variable name, unknown operator, no values,
several values for `equals` / `not-equals`, not an object) into `null` rather than applying it
partly. The group editor reports the same problems before Run or View Script, so a half-typed
row is never dropped silently. The generator is stricter than the store: a condition it is
handed that cannot work, or that reads a variable not known when the group starts, is a 400
that names the group and the variable.

How it runs (`server/generator/run-if.js`): the requests of the group sit inside
`if (...) { ... }` in the default function, with their Before/After requests, processors,
assertions, request log, pauses, and gRPC calls. Requests of one group that are not next to
each other are separate runs, each checked when it starts. A variable that the group extracts
is declared above the block (`let name = "";`), so later requests can use `{{name}}`; when the
group does not run it stays empty (a real fallback value is a separate feature).

A data file with a `groupId` is read only when its group starts: inside the `if` when there
is a condition, and a data file of a turned-off group is not used at all. The row index still
comes from `exec.scenario.iterationInTest` (or `__VU - 1`), so it follows the iteration
number, not how many times the group ran.

## UI mode is not project data

The Simple / Advanced layout choice is never written to a project file, the
`/api/generate` or `/api/run` payloads, or `schemaVersion`. It lives only in the
browser as `localStorage['k6ui.uiMode']`, so the same file opens identically in
either mode. See [ui-modes.md](ui-modes.md).

## State boundary

`public/js/project-store.js` owns a normalized, deeply frozen snapshot (data files are normalized there too: defaults for missing fields, unique `ds_*` ids, a `groupId` that exists; a group's `runIf` is validated with `public/js/run-if.js`). `collectConfig()` updates the store from the form, while `applyConfig()` migrates and replaces state before rendering it into the form. Generator and runner payloads continue to use the same configuration semantics.

## Verification

```bash
npm test
npm run measure:baseline
```

The PR-02 browser smoke additionally verifies v1 migration, stable IDs across save/open, v2 download content, unknown-version errors, and zero browser runtime errors.
