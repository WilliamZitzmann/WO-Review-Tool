# Tests

Black-box jsdom test. Loads the REAL source it's testing (`worker.js`) and
drives it with mocked `fetch`/the GitHub API and real requests — not a
reimplementation of the logic under test, so a bug in the real code shows up
here too, not just a bug in a hand-copied model of it.

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

## Everything else moved to the private repo

`harness.js`, `org_config_harness.js`, `loader_test.mjs`,
`update_defer_test.js`, `sync_whoami_mapping_test.js`,
`config_version_test.js`, `revoke_banner_test.js`, `feedback_tab_test.js`,
`org_config_bucket_label_test.js`, `profiles_kebab_test.js`,
`scanlog_minimize_test.js`, and `admin_html_test.mjs` all load
`wo_tool.js`/`loader.js`/`admin.html` directly off disk
(`fs.readFileSync('../wo_tool.js')` etc.) — now that those three files are
edited only in the **private** repo (`WO-Review-Tool-Private`), the tests
that load them live there too, next to the files they test. See that repo's
`tests/README.md`.
