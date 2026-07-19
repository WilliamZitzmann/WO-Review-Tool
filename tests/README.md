# Tests

Black-box jsdom tests. Each file loads the REAL source it's testing
(`worker.js`, `loader.js`, `wo_tool.js`) and drives it with mocked
`fetch`/`XMLHttpRequest`/`caches` and real DOM events — none of these are
reimplementations of the logic under test, so a bug in the real code shows
up here too, not just a bug in a hand-copied model of it.

## Setup

```
cd tests
npm install
npm test
```

## Files

- **`worker_test.mjs`** — `access-control/worker.js`. Routing, auth
  (root token + hashed email/password accounts), bucket containment, the
  per-bucket allowedFields checklist, the ancestor-prepend hardlock, org-config resolution
  (`/check-access`, `/org-config-content`), bucket-level contact-email
  resolution, the dual-mode Resend/temp-password admin account flow.
- **`harness.js`** — `wo_tool.js`'s Setup UI: custom tables, formula
  columns, domain-list caching, drag/reorder controls. Drives real button
  clicks against a real DOM, not a simulated one.
- **`org_config_harness.js`** — the full org-config consumption path: the
  first-run installer listing/installing an admin-published config,
  through the real live-fetch chain (whoami → bootstrap → check-access →
  org-config-content) at install time.
- **`loader_test.mjs`** — `loader.js`'s optimistic instant-launch flow:
  a returning user's cached tool runs immediately, the real access check
  still verifies in the background, a real deny tears the session down
  live, bucket-resolved contact-email caching (including the wipe-ordering
  bug this suite caught — see its own comments).

## `admin_html_test.mjs`

Not in this directory — `admin.html` lives in the **private** repo
(`WO-Review-Tool-Private`), so its test file lives there too, next to the
file it tests. `run-all.js` skips it automatically when run from this
(public) checkout.
