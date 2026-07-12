# WO Review Tool — Architecture Reference

Internal reference for how the tool actually works end-to-end. Not user-facing —
see `index.html` (the Guide) for that. **Keep this updated whenever the
architecture changes** (new services, new localStorage keys, new release
steps) — it should always describe the current system, not history.

For "how do I use it" content (rules, scans, hotkeys, etc.), see `index.html`.
For console-only escape hatches, see `CONSOLE_COMMANDS.md`. For the
permission-rule cookbook, see `access-control/PERMISSIONS_GUIDE.md`.

---

## 1. The three moving pieces

| Piece | Lives in | What it does |
|---|---|---|
| `bookmarklet.js` | public repo | Permanent, never-changing one-liner the user actually bookmarks. Fetches `loader.js` (cached fallback if offline), evals it. |
| `loader.js` | public repo | Real logic for domain-gating, whoami, and the access check. Fetched fresh (or from cache) on every click. |
| `wo_tool.js` | **private repo only** | The actual tool. Fetched through the Worker, never from a public URL. |

Split rationale: `bookmarklet.js` never changes so installing it is a one-time
action. `loader.js` is public because it has to run *before* we know if the
user is even allowed to see the tool (domain check, whoami, access request) —
nothing in it is sensitive. `wo_tool.js` is the actual product, gated behind
the private repo + Worker so a revoked user's cached copy of the bookmarklet
can't just keep working forever, and so the tool source + permission rules
aren't sitting on a public URL for anyone to read.

Real repos:
- Public: `github.com/WilliamZitzmann/WO-Review-Tool` — `bookmarklet.js`,
  `loader.js`, `version.json`, `index.html` (Guide), `access-control/`
  (Worker source + docs + a *template* permissions file), `CONSOLE_COMMANDS.md`,
  this file.
- Private: `github.com/WilliamZitzmann/WO-Review-Tool-Private` — `wo_tool.js`
  and the *real* `permissions.json` (real usernames/rules — never in the
  public repo).
- Worker: `wo-review-tool-access.williamzitzmann.workers.dev` (Cloudflare,
  free tier) — `access-control/worker.js`, deployed with `wrangler deploy`.

---

## 2. Boot sequence (what happens on every bookmarklet click)

```
bookmarklet.js
  └─ eval loader.js
       ├─ 15-min grant cache valid + tool source cached?
       │    └─ YES → skip ALL network, eval cached tool source immediately
       │    └─ NO  ↓
       ├─ GET /bootstrap  (Worker, edge-cached ~30s)  → { maximoHosts, requiredFields }
       ├─ domain check against maximoHosts
       │    └─ not on a known host → redirect (single host: automatic;
       │       multiple hosts: one-time picker, remembered after)
       ├─ read Maximo's own /maximo/oslc/whoami (client-side, same-origin)
       ├─ POST /check-access  { fields: <only the required subset> }
       │    └─ Worker evaluates permissions.json → { granted, grants, token? }
       ├─ granted? → cache grants (both __wo_grants and the 15-min
       │    __wo_grant_cache), restore any revoked-backup, then:
       │    GET /tool?token=...&version=X.Y.Z  (edge-cached: 1 day if
       │    pinned/tagged, 15s if tracking the branch HEAD)
       │    → eval the returned wo_tool.js
       └─ denied? → snapshot-then-wipe local config (revokeLocal), show
            "contact <email>" banner
```

Two independent things get "verified live" here, on different clocks:
- **Access itself** (granted/denied) — live every click, UNLESS the 15-min
  grant cache is still valid, in which case it's trusted without re-checking.
  This is a deliberate speed/freshness tradeoff — see §4.
- **wo_tool.js's own self-update check** (`checkForUpdate()`) — runs
  independently once the tool is running, regardless of the grant cache.

`wo_tool.js` has its own internal copy of the same whoami→check-access→token
dance (`getWorkerAccessToken()`), used only for self-update fetches
(`fetchToolSourceViaWorker()`). It updates the same `__wo_grants` key as a
side effect, but it is NOT the primary access gate — `loader.js` is.

---

## 3. Access control (Worker + permissions.json)

`access-control/worker.js`, three real endpoints plus `/feedback`:

- `GET /bootstrap` — public, returns `{ maximoHosts, requiredFields }`.
  `requiredFields` is computed from whatever fields the current rules
  actually reference, so the client only ever sends that subset of whoami
  data (data minimization — no encryption, since TLS already covers transit
  and there's nothing here a devtools-equipped user couldn't already see
  about their own session).
- `POST /check-access` — body `{ fields }`. Evaluates
  **override → blacklist → allow → deny**, each a short-circuiting check.
  Returns `{ granted, grants, token }`. `grants` is an array (e.g.
  `["user","dev","beta_0"]`), not a single tier — see §3.2.
- `GET /tool?token=...&version=X.Y.Z` — redeems the token, proxies
  `wo_tool.js` from the private repo. No version = branch HEAD (dev
  channel). A version requests that exact `vX.Y.Z` tag — **the private repo
  needs that tag pushed too**, see §6.
- `POST /feedback` — body `{ token, type, body, context }`. Reuses the same
  token as `/tool` (not a separate identity check — just stops the endpoint
  being an open unauthenticated relay). Files a GitHub Issue on the private
  repo via the same PAT (needs `Issues: Read and write` in addition to
  `Contents: Read-only`).

Tokens are stateless, HMAC-SHA256 signed, 2-minute TTL, no KV/session
storage (`makeToken`/`verifyToken`).

### 3.1 Edge caching

`cachedFetchPrivateFile()` wraps GitHub reads in Cloudflare's Cache API
(`caches.default`), keyed by path(+ref). `permissions.json` caches 30s;
`wo_tool.js` caches 1 day if a specific tag was requested (a tag is
immutable by convention — never re-point one after release) or 15s if
tracking the branch HEAD. This exists purely for speed — it does not change
what gets evaluated, just how often GitHub gets hit for the same content.
**Caveat:** `caches.default` is per-Cloudflare-data-center, not truly global
— first request at a new PoP still pays the GitHub round trip.

### 3.2 The grants model

Replaces an earlier single-`tier` design. `permissions.json`:

```jsonc
{
  "maximoHosts": [{ "hostname": "...", "url": "..." }],
  "override": [{ "username": "ZITZMWX", "grants": ["user"] }],  // bypasses blacklist
  "blacklist": [ [ { "field": "...", "op": "...", "value": "..." } ] ],  // OR of AND-groups
  "allow": [{ "grants": ["user"], "conditions": [ /* AND-group */ ] }],
  "extraGrants": { "ZITZMWX": ["dev", "beta_0"] }  // additive, merged onto whatever base grants matched
}
```

Precedence: **override → blacklist → allow → deny** (see `evaluateAccess`).
`resolveGrants()` merges the matching rule's base grants (default `["user"]`
if omitted) with anything in `extraGrants` for that username — this is how
one person ends up with `["user","dev","beta_0"]` without needing a
dedicated override entry for every combination.

`beta_0` is a wildcard: holding it satisfies any `beta_N` check
(`hasGrant()` client-side, same rule embedded in the Worker's own grant
resolution conceptually — the actual wildcard *check* happens client-side in
`wo_tool.js`/`loader.js`, the server just hands back whatever flags are
literally assigned).

Full cookbook (adding a beta tester, blocking someone, onboarding a second
company) lives in `access-control/PERMISSIONS_GUIDE.md` — don't duplicate
it here, keep that doc current instead.

### 3.3 Client-side grant handling

- `__wo_grants` (localStorage) — JSON array, written by both `loader.js` and
  `wo_tool.js` on every successful check. Read via `getGrants()`/`hasGrant()`
  in `wo_tool.js`.
- `getDevTier()` — compat shim over `hasGrant()`, returns `''` / `'beta'` /
  `'dev'` for old call sites (channel gating, pinned-version gating) that
  only ever needed one best tier. New code should call `hasGrant()` directly
  for a specific flag.
- `__wo_grant_cache` (localStorage, `loader.js` only) — `{ grants, cachedAt }`,
  15-minute TTL. A valid hit skips *all four* network calls in the boot
  sequence (§2), not just some of them — checked in `main()` before
  `/bootstrap` even fires, not only inside `proceedWithAccessCheck()`.
  Deliberate tradeoff: a revoke can take up to 15 minutes to land on a
  browser that already cached a grant, instead of the very next click.

---

## 4. Config model (what lives in localStorage)

| Key | Contents |
|---|---|
| `__wo_rules_config` | Groups, rules, field registrations |
| `__wo_scan_config` | Scan targets (tabs/dialogs), post-scan actions |
| `__wo_vars_config` | Variables |
| `__wo_field_config` | Registered field mappings (tab, label, DOM id) |
| `__wo_group_state` | Per-group collapsed/visible state, ordering |
| `__wo_settings` | Device-level: hotkeys, channel/pin, auto-scan, auto-backup, `betaEnabled` |
| `__wo_profiles` / `__wo_active_profile_id` | Named config snapshots |
| `__wo_grants` / `__wo_grant_cache` | Access grants + the 15-min cache (§3.3) |
| `__wo_tool_src` | Cached copy of the last-run `wo_tool.js` source |
| `__wo_revoked_backup` | Snapshot taken on revoke, restored on next regrant |

**Profile vs. Settings split**: a profile only ever carries
`PROFILE_SETTINGS_KEYS` (`msgPrefix`, `msgSuffix`, `msgDelim`, `autoScan`) —
applying a profile MERGES into `__wo_settings`, never replaces it, so
switching profiles can't silently reset your hotkeys, update channel, or
`betaEnabled`. **Any new device-level setting must NOT be added to
`PROFILE_SETTINGS_KEYS`** unless it's genuinely meant to travel with a
profile.

**Config version migrations**: `CURRENT_CONFIG_VERSION` + `CONFIG_MIGRATIONS`
(keyed by version), run via `migrateProfile()` on every profile load/import.
No migrations exist yet (only one config shape has ever shipped) but the
plumbing is live — add an entry here whenever a config shape change needs
one.

### 4.1 The `openSetup()` shared-`st` gotcha

`openSetup()` hoists **one** `st` object (read once from `__wo_settings`,
around the modal-open point) that every tab function (`settingsTab`,
`betaTab`, the hotkey cards, etc.) reads and writes via closure — this is
what lets a staged channel/version change survive switching tabs before
Save & Apply. **Any new tab that touches settings must use this same
shared `st`, never its own fresh `JSON.parse(localStorage...)` read** — a
local shadow copy will get silently clobbered the moment Save & Apply
persists the *shared* object back to localStorage. (This exact bug shipped
once, in the Beta tab, and was fixed in v0.21.2 — see the version.json
changelog for that release before repeating it.)

---

## 5. Rule / scan engine

- **Rules** (`cfg.rules`) — a `formula` string, evaluated with the helper
  functions (`F`, `T`, `V`, `hours`, etc. — see the Guide's Formula
  Reference for the full list and user-facing semantics) against whatever
  the last scan captured (`cache`). Returns `true`/`false`/`'warn'`/`'na'`
  or throws (→ error status).
- **Variables** (`cfg.vars` via `getVars()`) — same environment, return any
  value, evaluated before rules so rules can reference them via `V()`.
- **Scan targets** (`scan.scans`) — visited in order by `runScan(done, mode)`.
  `mode` is `'scan'` (default) or `'fix'` (beta_1 only — see §6). Each
  target: `type` (`tab`/`dialog`), `tabId`/`eventType`, `waitFor`/`waitTable`,
  `condition` (lazily evaluated right before that step, so a later step can
  see data an earlier step in the *same run* just captured), `rowDetailFields`,
  `actions` (post-scan field-fill actions).
- **`runActions(step, mode)`** — executes `step.actions`. Each action has
  `fieldId`, `value` (a formula string), `condition` (optional gate), and
  `runOn` (`'both'` default / `'scan'` / `'fix'` — only rendered/editable in
  the Scan tab UI when beta_1 is on, but the field itself is preserved
  untouched in a non-beta user's config either way — it just never gates
  anything if beta_1 is off, since `mode` is always `'scan'` for them).
- **Table capture** — read directly off the live DOM (`findAllDocs()` walks
  every frame), keyed by column header, exposed via `T()`/`rowCount()`/`col()`/`has()`.

---

## 6. Beta feature framework

Two independent gates, both required for a feature to do anything:

1. **Server grant** — `hasGrant(featureId)` (permissions.json says this user
   qualifies at all, possibly via the `beta_0` wildcard).
2. **Local enablement** — `st.betaEnabled[featureId]`, a device-level
   on/off flipped in the Beta tab.

`isBetaFeatureOn(id)` is the ONLY check any feature's own code should ever
call — never `hasGrant()` alone — so "granted but disabled" is
indistinguishable from "never granted" everywhere in the UI.

`BETA_FEATURES` registry (`wo_tool.js`) — one entry per feature: `id`
(= the grant flag, e.g. `"beta_1"`), `label`, `description`. The Beta tab
just lists whichever entries the user `hasGrant()`s for, with a checkbox.
**A feature's own settings live wherever they naturally belong** (e.g. the
Fix hotkey sits right next to the Scan hotkey), marked with a `.wo-beta-pill`
"BETA" tag — never centralized in the Beta tab itself.

Current features:
- `beta_1` — Route symbol + Fix action (rescan + reapply "Fix"/"both"
  actions) next to Return/Approve, plus the Scan tab's per-action "Run on"
  option. See `HOTKEY_ACTIONS`'s `fix` entry and the `betaRouteOn` branch in
  the main panel's footer-building code.

**Adding a new feature**: add a `BETA_FEATURES` entry, gate every bit of its
UI/behavior behind `isBetaFeatureOn(newId)`, and if it needs its own hotkey
add a `HOTKEY_ACTIONS` entry with `betaFeature: newId` (see `hotkeyActionActive()`).

---

## 7. Hotkeys

`HOTKEY_ACTIONS` registry (top of `wo_tool.js`) — each entry: `id`,
`settingsKey` (its own top-level `__wo_settings` field, not nested — matches
the original single-hotkey convention so it stays device-level
automatically), `label`, `defaultHotkey`, optional `betaFeature`, `run()`.

`applyHotkeys()` builds one `document`-level keydown listener covering every
*currently active* action (`hotkeyActionActive()` — always true for a
non-beta action, requires `isBetaFeatureOn()` for a beta one). The Settings
UI is what actually enforces "no two actions share a combo" (rejects the
assignment with an inline error) — the listener itself just trusts that
invariant and does a straight combo→action lookup. The listener explicitly
ignores keydowns while `document.activeElement` is an editable control
(input/textarea/select/contenteditable) — added once Fix could silently
overwrite fields with no confirmation, unlike Return/Approve which confirm.

---

## 8. UI structure

- Three independently CSS-isolated top-level containers: `#__wo_dock` (main
  panel), `#__wo_setup_modal` (Setup), `#__wo_field_browser` (field picker).
  Each resets inherited host-page styles via
  `#id, #id *:not(svg,svg *){all:revert;...}` — always a comma-list, never
  chained `:not()`s (chaining sums specificity and breaks later plain-selector
  rules).
- Icons are stroke-only SVG (`stroke="currentColor"`, never `fill`) — a
  Chromium repaint bug misrenders `fill` cascades against a competing
  host-page rule even when the tool's own rule wins on specificity.
- Shared drag-and-drop reorder (`attachCardDrag`/`startPointerCapture`) —
  duplicated once for the main panel (outer scope) and once inside
  `openSetup()` for Setup's cards; kept manually in sync. Uses a
  deferred-arm pattern (~180ms after crossing the drag threshold) so a
  collapse-animation of sibling cards has time to settle before reorder math
  engages.
- `animateBodyToggle(body, expand)` — shared expand/collapse height
  transition, duplicated the same way (outer scope + inside `openSetup()`).
- `animateSwap(...)` — FLIP-style animation for move-up/down button clicks.

---

## 9. Release process

**Every release needs the same `vX.Y.Z` tag pushed to BOTH repos**, or
pinned-version installs / the Worker's `?version=` param silently fail to
resolve on whichever repo is missing it. Order that's been safe in practice:

1. Bump `TOOL_VERSION` in `wo_tool.js`, add a `version.json` entry (public repo).
2. Copy `wo_tool.js` into the private repo checkout, commit, tag `vX.Y.Z`, push (main + tag).
3. If `access-control/worker.js` changed: `wrangler deploy` (needs
   `CLOUDFLARE_API_TOKEN` set — not persisted across sessions, the user
   re-provides it each time it's needed).
4. Commit + tag + push the public repo (main + tag).
5. Smoke-test: `curl /bootstrap`, `curl -X POST /check-access`, then
   `curl "/tool?token=...&version=X.Y.Z"` and grep for the expected
   `TOOL_VERSION` string in the response.

Skipping step 2 (or tagging only one repo) is the single most likely release
mistake — check both tags exist before considering a release done.

---

## 10. Known rough edges (not bugs, just worth knowing)

- `EPHEMERAL_KEYS` (the "don't back this up on revoke" exclude-list) is
  hand-duplicated between `loader.js` and `wo_tool.js` — any new
  ephemeral-but-not-real-config key has to be added to both manually.
- `caches.default` (Worker edge cache) is regional, not global — see §3.1.
- `version.json` grows unbounded — nothing trims old entries.
- Feedback issues get no labels — could auto-tag `type:bug`/`type:suggestion`
  in the private repo if labels are ever set up there.
