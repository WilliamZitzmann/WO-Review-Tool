# Managing access — a guide to `permissions.json`

This file lives **only** in the private repo (`WO-Review-Tool-Private`), never here. Every time someone clicks the bookmarklet, the Worker fetches it fresh from GitHub — there's no caching, no redeploy step. **Edit the file, save it, and it's live for the next person who clicks the bookmarklet.** You can edit it right in GitHub's web UI (open the file → pencil icon → edit → commit) or via git — either way, no `wrangler deploy` needed.

Reminder of what this actually is: a **governance gate**, not a hard security boundary. It stops link-sharing and keeps a deprovisioned user's old bookmarklet from still working. It does not stop someone with legitimate Maximo access from lying about their own session before the check runs. Treat every rule below in that light.

## How a request is decided

Four steps, in this exact order, first match wins:

1. **Override** — is this username in the `override` list? → granted immediately, skips everything else, including blacklist.
2. **Blacklist** — does any blacklist group fully match? → denied, full stop.
3. **Allow** — does any allow group fully match? → granted.
4. **Otherwise** → denied.

Then, if granted, `tiers.dev` / `tiers.beta` can *upgrade* that person's tier (see below) — tiers don't grant access on their own, they only raise the tier of someone who already got in via override or allow.

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

The Worker only asks the browser to send whichever of these fields your rules actually reference (checked automatically — you don't manage this list yourself), so adding a condition on a new field just works.

## The operators

| Op | Meaning | Example |
|---|---|---|
| `eq` | exact match (case-insensitive) | `{"field":"insertSite","op":"eq","value":"AVWP"}` |
| `neq` | not equal | `{"field":"country","op":"neq","value":"IE"}` |
| `endsWith` | string ends with (for email domains) | `{"field":"email","op":"endsWith","value":"@abbvie.com"}` |
| `startsWith` | string starts with | `{"field":"username","op":"startsWith","value":"ADMIN"}` |
| `in` | matches any value in a list | `{"field":"insertSite","op":"in","value":["AVWP","AVDU"]}` |
| `notIn` | matches none of a list | `{"field":"insertSite","op":"notIn","value":["AVWP","AVDU"]}` |

A **group** (used in `blacklist` and each allow entry's `conditions`) is a list of these — **all** of them must be true (AND). Multiple groups in `blacklist`/`allow` are OR'd — any one group matching is enough.

## What your current file actually grants

```json
"override": [{ "username": "ZITZMWX", "tier": "dev" }],
"blacklist": [],
"allow": [
  { "tier": "user", "conditions": [{ "field": "insertSite", "op": "eq", "value": "AVWP" }] },
  { "tier": "user", "conditions": [{ "field": "email", "op": "endsWith", "value": "@abbvie.com" }] }
],
"tiers": { "dev": ["ZITZMWX"], "beta": [] }
```

Plainly: **you** (`ZITZMWX`) always get in at dev tier, no matter what. Separately — and this is the wide-open part — **anyone at the AVWP site, OR anyone with any `@abbvie.com` email address**, gets `user` tier access. Since you said no one else is using it yet, nothing's actually happened as a result of this being broad, but it *is* effectively "all of AbbVie" as it stands. See "Narrowing this down" below if that's wider than you want before anyone else starts clicking the bookmarklet.

## Cookbook — common edits

**Add a beta tester** (already has access via `allow`, or give them access + beta in one move):
```json
"tiers": { "dev": ["ZITZMWX"], "beta": ["SOMEUSER"] }
```
If `SOMEUSER` doesn't already match an `allow` group, add them to `override` too (plain `user` tier is fine — beta just upgrades it):
```json
"override": [{ "username": "ZITZMWX", "tier": "dev" }, { "username": "SOMEUSER", "tier": "user" }]
```

**Add a dev tester** — same idea, `"tiers":{"dev":[...,"SOMEUSER"]}`, or `{"username":"SOMEUSER","tier":"dev"}` directly in `override` if they shouldn't have to also match an allow rule.

**Block one specific person, no matter what else matches:**
```json
"blacklist": [
  [{ "field": "username", "op": "eq", "value": "JAMESXW" }]
]
```
(A single-condition group — still written as an array-of-one, since blacklist groups are always arrays.)

**Block an entire site:**
```json
"blacklist": [
  [{ "field": "insertSite", "op": "eq", "value": "AVDU" }]
]
```

**Narrowing today's wide-open access down to a specific list of people**, instead of "anyone at AVWP or anyone @abbvie.com":
```json
"allow": [
  { "tier": "user", "conditions": [{ "field": "username", "op": "in", "value": ["USER1", "USER2", "USER3"] }] }
]
```
Remove the `insertSite`/`email` groups entirely once you've moved to an explicit list — otherwise both the list AND the broad rule are still live (allow groups are OR'd, so the broad one would still let everyone else in).

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
   { "tier": "user", "conditions": [{ "field": "email", "op": "endsWith", "value": "@othercompany.com" }] }
   ```
   or by site code if you know it, same pattern as AVWP above.

3. **Verify their `whoami` shape matches**, before assuming it does. This whole field-mapping (`loginID`→`username`, `email`, `insertSite`, etc.) was built against AbbVie's actual Maximo response — other companies' Maximo versions/configs can expose slightly different field names. Have someone from that company run the same console snippet from `Whoami function and other maximo commands.txt` (kept local-only, not in either repo) against their instance, and compare the returned field names to `loader.js`'s `readWhoami()` mapping. If their fields differ, that mapping needs a small update (adding another fallback like `d.loginID || d.userName || d.theirFieldName`) — that's a `loader.js` change, not a `permissions.json` one, since it's public and shared across every company.

That's it — no separate deployment, no separate bookmarklet. The same `bookmarklet.js`/`loader.js` works for anyone on any configured `maximoHosts` entry; the Worker just evaluates whichever rules apply to the fields that particular user's `whoami` returned.
