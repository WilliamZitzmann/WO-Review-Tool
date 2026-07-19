# Managing access — a guide to `permissions.json`

This file lives **only** in the private repo (`WO-Review-Tool-Private`), never here. Every time someone clicks the bookmarklet, the Worker fetches it fresh from GitHub — there's no caching, no redeploy step. **Edit the file, save it, and it's live for the next person who clicks the bookmarklet.** You can edit it right in GitHub's web UI (open the file → pencil icon → edit → commit), via git, or through the admin tool at `/admin` (see the bottom of this guide) — none of these need a `wrangler deploy`.

Reminder of what this actually is: a **governance gate**, not a hard security boundary. It stops link-sharing and keeps a deprovisioned user's old bookmarklet from still working. It does not stop someone with legitimate Maximo access from lying about their own session before the check runs. Treat every rule below in that light.

## How a request is decided

Four steps, in this exact order, first match wins:

1. **Override** — does any `override` entry's conditions fully match? → granted immediately, skips everything else, including blacklist.
2. **Blacklist** — does any blacklist entry's conditions fully match? → denied, full stop.
3. **Allow** — does any allow entry's conditions fully match? → granted.
4. **Otherwise** → denied.

`override`, `blacklist`, `allow`, and `extraGrants` are now **all the same shape**: a list of entries, each with a `conditions` list (all must match — AND) and, for `override`/`allow`/`extraGrants`, a `grants` list. Multiple entries in the same section are OR'd. `override` used to be a bare `{"username": "...", "grants": [...]}` list — it's now condition-based too, so "override for this one person" is just a single-condition entry: `{"conditions":[{"field":"username","op":"eq","value":"ZITZMWX"}], "grants":["dev"]}`.

Then, if granted, any matching `extraGrants` entry can add *extra* flags on top (see below) — it doesn't grant access on its own, only adds to the grants of someone who already got in via `override` or `allow`.

## The fields you can write conditions against

Pulled from Maximo's `whoami`, mapped to these canonical names:

| Field | Where it comes from | Example |
|---|---|---|
| `username` | `loginID` | `ZITZMWX` |
| `email` | `email` | `william.zitzmann@abbvie.com` |
| `country` | `country` | `IE` |
| `insertSite` | `insertSite` | `AVWP` |
| `langcode` | `langcode` | `EN` |
| `displayName` | `displayName` | `Zitzmann, William` |
| `defaultSiteDescription` | `defaultSiteDescription` | `AbbVie Westport - EUR` |
| `primaryEmail` | `primaryemail` (falls back to `email`) | `william.zitzmann@abbvie.com` |
| `city` | `city` | `Westport` |
| `firstName` | `firstname` | `William` |
| `lastName` | `lastname` | `Zitzmann` |

These 11 are what `loader.js`'s `readWhoami()` currently forwards — the raw whoami response actually has ~30 fields (org code, timezone, phone, etc.); anything not in this table needs a small `loader.js` change first (add a line to the object it returns) before a rule can reference it, same as the "Onboarding a second company" caveat below. Note there's **no workgroup/department/craft field** in the real response — an earlier design sketch assumed a 4-level company→country→site→workgroup hierarchy, but that 4th level doesn't correspond to anything whoami actually returns (the closest thing, `defaultOrg`/`insertOrg`, is an org code like `ORG19`, not a workgroup). Today the real hierarchy tops out at site.

The Worker only asks the browser to send whichever of these fields your rules actually reference (checked automatically — you don't manage this list yourself), so adding a condition on a new field just works, *as long as `loader.js` actually populates that field name from Maximo's raw whoami response*. A field outside this table (e.g. a custom `workgroup` attribute) needs a small `loader.js` change first — see "Onboarding a second company" below for the same caveat in a different context.

## The operators

| Op | Meaning | Example |
|---|---|---|
| `eq` | exact match (case-insensitive) | `{"field":"insertSite","op":"eq","value":"AVWP"}` |
| `neq` | not equal | `{"field":"country","op":"neq","value":"IE"}` |
| `endsWith` | string ends with (for email domains) | `{"field":"email","op":"endsWith","value":"@abbvie.com"}` |
| `startsWith` | string starts with | `{"field":"username","op":"startsWith","value":"ADMIN"}` |
| `in` | matches any value in a list | `{"field":"insertSite","op":"in","value":["AVWP","AVDU"]}` |
| `notIn` | matches none of a list | `{"field":"insertSite","op":"notIn","value":["AVWP","AVDU"]}` |

A **group of conditions** (an allow entry's `conditions`, or a blacklist entry's `conditions`) is a list of these — **all** of them must be true (AND). Multiple entries in `blacklist`/`allow` are OR'd — any one entry matching is enough.

## What your current file actually grants

```json
"override": [
  { "id": "ove_...", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "ZITZMWX" }], "grants": ["user"] }
],
"blacklist": [],
"allow": [
  { "id": "all_...", "grants": ["user"], "bucketId": null, "conditions": [{ "field": "insertSite", "op": "eq", "value": "AVWP" }] }
],
"extraGrants": [
  { "id": "ext_...", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "ZITZMWX" }], "grants": ["dev", "beta_0"] }
]
```

Plainly: **you** (`ZITZMWX`) always get in (`override`, plain `user`) with `dev`/`beta_0` added on top via `extraGrants`. Separately — and this is the wide-open part — **anyone at the AVWP site** gets `user` access. Since you said no one else is using it yet, nothing's actually happened as a result of this being broad, but see "Narrowing this down" below if that's wider than you want before anyone else starts clicking the bookmarklet. (`id` values are server-generated — the admin tool assigns real ones; the `...` above is just a placeholder for hand-editing.)

**Migrating an older file**: if you're looking at a backup/example from before the admin tool's condition-based rewrite, `override` used to be `{"username": "...", "grants": [...]}` and `extraGrants` used to be a flat `{"username": ["grant", ...]}` map. Convert each to the shapes above — a single-condition entry (`field:"username", op:"eq", value:"<the old username>"`) reproduces the exact old behavior — and give every entry a unique `id` (the admin tool always writes one; only hand-edits risk missing this). **A missing/empty `conditions[]` is treated as a non-match, not a wildcard** — `evalGroup()` explicitly guards against `[].every(...)`'s vacuous `true`, so a mis-migrated entry just silently does nothing rather than accidentally granting everyone, but it also means it does nothing until fixed.

## Cookbook — common edits

**Add a beta tester** (already has access via `allow`, or give them access + beta in one move):
```json
"extraGrants": [
  { "id": "ext_1", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "ZITZMWX" }], "grants": ["dev", "beta_0"] },
  { "id": "ext_2", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "SOMEUSER" }], "grants": ["beta_0"] }
]
```
If `SOMEUSER` doesn't already match an `allow` rule, add them to `override` too (plain `["user"]` grants is fine — `extraGrants` just adds beta on top):
```json
"override": [
  { "id": "ove_1", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "ZITZMWX" }], "grants": ["dev"] },
  { "id": "ove_2", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "SOMEUSER" }], "grants": ["user"] }
]
```
Special grants like `dev`/`beta_0` on `override`/`allow`/`extraGrants` are **root-only** — a non-root admin's submitted `grants[]` gets silently filtered down to `["user"]` server-side, and `override`/`extraGrants` themselves reject any non-root write outright (403).

**Add a dev tester** — same idea: an `override` entry conditioned on their `username`, `grants:["dev"]`, if they shouldn't have to also match an allow rule, or a matching `extraGrants` entry adding `"dev"` if they already get in some other way.

**Block one specific person, no matter what else matches:**
```json
"blacklist": [
  { "id": "bla_1", "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "JAMESXW" }] }
]
```

**Block an entire site:**
```json
"blacklist": [
  { "id": "bla_2", "bucketId": null, "conditions": [{ "field": "insertSite", "op": "eq", "value": "AVDU" }] }
]
```

**Narrowing today's wide-open access down to a specific list of people**, instead of "anyone at AVWP":
```json
"allow": [
  { "id": "all_1", "grants": ["user"], "bucketId": null, "conditions": [{ "field": "username", "op": "in", "value": ["USER1", "USER2", "USER3"] }] }
]
```
Remove the `insertSite`/`email` entries entirely once you've moved to an explicit list — otherwise both the list AND the broad rule are still live (allow entries are OR'd, so the broad one would still let everyone else in).

**Someone should always get in regardless of the blacklist** (the "special occasion" case): put them in `override`. That's the only list that bypasses blacklist — being in `allow` does not.

## Onboarding a second company (different Maximo domain)

One Worker and one `permissions.json` can serve multiple companies at once — you don't need a second Worker or a second private repo unless you specifically want the two companies' rules managed completely separately by different people.

1. **Add their Maximo entry point to `maximoHosts`:**
   ```json
   "maximoHosts": [
     { "hostname": "masws.manage.mas.apps.rhos.abbvienet.com", "url": "https://masws.manage.mas.apps.rhos.abbvienet.com/maximo/oslc/graphite/manage-shell/index.html#/main" },
     { "hostname": "maximo.othercompany.com", "url": "https://maximo.othercompany.com/maximo/webclient/login/login.jsp" }
   ]
   ```
   `hostname` is what the domain-check compares against; `url` is where the bookmarklet redirects to if someone clicks it from the wrong page. Get the exact URL the same way you got yours — open their real Maximo instance and copy the address bar.

2. **Add an allow rule scoped to them**, so their people don't accidentally also match an AbbVie-specific rule (and vice versa):
   ```json
   { "id": "all_othercompany", "bucketId": null, "grants": ["user"], "conditions": [{ "field": "email", "op": "endsWith", "value": "@othercompany.com" }] }
   ```
   or by site code if you know it, same pattern as AVWP above.

3. **Verify their `whoami` shape matches**, before assuming it does. This whole field-mapping (`loginID`→`username`, `email`, `insertSite`, etc.) was built against AbbVie's actual Maximo response — other companies' Maximo versions/configs can expose slightly different field names. Have someone from that company run the same console snippet from `Whoami function and other maximo commands.txt` (kept local-only, not in either repo) against their instance, and compare the returned field names to `loader.js`'s `readWhoami()` mapping. If their fields differ, that mapping needs a small update (adding another fallback like `d.loginID || d.userName || d.theirFieldName`) — that's a `loader.js` change, not a `permissions.json` one, since it's public and shared across every company.

That's it — no separate deployment, no separate bookmarklet. The same `bookmarklet.js`/`loader.js` works for anyone on any configured `maximoHosts` entry; the Worker just evaluates whichever rules apply to the fields that particular user's `whoami` returned.

## Buckets, field levels & delegated admin groups

Everything above still works exactly as described — hand-editing `permissions.json` directly is always fine, and root access never depends on any of this. This section covers the **admin tool** (`/admin` on your Worker URL — see `README.md` §7b for setup), which lets you delegate *pieces* of this file to other people without giving them the whole thing, and without them needing Maximo open at all (admin identity is a bearer token, not a whoami claim).

### The three new private-repo files

| File | Holds |
|---|---|
| `buckets.json` | The delegation hierarchy (a tree, e.g. company → country → site → workgroup) — each bucket optionally carries its own `allowedFields` checklist (which whoami fields THAT bucket's own admin tier may use when authoring conditions). |
| `adminGroups.json` | Admin identities — hashed bearer tokens grouped by who controls the same bucket with the same delegation rights. |
| `admin.html` | The admin page itself, served through the Worker at `/admin` (same private-repo-gated pattern as `wo_tool.js`). |

Neither `buckets.json` nor `adminGroups.json` is ever read by the live `/bootstrap`/`/check-access` path a regular user hits — they're purely admin-layer metadata. The only thing from this system that touches live access decisions is the optional `bucketId` you'll now see on `override`/`allow`/`blacklist` entries (see above examples) — and even that is *never evaluated*, just a label saying which admin group owns that entry.

### Buckets — a real hierarchy, not flat scopes

A bucket is one node: a parent (or none, for a top-level branch) plus one whoami condition (`field`/`op`/`value`) on top of it. Example:

```json
{
  "buckets": [
    { "id": "abbvie", "parentId": null, "label": "AbbVie", "field": "email", "op": "endsWith", "value": "@abbvie.com" },
    { "id": "abbvie-ie", "parentId": "abbvie", "label": "Ireland", "field": "country", "op": "eq", "value": "IE" },
    { "id": "abbvie-ie-avwp", "parentId": "abbvie-ie", "label": "AVWP", "field": "insertSite", "op": "eq", "value": "AVWP", "allowedFields": ["insertSite", "workgroup"] }
  ]
}
```

An admin assigned to a bucket automatically controls that bucket **and everything beneath it** — an AVWP-level admin can grant/revoke access for anyone at AVWP or any workgroup under it, but can't touch Ireland or any other site.

### The hardlock — why a delegated admin's rules can't escape their branch

When a non-root admin creates an `allow`/`blacklist` entry, they only ever submit their *own* condition (e.g. "workgroup = Maintenance"). The Worker automatically prepends every ancestor condition on top — company, then country, then site — before storing it. **This isn't optional and isn't something the admin can turn off**: no matter what field they pick for their own condition (even something unrelated, like `email`), the stored rule can never match anyone outside their branch, because the ancestor conditions are always ANDed in underneath it. `override` and `extraGrants` don't get this treatment (they're username-keyed, nothing to prepend onto) — which is why they're **root-only**, always. Delegated admins grant access exclusively through `allow`.

### Per-bucket field checklists — governing which whoami field can be used where

Instead of one global field→level map (every branch at the same depth sharing identical field permissions), **each bucket carries its own `allowedFields` checklist** governing what *that bucket's own admin tier* may reference when authoring conditions — whether that's the `field` of a new child bucket, or an `ownConditions` entry on an `allow`/`blacklist`/config rule. This matters once more than one company/branch shares the same tool: AbbVie's country-level admins might be allowed to use `country` + `insertSite`, while a different company's country-level admins want a different set — a global per-depth map can't express that, a per-bucket checklist can.

The checklist that governs an action is always the **acting admin's own bucket** (never the bucket they're targeting) — root has no bucket and always bypasses. `allowedFields` absent or `null` means every field is allowed (the default — existing buckets with no checklist set keep working unchanged); an explicit `[]` is a deliberate lockdown to no fields at all. Because bucket edits are strictly-below the acting admin's own node (never *at* it — see the hardlock section above), only a **strictly-senior admin** (an ancestor, or root) can narrow or widen a given tier's checklist — a scoped admin can never self-escalate their own.

The "Create bucket" form and each bucket row's expandable field-checklist panel (Buckets tab) both offer every known field — the canonical whoami fields (`username`/`email`/`country`/`insertSite`/`langcode`/`displayName`) plus anything already referenced elsewhere in the tree — as checkboxes, plus a "Custom…" box for a genuinely new field name. You don't have to remember/retype exact field names once they exist somewhere in the system.

### Admin groups & accounts — delegate a permission once, add people to it

Instead of one credential per person carrying its own copy of the same bucket+permissions, an **admin group** defines the permission once (which bucket, and two flags — can this group's members add peers to their own group, and can they create a new child group below them) and holds a list of **accounts**. Adding a fourth person to the same "Maintenance Workgroup Admins" group is just adding an account, not redefining anything.

Each account is keyed by a real **work email + password** (PBKDF2-hashed, never stored or shown in plaintext after creation) — not a bearer token. Logging in (`POST /admin/login`) exchanges an email/password for a short-lived signed session token, which is what the admin page actually uses for subsequent requests. That session is remembered for the browser tab (`sessionStorage`, cleared on tab close) so signing in once covers the whole visit — but revocation is still immediate: every request re-checks the account/group actually still exist, so deleting an account (or resetting its password) kills any live session on its very next request, not just once the token's 12-hour TTL runs out.

If a whoami-matched admin account's email also matches what Maximo reports for that person, they'll additionally see an **Admin tab** appear right inside the WO Review Tool's own Setup modal (next to Guide/Feedback) — it just opens `/admin` in a new tab, a shortcut on top of the normal bookmark/URL, not a separate access path.

**One account can belong to more than one group.** Adding someone who already has an account (same work email) to a second group links their existing account in rather than creating a duplicate — they keep one password and can now act within either bucket. Their header badge lists every bucket they administer. Revoking them from one group never touches the others; resetting their password does affect all of them at once (it's one shared credential), so that requires authority over every group they're currently in, not just one.

**Cookbook — give someone AVWP-only admin access:**
1. In `/admin`, go to Buckets, find (or create) the `abbvie-ie-avwp` bucket.
2. Go to Groups, create a new group scoped to that bucket — pick whether its members can add peers to themselves and/or spin up workgroup-level groups beneath them.
3. Add that person as an account (their work email) — what happens next depends on whether Resend is configured (`RESEND_API_KEY`/`RESEND_FROM_EMAIL`, see `README.md`):
   - **Resend configured**: they're emailed a one-time setup link. They click it, set their own password, and are signed in immediately — nothing to hand off manually.
   - **Not configured**: the admin tool shows a **temporary password once**. Give it to them directly (Slack, in person — whatever channel you'd trust with a password). They use it to log in, and are prompted to set a real password on that first login (`mustChangePassword`).

They can now open `/admin` from anywhere (no Maximo needed), log in with their own email/password, and manage `allow` rules + sub-buckets + sub-admin-groups within AVWP, and nothing outside it. Existing entries can be edited in place (an "edit" button next to "delete" on every Override/Allow/Blacklist/extraGrants row) — editing only ever exposes that entry's *own* conditions; the inherited ancestor chain (§ hardlock above) is always re-derived from the chosen bucket on save, never shown as something you can tamper with directly.

**Lost password / locked out**: if Resend is configured, "Forgot password?" on the login screen (and "reset password" on the Groups/Root Accounts tabs) emails a fresh one-time setup link — same enumeration-resistant response either way, so it never reveals whether an email has an account. Without Resend, reset is always admin-assisted: anyone with authority over that account's bucket (or root) hits "reset password," which generates a fresh temporary password (shown once, same as creation) and forces a real change on next login. A logged-in account can also change its own password any time via the header's "Change password" button, given the current one.

### Root — the one identity everything else is scoped relative to

`ROOT_ADMIN_TOKEN` (a Wrangler secret, see `README.md`) always grants full, unscoped access — it bypasses `adminGroups.json` entirely, so it keeps working even if that file is empty, missing, or corrupted. Treat it like a master password, and use it sparingly — for day-to-day work, create yourself a **root account** instead (Root Accounts tab, root-only) so you're not retyping a 64-character secret. Root (via either credential) is the only identity that can: create top-level buckets, touch `override`/`extraGrants`, manage `version.json`, and manage root accounts.
