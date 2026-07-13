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

### 5.3 Unwrapped-helper warning in message boxes (v0.24.0)

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

**Adding a new feature**: add a `BETA_FEATURES` entry, gate every bit of its
UI/behavior behind `isBetaFeatureOn(newId)`, and if it needs its own hotkey
add a `HOTKEY_ACTIONS` entry with `betaFeature: newId` (see `hotkeyActionActive()`).

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
2. Commit + push `wo_tool.js` to the **public** repo's `main`.
3. Same file to the **private** repo's `main` — `gh repo clone
   WilliamZitzmann/WO-Review-Tool-Private` into a scratch/tmp dir (**no
   persistent local checkout exists** — confirmed with the user, v0.22.0;
   don't go looking for one), copy `wo_tool.js` in (leave its
   `permissions.json` alone), set local `git config user.name`/`user.email`
   (the fresh clone won't inherit global config), commit, push `main` — **no
   tag yet** — then delete the scratch clone.
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
considering a promotion done.

---

## 10. Known rough edges (not bugs, just worth knowing)

- `EPHEMERAL_KEYS` (the "don't back this up on revoke" exclude-list) is
  hand-duplicated between `loader.js` and `wo_tool.js` — any new
  ephemeral-but-not-real-config key has to be added to both manually. (Both
  copies list the same 6 keys as of v0.21.2 — `__wo_grant_cache` was missing
  from `wo_tool.js`'s copy until then, added for consistency.)
- `caches.default` (Worker edge cache) is regional, not global — see §3.1.
- `version.json` grows unbounded — nothing trims old entries. **Trimming old
  `versions` array entries is safe** for exact pins and unpinned
  channels — `resolveUpdateTarget()` fetches by git tag (`/tool?version=X`),
  independent of whether the manifest still lists that version. The one path
  that isn't safe: a **floating minor pin** (`"0.20"`) whose entire line has
  no entries left in `versions` — `resolveFloatingMinor()` used to silently
  fall back to the channel/latest version while the UI kept saying "pinned to
  0.20.x," a real track-jump with no warning. Fixed (see the `pinMissing`
  flag on `resolveUpdateTarget()`'s return value): it now holds at the
  currently-installed version and reports "pin has no builds left in the
  manifest" instead. **Rule for future manifest cleanup: never delete the git
  tag; trimming the changelog entry is fine except it can strand a floating
  pin exactly as described above** — if trimming an entire minor line that
  someone might have floating-pinned to, expect them to see that message.
- Feedback issues get no labels — could auto-tag `type:bug`/`type:suggestion`
  in the private repo if labels are ever set up there.
- `settingsTab()` adds a fresh `content.addEventListener('input', saveSettings)`
  every time the tab is (re-)rendered, and never removes the previous one —
  `content` itself is never replaced (only its `innerHTML`), so listeners
  stack across repeated visits to the Settings tab within the same Setup
  session. Harmless today since `saveSettings` is idempotent (just re-writes
  the same `st` object per keystroke), but worth fixing if it ever stops
  being idempotent.
