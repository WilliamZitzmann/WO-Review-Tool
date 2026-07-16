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

### 4.2 Save & Apply dirty-tracking

`#__s_save` is disabled whenever `JSON.stringify({cfg, scan, st})` still
matches the snapshot taken at `openSetup()` time — a whole-object compare,
not per-field dirty flags, so it **automatically covers any setting added
later with no extra wiring**. Re-checked via a debounced (150ms)
`MutationObserver` on `#__s_content` (catches drag-reorder, add/delete rows,
toggles) plus a plain `input`/`change` listener (catches keystrokes, which
don't touch the DOM tree). One harmless quirk: a few settings (e.g.
`settingsTab`'s hotkey/message fields) already auto-persist on `input` via
their own listener, so the button can go "dirty" even though that particular
edit is already saved — clicking Save & Apply again just re-saves the same
data.

**Save & Apply no longer closes the modal** — it persists, re-renders the
main panel, then refreshes whichever Setup tab is currently active in place
(via a `tabFns` map populated by `bindTab`), restoring scroll position, then
re-takes `__woSetupSnapshot` and re-runs `updateSaveButtonState()` so the
button goes grey again immediately rather than staying enabled. Guide and
Feedback are excluded from the refresh: Guide's "render" is `window.open()`
(would spawn a new tab on every save), and Feedback would wipe an
in-progress draft. **Any future change to this handler must keep
re-snapshotting after save** — skip it and the grey-out from §4.2 breaks
(the button would stay permanently enabled after the first save, since the
snapshot would never again match the live objects).

**Button label is just "Save"** (v0.24.0; renamed from "Save & Apply" — it
always did both in one action, so a second word added nothing). Hovering it
runs `setupChangedAreasText()`, which re-parses `__woSetupSnapshot` and
diffs `cfg.rules`/`cfg.groups`/`scan`/`st` against the live objects — a
**coarse, top-level diff** ("Rules", "Groups", "Scan targets & actions",
"Settings"), not per-field, on purpose: per-field would mean hand-listing
every property, defeating the whole-object-compare design in §4.2. Variables
are deliberately excluded from this list — `saveVars()` already persists on
every keystroke (see §4.4), so they're never part of what this button
actually applies.

**Closing with unsaved changes** — `#__s_close` now calls `isSetupDirty()`
(same compare as `updateSaveButtonState()`, factored out so both share one
definition) before removing the modal. If dirty, `showUnsavedChangesDialog()`
shows a small overlay **appended as a child of `#__wo_setup_modal` itself**
(so it inherits that root's `--wo-*` CSS reset/tokens) with Cancel / Discard
& Exit / Save buttons — a custom `pointer-events`-blocking overlay, not
`confirm()`, per the standing "no browser-chrome dialogs" preference for
this UI. Save re-uses the existing `#__s_save` click handler
(`.click()`) rather than duplicating its logic, then closes. **Only the
Close button is gated** — the Settings tab's Reset/Full-Reset paths
(`#__st_reset_all` etc.) call `modal.remove()` directly and deliberately stay
that way: they've already destroyed the config being asked about, so there's
nothing left to warn about saving.

### 4.3 Reset / Uninstall (Settings tab)

Two buttons, both explicitly framed as resets, not permanent removal — the
bookmarklet always reinstalls on the next click, so nothing can be removed
from a page you don't control:
- **Reset Tool (Keep My Config)** — same snapshot-then-wipe-all-`__wo_`-keys
  pattern as `revokeAccessLocally()`/`revokeLocal()` (§3), reusing
  `EPHEMERAL_KEYS`/`REVOKED_BACKUP_KEY`. `loader.js`'s
  `restoreFromRevokedBackupIfAny()` picks the snapshot back up automatically
  on the next successful grant check — no separate restore path needed.
- **Full Reset (Erase Everything)** — same as the existing `window.__woReset()`
  console helper: wipes every `__wo_` key AND deletes the `__wo_tool_db`
  IndexedDB database (forgets the linked backup-file handle), no snapshot.
  Double-confirms since there's no way back.

### 4.4 Per-entry tooltips (Rules/Groups/Variables/Scan)

Each entry can carry an optional `.tooltip` string (`rule.tooltip`,
`group.tooltip`, `v.tooltip`, `s.tooltip`) — same property name everywhere,
including Groups' pre-existing `tooltip` field (already used for the main
panel's group-header hover icon; the Setup-tab icon added alongside it is a
separate, new location, not a duplicate feature). Three shared helpers
(defined once, right after `thWithTip`, reused by all four tabs):
- `entryTipIconHtml(entry)` — returns the icon's HTML, or `''` if the entry
  has no tooltip text. **The icon is never emitted as hidden-but-present**;
  an entry with nothing set gets no icon in the DOM at all.
- `wireEntryTipIcon(box, entry)` — attaches the floating tooltip to whatever
  `entryTipIconHtml()` rendered (a no-op if it rendered nothing).
- `wireEditTooltipKebabItem(menu, entry, entryLabel, rerenderFn)` — wires the
  4th kebab-menu item (alongside Rename/Duplicate/Delete) to a `prompt()`-based
  editor. A plain prompt rather than an inline field — four near-identical
  call sites, not worth a richer editor for one short text value.
- `editTooltipKebabHtml(entry)` (v0.24.0; was the static const
  `EDIT_TOOLTIP_KEBAB_HTML`) — now a function so the label can read "Set
  Tooltip" when `entry.tooltip` is empty/falsy and "Edit Tooltip" once one's
  set. Called at menu-build time (`editTooltipKebabHtml(v)` /
  `(rule)`/`(group)`/`(s)`), so it must be re-called on every kebab-menu
  rebuild — the label is a snapshot of `entry.tooltip` at that moment, not
  reactive.

The icon itself only becomes visible on `[data-reorder-card]:hover` /
`:focus-within` (`.wo-entry-tip-icon`, CSS), the same show-on-card-hover
treatment as the existing drag-handle/move-buttons — so a long list of
entries with tooltips set doesn't look any busier at rest than one without.

**Adding tooltip support to a new Setup entry type**: give it a `.tooltip`
field, call `entryTipIconHtml(entry)` right after the title in its header
markup, call `wireEntryTipIcon(box, entry)` after the card is built, and add
`editTooltipKebabHtml(entry)` + `wireEditTooltipKebabItem(...)` to its kebab
menu alongside the other three items.

### 4.5 Delete confirmations

Every kebab-menu Delete action (Variables, Rules, Groups, Scan-steps, plus
the pre-existing Profile delete) is gated behind a `woConfirm('Delete <kind>
"<label>"?')` — the splice-and-rerender only runs in the `.then(ok => ...)`
callback, never unconditionally. Added v0.24.0 after an audit found several
delete paths had no confirmation at all (a single misclick removed a rule or
group with no undo). **Any new deletable entry type must follow the same
pattern** — wrap the existing removal logic in a `woConfirm()` gate rather
than calling it straight from the kebab item's `onclick`.

### 4.6 Table display names (`cfg.tableNames`)

Maximo's scraped table identifiers are frequently opaque hashes (e.g.
`m69f3c12d`) rather than human-readable names. `friendlyTableName(cfg, id)`
is a pure **display-layer** lookup — `cfg.tableNames[id] || KNOWN_TABLE_NAMES[id]
|| id` — it never rewrites what's actually stored in `group.table`,
`waitTable`, or a Row Detail Field's `tablePrefix`; those keep referencing the
raw id so scan logic never has to care about the friendly name at all.
- `KNOWN_TABLE_NAMES` — a small hardcoded map of built-in friendly names
  shipped with the tool (currently just `m69f3c12d → 'Downtime History'`).
- `cfg.tableNames` — a per-profile user override registry (`{}` by default),
  edited from the new **Tables** Setup tab (`tablesTab()`, between Scan and
  Profiles) rather than the new-installs-only DEFAULT_CFG path (§ below) —
  renaming a table is a live, per-profile edit any existing install can use
  immediately, unlike the DEFAULT_CFG label shortening.
- `tablesTab()` builds its list by walking `cfg.groups` (`.table`) and
  `scan.scans` (`.waitTable`, each `.rowDetailFields[].tablePrefix`) to find
  every id actually referenced, showing where each is used
  (`Groups: ...` / `Scan: ...`) next to an editable "Display name" input.
  A table with no override and no `KNOWN_TABLE_NAMES` entry shows its raw id
  as the input's placeholder.
- The Groups tab's Table `<select>` renders `friendlyTableName(cfg, t) + '
  (' + t + ')'` when the friendly name differs from the raw id, so the raw
  identifier stays visible/searchable even once renamed.

### 4.7 Custom tables (`cfg.customTables`) + `lookup()`

Not every lookup table comes from a Maximo scan — `cfg.customTables` (added
alongside the Tables tab work, same tab) is a per-profile registry of
hand-entered tables (part numbers, cost centers, anything static) that
formulas can read exactly like a scanned one.
- Shape: `cfg.customTables[id] = { columns: [...], rows: [{...}, ...] }` —
  rows are plain objects keyed by column name, the same row shape
  `cache.tables[t]` already uses, so every existing table helper works on a
  custom table with zero special-casing.
- `id` is fixed at creation (`/^[A-Za-z0-9_]+$/`, checked for collision
  against both other custom tables and every scanned id currently in use) —
  it's what a formula actually references via `T(id)`/`lookup(id, ...)`, so
  unlike `cfg.tableNames`' friendly-name layer, renaming it after the fact
  would silently break any formula already written against it. Only the
  columns/rows/cell values stay editable afterward.
- `buildCtx()`'s `T(t)` is the single fusion point: it returns
  `data.tables[t]` (the scan cache) if that id was actually scanned this
  run, otherwise falls back to `getCfg().customTables[t].rows` — a scanned
  table always wins if the same id somehow exists in both places. This is
  also why a custom table resolves correctly even pre-scan: `data.tables` is
  empty before the first scan, but `cfg.customTables` comes from config, not
  the cache, so it's available immediately.
- `lookup(table, keyCol, keyVal, returnCol)` — added alongside custom
  tables as the actual "look up value A, return column B" primitive the
  feature exists for; a linear scan via the same `T()`, so it works
  identically on a scanned or custom table. Wired into `ARGN`/both `av`
  arrays (`runVariable`/`runFormula`, plus the two inline copies in
  `runActions()`/`formulaBool()`'s condition evaluator — all four literal
  arrays must stay in sync, there's no shared constant for them), `HELPER_REF`
  (signature tooltip), `completionSource()` (its first arg gets the same
  table-name completion dropdown as `T(`), and index.html's Formula
  Reference — same sync rule as every other helper (§5.2).
- `fieldKeyOptions()` (the source both the Groups Table `<select>` and the
  formula-assist autocomplete read from) merges `Object.keys(cfg.customTables)`
  into its table list, so a custom table id shows up everywhere a scanned
  one would — completion, the Table dropdown, everything — without either
  UI needing to know which kind of table it's looking at.
- Deleting a custom table (Tables tab, kebab-style delete on the table's own
  card) goes through the same `woConfirm()` gate as every other delete
  (§4.5) — its wording explicitly warns that a formula referencing it will
  start returning empty results, since unlike a Rule/Group there's no
  natural "nothing references this anymore" signal to check first.
- **Grid editing (v0.25.1)**: the table itself renders as a real bordered
  grid (`.wo-ct-grid`, a genuine `<table>` with per-cell borders and a
  shaded header row) rather than floating inputs each carrying their own
  delete button — meant to read as a spreadsheet, not a stack of controls.
  Every structural edit (add/delete row, add/delete column, clear a cell)
  moved off visible buttons entirely and into a right-click context menu,
  `ctGridContextMenu(e, t, hit)` — `hit` is `{ci}` for a header `<th>` or
  `{ci, ri}` for a data `<td>`, found via `e.target.closest()` on a single
  `contextmenu` listener on the table (not one listener per cell). Reuses
  the same shared `openRuleMenu`/`closeRuleMenu` single-open-menu variable
  and `.wo-kebab-menu`/`.wo-kebab-item` styling every other kebab/context
  menu in Setup already uses, positioned at the cursor (`e.clientX/clientY`)
  the same way the tab-bar's right-click mode menu does. "Delete Column" is
  omitted from the menu entirely (not just disabled) when only one column
  remains, same guard the old visible-button version had. "Delete Cell"
  clears that cell's value only (`delete row[colName]`) — there's no
  structural "shift cells" concept in this row-of-plain-objects model, so
  it behaves like pressing Delete on a spreadsheet cell, not Excel's
  shift-up/shift-left variant. Column rename and cell-value `oninput`
  handlers now resolve their row/column index via `input.closest('th'|'td')`
  instead of an index baked onto the `<input>` itself — no behavior change,
  just following the markup restructure.

### 4.8 API tables (`cfg.apiTables`, beta_2, v0.25.0)

A third table source alongside scanned and custom tables (§4.6/4.7): a named
config entry that resolves live via Maximo's own OSLC REST API instead of a
DOM scan or hand-typed rows, but reads through `T()`/`lookup()`/`col()`/
`has()`/`count()`/`rowCount()` exactly like either of those — no helper has
any special-casing for where a table actually came from.
- Shape: `cfg.apiTables[id] = { source: 'assetWO'|'assetDowntime',
  assetFormula, siteFormula, limit }`. `assetFormula`/`siteFormula` are
  themselves formula strings (evaluated via `runVariable()`, not stored as
  static values), so the same API table definition can resolve to a
  different asset/site per WO reviewed — e.g. `assetFormula: "F('ASSETNUM')"`
  picks up whatever asset the currently-open WO is on.
- `buildCtx()`'s `T(t)` gained a third fallback: scanned → custom →
  `resolveApiTable(t, cfg.apiTables[t], data)`. Checked last since it's the
  only one of the three that can be genuinely slow/async-backed.
- `resolveApiTable(id, def, data)` — gated by `isBetaFeatureOn('beta_2')`
  same as every other beta_2 capability (returns `[]` immediately if off).
  Evaluates `assetFormula`/`siteFormula` via `evalApiTableExpr()` (a thin
  `runVariable()` wrapper returning `''` on error/blank rather than
  throwing); if either resolves empty, returns `[]` without ever touching
  the network — so an API table on a WO with no asset just reads empty, not
  broken.
- **`betaApiTableCache`** — same per-argument-combination, placeholder-on-
  kickoff pattern as `betaAssetWoCache`/`betaAssetDowntimeCache` (§6), keyed
  by `id + assetnum + siteid + limit` so two different API table configs
  pointed at the same asset don't collide, and a formula re-evaluated
  mid-render doesn't fire a duplicate fetch for a request already in flight.
  Delegates the actual request to the same ungated `fetchAssetWOHistoryRaw()`/
  `fetchAssetDowntimeHistoryRaw()` used by the standalone `assetWOHistory()`/
  `assetDowntimeHistory()` helpers and by `__woProbeAsset()` — one fetch
  implementation, three call sites. Cleared at the top of every `runScan()`
  alongside the other two beta_2 caches, same reasoning (§6): without this,
  a rescan would keep serving first-fetch-of-the-session REST data forever.
- Editable from the Tables tab's new "API Tables" section (own BETA pill,
  same `data-beta-pill-tip` convention as Post-Scan Actions/Run-on column) —
  a card per entry with a Source `<select>`, the two formula boxes (wired
  through `attachFormulaAssist`, so they get the same autocomplete/signature
  tooltip as any other formula field), and a Limit input (assetWO source
  only). `id` creation follows the same collision/format rule as custom
  tables (§4.7) — checked against `cfg.apiTables`, `cfg.customTables`, and
  every scanned id currently in use.
- `fieldKeyOptions()` merges `Object.keys(cfg.apiTables)` into the shared
  table-name list, same as the existing customTables merge (§4.7), so an API
  table id shows up in `T(`/`lookup(`/`count(` completion and the Groups
  Table `<select>` without either UI needing to know it's API-backed.

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
  `runOn` (`'both'` default / `'scan'` / `'fix'`). The entire Post-Scan
  Actions feature — editor AND execution — is gated behind `beta_1`
  (`runActions()` no-ops immediately if `!isBetaFeatureOn('beta_1')`, and the
  Scan tab renders a "enable Fix beta feature" notice instead of the editor).
  Untested alongside Fix, same reasoning. A non-beta user's existing
  `s.actions` config is left untouched in storage — it just goes dormant,
  never deleted.
- **Table capture** — read directly off the live DOM (`findAllDocs()` walks
  every frame), keyed by column header, exposed via `T()`/`rowCount()`/`col()`/`has()`.

### 5.1 Editable return message

The Quick Return box (`.wo-qr-box`, a `<textarea>` since v0.23.0) is
editable — Return (button or Alt+R) and Copy (button or Alt+C) both use
exactly what's in the box, not a value recomputed fresh.
`currentReturnMsg` (module scope, `null` until the user types) is the single
source of truth, read via `currentOrComputedReturnMessage()` — **never read
the DOM textarea directly** for this: Alt+C/Alt+R are hotkeys and can fire
while the panel is collapsed and the textarea doesn't exist at all.
- `null` → `buildReturnMessage()` (freshly computed from current rule
  results) is used.
- Non-null → the user's exact edited text is used, verbatim, until the next
  real scan.
- Reset point: the top of `runScan()`, alongside the `cache`/`scanLog`
  reset — a fresh scan always starts from a freshly computed message again,
  but an *incidental* re-render (toggling a group, Setup Save & Apply, etc.)
  does NOT reset it, so an in-progress edit survives those.
- The textarea's `oninput` is what keeps `currentReturnMsg`, the box's empty/
  non-empty styling, AND the Copy button's disabled state all in sync live —
  typing into an empty ("no failed rules") box has to re-enable Copy
  immediately, not just on the next render.
- `copyReturnMessage()` is the one clipboard implementation, shared by the
  Copy button's click handler and the `copyReturn` hotkey action — don't
  duplicate the temp-textarea/execCommand dance a second time anywhere.

### 5.2 Formula autocomplete + signature tooltip (v0.24.0)

One parser, `parseFormulaContext(text, pos)`, drives both an F(/T(/V(
completion dropdown and an Excel-style signature tooltip for every helper —
so they can never disagree about what the cursor is inside. It scans
backward from the cursor for the nearest **unclosed** `(` and the identifier
before it, and counts top-level commas between that `(` and the cursor to
get an arg index, returning `{func, argIndex, argStart, prefix}` (or `null`
outside any call). Deliberately naive about parens inside string literals
(e.g. `F('a)b'`) — degrades to "no context" rather than throwing, which is
fine since the fallback (no popup) is harmless. Unit-tested in isolation
(not from a browser) before shipping since it's the one piece of pure,
easily-wrong logic in this feature.

`attachFormulaAssist(el)` wires both UI pieces onto one field:
- `argIndex === 0` **and** `func` is `F`/`T`/`V` → completion dropdown,
  sourced from `opts.fields`/`opts.tables`/`getVars().map(v => v.label)`,
  substring-filtered against `ctx.prefix`, click-to-insert.
- Otherwise, if `func` is any key in `HELPER_REF` (the full helper list —
  `F`, `T`, `V`, `rowCount`, `col`, `has`, `hours`, `hoursBetween`, `oneOf`,
  `contains`, `matches`, `isEmpty`, `notEmpty`, `maxLaborHours`) → signature
  tooltip, current arg bolded via `→`. **Keep `HELPER_REF` in sync with
  `index.html`'s Formula Reference table** — same source of truth, two
  copies, no shared code between the client tool and the static Guide page.
- Insertion writes `el.value` directly then **dispatches a synthetic
  `input` event** — every one of these fields already has its own `oninput`
  that persists the edit into `cfg`/`scan`; a bare `.value` write doesn't
  fire it, so skipping the dispatch would make the completion look right
  and silently not save.
- Dropdown/tooltip are `position:fixed`, appended to `document.body` (like
  `attachTooltip`'s floating tip), anchored below the field's own
  `getBoundingClientRect()` — **not** the caret's pixel position, which
  would need a hidden mirror-`<div>` to compute reliably. Flips above the
  field if there isn't room below (checked against `window.innerHeight`).
  Because they're outside `#__wo_setup_modal`, they use **hardcoded hex
  colors matching that root's `--wo-*` token values**, not `var(--wo-*)` —
  those custom properties don't cascade to a `document.body` child.

**Wired at every genuine formula/condition field** — Rules/Variables
`[data-f]`, a rule's per-Long-entry `[data-cond]`, a scan target's own
condition (`[data-f]` via `formulaBox`), Scan Actions' `[data-act-val]`/
`[data-act-cond]`, and Row Detail Fields' `[data-rdf-cond]`. **Deliberately
not wired** on plain text fields — labels/titles, Prefix/Suffix, the Install
tab's raw-source paste box, or message boxes' `[data-msg]`/`[data-short]`/
`[data-ret-custom]` (those are plain string templates, not formulas — see
§5.3).

### 5.3 Redundant status text (v0.24.0)

The main panel's rule rows lean on color/icon as the primary status signal
now, not a repeated word — added as part of a broader text-reduction pass.
Two independent changes in the same render block:
- **`na` rows with no custom message** — if a rule's status is `'na'` AND its
  `detail` is exactly the generic string `'Not applicable'` (i.e. the rule
  author never set a custom N/A message), the whole `.wo-rule` row gets
  `opacity:0.5` instead of rendering "— N/A" text. A formula that resolves to
  `'na'` but supplies its own detail text still shows that text — only the
  boilerplate default is suppressed.
- **Pass/fail/warn bare labels** — `'✓ OK'` collapses to a bare `'✓'`,
  and fail/warn similarly drop the generic `'Failed'`/`'Warning'` filler down
  to just their icon (`'✗'`/`'⚠'`), **only** when there's no rule-specific
  short message configured for that outcome. A rule with its own configured
  short text for a given outcome still shows it next to the icon exactly as
  before — this only removes the boilerplate default, it doesn't hide
  anything the rule author actually wrote. **Verify this against a real scan
  before trusting it** (pass=✓, fail=✗, warn=⚠, na=dimmed) — this logic was
  checked by re-reading `runFormula`'s generic-string branches, not exercised
  in a browser.

### 5.4 Unwrapped-helper warning in message boxes (v0.24.0)

Message boxes (`[data-short]`, a Long entry's `[data-msg]`,
`[data-ret-custom]`) only evaluate text inside `{{expr}}` spans — anything
else is shown to the user literally. `wireUnwrappedHelperWarning(inputEl,
afterEl?)` shows a small inline hint whenever the field's value contains a
call to a known helper name (`hasUnwrappedHelperCall()`, same `HELPER_REF`
name set as §5.2) **outside** any `{{...}}` span — a likely sign someone
meant to interpolate a formula and forgot the braces. Non-blocking (doesn't
stop saving) since it's a heuristic that can false-positive on ordinary
prose containing "(" near one of the shorter helper names (`F`, `T`, `V`,
`has`). The optional `afterEl` param exists because a Long entry's
`[data-msg]` is one of several flex children in an inline row — inserting
the warning `afterend` of the input itself would make it a 4th flex item in
that row instead of a full-width line below it; callers there pass the
wrapping `row` element instead.

### 5.5 Telling an intentionally-skipped table apart from a broken one

A group's linked table showing 0 rows is ambiguous on its own: it could mean
the owning scan step never ran this pass (its `condition` was false — fully
expected, e.g. no downtime to check this run) or that something genuinely
failed to capture. Before this fix, `captureTablesAndFields()`'s raw
diagnostic string (`'Table "id" - 0 rows (prefix: ...)'` or `'... not
rendered'`) was shown to the user in red regardless of which case it was —
scary and wrong for the common, intentional case.

`tableRunStatus(tableId, scanCfg)` resolves the ambiguity: it finds the
`scan.scans` entry (if any) whose `waitTable` matches the table id, then
looks up that step's own `scanLog` entry for the run that just completed
(matched by exact `title` equality — a dialog step's `' (nav)'`/`' (close)'`
suffixed entries are deliberately excluded by this, since only the plain-
title entry carries the final skipped/OK/TIMEOUT/FAILED outcome). The
render-time check (`render()`, the `group.table` block) only shows an error
when that status is `'unknown'` (no step owns this table id at all — 0 rows
is genuinely unexpected) or starts with `TIMEOUT`/`FAILED`. `'skipped ...'`
(condition false, intentional) and `'OK ...'` (the step ran; the table's
just legitimately empty this time, e.g. no downtime logged) both fall
through to the same plain muted "No rows" the empty-but-no-error case
already used — no red text, no boilerplate id/prefix string. When an error
is shown, the wording is a fixed friendly string ("Couldn't load this table
— try rescanning."), never the raw prefix/id — that diagnostic detail is
still available via `window.__woDebugTables()`/console for anyone who needs
it. **Only matches by `waitTable`** — a table populated purely via a
`rowDetailFields[].tablePrefix` (no step actually waits on it directly) or a
step using `waitFor` text instead of `waitTable` won't resolve to a step at
all and falls to the `'unknown'`-is-an-error default; this covers the
reported case (default config's downtime step sets `waitTable`) but isn't a
complete solution for every possible scan config shape. **Not yet verified
in a browser** — confirm with one real scan (both a skipped-condition run
and a normal run) before trusting it fully.

### 5.6 New formula helpers + opt-in `whoami()` (v0.25.0)

Thirteen new helpers were added alongside `lookup()`: `count`, `ifBlank`,
`trim`, `upper`, `lower`, `left`, `right`, `mid`, `sum`, `avg`, `today`,
`daysBetween`, and `whoami`. Two more, `toNumber`/`toString` (v0.25.1),
followed the same pattern — explicit type conversion for a formula, since a
captured Maximo field is always a string even when it looks numeric.
`toNumber()` reuses `toNumOrNull()` (the same comma-stripping numeric
parse `sum()`/`avg()` already used internally), returning `null` rather
than `NaN` on a non-numeric value so `isEmpty()`/`ifBlank()` compose with it
naturally. All follow the existing §5.2 pattern — added to `buildCtx()`'s
return object, `ARGN`, all **four** literal `av` arrays (`runVariable`,
`runFormula`, `runActions()`'s condition evaluator, and the scan-step
condition evaluator — there's no shared constant for these, they have to be
kept in sync by hand), `HELPER_REF`, and index.html's Formula Reference.
`mid()` is 0-indexed (JS `substr` convention), not Excel's 1-indexed `MID`
— deliberate, since this formula language already mirrors real JS elsewhere
(regex helpers, `has()`'s real `.indexOf`).

`whoami(field)` is architecturally different from the other twelve — it's
the one helper backed by an **async, opt-in-gated** data source instead of
already-captured synchronous `cache`/`cfg` data:
- **Gate**: `st.whoamiInFormulas` (Settings > Display, off by default).
  Unlike the Feedback tab's PII checkbox (§10), this isn't about data
  leaving the laptop over the network — `whoami()` never makes a new
  network call, it reads the same same-origin `/maximo/oslc/whoami`
  endpoint `readWhoamiCanonical()` already uses for the access check. The
  risk this gate exists for is **display exposure**: a rule/message using
  `whoami('email')` could paste a name/email into a permanent WO record
  (Memo, etc.) without whoever wrote the rule realizing it would.
- **`whoamiCache`** (module-level var, `null` until populated) — formulas
  are evaluated synchronously (`runFormula`/`runVariable` return
  immediately), but `readWhoamiCanonical()` is an XHR promise, so `whoami()`
  can only ever read a value that was already fetched by some earlier,
  separate step — it can't fetch on demand mid-formula-eval. It reads
  `whoamiCache[field]`, returning `''` whenever the cache is still cold
  (gate off, or the fetch hasn't resolved yet) — **never throws**, so a
  formula referencing `whoami()` before the cache warms just seems to say
  "empty" rather than erroring.
- **`ensureWhoamiCache()`** — checks the gate, returns instantly if it's off
  or the cache is already warm, otherwise fetches once and populates
  `whoamiCache` (swallowing a fetch failure into `{}` rather than leaving
  `null`, so a broken fetch doesn't retry forever on every scan).
- **`refreshWhoamiIfEnabled()`** — the actual call site wrapper, used at
  exactly two places: tool startup, and the Settings checkbox's own
  `onchange` (to cover turning the toggle on mid-session without a reload).
  Checks `st.whoamiInFormulas` **before** touching `ensureWhoamiCache()`'s
  promise chain at all, so the common case (feature off) costs one
  `localStorage` read and nothing else. **Deliberately not called from
  `runScan()`** — whoami data essentially never changes within a session,
  and `ensureWhoamiCache()`'s "already have a cached value" guard means a
  second call can never actually refresh anything anyway (success or
  fetch-failure, the cache is treated as settled either way) — a scan-time
  call would only ever be a wasted `localStorage` read, or in the narrow
  window before startup's own fetch resolves, a pointless duplicate
  in-flight request. Both real call sites are fire-and-forget (`.then(render)`,
  never awaited) since neither can block on a network round trip: startup's
  own `render()` already happened synchronously before this fires (pre-scan
  formulas just see `''` until this resolves and re-renders), and toggling
  the checkbox doesn't block anything either.
- Its first argument (`field`) gets the same completion-dropdown treatment
  as a table name in `T(`/`lookup(`/`count(`. `readWhoamiCanonical()`
  returns more than the six curated names, though — it merges every scalar
  field the raw `/maximo/oslc/whoami` response actually contains (its real
  Maximo name, e.g. `loginID`/`personid`) alongside the six canonical ones,
  so `whoami()` can reach any whoami field without this file needing to
  know about it ahead of time (canonical names win on a collision).
  `completionSource()` mirrors that: once `whoamiCache` is actually warm,
  it offers `Object.keys(whoamiCache)` — the real discovered field list —
  falling back to the fixed six-name list only while the cache is still
  cold (feature off, or not fetched yet this session), so the dropdown
  isn't just empty for the common case. `getWorkerAccessToken()` is
  unaffected by the richer return shape — it only ever reads
  `whoamiData[f]` for `f` in `boot.requiredFields` (today just `username`/
  `insertSite`), which the canonical mapping still covers exactly as
  before.

**Known gap, not fixed**: a custom table (§4.7) with two columns renamed to
the same string silently makes both share one `row[name]` key — `lookup()`/
`col()` against that name become ambiguous. Left as a known limitation
rather than guarded, since a per-keystroke duplicate check would fight the
live-typing editing model the grid uses.

### 5.7 Formula Reference popup + function-name autocomplete (v0.25.0)

Two independent discoverability additions on top of §5.2's existing
arg-completion/signature-tooltip pair — added because the only prior
reference (index.html's Formula Reference table) lived outside Setup
entirely, and there was no way to discover a function's *name* at all, only
its arguments once you'd already typed `funcName(`.

- **`openFormulaReferencePopup()`** — a standalone modal (`#__wo_formula_ref`,
  appended to `document.body`, not the Setup modal — same reasoning as
  §5.2's dropdown/tooltip needing hardcoded colors) listing every
  `HELPER_REF` entry (signature, description, args), with a live search
  input filtering by name or description substring. Opened via a new 📖
  titlebar button (`#__s_formulas`) next to Save in the Setup modal.
  `doCloseSetup()` explicitly removes `#__wo_formula_ref` if present — since
  it's a `document.body` child rather than a descendant of `modal`, it
  wouldn't otherwise get cleaned up by `modal.remove()` and would linger
  after Setup closes.
- **Function-name autocomplete** — `attachFormulaAssist(el)`'s `update()`
  gained a second parse path. `parseFormulaContext()` (§5.2) only finds
  context *inside* an unclosed call; it returns `null` for a blank formula
  box or a fresh, not-yet-typed argument. The new
  **`parseBareIdentifierPrefix(text, pos)`** scans backward from the cursor
  for a bare identifier touching it, regardless of enclosing structure —
  guarded by **`insideStringLiteral(text, pos)`** (a naive quote-parity
  scanner) so it never fires while typing inside a string-literal argument
  (e.g. the `'col…'` in `lookup('table', 'col…`).
  `matchingFunctionNames(prefix)` filters `HELPER_REF` keys by prefix (case-
  insensitive substring, capped at 8 matches); selecting one via
  `insertFunctionName()` inserts `name(` and re-triggers `update()`, so the
  existing arg-completion/signature-tooltip flow picks up immediately after.
  `update()` tries the §5.2 context first (arg dropdown takes priority when
  both could theoretically apply), falls through to the name-dropdown path
  only when that returns nothing usable, and closes the signature tooltip
  whenever either dropdown is showing — the two can never render at once.
  The dropdown item itself shows just the bare name (e.g. `daysBetween`),
  not `daysBetween(` — the trailing paren was dropped (v0.25.1) since the
  description text right next to it already makes clear it's a function.

**Excel-style keyboard nav (v0.25.1)**: both dropdown flavors (arg
completion and function-name completion) share one set of closure state in
`attachFormulaAssist(el)` — `ddItems` (the open dropdown's `{el, value}`
list), `ddIndex` (which one is highlighted), `ddAccept(value)` (the
insertion function for whichever flavor is open). The top match is
highlighted by default (`setDdIndex(0)` at the end of both `showDropdown()`/
`showFunctionNameDropdown()`), `ArrowUp`/`ArrowDown` move the highlight
(`e.preventDefault()`'d so the caret doesn't also move), and `Tab`/`Enter`
accept the highlighted item instead of their normal effect (leaving the
field / inserting a newline) — this is deliberately closer to Excel's own
function-name IntelliSense (highlighted top match, Tab/Enter to accept)
than to a Google-style inline "ghost text" suggestion, which would need a
mirror-`<div>` overlay matching the textarea's exact font metrics/wrapping
to implement reliably — a much larger, higher-risk undertaking than this
keyboard-nav layer for a feature that's still this new. Hovering an item
with the mouse calls the same `setDdIndex()`, so mouse and keyboard share
one notion of "current selection" rather than fighting each other.

### 5.8 Case-insensitive function names (v0.25.1)

Reported bug: typing `daysbetween(` (or any wrong-case helper name) showed
neither the arg dropdown nor the signature tooltip at all — `ctx.func` was
whatever case was actually typed, and both `completionSource(ctx.func)` and
`HELPER_REF[ctx.func]` are exact-match object lookups, so a case mismatch
against the real `daysBetween` key just silently found nothing. Two
independent fixes, one editor-side and one execution-side, both keyed off
the same `ARGN_LOWER` map (`{lowercased name: canonical ARGN casing}`,
built once from `ARGN`):

- **Editor recognition** — `attachFormulaAssist(el)`'s `update()`
  canonicalizes `ctx.func` via `ARGN_LOWER` immediately after
  `parseFormulaContext()` returns it, before any dropdown/tooltip lookup
  runs. So `daysbetween(`, `DaysBetween(`, `DAYSBETWEEN(` all resolve to
  the same `HELPER_REF['daysBetween']` entry and show its signature tooltip
  immediately — the underlying complaint was never really about dropdowns
  vs. tooltips, it was that a case-mismatched name matched nothing at all.
- **Execution correctness** — `normalizeFormulaFunctionCase(formula)` is a
  small hand-rolled scanner (string-literal-aware via the same naive
  quote-parity approach as `insideStringLiteral()`) that rewrites every
  bare identifier immediately followed by `(` to its canonical `ARGN_LOWER`
  casing, leaving everything else (string contents, non-call identifiers,
  already-correct casing) untouched. Without this, a formula saved with
  wrong casing would still fail at actual evaluation — the generated
  `Function` only binds the exact-case `ARGN` names as parameters, so a
  mistyped case is a `ReferenceError` at eval time regardless of what the
  editor showed while typing. Called once at the top of the same four
  formula-evaluation entry points that share the `av`/`ARGN` arrays
  (`runVariable`, `runFormula`, `runActions()`'s `action.value` evaluator,
  `resolveMsg()`'s `{{...}}` interpolation) — so a rule/message/action
  formula that used the wrong case for a helper name now just works,
  silently corrected, rather than erroring or (worse) evaluating to
  nothing without explanation.
- This is deliberately a **normalize-at-use** design, not a live rewrite of
  what's in the textarea as the user types — the field always shows
  exactly what was typed; only the version actually evaluated (and, for the
  editor's dropdown/tooltip purposes, the version looked up against
  `HELPER_REF`) gets case-corrected. Rewriting the live textarea value
  in-place would risk fighting the user's cursor position mid-keystroke for
  a cosmetic win that isn't needed — the "auto-correct" only matters for
  whether the formula *works*, which this already guarantees.

### 5.9 Signature tooltip + value dropdown shown together (v0.25.1)

Follow-up to the same bug report: the case fix above only explains half of
"typing `domain(`/`daysbetween(` doesn't instantly tell me what belongs
between the parens." `domain` was never miscased — the real gap was that
`domain(`, `lookup(`, `count(`, `whoami(`, `F(`, `T(`, and `V(` all have a
`completionSource()` entry (a value list for their first argument), and
`update()` treated that dropdown and the signature tooltip as mutually
exclusive: whichever showed, the other was explicitly closed. So typing
`domain(` got a raw list of domain-key strings with no indication a second
argument (`code`) even exists. Excel shows both together for its own
functions (a value/range suggestion list alongside the persistent argument
tooltip), so this tool now does too:

- `showDropdown(ctx, pinBelow)` and `showSigTip(ctx, pinAbove)` each gained
  an optional flag. Both dropdown/tooltip already had independent
  "flip above the field if there's no room below" logic tied to the same
  `el.getBoundingClientRect()` anchor — left alone, showing both at once
  would just stack them in the same spot. When `update()` shows both, it
  passes `true` to force the dropdown below the field and the tooltip
  above it unconditionally, instead of each independently guessing.
  `showSigTip`'s pinned-above position still clamps to `Math.max(4, ...)`
  so it can't go fully off-screen near the top of the viewport; the
  dropdown's pinned-below position isn't similarly clamped against the
  bottom, so a field very close to the viewport's bottom edge can still
  render a dropdown that's partly cut off — a narrow, pre-existing-style
  edge case, not new to this change.
- `update()` no longer `return`s immediately after a successful
  `showDropdown()` — it now falls through to `showSigTip(ctx, dropdownShown)`
  regardless, so a signature tooltip renders whenever `ctx` resolves,
  independent of whether a value dropdown also happened to apply. The one
  case that's still mutually exclusive with the signature tooltip is the
  bare function-**name** dropdown (`showFunctionNameDropdown`, §5.7) — that
  one fires when there's no complete enclosing call yet at all, so there's
  no signature to show alongside it.

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
  actions) next to Return/Approve, plus the entire Post-Scan Actions feature
  (editor in the Scan tab + `runActions()` execution — see §5). All bundled
  under one flag since they're the same untested code path. See
  `HOTKEY_ACTIONS`'s `fix` entry and the `betaRouteOn` branch in the main
  panel's footer-building code.
- `beta_2` — "Maximo REST Data (experimental)": three new formula helpers,
  `domain()`, `assetWOHistory()`, `assetDowntimeHistory()` (v0.25.0-era,
  added in response to console-tested REST/localStorage exploration — see
  `MAXIMO_DATA_SOURCES.md`, private repo). Gated INSIDE each helper's own
  function body (`if (!isBetaFeatureOn('beta_2')) return '' /* or [] */;`),
  not just hidden from the UI — same convention as `runActions()`'s beta_1
  gate — so a formula written against one of these on a non-beta_2 install
  gets a harmless empty result instead of a `ReferenceError`, and turning
  the feature off later doesn't retroactively break saved formulas, it just
  makes them go quiet.
  - `domainFn(key, code)` — the one **synchronous, local-only** helper: reads
    one of Maximo's own domain/lookup lists straight out of `localStorage`
    (`KNOWN_DOMAIN_KEYS` lists the 14 known keys — `DOWNCODE`, `HAZTYPE`,
    `WOCLASS`, etc. — also offered as `domain(`'s first-arg completion, same
    mechanism as `whoami('s field-name dropdown). **Shape confirmed
    (v0.25.1)** via `__woBeta2Report()` across 15 real domains: `{ data:
    [[...], ...], attributes: {value: idx, description: idx, ...} }` —
    `attributes` maps each column NAME to its index in every `data` row,
    and that mapping genuinely varies by domain (`description` is index 1
    for `ABBWPRIORITY` but index 2 for `WOCLASS`, which also has a
    `maxvalue` column — `description` is preferred when both exist, since
    `maxvalue` is usually just an uppercase echo of `value`). `domainDecodeRaw()`
    reads `attrs.value`/`attrs.description` (falling back to `attrs.maxvalue`)
    rather than hardcoding index 0/1, since the whole point of this shape is
    that it's self-describing. The old array-of-objects/plain-map guesses
    are kept as further fallbacks but were never actually confirmed against
    a real domain and probably never will match one.
  - `assetWOHistoryFn(assetnum, siteid, limit)` / `assetDowntimeHistoryFn(assetnum, siteid)`
    — both hit Maximo's own OSLC REST API (`/maximo/oslc/os/mxapiwo`,
    `/maximo/oslc/os/mxapiasset`) directly via `xhrGetText()`, same-origin,
    riding the browser's existing session — not a new auth surface.
    **Every mxapi\* call now sends `Accept: application/json` (v0.25.1,
    via the shared `MXAPI_HEADERS` constant and `xhrGetText()`'s new
    optional `headers` param)** — every `/oslc/os/mxapi*` call 406'd
    without it (confirmed via `__woBeta2Report()`: same URL, same session,
    406 without the header vs. 200 with it), which meant these two helpers
    — and any API table built on them — had never actually returned data
    before this fix, on any install. `whoami` worked fine either way, so
    this had nothing to do with auth; it's pure content negotiation on
    Maximo's `os/` endpoints specifically. Deliberately NOT baked into
    `xhrGetText()` unconditionally — that function is also the self-update
    path's fetch primitive (`getWorkerAccessToken()`'s `/bootstrap` call,
    `fetchToolSourceViaWorker()`'s `/tool` call, which returns raw JS
    source, not JSON), and forcing a JSON `Accept` header onto a
    load-critical, never-tested-against-this-change path wasn't worth the
    risk for a header only ever confirmed necessary on Maximo's own mxapi
    endpoints. `MXAPI_HEADERS` is passed explicitly at every mxapi\* call
    site instead (`fetchAssetWOHistoryRaw`, `fetchAssetDowntimeHistoryRaw`,
    `__woDumpWO`, `__woDumpAsset`). Each
    uses a **per-argument-combination cache** (`betaAssetWoCache`/
    `betaAssetDowntimeCache`, keyed by `assetnum+siteid[+limit]`) rather than
    whoami's single global cache, since the result genuinely depends on the
    formula's own arguments. The cache slot is set to the empty placeholder
    (`[]`) the MOMENT the fetch is kicked off, not only once it resolves —
    a formula gets re-evaluated multiple times per render (once for the
    rule, again for its message), so without this a fetch already in flight
    for the same key would get fired a second time on the very next
    evaluation. `assetDowntimeHistoryFn` only requests `startdate`/`enddate`
    from `moddowntimehist` — `downtimecode`/`remarks`/`reportedby`/
    `positivedowntime` were tried against the same nested-select in console
    testing and never came back, so requesting them here would just be dead
    weight (see the data-sources doc §2.4 for the exact repro).
  - Both caches are cleared at the top of every `runScan()`, alongside the
    main `cache` reset — this tool's whole job is showing CURRENT state, and
    asset WO/downtime history is exactly the kind of thing that changes
    between scans (someone logs downtime, you rescan to verify a fix); a
    session-sticky cache would silently serve first-fetch-of-the-session
    data for the rest of the review.
  - The actual fetch logic lives in two Promise-returning, cache-free,
    gate-free functions — `fetchAssetWOHistoryRaw()`/
    `fetchAssetDowntimeHistoryRaw()` — that both the gated/cached formula
    helpers AND the `__woProbeAsset()` console tool call into, so probing
    from the console always exercises the exact same request a formula
    would make. Same split exists for the domain decode:
    `domainDecodeRaw(key, code)` is the ungated logic, `domainFn()` just
    adds the `isBetaFeatureOn` check in front of it — `__woTestDomain()`
    calls the raw version directly. See `CONSOLE_COMMANDS.md`'s "beta_2
    discovery tools" section for the full set
    (`__woDebugDomains`/`__woTestDomain`/`__woProbeAsset`/`__woDumpWO`/
    `__woDumpAsset`/`__woBeta2Report`) — deliberately NOT gated behind
    beta_2 themselves, same reasoning as the pre-existing
    `__woDebugTables`/`__woDebugCache`: a debug tool gated behind the
    feature it's meant to help you verify would be useless the one time you
    actually need it. `__woBeta2Report(assetnum?, siteid?)` /
    `buildBeta2DiagnosticReport()` is the one that actually found the 406
    and domain-shape fixes above — bundles both checks into one plain-text
    report, also available as a **"Run beta_2 Diagnostics"** button in
    Setup > Settings > Debug (dev tier only) that prompts once for
    asset/site and copies the report straight to the clipboard via the new
    generic `copyTextToClipboard(text)` helper — built so confirming a fix
    like this never again requires hand-typing `fetch()`/`JSON.parse()`
    snippets into DevTools.
  - **API tables** (`cfg.apiTables`, see §4.8) generalize
    `assetWOHistoryFn`/`assetDowntimeHistoryFn` from standalone formula
    calls into a proper named table — resolved through the same
    `fetchAssetWOHistoryRaw()`/`fetchAssetDowntimeHistoryRaw()` and gated/
    cached the same way, but reachable via `T()`/`lookup()`/`col()` by name
    like any scanned or custom table, and editable from the Tables tab.

**Adding a new feature**: add a `BETA_FEATURES` entry, gate every bit of its
UI/behavior behind `isBetaFeatureOn(newId)`, and if it needs its own hotkey
add a `HOTKEY_ACTIONS` entry with `betaFeature: newId` (see `hotkeyActionActive()`).
For a formula helper specifically, gate INSIDE the helper function itself
(not just in whatever UI exposes it) so a saved formula referencing it stays
inert rather than erroring once the feature's disabled again.

---

## 7. Hotkeys

`HOTKEY_ACTIONS` registry (top of `wo_tool.js`) — each entry: `id`,
`settingsKey` (its own top-level `__wo_settings` field, not nested — matches
the original single-hotkey convention so it stays device-level
automatically), `label`, `defaultHotkey`, optional `betaFeature`, `run()`.
Current actions: `rescan` (default `Alt+S`, was `Ctrl+Shift+S` before
v0.23.0 — a real reassignment for anyone who never customized it, not just
a new option), `return` (default `Alt+R`, added v0.23.0 — safe to
default-bind because `run()` still gates on its own `confirm()`), `approve`
(no default — the one action still opt-in only), `fix` (no default,
beta_1-gated), `copyReturn` (default `Alt+C`, added v0.23.0, calls
`copyReturnMessage()` — see §5.1).

`applyHotkeys()` builds one `document`-level keydown listener covering every
*currently active* action (`hotkeyActionActive()` — always true for a
non-beta action, requires `isBetaFeatureOn()` for a beta one). The Settings
UI is what actually enforces "no two actions share a combo" (rejects the
assignment with an inline error) — the listener itself just trusts that
invariant and does a straight combo→action lookup. The listener explicitly
ignores keydowns while `document.activeElement` is an editable control
(input/textarea/select/contenteditable) — added once Fix could silently
overwrite fields with no confirmation, unlike Return/Approve which confirm.

### 7.1 Action busy-lock (Return/Approve/Fix/Scan)

`actionsBusy()` (true while `scanning` or the new `routing` flag is set) is
checked at the top of every entry point into Return/Approve/Fix/Scan —
button `onclick`, hotkey `run()`, and the header Scan trigger all share the
same guard — so a double-click or a hotkey firing mid-route can't start a
second overlapping action. `setActionsLocked(bool)` is the single place that
flips the buttons'/hotkeys' disabled-looking state in sync with the flag.

`routeWorkflow()` (Return/Approve/Fix's shared implementation) has roughly
15 terminal branches (success, various poll-timeout/error paths); every one
of them now calls `finishRoute()` on the way out rather than leaving the
caller to remember to clear `routing` itself — a lock that only gets
released on the *happy* path is worse than no lock, since a failed branch
would leave every action permanently disabled until reload.
`finishRoute()` is backstopped by a 180-second safety timer
(`__woRouteSafetyTimer`, cancelled and re-armed at the top of every
`routeWorkflow()` call) — 180s because the longest legitimate wait chain
inside `routeWorkflow()` is a 90-second password-prompt poll reached only
after other polls have already run; a shorter safety window would have
false-positive-unlocked mid-route. Cancel-and-rearm matters because a stale
timer left over from an earlier, already-finished route must not fire in
the middle of a later one and release a lock that's legitimately still
held.

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
- `applyResponsiveTabFit()` — two escalating tiers as the Setup tab bar runs
  out of room, always recomputed from a clean baseline (never just delta'd)
  so growing the modal back out correctly reverses both: (1) shrink AUTO
  then BOTH-pinned tabs to icon-only, lowest-priority (rightmost) first; (2)
  if the bar *still* overflows even fully icon-shrunk, hide all four
  `.wo-tab-group-end` tabs (Guide/Feedback/Export/Import) and show `#__s_more`
  instead — a single button that opens a `.wo-kebab-menu`-styled list; each
  item just calls `.click()` on the real (hidden) tab button rather than
  duplicating its `bindTab()`-wired switch logic.

---

## 9. Release process

**Two stages, deliberately separate (standing instruction as of v0.24.0):
push to dev first, only promote to stable/beta when the user explicitly says
so.** This exists because `worker.js`'s `/tool` endpoint resolves an
unpinned/"dev channel" request straight from `GITHUB_BRANCH` (the private
repo's live `main` — see §3), while a pinned request (`?version=X`, which is
what `channels.stable`/`channels.beta`/exact-pins in `version.json` all
resolve to) fetches an **immutable git tag**. Pushing new code to `main`
therefore only ever reaches dev-grant holders on the dev channel — everyone
on stable/beta is completely unaffected until a new tag exists and
`version.json` is updated to point at it. That gap is the whole point: it's
a live, low-blast-radius way to exercise interactive code that can't be
verified from this environment (no browser here) before it reaches
everyone.

### 9.1 Stage 1 — push to dev

1. Bump `TOOL_VERSION` in `wo_tool.js`. **Do not** touch `version.json`
   (`latest`, `channels`, or add a `versions[]` entry) — that's what keeps
   stable/beta users unaffected.
2. Commit + push `wo_tool.js` to the **public** repo's `main`. The public
   repo's `.git/hooks/pre-commit` auto-rewrites `BUILD_ID` (see §9.3) to the
   current UTC timestamp whenever `wo_tool.js` is part of the commit — no
   manual bump needed, it re-stages the file itself.
3. Same file to the **private** repo's `main` — `scripts/push-private.sh
   "<commit message>"` (v0.24.0) collapses the whole routine into one
   command: clones fresh into a `mktemp -d` scratch dir (**still no
   persistent local checkout** — confirmed with the user, v0.22.0; the
   script deliberately preserves that, it doesn't change the pattern),
   copies the SAME `pre-commit` hook into the fresh clone (hooks are
   local-only, never come along with `git clone`, so this step can't be
   skipped or `BUILD_ID` silently goes stale there), copies `wo_tool.js` in
   (leaves `permissions.json` alone), commits, pushes `main` — **no tag
   yet** — and cleans up the scratch dir automatically via `trap ... EXIT`.
   Run it from the public repo's root.
4. Tell the user it's live on dev and wait for them to test and explicitly
   say when to promote.

### 9.2 Stage 2 — promote to stable/beta (only on explicit go-ahead)

1. Add the `version.json` changelog entry (public repo) describing the
   already-pushed changes.
2. Tag `vX.Y.Z` on **both** repos at the commit already pushed in stage 1
   (don't re-push code — it's already there) — pinned-version installs and
   `?version=` silently fail to resolve on whichever repo is missing the tag.
3. Update `version.json`'s `latest` and the relevant `channels` entries
   (`stable`, and `beta` if applicable) to `X.Y.Z`, commit, push (public repo).
4. If `access-control/worker.js` changed: `wrangler deploy` (needs
   `CLOUDFLARE_API_TOKEN` — not persisted across sessions, re-provided each
   time it's needed).
5. Smoke-test: `curl /bootstrap`, `curl -X POST /check-access`, then
   `curl "/tool?token=...&version=X.Y.Z"` and grep for the expected
   `TOOL_VERSION` string in the response.

Skipping the private-repo tag (or tagging only one repo) is the single most
likely release mistake at promotion time — check both tags exist before
considering a promotion done. (See §9.3 below for the unrelated §9-adjacent
`BUILD_ID` mechanism — it runs on every dev push in §9.1, not at promotion
time.)

### 9.3 `BUILD_ID`

`TOOL_VERSION` only bumps on a tagged stable/beta release, but the dev
channel always tracks the live tip of `main` (§9's whole premise) — so
several different dev pushes in a row can share one `TOOL_VERSION` with no
way to tell them apart. `BUILD_ID` (declared next to `TOOL_VERSION`) is a
compact UTC timestamp in `YYDDD.HHMMz` format (2-digit year, zero-padded
day-of-year, UTC hour+minute, literal lowercase `z` — e.g. `26195.1307z`),
surfaced dev-grant-only via `grantsStatusLine()` (prepended ahead of the
existing grant labels) and a standalone line in Settings > Updates (no
explanatory subtext there, by request — just the value).

**It is enforced by the `pre-commit` git hook, not by memory or discipline**:
`.git/hooks/pre-commit` in the public repo greps staged files for
`wo_tool.js`, and if present, `sed`-rewrites the `BUILD_ID` literal to
`date -u +"%y%j.%H%M"z` and re-stages the file — so a stale/forgotten
`BUILD_ID` is structurally impossible on every commit that touches the file,
on either repo (§9.1 step 3 covers the private repo's copy of the same
hook, installed fresh by `scripts/push-private.sh` every run since hooks
aren't part of `git clone`). Since `.git/hooks/` is never tracked by git, a
fresh clone anywhere else (a new machine, a CI runner) needs the hook file
recreated manually before it'll take effect there — see the exact `sed`
line in the hook file itself if it's ever missing.

### 9.4 Auto-update banner: one-click re-enable

`showUpdatePrompt(remote, target, isPatchOnly)` gained a third button
(v0.24.0) alongside the existing install/dismiss actions:
`'Enable Auto-Patch Updates'` (when `isPatchOnly`) or `'Enable Automatic
Updates'` otherwise. Both just flip an existing Settings toggle
(`s.autoUpdatePatch` or `s.autoUpdate`) the user had previously turned off,
then immediately call `installUpdate(target.version)` — it's a reactivation
shortcut for a setting that already existed, not a new settings surface.
considering a promotion done.

---

## 10. Known rough edges (not bugs, just worth knowing)

- `EPHEMERAL_KEYS` (the "don't back this up on revoke" exclude-list) is
  hand-duplicated between `loader.js` and `wo_tool.js` — any new
  ephemeral-but-not-real-config key has to be added to both manually. (Both
  copies list the same 6 keys as of v0.21.2 — `__wo_grant_cache` was missing
  from `wo_tool.js`'s copy until then, added for consistency.)
- `caches.default` (Worker edge cache) is regional, not global — see §3.1.
- `version.json` grows unbounded — nothing trims old entries automatically,
  but trimming is a supported, expected admin action (as of v0.24.0). **The
  standing policy this all depends on: git tags are NEVER deleted, only
  `versions[]` entries are trimmed.** `versions[]` is purely the curated
  "available" list; the tag stays fetchable regardless. If that policy is
  ever violated (a tag actually deleted), `?version=X` 404s and none of the
  below fires — there's no handling in the fetch-failure path for that case,
  only in the manifest-read path.
  - **Exact pin or a channel's target (`channels.stable`/`channels.beta`)
    trimmed out of `versions[]`** — `resolveUpdateTarget()` calls
    `resolveNearestAvailable(from, remote.versions, tier)`: prefers the
    closest still-listed, permission-appropriate version AT OR ABOVE `from`
    (a deliberate downgrade-pin lands as close to where it was as possible),
    falling back to the single highest available version this tier can use
    only if nothing qualifies above (the genuine rollback case — e.g. the
    whole channel's target vanished with nothing newer behind it). Surfaced
    via `target.rolledFrom` and a `rolledNote` prefix on the status line in
    `checkForUpdate()` — never silent. **Deliberately does not persist**
    (`resolveUpdateTarget()` stays a pure read, no `st.pinnedVersion` write):
    Setup's `openSetup()` holds its own long-lived shared `st` (§4.1) that
    wouldn't know about a write made through a freshly-parsed copy here, and
    since `checkForUpdate()` can run while Setup is open (Save & Apply
    triggers it without closing the modal), a later Save & Apply would
    re-persist Setup's stale in-memory pin and clobber a write made here —
    the same bug class as the v0.21.2 Beta-tab fix. The one path that DOES
    need the pin reconciled (an active exact/floating pin) is instead handled
    downstream in `installUpdate()`, which is safe for a different reason:
    its write there is immediately followed by `rawInstall()`'s
    teardown-and-reload, so Setup's stale in-memory `st` never survives to
    overwrite it. Not persisting here isn't "safe because idempotent" on its
    own — it's safe because that one path is covered elsewhere, by a write
    that's reload-guarded instead of race-prone.
  - **A floating minor pin** (`"0.20"`) **whose entire line has no entries
    left** — different, narrower case, left as-is: `resolveFloatingMinor()`
    holds at the currently-installed version and reports "pin has no builds
    left in the manifest" (via `pinMissing`) rather than rolling forward to
    a different line — a floating pin's whole point is staying on one
    specific line, so jumping it to another line isn't "nearest available,"
    it's picking a different feature set the user never asked for.
  - **Version picker gating** (Settings > Updates): each `version.json` entry
    can now optionally carry `"grant": "dev"` / `"beta_0"` / `"beta_1"` etc.
    (same convention as `HOTKEY_ACTIONS`' `betaFeature`) to gate one specific
    version to one specific grant, checked via the real `hasGrant()` (not the
    coarse tier string) so a `"beta_1"`-gated entry needs that exact grant.
    `isVersionEntryAllowed(entry, tier)` is the single gating check, reused by
    the picker's list-building AND by `resolveNearestAvailable()`'s rollback
    candidates — a gated version a user can't see is also never offered as a
    rollback target for them. The picker's "Latest" default option's LABEL is
    computed by `updateLatestLabel()`, which mirrors `resolveUpdateTarget()`'s
    own channel fallback (`channels[effChannel] || channels.stable ||
    remote.latest`) keyed off the CHANNEL currently selected in the Settings
    form (`st.channel`, with the same dev/beta-without-grant-falls-back-to-
    stable normalization `resolveUpdateTarget()` does) — NOT off the user's
    dev/beta grant tier. A dev-grant holder sitting on the stable channel sees
    "Latest stable (vX)", same as a plain user; switching their own Channel
    dropdown to beta/dev updates the label live (`refreshVersionPicker()`
    calls it on every channel change) without needing to Save first. The dev
    channel has no `channels.dev` pointer at all (it always installs whatever
    is live on `main`, ignoring `version.json` — see `resolveUpdateTarget()`'s
    early return for `channel==='dev'`), so that case is special-cased to say
    "Latest (dev — always tracks main)" instead of falling back to a stable
    version number dev doesn't actually track. Earlier versions of this label
    were computed via a since-removed `highestAllowedVersion()` helper (the
    highest version.json entry the user's GRANT could see at all, independent
    of channel) — that meant a dev/beta-grant holder saw their gated ceiling
    as "Latest" even while sitting on the stable channel, which isn't what
    unpinned selection actually resolves to. Fixed after being reported live
    as real confusion, not just the latent mismatch this note used to flag.
- Feedback issues get no labels — could auto-tag `type:bug`/`type:suggestion`
  in the private repo if labels are ever set up there.
- The Feedback tab's "Include my Maximo name/username/email" checkbox
  (unchecked by default) is opt-in for that field only: `readWhoamiCanonical()`
  is only called when it's checked, and only its result (display
  name/username/email) is appended to the report's `context` as a
  `Reporter:` line. This does NOT change whether whoami data reaches the
  Worker at all — `getWorkerAccessToken()`'s own `/check-access` call
  (needed to get a token to send the report) already sends whoami fields
  every time, checkbox or not; that's a separate, pre-existing access-check
  round trip this checkbox was never meant to gate.
- `settingsTab()` adds a fresh `content.addEventListener('input', saveSettings)`
  every time the tab is (re-)rendered, and never removes the previous one —
  `content` itself is never replaced (only its `innerHTML`), so listeners
  stack across repeated visits to the Settings tab within the same Setup
  session. Harmless today since `saveSettings` is idempotent (just re-writes
  the same `st` object per keystroke), but worth fixing if it ever stops
  being idempotent.
