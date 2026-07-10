# WO Review Tool — Console Commands

Reference for the `window.__wo*` commands exposed by `wo_tool.js`. Run these in the
browser DevTools console on the Maximo page, with the tool installed.

> Keep this file updated whenever a new `window.__wo*` command is added to `wo_tool.js`.

---

## Update channel / dev mode

By default, everyone runs the **stable** channel and can only pin to a released
(non-prerelease) version — see [Setup > Settings > Updates]. These commands unlock
more.

### `window.__woEnableBeta()`
Unlocks **beta** tier. Reveals the Beta channel option and any beta-tagged
(`X.Y.Z-beta1`) builds in the version-pin list, in Setup > Settings > Updates.

### `window.__woEnableDev()`
Unlocks **dev** tier (superset of beta). Also reveals the Dev channel option
(tracks the tip of `main` directly, not a tagged release) and the Debug section
in Setup > Settings.

### `window.__woLockDev()`
Re-locks dev/beta mode. Resets the channel back to `stable` and clears any
version pin. Everything unlocked by the two commands above goes back to hidden.

**Note:** the unlock state lives in its own localStorage key, separate from
`__wo_settings` — it never travels with an exported/shared config backup.

---

## First-run / testing

### `window.__woReset()`
Wipes all WO Tool localStorage keys (`__wo_*`) and the linked-backup-file
IndexedDB database. Does **not** touch any other Maximo site data, and does not
delete a linked backup `.json` file on disk (only the browser's reference to it).
Reload the page and click the bookmarklet afterward to trigger a genuine
fresh install.

### `window.__woShowInstaller()`
Manually opens the first-run installer modal (profile picker + channel/version
section) on demand, without needing to actually wipe storage first. Useful for
re-checking config profiles or re-running setup without losing your current config
(picking a profile still applies it over your live config, same as first run).

---

## Debug / diagnostics

### `window.__woDebugCache()`
Dumps the current scan cache to the console: all captured field values, every
captured table (first 5 rows each), any table read errors, and the last-resolved
table-prefix log. Also available as a button in Setup > Settings (dev tier only).

### `window.__woDebugTables()`
Scans all frames on the page for Maximo table-row DOM patterns (`*_tdrow_*`) and
logs the table prefixes and column-widget patterns found, plus visibility state
of nearby `-lb` labels. Useful when a table isn't being detected/read correctly
and you need to find its real prefix. Also available alongside the Debug button
in Setup > Settings (dev tier only).

---

## Quick escape hatches

If the tool ever gets stuck (e.g. pinned to a version and the UI seems
unresponsive), these bypass the UI entirely:

**Clear a stuck version pin:**
```js
var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
s.pinnedVersion = '';
localStorage.setItem('__wo_settings', JSON.stringify(s));
location.reload();
```

**Full wipe (equivalent to `__woReset()`, for a version that doesn't have it yet):**
```js
Object.keys(localStorage).filter(function(k) { return k.indexOf('__wo_') === 0; })
    .forEach(function(k) { localStorage.removeItem(k); });
indexedDB.deleteDatabase('__wo_tool_db');
```
