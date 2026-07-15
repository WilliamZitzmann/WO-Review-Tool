# Maximo Data Sources — Reference

Notes on data available to the browser session beyond what the tool currently
scrapes from the DOM. Two distinct sources, both same-origin (no extra auth
needed — they ride the browser's existing logged-in Maximo session):

1. **Cached domain/lookup lists** — value lists Maximo's own UI keeps in
   `localStorage` to populate dropdowns without a server round trip.
2. **The OSLC REST API** (`/maximo/oslc/os/...`) — Maximo's own backend API,
   callable directly via `fetch()` from the console (or from the tool).

This file only documents what's been confirmed to actually work (console
commands run against a real WO, real responses pasted back). Anything not
directly confirmed is marked as such — don't build on an unconfirmed shape.

---

## 1. Cached domain/lookup lists (`localStorage`)

Reported keys and their contents (found via manual inspection of
`localStorage`, key names and one-line descriptions only — **the exact JSON
shape of each value hasn't been confirmed yet**; check
`JSON.parse(localStorage.getItem('KEY'))` in the console to see the real
structure before building anything against it):

| Key | Contents |
|---|---|
| `ABBCLAUSECODE` | PO clause code library |
| `ABBWPRIORITY` | Work priorities (Emergency, 2hr, etc.) |
| `WOCLASS` | WO classes (Activity, Change, Release...) |
| `DOWNCODE` | Downtime reason codes |
| `LOCASSETSTATUS` | Asset status codes |
| `ABBASPRIORITY` | Asset priority levels |
| `HAZTYPE` | Hazard types (Electrical, Health, Mechanical) |
| `POSTATUS` / `PRSTATUS` | PO / PR status codes |
| `ASSETTYPE` | Full asset type hierarchy |
| `ABVASSETCAT` | Asset categories (AC Unit, Accumulator...) |
| `SHIPVIA` | Shipping method codes (323KB — very complete) |
| `ABBWOEXECMETHOD` | WO execution methods (Handheld, Maximo, Paper) |
| `CREWID` | Crew IDs |
| `JOBPLANSTATUS` | Job plan statuses |

These are almost certainly Maximo's standard "domain" value lists (a code →
description mapping used to populate a `<select>`), cached client-side once
per session so re-opening a dropdown doesn't re-fetch it. Likely shape is an
array of `{value, description}` pairs or similar, but **confirm before
relying on it** — domain caches can also be keyed slightly differently
depending on Maximo version/config.

---

## 2. OSLC REST API — confirmed working patterns

All requests below were run from the browser console on a live WO page and
returned real data (responses included, trimmed for brevity). Every request
uses `Accept: application/json` and `_format=json`; several add `lean=1`
(strips OSLC envelope noise — `href`/`_rowstamp` etc. — down to closer to a
flat object). `siteid` was hardcoded to `"AVWP"` in these tests — a real
implementation would need to read the actual site from the current WO/user
context, not assume one site.

### 2.1 Work order history for an asset

```js
fetch('/maximo/oslc/os/mxapiwo?oslc.where=assetnum%3D%22' + assetnum +
  '%22%20and%20siteid%3D%22AVWP%22' +
  '&oslc.select=wonum,description,status,wopriority,reportdate,worktype' +
  '&oslc.orderBy=-reportdate&oslc.pageSize=10&lean=1&_format=json',
  { headers: { 'Accept': 'application/json' } })
  .then(r => r.json())
  .then(d => console.table(d.member));
```

Returns `{member: [...]}`, one object per WO, newest first. Confirmed
fields: `wonum`, `description`, `status`, `wopriority`, `reportdate`,
`worktype`. With `lean=1`, coded fields also get a paired
`<field>_description` (e.g. `status_description: "Waiting to be
scheduled"`, `wopriority_description: "Within 8 Hours"`) — a human-readable
label for the code, straight from the API, no local domain-list decode
needed for these ones.

### 2.2 Single work order by its internal ID

```js
var woId = new URLSearchParams(window.location.search).get('uniqueid');
fetch('/maximo/oslc/os/mxapiwo/' + woId +
  '?oslc.select=wonum,description,status,assetnum,location,wopriority,' +
  'reportdate,targstartdate,targcompdate,lead,supervisor,failurecode,' +
  'problemcode,causecode,remedycode&lean=1&_format=json',
  { headers: { 'Accept': 'application/json' } })
  .then(r => r.json())
  .then(wo => console.log(wo));
```

`uniqueid` (the WO's internal numeric ID, distinct from `wonum`) comes
straight off the page URL's query string — no lookup needed, works on any
open WO tab. Confirmed real response fields include everything requested
plus each coded field's `_description` companion.

**Full raw dump** (no `oslc.select` at all) is a useful *discovery*
technique — fetch `mxapiwo/{id}?lean=1&_format=json` with no select filter
to see every scalar field and sub-resource collection ref the WO record
actually carries. One real dump returned ~130 scalar fields (labor hours,
costs, org/site codes, flags, dates, `abb*`/`abv*` custom fields) plus one
collection ref (`worklog`). Worth re-running this on a WO from each work
type if custom fields differ by type.

### 2.3 Asset lookup

```js
fetch('/maximo/oslc/os/mxapiasset?oslc.where=assetnum%3D%22' + assetnum +
  '%22%20and%20siteid%3D%22AVWP%22' +
  '&oslc.select=assetnum,description,assetstatus,location,assettype,serialnum' +
  '&lean=1&_format=json',
  { headers: { 'Accept': 'application/json' } })
  .then(r => r.json())
  .then(d => console.log(d.member?.[0]));
```

Returns `{member: [...]}` (filter by `assetnum`+`siteid` still returns an
array — take `member[0]`). `assetstatus_description` came back as
`undefined` in testing even though other `_description` fields worked
elsewhere — **not reliable on every field**, don't assume every coded field
gets a description automatically.

### 2.4 Asset downtime history

```js
fetch('/maximo/oslc/os/mxapiasset?oslc.where=assetnum%3D%22' + assetnum +
  '%22%20and%20siteid%3D%22AVWP%22' +
  '&oslc.select=assetnum,moddowntimehist{startdate,enddate,downtimecode,remarks}' +
  '&lean=1&_format=json',
  { headers: { 'Accept': 'application/json' } })
  .then(r => r.json())
  .then(d => console.table(d.member?.[0]?.moddowntimehist));
```

The `collection{field1,field2}` nested-select syntax works — it returns the
asset's full downtime history (not scoped to any single WO), independent of
whatever's visible on the currently-open WO's own downtime tab. **Caveat,
confirmed by repeated testing**: only `startdate`/`enddate` (plus
`href`/`localref`) actually came back — `downtimecode`, `remarks`,
`reportedby`, and `positivedowntime` were all requested but never appeared
in the response, across multiple attempts. Either those fields need a
different access path (e.g. a follow-up fetch via each row's own
`localref`), or they're not exposed through this particular nested-select
route. **Don't build on downtimecode/remarks working this way until that's
resolved** — only start/end timestamps are confirmed reliable here.

A sibling collection, `downtimereport`, also exists on the asset resource
but returned only a stub reference (`{localref, href}`, no data) — would
need a separate follow-up fetch via its `localref` to actually pull
anything.

### 2.5 Chained lookups (WO → asset → asset's other WOs)

Confirmed working end-to-end: fetch the open WO → read its `assetnum` →
fetch that asset's detail → fetch that asset's other WO history (2.1 above,
keyed by the asset just resolved) — three sequential fetches, each feeding
the next's `oslc.where`. This is the shape a "has this asset failed
recently / repeatedly" check would use.

---

## 3. What this could realistically be used for

Ideas, roughly ordered by how safe/cheap they'd be to build:

1. **Decode a coded field via a domain list, locally, no network call** — a
   `domain(key, code)` formula helper reading straight from the
   already-cached `localStorage` list (e.g. `DOWNCODE`, `HAZTYPE`). Cheapest
   option here: no new network traffic, no new permission surface, just a
   local lookup. Blocked on confirming the actual value shape in §1 first.
2. **Lean on `_description` fields instead of a local decode** — for the
   subset of REST-sourced fields that already come back with a
   `_description` companion (confirmed for WO status/priority/class/exec
   method), no separate domain-list decode is even needed if the data's
   coming from a REST call rather than DOM scrape.
3. **Asset-history rules** — "this asset has had N work orders in the last
   30 days" or "this asset had unplanned downtime in the last week" as a
   new Rule, fed by §2.1/§2.4 instead of (or alongside) a DOM-scraped Downtime
   group. Would surface repeat-failure patterns the currently-open WO's own
   tabs can't show, since they only show what's linked to *this* WO.
4. **Richer/faster scan target** — an asset or WO detail fetched via REST
   (§2.2/§2.3) is a single request instead of navigating a tab and waiting
   for DOM render, and immune to the DOM-scrape fragility (relies on a
   stable field name, not a CSS id that can shift between Maximo versions).

**This is a materially different data-access model than the tool's current
design** (every existing scan step navigates a tab and scrapes rendered
DOM). Adding REST-based data collection as a real feature — a new scan
target type, or a formula helper that fetches live — isn't a small addition:
it changes what "a scan" means, needs its own error handling for a failed/
slow request, and its reliability depends on organizational REST API
access not being blocked or rate-limited (unconfirmed whether that's a
concern here). Recommend treating #1/#2 (local-only, no new network
surface) as safe to build now if wanted, and treating #3/#4 (new REST calls
as part of a scan) as a separate, larger decision — worth a deliberate
scope conversation before starting, not a silent addition.
