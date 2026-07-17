# Managing access — a guide to `permissions.json`

This file lives **only** in the private repo (`WO-Review-Tool-Private`), never here. Every time someone clicks the bookmarklet, the Worker fetches it fresh from GitHub — there's no caching, no redeploy step. **Edit the file, save it, and it's live for the next person who clicks the bookmarklet.** You can edit it right in GitHub's web UI (open the file → pencil icon → edit → commit), via git, or through the admin tool at `/admin` (see the bottom of this guide) — none of these need a `wrangler deploy`.

Reminder of what this actually is: a **governance gate**, not a hard security boundary. It stops link-sharing and keeps a deprovisioned user's old bookmarklet from still working. It does not stop someone with legitimate Maximo access from lying about their own session before the check runs. Treat every rule below in that light.

## How a request is decided

Four steps, in this exact order, first match wins:

1. **Override** — is this username in the `override` list? → granted immediately, skips everything else, including blacklist.
2. **Blacklist** — does any blacklist entry's conditions fully match? → denied, full stop.
3. **Allow** — does any allow entry's conditions fully match? → granted.
4. **Otherwise** → denied.

Then, if granted, `extraGrants[username]` can add *extra* flags on top (see below) — it doesn't grant access on its own, only adds to the grants of someone who already got in via `override` or `allow`.

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
"override": [{ "username": "ZITZMWX", "grants": ["dev"] }],
"blacklist": [],
"allow": [
  { "grants": ["user"], "conditions": [{ "field": "insertSite", "op": "eq", "value": "AVWP" }] },
  { "grants": ["user"], "conditions": [{ "field": "email", "op": "endsWith", "value": "@abbvie.com" }] }
],
"extraGrants": { "ZITZMWX": ["dev", "beta_0"] }
```

Plainly: **you** (`ZITZMWX`) always get in with `dev` (and `beta_0`, from `extraGrants`), no matter what. Separately — and this is the wide-open part — **anyone at the AVWP site, OR anyone with any `@abbvie.com` email address**, gets `user` access. Since you said no one else is using it yet, nothing's actually happened as a result of this being broad, but it *is* effectively "all of AbbVie" as it stands. See "Narrowing this down" below if that's wider than you want before anyone else starts clicking the bookmarklet.

## Cookbook — common edits

**Add a beta tester** (already has access via `allow`, or give them access + beta in one move):
```json
"extraGrants": { "ZITZMWX": ["dev", "beta_0"], "SOMEUSER": ["beta_0"] }
```
If `SOMEUSER` doesn't already match an `allow` rule, add them to `override` too (plain `["user"]` grants is fine — `extraGrants` just adds beta on top):
```json
"override": [{ "username": "ZITZMWX", "grants": ["dev"] }, { "username": "SOMEUSER", "grants": ["user"] }]
```

**Add a dev tester** — same idea: `{"username":"SOMEUSER","grants":["dev"]}` directly in `override` if they shouldn't have to also match an allow rule, or add `"dev"` to their `extraGrants` list if they already get in some other way.

**Block one specific person, no matter what else matches:**
```json
"blacklist": [
  { "bucketId": null, "conditions": [{ "field": "username", "op": "eq", "value": "JAMESXW" }] }
]
```

**Block an entire site:**
```json
"blacklist": [
  { "bucketId": null, "conditions": [{ "field": "insertSite", "op": "eq", "value": "AVDU" }] }
]
```

**Narrowing today's wide-open access down to a specific list of people**, instead of "anyone at AVWP or anyone @abbvie.com":
```json
"allow": [
  { "grants": ["user"], "conditions": [{ "field": "username", "op": "in", "value": ["USER1", "USER2", "USER3"] }] }
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
   { "grants": ["user"], "conditions": [{ "field": "email", "op": "endsWith", "value": "@othercompany.com" }] }
   ```
   or by site code if you know it, same pattern as AVWP above.

3. **Verify their `whoami` shape matches**, before assuming it does. This whole field-mapping (`loginID`→`username`, `email`, `insertSite`, etc.) was built against AbbVie's actual Maximo response — other companies' Maximo versions/configs can expose slightly different field names. Have someone from that company run the same console snippet from `Whoami function and other maximo commands.txt` (kept local-only, not in either repo) against their instance, and compare the returned field names to `loader.js`'s `readWhoami()` mapping. If their fields differ, that mapping needs a small update (adding another fallback like `d.loginID || d.userName || d.theirFieldName`) — that's a `loader.js` change, not a `permissions.json` one, since it's public and shared across every company.

That's it — no separate deployment, no separate bookmarklet. The same `bookmarklet.js`/`loader.js` works for anyone on any configured `maximoHosts` entry; the Worker just evaluates whichever rules apply to the fields that particular user's `whoami` returned.

## Buckets, field levels & delegated admin groups

Everything above still works exactly as described — hand-editing `permissions.json` directly is always fine, and root access never depends on any of this. This section covers the **admin tool** (`/admin` on your Worker URL — see `README.md` §7b for setup), which lets you delegate *pieces* of this file to other people without giving them the whole thing, and without them needing Maximo open at all (admin identity is a bearer token, not a whoami claim).

### The three new private-repo files

| File | Holds |
|---|---|
| `buckets.json` | The delegation hierarchy (a tree, e.g. company → country → site → workgroup) plus `fieldLevels` (which whoami field is allowed at which depth of that tree). |
| `adminGroups.json` | Admin identities — hashed bearer tokens grouped by who controls the same bucket with the same delegation rights. |
| `admin.html` | The admin page itself, served through the Worker at `/admin` (same private-repo-gated pattern as `wo_tool.js`). |

Neither `buckets.json` nor `adminGroups.json` is ever read by the live `/bootstrap`/`/check-access` path a regular user hits — they're purely admin-layer metadata. The only thing from this system that touches live access decisions is the optional `bucketId` you'll now see on `override`/`allow`/`blacklist` entries (see above examples) — and even that is *never evaluated*, just a label saying which admin group owns that entry.

### Buckets — a real hierarchy, not flat scopes

A bucket is one node: a parent (or none, for a top-level branch) plus one whoami condition (`field`/`op`/`value`) on top of it. Example:

```json
{
  "fieldLevels": { "email": 1, "country": 2, "insertSite": 3, "workgroup": 4 },
  "buckets": [
    { "id": "abbvie", "parentId": null, "label": "AbbVie", "field": "email", "op": "endsWith", "value": "@abbvie.com" },
    { "id": "abbvie-ie", "parentId": "abbvie", "label": "Ireland", "field": "country", "op": "eq", "value": "IE" },
    { "id": "abbvie-ie-avwp", "parentId": "abbvie-ie", "label": "AVWP", "field": "insertSite", "op": "eq", "value": "AVWP" }
  ]
}
```

An admin assigned to a bucket automatically controls that bucket **and everything beneath it** — an AVWP-level admin can grant/revoke access for anyone at AVWP or any workgroup under it, but can't touch Ireland or any other site.

### The hardlock — why a delegated admin's rules can't escape their branch

When a non-root admin creates an `allow`/`blacklist` entry, they only ever submit their *own* condition (e.g. "workgroup = Maintenance"). The Worker automatically prepends every ancestor condition on top — company, then country, then site — before storing it. **This isn't optional and isn't something the admin can turn off**: no matter what field they pick for their own condition (even something unrelated, like `email`), the stored rule can never match anyone outside their branch, because the ancestor conditions are always ANDed in underneath it. `override` and `extraGrants` don't get this treatment (they're username-keyed, nothing to prepend onto) — which is why they're **root-only**, always. Delegated admins grant access exclusively through `allow`.

### Field levels — governing which whoami field can be used where

A field's level is (by design) the same number as the tree depth it's meant for — `insertSite` at level 3 means "only usable for buckets/rules at depth 3, by admins at depth 3 or more senior." A company-level admin (depth 1) can reference any field, including deep ones; a workgroup-level admin (depth 4) can only use workgroup-appropriate fields, not reach up and reference `email` even in their own rules. This doesn't add security (the hardlock above already makes any field choice safe) — it keeps authoring *intentional*, so a junior admin can't invent a confusing rule that technically only affects their branch but reads like it's about something else entirely. Only root can introduce a brand-new field name into `fieldLevels`; a more senior admin can reassign an existing field's level (move it between levels), but never a peer or junior.

### Admin groups — delegate a permission once, add people to it

Instead of one token per person carrying its own copy of the same bucket+permissions, an **admin group** defines the permission once (which bucket, and two flags — can this group's members add peers to their own group, and can they create a new child group below them) and holds a list of members. Adding a fourth person to the same "Maintenance Workgroup Admins" group is just adding a member, not redefining anything.

**Cookbook — give someone AVWP-only admin access:**
1. In `/admin`, go to Buckets, find (or create) the `abbvie-ie-avwp` bucket.
2. Go to Groups, create a new group scoped to that bucket — pick whether its members can add peers to themselves and/or spin up workgroup-level groups beneath them.
3. Add that person as a member — the admin tool shows their token **once**. Give it to them directly (it's never recoverable afterward — revoking and re-adding is the only way back if it's lost).

They can now open `/admin` from anywhere (no Maximo needed), paste that token, and manage `allow` rules + sub-buckets + sub-admin-groups within AVWP, and nothing outside it.

### Root — the one identity everything else is scoped relative to

`ROOT_ADMIN_TOKEN` (a Wrangler secret, see `README.md`) always grants full, unscoped access — it bypasses `adminGroups.json` entirely, so it keeps working even if that file is empty, missing, or corrupted. Treat it like a master password. Root is the only identity that can: create top-level buckets, touch `override`/`extraGrants`, manage `version.json`, and register brand-new fields into `fieldLevels`.
