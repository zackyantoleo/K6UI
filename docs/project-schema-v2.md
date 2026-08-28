# K6UI project schema v2

PR-02 introduces a lightweight, versioned project state without adding a tree or framework.

## Compatibility

- Files without `schemaVersion` are treated as v1 and migrated when opened.
- Saving always emits `schemaVersion: 2`.
- Existing valid request IDs are preserved.
- Missing or duplicate request IDs are assigned deterministic, unique `req_*` IDs.
- Unknown schema versions fail with an actionable compatibility error instead of being applied partially.
- Imported objects are cloned; migration does not mutate caller-owned data.

## Minimal shape

```json
{
  "schemaVersion": 2,
  "scenario": {
    "requests": [
      {
        "id": "req_login",
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

## State boundary

`public/js/project-store.js` owns a normalized, deeply frozen snapshot. `collectConfig()` updates the store from the form, while `applyConfig()` migrates and replaces state before rendering it into the form. Generator and runner payloads continue to use the same configuration semantics.

## Verification

```bash
npm test
npm run measure:baseline
```

The PR-02 browser smoke additionally verifies v1 migration, stable IDs across save/open, v2 download content, unknown-version errors, and zero browser runtime errors.
