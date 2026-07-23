/**
 * WO Review Tool — access-control Worker.
 *
 * SCOPE, HONESTLY STATED: this gates casual/unauthorized use of the tool —
 * it stops link-sharing, stops a deprovisioned user's old bookmarklet from
 * still working, and keeps the tool source + the permissions list off any
 * public URL. It is NOT a hard security boundary. Identity comes from a
 * client-reported whoami claim (this Worker cannot reach the Maximo
 * instance directly — it's VPN-only), so a user willing to lie about their
 * own session before the token is issued is not stopped by this. Encrypting
 * the request body was considered and deliberately skipped: TLS already
 * covers transit, and app-layer crypto wouldn't change what a user with
 * devtools open on their own legitimate session can already see.
 *
 * Regular-user endpoints (unchanged behavior from before the admin layer below):
 *   GET  /bootstrap      — public. Returns { maximoHosts, requiredFields }.
 *   POST /check-access   — body: { fields: {...} } (only the fields
 *                          /bootstrap said were required). Evaluates
 *                          override -> blacklist -> allow -> deny and
 *                          returns { granted, grants, token? }. `grants` is
 *                          an array (e.g. ["user","dev","beta_0"]) rather
 *                          than a single tier — a user can hold more than
 *                          one flag at once (e.g. dev AND beta_0).
 *                          "beta_0" is a wildcard meaning "all betas"; the
 *                          client treats any other "beta_N" as one specific
 *                          feature.
 *   GET  /tool?token=...&version=X.Y.Z (version optional)
 *                        — redeems a short-lived signed token and proxies
 *                          wo_tool.js from the private repo. With no
 *                          version, serves whatever GITHUB_BRANCH currently
 *                          holds; with one, serves that exact "vX.Y.Z" tag
 *                          (the private repo needs the same tags pushed to
 *                          it as the public repo, for every release, so
 *                          version pinning/rollback keeps working).
 *   POST /feedback       — body: { token, type, body, context }. Requires a
 *                          valid (unexpired) access token, same as /tool —
 *                          this is what stops the endpoint being an open
 *                          spam relay, not a separate auth check. Files a
 *                          GitHub Issue in the PRIVATE repo (so a reporter
 *                          never needs private-repo access themselves) and
 *                          returns { ok, issueUrl }.
 *
 * Admin endpoints (new — manage permissions.json / buckets.json /
 * adminGroups.json / version.json without hand-editing on GitHub):
 *   GET  /admin                        — public, unauthenticated shell.
 *                                        Serves admin.html from the private
 *                                        repo (Cache-Control: no-store on
 *                                        the response). No data, no role —
 *                                        just the login form.
 *   POST /admin/login                  — public. Body { email, password }.
 *                                        Real accounts (PBKDF2-hashed
 *                                        passwords, email as the
 *                                        identifier), not raw bearer tokens
 *                                        — returns a signed session token
 *                                        on success. See handleAdminLogin.
 *   POST /admin/complete-signup        — public. Body { token, newPassword
 *                                        }. Redeems a one-time emailed
 *                                        setup/reset link (see
 *                                        sendAccountSetupEmail), sets the
 *                                        account's password, logs them in.
 *   POST /admin/forgot-password        — public. Body { email }. Self-
 *                                        service reset — always returns the
 *                                        same generic response regardless
 *                                        of whether the email matched an
 *                                        account (no enumeration signal).
 *                                        No-op if Resend isn't configured.
 *   All other /admin/* routes require `Authorization: Bearer <token>`,
 *   resolved by resolveAdminIdentity() — either ROOT_ADMIN_TOKEN (a
 *   Wrangler secret, unconditional break-glass, bypasses adminGroups.json
 *   entirely) or a session token issued by /admin/login (HMAC-signed,
 *   ADMIN_SESSION_SECRET, 12h TTL — but every request still re-checks the
 *   account/group actually exist, so a revoked account's session dies on
 *   its next request regardless of TTL). See
 *   access-control/PERMISSIONS_GUIDE.md for the full hierarchy/delegation
 *   model (buckets, field levels, admin groups/accounts, the
 *   ancestor-condition "hardlock" prepend). Route list:
 *     POST   /admin/login
 *     POST   /admin/complete-signup
 *     POST   /admin/forgot-password
 *     POST   /admin/accounts/me/change-password
 *     POST   /admin/accounts/:id/reset-password
 *     GET    /admin/root-accounts
 *     POST   /admin/root-accounts
 *     DELETE /admin/root-accounts/:id
 *     GET    /admin/permissions
 *     POST   /admin/permissions/:section        (allow|blacklist|override|extraGrants —
 *                                                  all four are condition-based, {conditions[],
 *                                                  grants?} — a non-root submission's grants
 *                                                  silently collapse to just ["user"], dev/beta_*
 *                                                  are root-only)
 *     DELETE /admin/permissions/:section/:id
 *     POST   /admin/maximo-hosts                — root-only, whole-array replace, body
 *                                                  {hosts:[{hostname,url}]}
 *     GET    /admin/buckets                     — also returns canonicalFields (known whoami
 *                                                  field names) for the admin UI's field picker
 *     POST   /admin/buckets
 *     PATCH  /admin/buckets/:id                 — incl. allowedFields ([] = no fields usable by
 *                                                  this bucket's own admin tier, null/absent =
 *                                                  all fields usable — see canUseFieldForIdentity)
 *     DELETE /admin/buckets/:id?cascade=true
 *     GET    /admin/configs                   — metadata only (name/description/bucketId/
 *                                                conditions), never the heavy content blob
 *     POST   /admin/configs                   — body {name, description, bucketId,
 *                                                ownConditions, content} - content is the
 *                                                same JSON shape as wo_tool.js's Setup >
 *                                                Export/Import. Admin-side management only;
 *                                                nothing in wo_tool.js consumes these yet.
 *     GET    /admin/configs/:id               — download (returns metadata + full content)
 *     PATCH  /admin/configs/:id                — rename/re-target/replace content
 *     DELETE /admin/configs/:id
 *     POST   /admin/configs/:id/duplicate      — body {name, bucketId, ownConditions} -
 *                                                copies an existing config's content into
 *                                                a new one (e.g. a site admin duplicating
 *                                                a company-level config down to their site)
 *     GET    /admin/groups
 *     POST   /admin/groups
 *     POST   /admin/groups/:id/members          — creates an ACCOUNT (email +
 *                                                  either a temp password shown
 *                                                  once, or an emailed setup link
 *                                                  if Resend is configured — see
 *                                                  provisionAccount)
 *     DELETE /admin/groups/:id/members/:memberId
 *     DELETE /admin/groups/:id
 *     GET    /admin/version
 *     POST   /admin/version
 *     GET    /admin/packages                   — packages.json (private issue #3, Phase 4)
 *     POST   /admin/packages                   — body {doc} — the same array shape
 *                                                loadPackagesCached()/resolvePackagesForUser()
 *                                                already read at runtime; root-only, since a
 *                                                package's grant requirement applies to every
 *                                                bucket, not one admin's own scope.
 *   Every admin write does its own fresh (uncached) read of the file it's
 *   about to change immediately before writing — see loadPermissionsLive/
 *   loadBucketsDoc/loadAdminGroupsDoc — so no client-supplied sha is
 *   needed for single-entry operations; the staleness window is the
 *   lifetime of one request, not "since the client's last GET". A raw
 *   GitHub 409 (two writes landing in the same instant) is surfaced as a
 *   plain error for the human to retry — extremely rare at this scale.
 *
 * Password reset — two paths, both eventually funnel through the same
 * emailed-link mechanism once Resend is configured (RESEND_API_KEY +
 * RESEND_FROM_EMAIL): self-service (/admin/forgot-password) or admin-
 * assisted (/admin/accounts/:id/reset-password, for someone who can't
 * self-serve or before Resend is set up). If Resend ISN'T configured,
 * account creation/reset falls back to showing a temp password once in
 * the admin UI instead — the system stays fully functional either way,
 * see isEmailSendingConfigured()/provisionAccount().
 *
 * Regular-user `admin` grant: handleCheckAccess cross-references the
 * whoami email against every admin-account email (loadAdminAccountEmails,
 * edge-cached like permissions.json) and adds an `admin` grant on top of
 * an already-granted result — wo_tool.js shows an Admin button when this
 * grant is present, linking here. Deliberately only ever ADDS to an
 * existing grant, never grants regular tool access on its own.
 *
 * Required secrets (wrangler secret put ...):
 *   GITHUB_PAT            — fine-grained PAT covering BOTH repos (public
 *                            WO-Review-Tool for version.json, private
 *                            WO-Review-Tool-Private for wo_tool.js/
 *                            permissions.json/buckets.json/adminGroups.json/
 *                            admin.html). Needs Contents:Read-and-write on
 *                            both, plus Issues:write on the private repo
 *                            (feedback reports).
 *   TOKEN_SECRET          — random string, signs the short-lived
 *                            regular-user access tokens (/check-access,
 *                            /tool, /feedback).
 *   ROOT_ADMIN_TOKEN       — random string, unconditional full-admin
 *                            bearer token — the break-glass credential
 *                            that always works even if adminGroups.json is
 *                            empty, missing, or corrupted, and the only
 *                            way to bootstrap the first root ACCOUNT (see
 *                            POST /admin/root-accounts). Never stored
 *                            inside adminGroups.json itself.
 *   ADMIN_SESSION_SECRET   — random string, signs admin session tokens
 *                            issued by /admin/login, AND the one-time
 *                            setup/reset links emailed by
 *                            sendAccountSetupEmail (a distinct `type`
 *                            claim keeps the two token kinds from being
 *                            confused with each other). A distinct secret
 *                            from TOKEN_SECRET on purpose — the two
 *                            credential classes (regular-user vs. admin)
 *                            shouldn't share a trust domain.
 *   RESEND_API_KEY         — optional. If unset (along with RESEND_FROM_EMAIL
 *                            below), email sending is simply skipped and
 *                            everything falls back to on-screen temp
 *                            passwords — see isEmailSendingConfigured().
 *
 * Required vars (wrangler.toml [vars]):
 *   GITHUB_OWNER, GITHUB_REPO (private repo), GITHUB_BRANCH
 *   RESEND_FROM_EMAIL      — optional, not sensitive (just an address) — see
 *                            RESEND_API_KEY above.
 */

const TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes — used almost immediately after issue
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — bounds a left-open tab; sessionStorage's own tab-close boundary is the more common expiry in practice
// maximoHost is synthetic — not part of Maximo's own whoami response at
// all, it's the browser's own location.hostname (see loader.js's
// readWhoami() / wo_tool.js's readWhoamiCanonical()), included here so it
// can be used as an ordinary condition field like any other — most
// usefully for a company-level bucket, since which Maximo host you're on
// is a more direct signal than an incidental email-domain match, and
// (unlike email) isn't already claimed by any other tier.
const CANONICAL_FIELDS = ['username', 'email', 'country', 'insertSite', 'langcode', 'displayName', 'defaultSiteDescription', 'primaryEmail', 'city', 'firstName', 'lastName', 'maximoHost'];

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

function json(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
    });
}

// ── GitHub private-repo fetch (server-side only — the PAT never reaches the client) ──
// `ref` defaults to the configured branch (used for permissions.json, and
// for wo_tool.js on the "dev channel"/unpinned case) — passing a specific
// tag (e.g. "v0.20.34") serves an exact pinned release instead, mirroring
// the public repo's existing tag-per-version convention. The private repo
// needs the same tags pushed to it for this to resolve.
async function fetchPrivateFile(env, path, ref) {
    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${ref || env.GITHUB_BRANCH}`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.raw',
            'User-Agent': 'wo-review-tool-worker',
        },
    });
    if (!res.ok) throw new Error(`GitHub fetch failed for ${path}${ref ? '@' + ref : ''}: HTTP ${res.status}`);
    return res.text();
}

// ── Edge cache for GitHub reads ──
// Every /bootstrap and /check-access call used to re-fetch permissions.json
// from GitHub (two full round trips per launch, not one), and every /tool
// call re-fetched wo_tool.js (hundreds of KB) even when nothing had
// changed since the last request. Caching at Cloudflare's edge (not
// client-side, and not the access DECISION itself) cuts that down to a
// single GitHub fetch per TTL window, worldwide, while every request still
// re-evaluates permissions against whatever's in the cache — a revoke
// still lands within the TTL, not "whenever this browser feels like
// re-checking." A tagged version ref is immutable by convention (a
// released tag never gets its content changed after the fact), so pinned
// tool fetches cache far longer than the branch HEAD / permissions.json,
// which can change at any time.
//
// NOTE: this cache is ONLY used by the regular-user path (loadPermissions,
// handleGetTool below). All /admin/* reads bypass it entirely (see
// fetchFileWithSha) — admin operations need live data, not a ~30s-stale
// edge copy, especially since a write immediately re-reads before merging.
const PERMISSIONS_CACHE_TTL = 30; // seconds
const TOOL_SRC_CACHE_TTL_PINNED = 24 * 60 * 60; // seconds — a "vX.Y.Z" tag never changes
const TOOL_SRC_CACHE_TTL_UNPINNED = 15; // seconds — dev channel tracks a moving branch

async function cachedFetchPrivateFile(env, ctx, path, ref, ttlSeconds) {
    const cache = caches.default;
    const cacheKey = new Request('https://wo-review-tool-cache.internal/' + path + (ref ? '@' + ref : ''));
    const hit = await cache.match(cacheKey);
    if (hit) return hit.text();
    const text = await fetchPrivateFile(env, path, ref);
    const toCache = new Response(text, { headers: { 'Cache-Control': 'max-age=' + ttlSeconds } });
    if (ctx && ctx.waitUntil) {
        ctx.waitUntil(cache.put(cacheKey, toCache));
    } else {
        await cache.put(cacheKey, toCache);
    }
    return text;
}

async function loadPermissions(env, ctx) {
    const raw = await cachedFetchPrivateFile(env, ctx, 'permissions.json', null, PERMISSIONS_CACHE_TTL);
    return JSON.parse(raw);
}

// Cached, fail-open read of configs/index.json for the REGULAR-user path
// (bootstrap/check-access) — deliberately separate from the admin-side
// loadConfigsIndexDoc() (uncached, throws, carries a sha for optimistic-
// concurrency writes). A hiccup here must never block ordinary tool access,
// same reasoning as loadAdminAccountEmails() below.
async function loadConfigsIndexCached(env, ctx) {
    try {
        var raw = await cachedFetchPrivateFile(env, ctx, 'configs/index.json', null, PERMISSIONS_CACHE_TTL);
        var doc = JSON.parse(raw);
        doc.configs = doc.configs || [];
        return doc;
    } catch (e) {
        return { configs: [] };
    }
}

// Cached, fail-open read of buckets.json for the REGULAR-user path — same
// reasoning as loadConfigsIndexCached() above. This is a deliberate
// exception to the general "buckets.json is admin-layer only, never read
// on the hot path" rule: contact-email resolution (resolveContactForBucket)
// needs the real tree structure, not just a pre-baked ancestor-condition
// chain the way permissions/configs matching does — there's no way to
// "bake in" a nearest-ancestor walk ahead of time the way
// buildEntryConditions() does for access rules.
async function loadBucketsDocCached(env, ctx) {
    try {
        var raw = await cachedFetchPrivateFile(env, ctx, 'buckets.json', null, PERMISSIONS_CACHE_TTL);
        var doc = JSON.parse(raw);
        doc.buckets = doc.buckets || [];
        return doc;
    } catch (e) {
        return { buckets: [] };
    }
}

// Cached, fail-open read of packages.json for the REGULAR-user path — same
// reasoning as loadConfigsIndexCached()/loadBucketsDocCached() above. Backs
// the package-eligibility resolution in handleCheckAccess() below (private
// issue #3, "v1.0.0 — Modularisation"). A hiccup here just means no
// packages resolve for this request, never blocks the underlying grant
// decision — packages are additive to an already-granted session, exactly
// like org configs.
async function loadPackagesCached(env, ctx) {
    try {
        var raw = await cachedFetchPrivateFile(env, ctx, 'packages.json', null, PERMISSIONS_CACHE_TTL);
        var doc = JSON.parse(raw);
        doc.packages = doc.packages || [];
        return doc;
    } catch (e) {
        return { packages: [] };
    }
}

// ── Rule evaluation ──
function evalCondition(user, cond) {
    var v = String(user[cond.field] || '').toLowerCase();
    var target = cond.value;
    switch (cond.op) {
        case 'eq':
            return v === String(target).toLowerCase();
        case 'neq':
            return v !== String(target).toLowerCase();
        case 'endsWith':
            return v.endsWith(String(target).toLowerCase());
        case 'startsWith':
            return v.startsWith(String(target).toLowerCase());
        case 'in':
            return Array.isArray(target) && target.some(function(t) { return v === String(t).toLowerCase(); });
        case 'notIn':
            return Array.isArray(target) && !target.some(function(t) { return v === String(t).toLowerCase(); });
        default:
            return false;
    }
}

// admin.html's condition editors (bucket own-condition, permission entry
// ownConditions, config ownConditions/orConditions) all offer 'in'/'notIn'
// as selectable ops, but every one of those UI panels only ever submits a
// single plain-string value — never an array. evalCondition's 'in'/'notIn'
// cases require Array.isArray(target), so those ops silently evaluate to
// false whenever the value arrived as-typed from the UI. Rather than fix
// every panel's markup individually, every admin write path that accepts a
// condition object runs it through this first: for 'in'/'notIn', a string
// value is comma-split and trimmed into an array (already-array values pass
// through untouched, so a future array-aware UI keeps working too).
function normalizeCondition(c) {
    if (!c || typeof c !== 'object') return c;
    var out = { field: c.field, op: c.op, value: c.value };
    if ((c.op === 'in' || c.op === 'notIn') && typeof c.value === 'string') {
        out.value = c.value.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    }
    return out;
}
function normalizeConditions(list) {
    return Array.isArray(list) ? list.map(normalizeCondition) : list;
}

// A missing/empty conditions array must NEVER match — an override/allow/
// blacklist entry with no conditions is a data bug (e.g. a pre-migration
// record), not "matches everyone." Array.prototype.every() on [] is
// vacuously true, which would silently grant universal access if this
// guard weren't here.
function evalGroup(user, conditions) {
    return Array.isArray(conditions) && conditions.length > 0 &&
        conditions.every(function(c) { return evalCondition(user, c); });
}

// Precedence: override -> blacklist -> allow -> default deny.
// override/blacklist/allow are ALL condition-based now (AND within one
// entry's conditions[], OR across entries in the same list) — override
// used to be a bare username-equality match; that's now just what it
// migrates to (a single {field:"username",op:"eq",value:"..."} condition),
// not a separate code path. See PERMISSIONS_GUIDE.md's migration note.
function evaluateAccess(perms, user) {
    var override = (perms.override || []).find(function(o) {
        return evalGroup(user, o.conditions);
    });
    if (override) {
        return { granted: true, grants: resolveGrants(perms, user, override.grants) };
    }

    // blacklist entries are {bucketId, conditions} objects (bucketId is
    // admin-layer metadata only — see buckets.json / PERMISSIONS_GUIDE.md's
    // "delegated admin groups" section; this evaluator never reads it).
    var blacklisted = (perms.blacklist || []).some(function(entry) {
        return evalGroup(user, entry.conditions);
    });
    if (blacklisted) {
        return { granted: false };
    }

    var allowMatch = (perms.allow || []).find(function(group) {
        return evalGroup(user, group.conditions);
    });
    if (allowMatch) {
        return { granted: true, grants: resolveGrants(perms, user, allowMatch.grants) };
    }

    return { granted: false };
}

// Merges the base grants a user got from their matching override/allow rule
// with any extra flags from every perms.extraGrants entry whose conditions
// ALSO match this user — this is the server-side replacement for the
// console __woEnableBeta/__woEnableDev commands, not a separate access gate
// of its own. Lets one person hold multiple grants at once (e.g. dev +
// beta_0) without needing a dedicated override entry for every combination.
// extraGrants used to be a {username: [grants]} map (exact-match only, no
// conditions) — now an array of {conditions[], grants[]} like every other
// list here, so ALL matching entries contribute (not just one), same OR-
// across-entries/AND-within-an-entry rule as override/allow/blacklist.
function resolveGrants(perms, user, baseGrants) {
    var set = {};
    (baseGrants && baseGrants.length ? baseGrants : ['user']).forEach(function(g) { set[g] = true; });
    (perms.extraGrants || []).forEach(function(entry) {
        if (evalGroup(user, entry.conditions)) {
            (entry.grants || []).forEach(function(g) { set[g] = true; });
        }
    });
    return Object.keys(set);
}

// Every field name referenced anywhere in the ruleset, plus username and
// email always — username for override/tier lookups even if no condition
// references it directly, email because handleCheckAccess's auto-`admin`-
// grant cross-reference (see below) needs it regardless of whether any
// permissions.json rule happens to mention it. The client only ever sends
// this list, not every whoami field.
function computeRequiredFields(perms) {
    var fields = { username: true, email: true };
    function collect(conditions) {
        (conditions || []).forEach(function(c) {
            if (CANONICAL_FIELDS.indexOf(c.field) !== -1) fields[c.field] = true;
        });
    }
    (perms.override || []).forEach(function(entry) { collect(entry.conditions); });
    (perms.blacklist || []).forEach(function(entry) { collect(entry.conditions); });
    (perms.allow || []).forEach(function(group) { collect(group.conditions); });
    (perms.extraGrants || []).forEach(function(entry) { collect(entry.conditions); });
    return Object.keys(fields);
}

// Every field referenced in any config entry's (already ancestor-prepended,
// see buildEntryConditions) conditions — merged into computeRequiredFields'
// list so /bootstrap tells loader.js to actually send whoami fields a
// config's bucket chain depends on, even when nothing in permissions.json
// happens to reference that field (e.g. access is granted purely by email
// domain, but site-level config targeting still needs insertSite).
function computeConfigRequiredFields(configsDoc) {
    var fields = {};
    (configsDoc.configs || []).forEach(function(entry) {
        (entry.conditions || []).forEach(function(c) {
            if (CANONICAL_FIELDS.indexOf(c.field) !== -1) fields[c.field] = true;
        });
    });
    return Object.keys(fields);
}

// Which admin-authored configs apply to this whoami — ALL matches are
// returned (not a single most-specific winner): the user explicitly wants
// every applicable config to show up as a choice in the installer, not one
// auto-picked default. Unlike evalGroup() (used for override/allow/
// blacklist, where empty conditions[] must never vacuously match — that
// would be an accidental universal access grant), a config's empty
// conditions[] legitimately means "applies to everyone at that bucket" (or
// literally everyone, for a root config with no ownConditions) — not a
// security-relevant match, so Array.prototype.every()'s natural vacuous-
// true on [] is exactly the wanted behavior here, not a bug to guard
// against.
function matchesConfigConditions(user, conditions) {
    return Array.isArray(conditions) && conditions.every(function(c) { return evalCondition(user, c); });
}

// ── OR logic for config matching (private issue #7) ──
// A config entry can now target MULTIPLE buckets and/or carry extra
// standalone OR-branches (orConditions) alongside the bucket(s) it's
// scoped to — the entry matches if ANY one branch matches, satisfying
// both of the issue's written examples: "Site = Westport OR Sligo" (two
// bucketIds, or a single bucket whose OWN condition uses op:'in' with
// multiple values — both already work via evalCondition's existing 'in'
// case) and "Site = Westport OR user = specific person" (bucketIds:
// [westport], orConditions: [[{field:'username',...}]] — a branch with NO
// bucket chain at all).
//
// Stored shape going forward: entry.conditionGroups (array of AND-groups,
// OR'd). Reads the OLD flat entry.conditions (a single implicit AND-group)
// for anything not yet re-saved under the new shape — zero data migration
// needed, exactly the same "handle both shapes forever" pattern used
// throughout this codebase (isNewRuleShape, extractPackageSectionsFromLegacyShape).
function configEntryMatchGroups(entry) {
    if (Array.isArray(entry.conditionGroups)) return entry.conditionGroups;
    return [entry.conditions || []];
}
// Same "read either shape" fallback as configEntryMatchGroups(), for the
// admin-scope (isAtOrBelow) checks rather than the whoami-matching ones —
// a scoped admin can see/touch a multi-bucket config if ANY of its target
// buckets is within their scope, not only the first.
function configEntryBucketIds(entry) {
    return Array.isArray(entry.bucketIds) ? entry.bucketIds : [entry.bucketId !== undefined ? entry.bucketId : null];
}
function matchesConfigEntry(user, entry) {
    return configEntryMatchGroups(entry).some(function(group) { return matchesConfigConditions(user, group); });
}

// Builds the full conditionGroups for a config entry from admin input:
// one AND-group per target bucket (that bucket's own ancestor chain +
// the shared ownConditions), plus any additional standalone orConditions
// groups (no bucket chain prepended at all). bucketIds is an ARRAY here
// deliberately (not a single id) — passing [] means "no bucket-scoped
// branch at all" (pure orConditions-only config), which is intentionally
// different from passing [null] (one branch scoped to the root/global
// bucket, matching everyone in it).
function buildConfigConditionGroups(bucketIds, ownConditions, orConditions, byId) {
    var groups = bucketIds.map(function(bid) {
        return bucketConditionChain(bid, byId).concat(ownConditions || []);
    });
    (orConditions || []).forEach(function(g) {
        if (Array.isArray(g)) groups.push(g);
    });
    return groups;
}

// clientConfigVersion is the requesting wo_tool.js build's own
// CURRENT_CONFIG_VERSION (private issue #3, Phase 5, "modular configs" —
// configVersion-aware org-config filtering), sent on every /check-access
// call by loader.js/wo_tool.js. An entry with no configVersion at all
// predates this field and is treated as 1 (the oldest/most conservative
// shape) — same `|| 1` convention wo_tool.js's own migrateProfile()/
// installOrgConfig() already use for untagged content. A caller that omits
// clientConfigVersion entirely (an old loader.js/wo_tool.js build that
// predates this) is treated the same way: only version-1 configs are ever
// offered to it, never a config shaped for a schema it can't understand.
// This is a visibility filter ONLY — an incompatible config was already
// unable to actually apply (migrateProfile()/applyBackup() throw a clear
// error on a too-new configVersion); this just keeps it from ever showing
// up as a choice in the first place.
function resolveOrgConfigsForUser(user, configsDoc, clientConfigVersion) {
    var maxVersion = typeof clientConfigVersion === 'number' && clientConfigVersion > 0 ? clientConfigVersion : 1;
    return (configsDoc.configs || []).filter(function(entry) {
        return matchesConfigEntry(user, entry) && (entry.configVersion || 1) <= maxVersion;
    });
}

// Package eligibility is a pure membership filter against the grants a user
// ALREADY holds (result.grants, post override/blacklist/allow/extraGrants
// resolution in handleCheckAccess) — deliberately NOT a new condition-
// evaluation path. Package grants (`pkg:admin`, `pkg:dev-tools`, etc.) are
// issued through the existing permissions.json allow/override/extraGrants
// sections exactly like `admin`/`dev`/`beta_0` are today (see
// PERMISSIONS_GUIDE.md). `pkg:*` is a wildcard mirroring today's `beta_0`
// ("holding it satisfies any package"), for a root/dev-style blanket grant.
//
// Some packages reuse an EXISTING literal grant instead of a new `pkg:*`
// one — e.g. private-repo issue #3's Admin/Dev Tools packages gate on the
// plain `admin`/`dev` strings so current holders need zero re-provisioning,
// and BETA_1/BETA_2 gate on `beta_1`/`beta_2`. For a `beta_N` grant
// specifically, `beta_0` must also satisfy it — the exact same wildcard
// rule hasGrant() already applies client-side in wo_tool.js ("beta_0 is a
// wildcard: holding it satisfies any beta_N check") — otherwise a beta_0
// holder's client would render the feature (hasGrant passes) while the
// Worker silently withheld the package's actual code, a fail-open gap that
// looks like a broken feature rather than a missing grant.
function resolvePackagesForUser(grants, packagesDoc) {
    var hasWildcard = grants.indexOf('pkg:*') !== -1;
    var hasBetaWildcard = grants.indexOf('beta_0') !== -1;
    return (packagesDoc.packages || []).filter(function(p) {
        if (hasWildcard) return true;
        if (hasBetaWildcard && String(p.grant).indexOf('beta_') === 0) return true;
        return grants.indexOf(p.grant) !== -1;
    });
}

// ── Stateless short-lived signed tokens (HMAC-SHA256, no KV/storage) ──
// Used ONLY for the regular-user flow (/check-access -> /tool/-feedback).
// Admin tokens (adminGroups.json) are a completely different, longer-lived
// credential class — see resolveAdminIdentity() below.
function b64url(bytes) {
    var bin = '';
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToString(str) {
    var pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
    return atob(b64);
}

async function hmac(secret, message) {
    var enc = new TextEncoder();
    var key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return b64url(sig);
}

async function makeToken(secret, data) {
    var payload = b64url(new TextEncoder().encode(JSON.stringify(data)));
    var sig = await hmac(secret, payload);
    return payload + '.' + sig;
}

async function verifyToken(secret, token) {
    if (!token || token.indexOf('.') === -1) return null;
    var parts = token.split('.');
    if (parts.length !== 2) return null;
    var expectedSig = await hmac(secret, parts[0]);
    if (expectedSig !== parts[1]) return null;
    var data;
    try {
        data = JSON.parse(b64urlDecodeToString(parts[0]));
    } catch (e) {
        return null;
    }
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
}

// ── Regular-user handlers (unchanged behavior) ──
async function handleBootstrap(env, ctx) {
    var perms = await loadPermissions(env, ctx);
    var configsDoc = await loadConfigsIndexCached(env, ctx);
    var bucketsDoc = await loadBucketsDocCached(env, ctx);
    var fields = {};
    computeRequiredFields(perms).forEach(function(f) { fields[f] = true; });
    computeConfigRequiredFields(configsDoc).forEach(function(f) { fields[f] = true; });
    computeBucketRequiredFields(bucketsDoc).forEach(function(f) { fields[f] = true; });
    return json({
        maximoHosts: perms.maximoHosts || [],
        requiredFields: Object.keys(fields),
    });
}

// Best-effort bucket-label resolution for a granted user's matched org
// configs, so wo_tool.js's installer/Setup > Profiles can show "Name -
// Bucket" instead of a bare name when more than one config could apply
// (e.g. "Default" from two different sites is otherwise indistinguishable).
// Same fail-open reasoning as resolveContactEmailForUser below: a
// buckets.json hiccup just means the label is omitted, never blocks the
// grant/config match itself.
async function resolveConfigBucketLabels(matchedConfigs, env, ctx) {
    if (!matchedConfigs.length) return matchedConfigs;
    var byId = {};
    try {
        var bucketsDoc = await loadBucketsDocCached(env, ctx);
        byId = bucketsById(bucketsDoc.buckets);
    } catch (e) {}
    return matchedConfigs.map(function(c) {
        var node = c.bucketId != null ? byId[c.bucketId] : null;
        return { id: c.id, name: c.name, description: c.description || '', bucket: node ? node.label : null };
    });
}

// Best-effort contact-email resolution — used for BOTH a granted and a
// denied /check-access result (a denied user still needs to know who to
// ask for access), so it's factored out and called unconditionally rather
// than living inside handleCheckAccess's granted-only branch. Never throws
// and never blocks a grant/deny decision: a buckets.json hiccup just means
// no contact resolves, same fail-open reasoning as every other regular-
// path lookup here.
async function resolveContactEmailForUser(user, env, ctx) {
    try {
        var bucketsDoc = await loadBucketsDocCached(env, ctx);
        var byId = bucketsById(bucketsDoc.buckets);
        var matchedBucketId = resolveBucketForWhoami(user, bucketsDoc.buckets);
        if (matchedBucketId == null) return null;
        return resolveContactForBucket(matchedBucketId, byId);
    } catch (e) {
        return null;
    }
}

// Set of every admin-account email (root + every group's members),
// edge-cached the same way loadPermissions() caches permissions.json — a
// revoke/new-admin lands within this TTL, not the next Worker restart.
// Deliberately fail-open-to-empty-set (not fail-closed) on any read/parse
// error: a hiccup reading adminGroups.json should never block a real
// user's regular tool access, it should just mean nobody gets the extra
// `admin` grant for that one request.
async function loadAdminAccountEmails(env, ctx) {
    var raw;
    try {
        raw = await cachedFetchPrivateFile(env, ctx, 'adminGroups.json', null, PERMISSIONS_CACHE_TTL);
    } catch (e) {
        return {};
    }
    var doc;
    try {
        doc = JSON.parse(raw);
    } catch (e) {
        return {};
    }
    var set = {};
    (doc.rootAccounts || []).forEach(function(a) { if (a.email) set[a.email.toLowerCase()] = true; });
    // Current shape - accounts live independently, referenced by id from
    // one or more groups (see loadAdminGroupsDoc's migration comment).
    (doc.accounts || []).forEach(function(a) { if (a.email) set[a.email.toLowerCase()] = true; });
    // Old shape fallback - this is a raw, uncached-through-loadAdminGroupsDoc
    // read, so it never triggers that function's self-healing migration; a
    // file that hasn't been written since the migration shipped can still
    // be in the old shape on disk.
    (doc.groups || []).forEach(function(g) {
        (g.members || []).forEach(function(m) { if (m.email) set[m.email.toLowerCase()] = true; });
    });
    return set;
}

async function handleCheckAccess(request, env, ctx) {
    var body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ granted: false, error: 'bad request' }, 400);
    }
    var user = body.fields || {};
    var perms = await loadPermissions(env, ctx);
    var result = evaluateAccess(perms, user);
    if (!result.granted) {
        var deniedContact = await resolveContactEmailForUser(user, env, ctx);
        return json({ granted: false, contactEmail: deniedContact });
    }

    // Auto-`admin` grant: a Maximo user whose whoami email matches a real
    // admin-account email gets the `admin` grant on top of whatever they
    // already qualified for — wo_tool.js shows an Admin button when this
    // grant is present, linking to /admin. Only ever ADDS to an already-
    // granted result (see the early `if (!result.granted)` return above) —
    // being an admin of the access system doesn't independently grant the
    // regular review tool itself.
    var adminEmails = await loadAdminAccountEmails(env, ctx);
    var userEmail = String(user.email || '').toLowerCase();
    if (userEmail && adminEmails[userEmail] && result.grants.indexOf('admin') === -1) {
        result.grants = result.grants.concat(['admin']);
    }

    // Org-authored configs (buckets.json/configs/index.json, built via
    // /admin/configs) that apply to this whoami — ALL matches, not just the
    // most specific. Metadata only here (id/name/description); content is
    // fetched separately via /org-config-content using the SAME token below,
    // right after this response, while it's still fresh — see loader.js.
    // Never blocks a grant decision: a configs-load hiccup just means an
    // empty list, exactly like the admin-email cross-reference above.
    var matchedConfigs = [];
    try {
        var configsDoc = await loadConfigsIndexCached(env, ctx);
        matchedConfigs = resolveOrgConfigsForUser(user, configsDoc, body.configVersion);
    } catch (e) {
        matchedConfigs = [];
    }

    // Packages this user's grants make them eligible for (private issue #3,
    // Phase 1) — metadata only (id/name); content is fetched separately via
    // /package-content using the SAME token below, mirroring matchedConfigs
    // immediately above. Never blocks a grant decision: a packages-load
    // hiccup just means an empty list, same fail-open reasoning as configs.
    var eligiblePackages = [];
    try {
        var packagesDoc = await loadPackagesCached(env, ctx);
        eligiblePackages = resolvePackagesForUser(result.grants, packagesDoc);
    } catch (e) {
        eligiblePackages = [];
    }

    var contactEmail = await resolveContactEmailForUser(user, env, ctx);
    var configsWithLabels = await resolveConfigBucketLabels(matchedConfigs, env, ctx);

    var token = await makeToken(env.TOKEN_SECRET, {
        grants: result.grants,
        exp: Date.now() + TOKEN_TTL_MS,
        configIds: matchedConfigs.map(function(c) { return c.id; }),
        packageIds: eligiblePackages.map(function(p) { return p.id; }),
    });
    return json({
        granted: true, grants: result.grants, token: token, contactEmail: contactEmail,
        configs: configsWithLabels,
        packages: eligiblePackages.map(function(p) { return { id: p.id, name: p.name }; }),
    });
}

async function createPrivateIssue(env, title, body) {
    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'wo-review-tool-worker',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: title, body: body }),
    });
    if (!res.ok) throw new Error(`GitHub issue create failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.html_url;
}

async function handleFeedback(request, env) {
    var body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ ok: false, error: 'bad request' }, 400);
    }
    // Same token /tool uses — this isn't a separate identity check, just a
    // cheap way to keep this endpoint from being an open, unauthenticated
    // relay onto the private repo's issue tracker.
    var data = await verifyToken(env.TOKEN_SECRET, body.token);
    if (!data) {
        return json({ ok: false, error: 'invalid or expired token' }, 403);
    }
    var type = (body.type === 'Suggestion') ? 'Suggestion' : 'Bug';
    var text = String(body.body || '').slice(0, 8000);
    var context = String(body.context || '').slice(0, 2000);
    if (!text.trim()) return json({ ok: false, error: 'empty report' }, 400);

    var title = 'WO Review Tool ' + type + ': ' + text.split('\n')[0].slice(0, 80);
    var issueBody = text + '\n\n---\n' + context;
    try {
        var issueUrl = await createPrivateIssue(env, title, issueBody);
        return json({ ok: true, issueUrl: issueUrl });
    } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
}

async function handleGetTool(request, env, ctx) {
    var url = new URL(request.url);
    var token = url.searchParams.get('token');
    var data = await verifyToken(env.TOKEN_SECRET, token);
    if (!data) {
        return new Response('Access token invalid or expired.', { status: 403, headers: corsHeaders() });
    }
    // No version = whatever the default branch currently holds (the
    // "dev channel"/unpinned case). A version requests that exact tagged
    // release instead — the private repo needs the matching "vX.Y.Z" tag
    // pushed to it, same as the public repo already does on every release.
    var version = url.searchParams.get('version');
    var ref = version ? 'v' + version.replace(/^v/, '') : null;
    var ttl = ref ? TOOL_SRC_CACHE_TTL_PINNED : TOOL_SRC_CACHE_TTL_UNPINNED;
    // wo_tool.min.js is what every build going forward actually serves —
    // see scripts/minify-tool.js. Tags cut before minification existed only
    // have wo_tool.js at that ref, so a pinned request for one of those
    // falls back to the readable file rather than 404ing.
    var src;
    try {
        src = await cachedFetchPrivateFile(env, ctx, 'wo_tool.min.js', ref, ttl);
    } catch (e) {
        src = await cachedFetchPrivateFile(env, ctx, 'wo_tool.js', ref, ttl);
    }
    return new Response(src, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders()),
    });
}

// bookmarklet.js's one and only fetch target. Unauthenticated by design —
// same reasoning as /bootstrap: there's nothing here an unauthenticated
// caller couldn't already get by installing the bookmarklet themselves, and
// gating it would mean embedding a credential in a plaintext bookmarklet
// anyone can inspect. Short TTL (same as the tool's own dev-channel/unpinned
// fetch) since this always tracks the private repo's main branch, not a tag.
async function handleGetLoader(env, ctx) {
    var src = await cachedFetchPrivateFile(env, ctx, 'loader.js', null, TOOL_SRC_CACHE_TTL_UNPINNED);
    return new Response(src, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders()),
    });
}

// wo_tool.js's self-update checker (checkForUpdate(), the Settings version
// picker) and /admin/version's root-only editor both read/write this same
// file — this route is the read side for the tool itself, unauthenticated
// for the same reason as handleGetLoader above (a version manifest isn't
// sensitive, and gating it would gain nothing).
async function handleGetVersionJson(env, ctx) {
    var src = await cachedFetchPrivateFile(env, ctx, 'version.json', null, TOOL_SRC_CACHE_TTL_UNPINNED);
    return new Response(src, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders()),
    });
}

// Full content for every org config the caller's /check-access token was
// found to match (see configIds in handleCheckAccess) — a single batch call
// rather than one round trip per config, since loader.js fetches this
// eagerly (once, on a fresh install) right alongside fetchAndRunTool, using
// the same short-lived token while it's still fresh. Only ever returns
// configs the token itself already carries — never re-evaluates conditions
// against fresh input here, so this can't be used to probe other configs by
// guessing ids.
async function handleGetOrgConfigContent(request, env, ctx) {
    var url = new URL(request.url);
    var token = url.searchParams.get('token');
    var data = await verifyToken(env.TOKEN_SECRET, token);
    if (!data) {
        return json({ error: 'invalid or expired token' }, 403);
    }
    var ids = Array.isArray(data.configIds) ? data.configIds : [];
    if (!ids.length) return json({ configs: [] });

    var indexDoc = await loadConfigsIndexCached(env, ctx);
    var byId = {};
    (indexDoc.configs || []).forEach(function(c) { byId[c.id] = c; });

    // Same "Name - Bucket" label resolution as /check-access's configs
    // list (resolveConfigBucketLabels) — this response is what
    // installOrgConfig() actually stores as the profile's own `name`, so
    // without this the label would revert to the bare name the moment a
    // config gets installed, even though the picker showed it labeled.
    var metasInOrder = ids.map(function(id) { return byId[id]; }).filter(Boolean);
    var labeledById = {};
    (await resolveConfigBucketLabels(metasInOrder, env, ctx)).forEach(function(c) { labeledById[c.id] = c; });

    var results = [];
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var meta = byId[id];
        if (!meta) continue; // config was deleted/moved since the token was issued
        var raw;
        try {
            raw = await cachedFetchPrivateFile(env, ctx, 'configs/' + id + '.json', null, PERMISSIONS_CACHE_TTL);
        } catch (e) {
            continue; // content missing - skip rather than fail the whole batch
        }
        var content;
        try { content = JSON.parse(raw); } catch (e) { continue; }
        var labeled = labeledById[id];
        results.push({ id: id, name: meta.name, description: meta.description || '', bucket: labeled ? labeled.bucket : null, content: content });
    }
    return json({ configs: results });
}

// Batch-fetches full package source for every id in the token's
// packageIds (private issue #3, Phase 1) — mirrors
// handleGetOrgConfigContent() exactly: re-derives eligibility from the
// token itself rather than re-evaluating grants, so this can't be used to
// probe packages the original /check-access grant didn't include. Shares
// /tool's exact pin/channel `ref` derivation, so a version-pinned install
// pins packages to the SAME git tag for free — core+packages are always
// released together (lockstep versioning, see the private issue's
// "Versioning" section), so there's no separate package-version tracking
// to keep in sync here.
async function handleGetPackageContent(request, env, ctx) {
    var url = new URL(request.url);
    var token = url.searchParams.get('token');
    var data = await verifyToken(env.TOKEN_SECRET, token);
    if (!data) {
        return json({ error: 'invalid or expired token' }, 403);
    }
    var ids = Array.isArray(data.packageIds) ? data.packageIds : [];
    if (!ids.length) return json({ packages: [] });

    var packagesDoc = await loadPackagesCached(env, ctx);
    var byId = {};
    (packagesDoc.packages || []).forEach(function(p) { byId[p.id] = p; });

    var version = url.searchParams.get('version');
    var ref = version ? 'v' + version.replace(/^v/, '') : null;
    var ttl = ref ? TOOL_SRC_CACHE_TTL_PINNED : TOOL_SRC_CACHE_TTL_UNPINNED;

    var results = [];
    for (var i = 0; i < ids.length; i++) {
        var meta = byId[ids[i]];
        if (!meta) continue; // package removed/renamed since the token was issued
        var src;
        try {
            src = await cachedFetchPrivateFile(env, ctx, meta.entry, ref, ttl);
        } catch (e) {
            continue; // missing entry - skip rather than fail the whole batch
        }
        results.push({ id: meta.id, name: meta.name, src: src });
    }
    return json({ packages: results });
}

// ══════════════════════════════════════════════════════════════════════
// ── Admin layer ──
// ══════════════════════════════════════════════════════════════════════

// ── UTF-8-safe base64 (GitHub's Contents API is base64-of-raw-bytes;
// btoa/atob alone only handle latin1, and labels/usernames can be non-ASCII) ──
function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function base64ToUtf8(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

async function sha256Hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function randomBase64Url(byteLen) {
    var arr = new Uint8Array(byteLen);
    crypto.getRandomValues(arr);
    return b64url(arr.buffer);
}
function genId(prefix) {
    return prefix + '_' + randomBase64Url(9);
}

// ── Admin account passwords (PBKDF2-SHA256, Workers-native via
// crypto.subtle — no external dependency). Not for the regular-user token
// flow above, which stays exactly as it was. ──
var PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
    return Array.from(bytes).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
}
// Constant-time-ish comparison — avoids a short-circuit-on-first-mismatch
// timing difference between "close" and "wildly wrong" hash guesses.
function timingSafeEqualHex(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
async function deriveHash(password, saltBytes, iterations) {
    var keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' }, keyMaterial, 256);
    return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(password) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
    return { salt: bytesToHex(salt), hash: hash, iterations: PBKDF2_ITERATIONS };
}
// Always runs a full PBKDF2 derivation, even against a dummy stored hash
// when the account doesn't exist (see handleAdminLogin) — a login that
// short-circuits on "no such user" is a timing side-channel that lets an
// attacker enumerate valid usernames by response time alone.
var DUMMY_PASSWORD_HASH = { salt: '00000000000000000000000000000000', hash: '0', iterations: PBKDF2_ITERATIONS };
async function verifyPassword(password, stored) {
    var computed = await deriveHash(password, hexToBytes(stored.salt), stored.iterations);
    return timingSafeEqualHex(computed, stored.hash);
}
// Temporary passwords (initial account creation, admin-triggered reset) —
// human-typeable, not a raw hex blob, since the recipient has to type this
// in once to log in and set a real password.
function genTempPassword() {
    var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
    var bytes = new Uint8Array(14);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out.slice(0, 4) + '-' + out.slice(4, 9) + '-' + out.slice(9, 14);
}

// ── Generic GitHub Contents API read-with-sha / write (ADMIN paths only —
// always live, never edge-cached, since a write immediately re-reads
// before merging and a stale admin-side view is exactly what would let a
// scoped admin's merge clobber a concurrent edit). ──
async function fetchFileWithSha(env, owner, repo, path) {
    var url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
    var res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'wo-review-tool-worker',
        },
    });
    if (res.status === 404) return { text: null, sha: null, exists: false };
    if (!res.ok) throw new Error(`GitHub fetch failed for ${path}: HTTP ${res.status}`);
    var data = await res.json();
    return { text: base64ToUtf8(data.content), sha: data.sha, exists: true };
}

async function writeFile(env, owner, repo, path, contentText, sha, message) {
    var url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    var body = { message: message, content: utf8ToBase64(contentText), branch: env.GITHUB_BRANCH };
    if (sha) body.sha = sha;
    var res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'wo-review-tool-worker',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        var err = new Error(`GitHub write failed for ${path}: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    var data = await res.json();
    return data.content.sha;
}

async function deleteFile(env, owner, repo, path, sha, message) {
    var url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    var res = await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'wo-review-tool-worker',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: message, sha: sha, branch: env.GITHUB_BRANCH }),
    });
    if (!res.ok) {
        var err = new Error(`GitHub delete failed for ${path}: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
}

function fetchPrivateFileWithSha(env, path) { return fetchFileWithSha(env, env.GITHUB_OWNER, env.GITHUB_REPO, path); }
function writePrivateFile(env, path, text, sha, message) { return writeFile(env, env.GITHUB_OWNER, env.GITHUB_REPO, path, text, sha, message); }
function deletePrivateFile(env, path, sha, message) { return deleteFile(env, env.GITHUB_OWNER, env.GITHUB_REPO, path, sha, message); }

async function loadPermissionsLive(env) {
    var f = await fetchPrivateFileWithSha(env, 'permissions.json');
    if (!f.exists) throw new Error('permissions.json not found in private repo');
    var doc = JSON.parse(f.text);
    doc.override = doc.override || [];
    doc.blacklist = doc.blacklist || [];
    doc.allow = doc.allow || [];
    doc.extraGrants = doc.extraGrants || []; // array of {conditions[], grants[]} - was a {username: grants[]} map before the condition-based migration
    doc.maximoHosts = doc.maximoHosts || [];
    return { doc: doc, sha: f.sha };
}

async function loadBucketsDoc(env) {
    var f = await fetchPrivateFileWithSha(env, 'buckets.json');
    var doc = f.exists ? JSON.parse(f.text) : { buckets: [] };
    doc.buckets = doc.buckets || [];
    delete doc.fieldLevels; // migrated away — see bucket.allowedFields / canUseFieldForIdentity
    return { doc: doc, sha: f.sha };
}

async function loadAdminGroupsDoc(env) {
    var f = await fetchPrivateFileWithSha(env, 'adminGroups.json');
    var doc = f.exists ? JSON.parse(f.text) : { rootAccounts: [], accounts: [], groups: [] };
    doc.rootAccounts = doc.rootAccounts || [];
    doc.accounts = doc.accounts || [];
    doc.groups = doc.groups || [];
    // Migrate the old shape (each account embedded inline in exactly one
    // group's `members[]`, so an account could only ever belong to one
    // group) into the new shape (accounts live independently in doc.accounts;
    // groups just reference member ids) - this is what lets one account
    // belong to more than one group. Self-healing: every load normalizes to
    // the new shape in memory; the next WRITE persists it, so this only
    // actually does anything against genuinely old data.
    doc.groups.forEach(function(g) {
        if (Array.isArray(g.members)) {
            g.members.forEach(function(m) {
                if (!doc.accounts.some(function(a) { return a.id === m.id; })) doc.accounts.push(m);
            });
            g.memberIds = (g.memberIds || []).concat(g.members.map(function(m) { return m.id; }))
                .filter(function(id, i, arr) { return arr.indexOf(id) === i; });
            delete g.members;
        }
        g.memberIds = g.memberIds || [];
    });
    return { doc: doc, sha: f.sha };
}

// configs/index.json holds lightweight metadata only (id, name,
// description, bucketId/conditions targeting, timestamps) - the actual
// heavy WO-tool config blob (same shape as Setup > Export produces) lives
// in its own configs/<id>.json file, fetched only on demand (download/
// duplicate), so listing configs never pulls every blob over the wire.
async function loadConfigsIndexDoc(env) {
    var f = await fetchPrivateFileWithSha(env, 'configs/index.json');
    var doc = f.exists ? JSON.parse(f.text) : { configs: [] };
    doc.configs = doc.configs || [];
    return { doc: doc, sha: f.sha };
}

// Finds an account by id: root accounts first, then doc.accounts. Returns
// { account, isRootAccount, groups } - groups is every group this account
// is a member of (via g.memberIds), which can now be more than one. Root
// accounts always get groups: [] (they aren't scoped to any bucket) -
// isRootAccount is what distinguishes that from a genuinely orphaned
// scoped account (0 memberships, e.g. fully revoked) rather than
// overloading an empty groups array to mean two different things.
function findAccountById(doc, accountId) {
    var root = (doc.rootAccounts || []).find(function(a) { return a.id === accountId; });
    if (root) return { account: root, isRootAccount: true, groups: [] };
    var account = (doc.accounts || []).find(function(a) { return a.id === accountId; });
    if (!account) return null;
    var groups = (doc.groups || []).filter(function(g) { return (g.memberIds || []).indexOf(accountId) !== -1; });
    return { account: account, isRootAccount: false, groups: groups };
}
function findAccountByEmail(doc, email) {
    var e = email.toLowerCase();
    var root = (doc.rootAccounts || []).find(function(a) { return a.email.toLowerCase() === e; });
    if (root) return { account: root, isRootAccount: true, groups: [] };
    var account = (doc.accounts || []).find(function(a) { return a.email.toLowerCase() === e; });
    if (!account) return null;
    var groups = (doc.groups || []).filter(function(g) { return (g.memberIds || []).indexOf(account.id) !== -1; });
    return { account: account, isRootAccount: false, groups: groups };
}
function emailTaken(doc, email) {
    return !!findAccountByEmail(doc, email);
}
// Deliberately simple (not RFC 5322) - good enough to catch typos/garbage
// without rejecting a real work email over some obscure edge case.
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Bucket tree helpers ──
function bucketsById(buckets) {
    var m = {};
    buckets.forEach(function(b) { m[b.id] = b; });
    return m;
}

// Inclusive of ancestorId itself — used for grant/group-membership
// containment ("their own node or any descendant"). ancestorIdOrIds may be
// a single bucket id, an ARRAY of them (a multi-group identity's
// bucketIds — true if candidateId is at-or-below ANY of them, i.e. union
// semantics), or null (root - contains everything). An empty array
// contains nothing (fail closed - an account with zero group memberships
// has no scope).
function isAtOrBelow(candidateId, ancestorIdOrIds, byId) {
    if (Array.isArray(ancestorIdOrIds)) {
        return ancestorIdOrIds.some(function(a) { return isAtOrBelow(candidateId, a, byId); });
    }
    var ancestorId = ancestorIdOrIds;
    if (ancestorId == null) return true; // root contains everything
    if (candidateId == null) return false; // "everything" is never at-or-below one node
    var cur = candidateId, guard = 0;
    while (cur != null) {
        if (cur === ancestorId) return true;
        var node = byId[cur];
        if (!node) return false; // dangling/unknown id - fail closed
        cur = node.parentId;
        if (++guard > 1000) return false; // cycle guard - buckets.json is hand-editable
    }
    return false;
}

// Strict — excludes ancestorId itself. Used for bucket CRUD and new-child-
// group creation ("beneath their own node", not the node itself). Same
// array/union handling as isAtOrBelow above.
function isBelow(candidateId, ancestorIdOrIds, byId) {
    if (Array.isArray(ancestorIdOrIds)) {
        return ancestorIdOrIds.some(function(a) { return isBelow(candidateId, a, byId); });
    }
    var ancestorId = ancestorIdOrIds;
    if (candidateId == null) return false;
    if (ancestorId == null) return true; // every real bucket is beneath the implicit apex
    return candidateId !== ancestorId && isAtOrBelow(candidateId, ancestorId, byId);
}

// Root-level buckets are depth 1; root/full-admin is depth 0.
function bucketDepth(bucketId, byId) {
    if (bucketId == null) return 0;
    var depth = 0, cur = bucketId, guard = 0;
    while (cur != null) {
        var node = byId[cur];
        if (!node) return -1; // dangling
        depth++;
        cur = node.parentId;
        if (++guard > 1000) return -1;
    }
    return depth;
}

// Root-to-leaf chain of {field,op,value}, from the top-level ancestor down
// through and INCLUDING bucketId's own condition — this is what gets
// prepended onto a scoped admin's submitted conditions (see
// buildEntryConditions below), the mechanism that makes "hardlocked above
// them" a structural guarantee rather than a UI convention.
function bucketConditionChain(bucketId, byId) {
    var chain = [], cur = bucketId, guard = 0;
    while (cur != null) {
        var node = byId[cur];
        if (!node) break;
        chain.unshift({ field: node.field, op: node.op, value: node.value });
        cur = node.parentId;
        if (++guard > 1000) break;
    }
    return chain;
}

// Which bucket a whoami structurally belongs to, walking top-down from
// root-level buckets — only descends into a bucket's children once the
// bucket's OWN condition already matched, so the result is always
// consistent with what bucketConditionChain() would have prepended for
// that bucket (every ancestor's condition genuinely holds, not just the
// deepest one in isolation). Returns the DEEPEST matching bucket id, or
// null if not even a top-level bucket matches. Used for contact-email
// resolution — independent of whether any permission rule/config actually
// grants this whoami anything, since a denied user still needs to know who
// to ask.
function resolveBucketForWhoami(user, buckets) {
    var byParent = {};
    buckets.forEach(function(b) {
        var key = b.parentId || 'root';
        (byParent[key] = byParent[key] || []).push(b);
    });
    function deepestMatch(parentKey, guard) {
        if (guard > 1000) return null; // cycle guard - buckets.json is hand-editable
        var candidates = byParent[parentKey] || [];
        for (var i = 0; i < candidates.length; i++) {
            var b = candidates[i];
            if (evalCondition(user, { field: b.field, op: b.op, value: b.value })) {
                return deepestMatch(b.id, guard + 1) || b.id;
            }
        }
        return null;
    }
    return deepestMatch('root', 0);
}

// Nearest-ancestor-wins contact email — walks from bucketId UP toward the
// root, returning the first bucket (inclusive of bucketId itself) with a
// non-empty contactEmail set. Same shape as the old, removed
// resolveConfigForBucket() (nearest-ancestor cascade), now backing a real
// feature: e.g. an AVWP-level match with no contact set falls through to
// Ireland's, then AbbVie's.
function resolveContactForBucket(bucketId, byId) {
    var cur = bucketId, guard = 0;
    while (cur != null) {
        var node = byId[cur];
        if (!node) return null;
        if (node.contactEmail) return node.contactEmail;
        cur = node.parentId;
        if (++guard > 1000) return null;
    }
    return null;
}

// Every field referenced by any bucket's own condition — merged into
// /bootstrap's requiredFields alongside computeRequiredFields()/
// computeConfigRequiredFields() so resolveBucketForWhoami() always has the
// real field data to match against, even for a bucket that happens to have
// no permission rule or config directly targeting it (e.g. a mid-tree
// "Ireland" node with children but nothing of its own).
function computeBucketRequiredFields(bucketsDoc) {
    var fields = {};
    (bucketsDoc.buckets || []).forEach(function(b) {
        if (b.field && CANONICAL_FIELDS.indexOf(b.field) !== -1) fields[b.field] = true;
    });
    return Object.keys(fields);
}

// ── Field governance ──
// Instead of one global field→level map (every bucket at the same depth
// shared identical field permissions), each bucket carries its own
// allowedFields checklist governing what ITS OWN admin tier may reference
// when authoring conditions — different companies/branches at the same
// depth can allow different fields. Checked against the ACTING IDENTITY's
// own bucket(s) (identity.bucketIds — an admin can now belong to more than
// one group, hence more than one bucket), not the target/parent bucket,
// since the question is always "can THIS ADMIN use this field". Union
// semantics: allowed if ANY of the identity's own buckets permits it. Each
// of those buckets is only editable by a strictly-senior admin (isBelow —
// see handleAdminPatchBucket), so a scoped admin can never self-escalate
// their own checklist. Root has no bucket and always bypasses.
// bucket.allowedFields absent/null = every field allowed (backward-
// compatible default — existing buckets keep working unchanged); an
// explicit [] = no fields allowed (deliberate lockdown).
function canUseFieldForIdentity(identity, field, byId) {
    if (identity.isRoot) return true;
    return (identity.bucketIds || []).some(function(bucketId) {
        var bucket = byId[bucketId];
        if (!bucket) return false; // dangling own-bucket id - fail closed
        if (!Array.isArray(bucket.allowedFields)) return true;
        return bucket.allowedFields.indexOf(field) !== -1;
    });
}

// ── Admin identity resolution ──
// Two credential classes, checked in order:
//  1. ROOT_ADMIN_TOKEN (Wrangler secret) — checked BEFORE adminGroups.json
//     is even fetched, always works independent of that file's existence
//     or integrity. The break-glass safety net: since delegation lives in
//     a GitHub file the Worker itself writes to, there must be one
//     credential that can't be locked out by a bad write to that file.
//     Never stored inside adminGroups.json — the two mechanisms stay
//     fully separate.
//  2. A session token (see handleAdminLogin/ADMIN_SESSION_TTL_MS) — issued
//     after a real username/password login, HMAC-signed with
//     ADMIN_SESSION_SECRET (a distinct secret from the regular-user
//     TOKEN_SECRET, so compromising one credential class doesn't
//     compromise the other). The token itself only carries IDs; every
//     request still re-checks the account/group actually exist in
//     adminGroups.json, so revoking an account (or resetting its
//     password) invalidates any already-issued session on its very next
//     request — not just once the token's TTL expires.
async function resolveAdminIdentity(request, env) {
    var m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
    if (!m) return null;
    var presented = m[1].trim();
    if (!presented) return null;
    if (env.ROOT_ADMIN_TOKEN && presented === env.ROOT_ADMIN_TOKEN) {
        // bucketIds: null (not []) for root, deliberately - isAtOrBelow/
        // isBelow treat a null ancestor as "contains everything", which is
        // what lets a handful of handlers (e.g. handleAdminPatchBucket,
        // handleAdminDeleteBucket) skip an explicit `identity.isRoot`
        // check and just call isBelow(id, identity.bucketIds, byId)
        // directly. An empty ARRAY means the opposite (contains nothing -
        // used for a genuinely scoped-but-orphaned account), so root must
        // never be represented as [].
        return { isRoot: true, bucketIds: null, label: 'root (break-glass)', groupIds: [], accountId: null, groups: [] };
    }
    var session = await verifyToken(env.ADMIN_SESSION_SECRET, presented);
    if (!session) return null;

    var groupsDoc;
    try {
        groupsDoc = (await loadAdminGroupsDoc(env)).doc;
    } catch (e) {
        return null; // corrupt/unreachable adminGroups.json fails closed for session tokens
    }
    var found = findAccountById(groupsDoc, session.accountId);
    if (!found) return null; // account deleted/revoked since the session token was issued
    if (found.isRootAccount) {
        // Root account — confirmed session.isRoot already implied this at
        // login time, but re-derive from the CURRENT doc rather than
        // trusting the token's own claim, so a root account demoted (were
        // that ever added) can't keep asserting root via an old token.
        return { isRoot: true, bucketIds: null, label: found.account.label, groupIds: [], accountId: found.account.id, groups: [] }; // bucketIds: null, not [] - see the break-glass branch above
    }
    // An account can now belong to more than one group (see
    // loadAdminGroupsDoc's migration comment) - bucketIds/groupIds carry
    // EVERY membership, and every scope check downstream (isAtOrBelow/
    // isBelow/canUseFieldForIdentity) uses union semantics: permitted if
    // ANY one of them qualifies. `groups` (the full objects, not just ids)
    // is kept too because allowPeerAdminCreation/allowChildAdminCreation
    // are PER-GROUP flags, not a single identity-wide flag - a group-scoped
    // action always checks the flag on the SPECIFIC group being acted on
    // (see handleAdminAddGroupMember/canCreateChildGroupAt), never an
    // aggregate across every group the identity happens to belong to.
    return {
        isRoot: false,
        bucketIds: found.groups.map(function(g) { return g.bucketId; }),
        label: found.account.label,
        groupIds: found.groups.map(function(g) { return g.id; }),
        accountId: found.account.id,
        groups: found.groups,
    };
}

// Purely informational (shown in admin.html, never a security boundary) -
// the MOST SENIOR (shallowest) depth across every bucket the identity
// belongs to, since that's the closest single-number analogue to what
// "level" meant before multi-group existed. -1 (unknown) if the identity
// has zero resolvable buckets (e.g. every group membership was revoked).
function identityLevel(identity, byId) {
    if (identity.isRoot) return 0;
    var depths = (identity.bucketIds || []).map(function(id) { return bucketDepth(id, byId); }).filter(function(d) { return d >= 0; });
    return depths.length ? Math.min.apply(null, depths) : -1;
}

// Child-group creation is governed by a SPECIFIC group's own
// allowChildAdminCreation flag, combined with THAT SAME group's own scope
// (isBelow) - not "any group has the flag" OR'd with "any group is in
// scope" independently, which would let a flagged-but-out-of-scope group
// authorize reaching a bucket it has no actual authority over.
function canCreateChildGroupAt(identity, targetBucketId, byId) {
    if (identity.isRoot) return true;
    return (identity.groups || []).some(function(g) {
        return !!g.allowChildAdminCreation && isBelow(targetBucketId, g.bucketId, byId);
    });
}

// Defense-in-depth before any permissions.json write — a malformed write
// here breaks live access for every user of the tool, unlike a typical
// CRUD bug, so this is checked regardless of which section actually
// changed.
function validatePermissionsShape(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('invalid permissions document');
    if (!Array.isArray(doc.maximoHosts)) throw new Error('maximoHosts must be an array');
    if (!Array.isArray(doc.override)) throw new Error('override must be an array');
    if (!Array.isArray(doc.blacklist)) throw new Error('blacklist must be an array');
    if (!Array.isArray(doc.allow)) throw new Error('allow must be an array');
    if (!Array.isArray(doc.extraGrants)) throw new Error('extraGrants must be an array');
    // override/allow/blacklist/extraGrants are all condition-based now (AND
    // within one entry's conditions[], OR across entries) - every entry in
    // all four needs a conditions array, no exceptions (override's old
    // bare-username shape is a v1 concept, not a valid v2 entry).
    ['override', 'blacklist', 'allow', 'extraGrants'].forEach(function(section) {
        doc[section].forEach(function(entry, i) {
            if (!entry || !Array.isArray(entry.conditions) || entry.conditions.length === 0) {
                throw new Error(section + '[' + i + '] missing/empty conditions array');
            }
        });
    });
}

function requireAdmin(identity) {
    if (!identity) {
        var err = new Error('missing or invalid admin token');
        err.status = 401;
        throw err;
    }
}
function requireRoot(identity) {
    requireAdmin(identity);
    if (!identity.isRoot) {
        var err = new Error('root admin only');
        err.status = 403;
        throw err;
    }
}
function forbid(message) {
    var err = new Error(message);
    err.status = 403;
    throw err;
}
function badRequest(message) {
    var err = new Error(message);
    err.status = 400;
    throw err;
}
function notFound(message) {
    var err = new Error(message);
    err.status = 404;
    throw err;
}

// ── /admin/permissions ──
async function handleAdminGetPermissions(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var permsLoad = await loadPermissionsLive(env);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var level = identityLevel(identity, byId);

    if (identity.isRoot) {
        return json({
            role: 'root', label: identity.label, level: level, bucketIds: [],
            override: permsLoad.doc.override, blacklist: permsLoad.doc.blacklist,
            allow: permsLoad.doc.allow, extraGrants: permsLoad.doc.extraGrants,
            maximoHosts: permsLoad.doc.maximoHosts,
        });
    }
    var allow = permsLoad.doc.allow.filter(function(e) { return isAtOrBelow(e.bucketId, identity.bucketIds, byId); });
    var blacklist = permsLoad.doc.blacklist.filter(function(e) { return isAtOrBelow(e.bucketId, identity.bucketIds, byId); });
    return json({
        role: 'scoped', label: identity.label, level: level, bucketIds: identity.bucketIds,
        allow: allow, blacklist: blacklist,
        hidden: {
            override: permsLoad.doc.override.length,
            extraGrants: permsLoad.doc.extraGrants.length,
            maximoHosts: permsLoad.doc.maximoHosts.length,
            allow: permsLoad.doc.allow.length - allow.length,
            blacklist: permsLoad.doc.blacklist.length - blacklist.length,
        },
    });
}

// Root-only, whole-array replace — maximoHosts is a short, rarely-changed
// list (unlike allow/blacklist, which can have many entries needing
// individual CRUD), so there's no per-entry POST/DELETE here, just "set
// the whole list" — admin.html's form always submits every row together.
// Previously only editable via a raw GitHub edit to permissions.json;
// this is the first admin-UI-reachable way to manage it.
async function handleAdminSetMaximoHosts(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    if (!Array.isArray(body.hosts)) badRequest('hosts must be an array');

    var seen = {};
    var hosts = body.hosts.map(function(h, i) {
        var hostname = String((h && h.hostname) || '').trim();
        var url = String((h && h.url) || '').trim();
        if (!hostname) badRequest('hosts[' + i + ']: hostname required');
        if (!url) badRequest('hosts[' + i + ']: url required');
        try { new URL(url); } catch (e) { badRequest('hosts[' + i + ']: "' + url + '" is not a valid URL'); }
        var key = hostname.toLowerCase();
        if (seen[key]) badRequest('duplicate hostname: ' + hostname);
        seen[key] = true;
        return { hostname: hostname, url: url };
    });

    var permsLoad = await loadPermissionsLive(env);
    permsLoad.doc.maximoHosts = hosts;
    validatePermissionsShape(permsLoad.doc);
    await writePrivateFile(env, 'permissions.json', JSON.stringify(permsLoad.doc, null, 2), permsLoad.sha,
        'admin: ' + identity.label + ' updated maximoHosts (' + hosts.length + ' host' + (hosts.length === 1 ? '' : 's') + ')');
    return json({ ok: true, hosts: hosts });
}

function buildEntryConditions(bucketId, ownConditions, byId) {
    return bucketConditionChain(bucketId, byId).concat(ownConditions || []);
}

var PERMISSION_SECTIONS = ['override', 'blacklist', 'allow', 'extraGrants'];
// Which sections carry a `grants` field at all.
var GRANTS_SECTIONS = ['override', 'allow', 'extraGrants'];
// Grants a non-root admin is allowed to assign at all — everything else
// (dev, beta_0, beta_N, ...) is root-only, regardless of which section.
// Applies only where a non-root admin can reach this code path in the
// first place (allow — override/extraGrants are already root-only via
// requireRoot below), but enforced generically here rather than only in
// the one section that currently needs it, so it can't be quietly
// bypassed if another section ever gains non-root write access later.
var NON_ROOT_ALLOWED_GRANTS = ['user'];

// override/allow/blacklist/extraGrants are all condition-based now — one
// upsert path for all four, differing only in: which are root-only
// (override/extraGrants — nothing to prepend a hardlock onto for a plain
// username match, so there was never a sound way to confine them to a
// branch; see PERMISSIONS_GUIDE.md), and which carry a `grants` field
// (blacklist doesn't grant anything, so it has none).
async function handleAdminUpsertPermissionEntry(request, env, section) {
    if (PERMISSION_SECTIONS.indexOf(section) === -1) return notFound('unknown section');
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    if (section === 'override' || section === 'extraGrants') requireRoot(identity);

    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var permsLoad = await loadPermissionsLive(env);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var now = new Date().toISOString();

    var bucketId = body.bucketId != null ? body.bucketId : null;
    if (!identity.isRoot && !isAtOrBelow(bucketId, identity.bucketIds, byId)) forbid('target bucket outside your scope');
    var ownConditions = normalizeConditions(Array.isArray(body.ownConditions) ? body.ownConditions : []);
    if (!ownConditions.length) badRequest('at least one condition is required');
    ownConditions.forEach(function(c) {
        if (!canUseFieldForIdentity(identity, c.field, byId)) forbid('field "' + c.field + '" not permitted for your admin tier');
    });

    var arr = permsLoad.doc[section];
    var existing = body.id ? arr.find(function(e) { return e.id === body.id; }) : null;
    if (body.id && !existing) return notFound(section + ' entry not found');
    // Editing an entry's bucketId requires containment on BOTH the entry's
    // current bucket and its new one — otherwise a scoped admin could
    // retarget a rule they don't control into their own branch.
    if (existing && !identity.isRoot && !isAtOrBelow(existing.bucketId, identity.bucketIds, byId)) forbid('existing entry outside your scope');

    // override/extraGrants are root-only (requireRoot above) — the
    // ancestor-chain hardlock buildEntryConditions() applies exists purely
    // to stop a SCOPED (non-root) admin's rule from silently reaching
    // outside their own branch (see bucketConditionChain()'s own comment:
    // "the mechanism that makes 'hardlocked above them' a structural
    // guarantee"). Since a scoped admin can never reach this code path for
    // these two sections at all, that hardlock serves no access-control
    // purpose for them — it just means an override meant as a direct,
    // explicit exception grant ("this ONE user, regardless of site") could
    // silently fail to apply if the target user happens not to match
    // whatever condition the chosen bucketId's own ancestor chain checks
    // (private issue #7). bucketId is kept for UI/tree-placement purposes
    // only for these two sections; blacklist/allow (scoped-admin-writable)
    // keep the hardlock unchanged — it's load-bearing there.
    var conditions = (section === 'override' || section === 'extraGrants') ?
        ownConditions.slice() :
        buildEntryConditions(bucketId, ownConditions, byId);
    var newEntry = {
        id: existing ? existing.id : genId(section.slice(0, 3)),
        bucketId: bucketId,
        conditions: conditions,
        lastModifiedBy: identity.label, lastModifiedAt: now,
    };
    if (GRANTS_SECTIONS.indexOf(section) !== -1) {
        var grants = Array.isArray(body.grants) && body.grants.length ? body.grants : ['user'];
        if (!identity.isRoot) grants = grants.filter(function(g) { return NON_ROOT_ALLOWED_GRANTS.indexOf(g) !== -1; });
        if (!grants.length) grants = ['user'];
        newEntry.grants = grants;
    }
    if (existing) { Object.assign(existing, newEntry); } else { arr.push(newEntry); }
    validatePermissionsShape(permsLoad.doc);
    await writePrivateFile(env, 'permissions.json', JSON.stringify(permsLoad.doc, null, 2), permsLoad.sha,
        'admin: ' + identity.label + ' ' + (existing ? 'updated' : 'created') + ' ' + section + ' entry (bucket ' + (bucketId || 'root') + ')');
    return json({ ok: true, entry: newEntry });
}

async function handleAdminDeletePermissionEntry(request, env, section, id) {
    if (PERMISSION_SECTIONS.indexOf(section) === -1) return notFound('unknown section');
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    if (section === 'override' || section === 'extraGrants') requireRoot(identity);

    var permsLoad = await loadPermissionsLive(env);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);

    var arr = permsLoad.doc[section];
    var idx = arr.findIndex(function(e) { return e.id === id; });
    if (idx === -1) return notFound(section + ' entry not found');
    var target = arr[idx];
    if (!identity.isRoot && !isAtOrBelow(target.bucketId, identity.bucketIds, byId)) forbid('entry outside your scope');
    arr.splice(idx, 1);
    validatePermissionsShape(permsLoad.doc);
    await writePrivateFile(env, 'permissions.json', JSON.stringify(permsLoad.doc, null, 2), permsLoad.sha,
        'admin: ' + identity.label + ' deleted ' + section + ' entry ' + id);
    return json({ ok: true });
}

// ── /admin/buckets ──
async function handleAdminGetBuckets(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    // Every admin sees the FULL tree, not just their own subtree — scoped
    // admins need the ancestors/siblings above them for orientation (where
    // does my branch sit in the company?). This is read-only visibility;
    // every write endpoint below still independently enforces
    // isAtOrBelow/isBelow against identity.bucketIds, so nothing here
    // widens what a scoped admin can actually DO — admin.html is expected
    // to grey out/hide edit/delete controls for out-of-scope nodes using
    // the same identity.bucketIds this response's containing /admin/permissions
    // call already returned.
    var visible = bucketsLoad.doc.buckets;
    return json({
        buckets: visible, level: identityLevel(identity, byId),
        canonicalFields: CANONICAL_FIELDS, // known whoami field names, for the admin UI's per-bucket field checklist
    });
}

async function handleAdminCreateBucket(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var parentId = body.parentId != null ? body.parentId : null;

    if (!identity.isRoot && !isAtOrBelow(parentId, identity.bucketIds, byId)) forbid('parent bucket outside your scope');
    if (parentId == null && !identity.isRoot) forbid('only root can create a new top-level branch');
    if (parentId != null && !byId[parentId]) notFound('parent bucket not found');

    var field = String(body.field || '').trim();
    if (!field) badRequest('field required');
    if (!canUseFieldForIdentity(identity, field, byId)) forbid('field "' + field + '" not permitted for your admin tier');

    var contactEmail = body.contactEmail != null ? String(body.contactEmail).trim() : '';
    if (contactEmail && !isValidEmail(contactEmail)) badRequest('contact email must be a valid email address');

    var newCondition = normalizeCondition({ field: field, op: String(body.op || 'eq'), value: body.value != null ? body.value : '' });
    var newBucket = {
        id: genId('bkt'), parentId: parentId, label: String(body.label || field),
        field: field, op: newCondition.op, value: newCondition.value,
        contactEmail: contactEmail || null,
        createdBy: identity.label, createdAt: new Date().toISOString(),
    };
    bucketsLoad.doc.buckets.push(newBucket);
    await writePrivateFile(env, 'buckets.json', JSON.stringify(bucketsLoad.doc, null, 2), bucketsLoad.sha,
        'admin: ' + identity.label + ' created bucket "' + newBucket.label + '"');
    return json({ ok: true, bucket: newBucket });
}

async function handleAdminPatchBucket(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var bucket = byId[id];
    if (!bucket) return notFound('bucket not found');
    if (!isBelow(id, identity.bucketIds, byId)) forbid('bucket outside your scope (or is your own node — bucket CRUD is strictly below, not at, your own node)');

    if (body.field !== undefined && body.field !== bucket.field) {
        var newField = String(body.field).trim();
        if (!canUseFieldForIdentity(identity, newField, byId)) forbid('field "' + newField + '" not permitted for your admin tier');
        bucket.field = newField;
    }
    if (body.op !== undefined) bucket.op = String(body.op);
    if (body.value !== undefined) bucket.value = body.value;
    if (body.op !== undefined || body.value !== undefined) {
        var normalizedOwn = normalizeCondition({ field: bucket.field, op: bucket.op, value: bucket.value });
        bucket.value = normalizedOwn.value;
    }
    if (body.label !== undefined) bucket.label = String(body.label);
    if (body.contactEmail !== undefined) {
        var newContactEmail = String(body.contactEmail || '').trim();
        if (newContactEmail && !isValidEmail(newContactEmail)) badRequest('contact email must be a valid email address');
        bucket.contactEmail = newContactEmail || null;
    }
    // allowedFields governs what THIS bucket's own admin tier may reference
    // when authoring conditions (see canUseFieldForIdentity) — only a
    // strictly-senior admin can edit it (bucket CRUD is isBelow, never at
    // their own node), so a scoped admin can never widen their own
    // checklist. null/absent clears it back to "every field allowed";
    // [] is a deliberate lockdown to no fields.
    if (body.allowedFields !== undefined) {
        bucket.allowedFields = Array.isArray(body.allowedFields)
            ? body.allowedFields.map(function(f) { return String(f); })
            : null;
    }
    bucket.lastModifiedBy = identity.label;
    bucket.lastModifiedAt = new Date().toISOString();

    await writePrivateFile(env, 'buckets.json', JSON.stringify(bucketsLoad.doc, null, 2), bucketsLoad.sha,
        'admin: ' + identity.label + ' updated bucket "' + bucket.label + '"');
    return json({ ok: true, bucket: bucket });
}

async function handleAdminDeleteBucket(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var url = new URL(request.url);
    var cascade = url.searchParams.get('cascade') === 'true';

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    if (!byId[id]) return notFound('bucket not found');
    if (!isBelow(id, identity.bucketIds, byId)) forbid('bucket outside your scope');

    var descendantIds = bucketsLoad.doc.buckets.filter(function(b) { return isAtOrBelow(b.id, id, byId); }).map(function(b) { return b.id; });
    var hasChildren = descendantIds.length > 1;

    var permsLoad = await loadPermissionsLive(env);
    var referencingGrants = permsLoad.doc.allow.filter(function(e) { return descendantIds.indexOf(e.bucketId) !== -1; })
        .concat(permsLoad.doc.blacklist.filter(function(e) { return descendantIds.indexOf(e.bucketId) !== -1; })).length;

    if ((hasChildren || referencingGrants > 0) && !cascade) {
        return json({ ok: false, error: 'bucket has children or referencing grant entries — pass ?cascade=true to delete the whole subtree' }, 409);
    }

    bucketsLoad.doc.buckets = bucketsLoad.doc.buckets.filter(function(b) { return descendantIds.indexOf(b.id) === -1; });
    await writePrivateFile(env, 'buckets.json', JSON.stringify(bucketsLoad.doc, null, 2), bucketsLoad.sha,
        'admin: ' + identity.label + ' deleted bucket ' + id + (cascade ? ' (cascade)' : ''));

    if (!cascade) return json({ ok: true });

    // Non-atomic follow-up writes — documented limitation (see
    // PERMISSIONS_GUIDE.md / ARCHITECTURE.md): the bucket subtree is
    // already gone at this point regardless of whether these succeed. An
    // orphaned grant/group's bucketId simply fails every containment
    // check closed from now on either way.
    var warnings = [];
    try {
        permsLoad.doc.allow = permsLoad.doc.allow.filter(function(e) { return descendantIds.indexOf(e.bucketId) === -1; });
        permsLoad.doc.blacklist = permsLoad.doc.blacklist.filter(function(e) { return descendantIds.indexOf(e.bucketId) === -1; });
        validatePermissionsShape(permsLoad.doc);
        await writePrivateFile(env, 'permissions.json', JSON.stringify(permsLoad.doc, null, 2), permsLoad.sha,
            'admin: ' + identity.label + ' removed grants for deleted bucket subtree ' + id);
    } catch (e) {
        warnings.push('subtree deleted, but removing its grant entries failed: ' + String(e && e.message || e) + ' — reload and clean up manually');
    }
    try {
        var groupsLoad = await loadAdminGroupsDoc(env);
        var before = groupsLoad.doc.groups.length;
        groupsLoad.doc.groups = groupsLoad.doc.groups.filter(function(g) { return descendantIds.indexOf(g.bucketId) === -1; });
        if (groupsLoad.doc.groups.length !== before) {
            await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
                'admin: ' + identity.label + ' removed admin groups for deleted bucket subtree ' + id);
        }
    } catch (e) {
        warnings.push('subtree deleted, but removing its admin group(s) failed: ' + String(e && e.message || e) + ' — some admin(s) may still hold now-orphaned (non-functional) tokens, reload and revoke manually');
    }
    return json({ ok: true, warnings: warnings });
}

// ── /admin/configs — admin-managed WO-tool config blobs (same JSON shape
// as Setup > Export/Import in wo_tool.js), organized/targeted per bucket.
// wo_tool.js consumes these directly (via /check-access + /org-config-
// content — see handleCheckAccess and resolveOrgConfigsForUser above).
// An earlier, separate bucket.configProfileId label + nearest-ancestor
// resolver existed as a placeholder before this system was built; it was
// never wired to anything and has since been removed.
//
// Targeting reuses the exact same {bucketId, conditions} + ancestor-
// hardlock pattern as permissions.json entries (buildEntryConditions()),
// EXCEPT empty conditions[] is allowed here (unlike permissions) - a
// config with no extra conditions just means "everyone at that bucket",
// which isn't a security-relevant vacuous match the way it would be for
// access-control entries.
function configEntryPublic(doc) {
    return { id: doc.id, name: doc.name, description: doc.description || '', bucketId: doc.bucketId, conditions: doc.conditions,
        // bucketIds/conditionGroups (private issue #7, OR logic + multi-
        // bucket configs) — bucketId/conditions are kept for backward
        // compat (old admin.html builds, and any entry not yet re-saved
        // under the new shape reads back with bucketIds defaulting to
        // [bucketId] and conditionGroups computed from configEntryMatchGroups()
        // so the admin UI always has a consistent array to render/edit,
        // even for a pre-existing single-bucket entry).
        bucketIds: Array.isArray(doc.bucketIds) ? doc.bucketIds : [doc.bucketId !== undefined ? doc.bucketId : null],
        conditionGroups: configEntryMatchGroups(doc),
        createdBy: doc.createdBy, createdAt: doc.createdAt, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt, size: doc.size || 0,
        // Metadata mirror of the content's own configVersion (private issue
        // #3, Phase 5) — resolveOrgConfigsForUser() filters on this WITHOUT
        // fetching the full content blob, so a client only sees presets it
        // can actually apply. `|| 1` matches wo_tool.js's own untagged-
        // content convention (migrateProfile()/installOrgConfig()).
        configVersion: doc.configVersion || 1 };
}

async function handleAdminGetConfigs(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var indexLoad = await loadConfigsIndexDoc(env);
    var visible = identity.isRoot ? indexLoad.doc.configs :
        indexLoad.doc.configs.filter(function(c) {
            return configEntryBucketIds(c).some(function(bid) { return isAtOrBelow(bid, identity.bucketIds, byId); });
        });
    return json({ configs: visible.map(configEntryPublic) });
}

async function handleAdminCreateConfig(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var name = String(body.name || '').trim();
    if (!name) badRequest('name required');
    var contentText = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);
    var parsedContent;
    try { parsedContent = JSON.parse(contentText); } catch (e) { return badRequest('content must be valid JSON'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    // bucketIds (array) is the new, preferred targeting shape — OR across
    // every listed bucket (private issue #7). Falls back to the legacy
    // singular bucketId (still exactly one branch, possibly root/null) if
    // the caller doesn't send bucketIds at all, so existing admin.html
    // builds/API callers keep working unchanged. Passing bucketIds: []
    // explicitly means "no bucket-scoped branch" (orConditions-only config)
    // — deliberately different from omitting bucketIds entirely.
    var bucketIds = Array.isArray(body.bucketIds) ? body.bucketIds :
        [body.bucketId != null ? body.bucketId : null];
    // An empty bucketIds[] means "no bucket-scoped branch at all" — the
    // forEach containment check below never runs against it, so without
    // this guard a scoped (non-root) admin could submit bucketIds:[] to
    // create a config with NO bucket containment whatsoever, reaching
    // users entirely outside their branch via orConditions alone. Only
    // root may go bucket-less (root/global has always meant bucketId:null,
    // a SINGLE root branch — bucketIds:[] is stronger: no branch at all).
    if (!identity.isRoot && !bucketIds.length) forbid('at least one bucket (within your scope) is required');
    bucketIds.forEach(function(bid) {
        if (!identity.isRoot && !isAtOrBelow(bid, identity.bucketIds, byId)) forbid('target bucket outside your scope');
    });
    var ownConditions = normalizeConditions(Array.isArray(body.ownConditions) ? body.ownConditions : []);
    ownConditions.forEach(function(c) {
        if (!canUseFieldForIdentity(identity, c.field, byId)) forbid('field "' + c.field + '" not permitted for your admin tier');
    });
    // orConditions branches deliberately never get a bucket's ancestor
    // chain prepended (that's what makes them useful for "Site = Westport
    // OR a specific user" — see buildConfigConditionGroups) — which also
    // means they carry NO structural containment at all. Letting a scoped
    // admin add one would let them reach users completely outside their
    // branch, defeating the entire hardlock model. Root-only, same
    // reasoning as override/extraGrants.
    var orConditions = (Array.isArray(body.orConditions) ? body.orConditions : []).map(normalizeConditions);
    if (orConditions.length && !identity.isRoot) forbid('additional OR-condition branches (beyond your bucket-scoped ones) are root-only');
    orConditions.forEach(function(group) {
        (Array.isArray(group) ? group : []).forEach(function(c) {
            if (!canUseFieldForIdentity(identity, c.field, byId)) forbid('field "' + c.field + '" not permitted for your admin tier');
        });
    });
    var conditionGroups = buildConfigConditionGroups(bucketIds, ownConditions, orConditions, byId);

    var indexLoad = await loadConfigsIndexDoc(env);
    var now = new Date().toISOString();
    var entry = {
        id: genId('cfg'), name: name, description: String(body.description || ''),
        // bucketId kept as the FIRST target for backward-compat display
        // (old admin.html reads a singular bucketId) — bucketIds is the
        // real, authoritative target list going forward.
        bucketId: bucketIds.length ? bucketIds[0] : null,
        bucketIds: bucketIds, conditionGroups: conditionGroups,
        createdBy: identity.label, createdAt: now, updatedBy: identity.label, updatedAt: now,
        size: contentText.length,
        // Mirrors the uploaded content's own configVersion (untagged content
        // is v1, same convention wo_tool.js uses) so resolveOrgConfigsForUser()
        // can filter without fetching the full blob — see configEntryPublic().
        configVersion: parsedContent.configVersion || 1,
    };
    indexLoad.doc.configs.push(entry);
    await writePrivateFile(env, 'configs/' + entry.id + '.json', JSON.stringify(parsedContent, null, 2), null,
        'admin: ' + identity.label + ' uploaded config "' + name + '"');
    await writePrivateFile(env, 'configs/index.json', JSON.stringify(indexLoad.doc, null, 2), indexLoad.sha,
        'admin: ' + identity.label + ' created config "' + name + '"');
    return json({ ok: true, config: configEntryPublic(entry) });
}

async function handleAdminGetConfigContent(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var indexLoad = await loadConfigsIndexDoc(env);
    var entry = indexLoad.doc.configs.find(function(c) { return c.id === id; });
    if (!entry) return notFound('config not found');
    if (!identity.isRoot && !configEntryBucketIds(entry).some(function(bid) { return isAtOrBelow(bid, identity.bucketIds, byId); })) forbid('config outside your scope');
    var f = await fetchPrivateFileWithSha(env, 'configs/' + id + '.json');
    if (!f.exists) return notFound('config content missing (index/content out of sync)');
    return json({ config: configEntryPublic(entry), content: JSON.parse(f.text) });
}

async function handleAdminDuplicateConfig(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var indexLoad = await loadConfigsIndexDoc(env);
    var source = indexLoad.doc.configs.find(function(c) { return c.id === id; });
    if (!source) return notFound('config not found');
    var sourceBucketIds = Array.isArray(source.bucketIds) ? source.bucketIds : [source.bucketId !== undefined ? source.bucketId : null];
    if (!identity.isRoot && !sourceBucketIds.some(function(bid) { return isAtOrBelow(bid, identity.bucketIds, byId); })) forbid('source config outside your scope');

    var name = String(body.name || (source.name + ' (copy)')).trim();
    var bucketIds = Array.isArray(body.bucketIds) ? body.bucketIds :
        (body.bucketId !== undefined ? [body.bucketId] : sourceBucketIds);
    if (!identity.isRoot && !bucketIds.length) forbid('at least one bucket (within your scope) is required');
    bucketIds.forEach(function(bid) {
        if (!identity.isRoot && !isAtOrBelow(bid, identity.bucketIds, byId)) forbid('target bucket outside your scope');
    });
    var ownConditions = normalizeConditions(Array.isArray(body.ownConditions) ? body.ownConditions : []);
    ownConditions.forEach(function(c) {
        if (!canUseFieldForIdentity(identity, c.field, byId)) forbid('field "' + c.field + '" not permitted for your admin tier');
    });
    // See the identical guard + comment in handleAdminCreateConfig — an
    // explicitly-resupplied orConditions is root-only; carrying the
    // SOURCE's own orConditions forward untouched (the no-override branch
    // below) is not a new grant, so it isn't gated here.
    var orConditions = (Array.isArray(body.orConditions) ? body.orConditions : []).map(normalizeConditions);
    if (body.orConditions !== undefined && orConditions.length && !identity.isRoot) forbid('additional OR-condition branches (beyond your bucket-scoped ones) are root-only');
    var conditionGroups = (body.bucketIds !== undefined || body.bucketId !== undefined || body.ownConditions !== undefined || body.orConditions !== undefined) ?
        buildConfigConditionGroups(bucketIds, ownConditions, orConditions, byId) :
        configEntryMatchGroups(source); // no targeting override supplied — carry the source's own groups over exactly

    var f = await fetchPrivateFileWithSha(env, 'configs/' + id + '.json');
    if (!f.exists) return notFound('source config content missing (index/content out of sync)');

    var now = new Date().toISOString();
    var entry = {
        id: genId('cfg'), name: name, description: String(body.description !== undefined ? body.description : source.description || ''),
        bucketId: bucketIds.length ? bucketIds[0] : null,
        bucketIds: bucketIds, conditionGroups: conditionGroups,
        createdBy: identity.label, createdAt: now, updatedBy: identity.label, updatedAt: now,
        size: f.text.length,
        // The content is byte-identical to the source, so its configVersion
        // carries over unchanged — same reasoning as configEntryPublic().
        configVersion: source.configVersion || 1,
    };
    indexLoad.doc.configs.push(entry);
    await writePrivateFile(env, 'configs/' + entry.id + '.json', f.text, null,
        'admin: ' + identity.label + ' duplicated config "' + source.name + '" as "' + name + '"');
    await writePrivateFile(env, 'configs/index.json', JSON.stringify(indexLoad.doc, null, 2), indexLoad.sha,
        'admin: ' + identity.label + ' created config "' + name + '" (duplicate of ' + id + ')');
    return json({ ok: true, config: configEntryPublic(entry) });
}

async function handleAdminPatchConfig(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var indexLoad = await loadConfigsIndexDoc(env);
    var entry = indexLoad.doc.configs.find(function(c) { return c.id === id; });
    if (!entry) return notFound('config not found');
    var entryBucketIds = Array.isArray(entry.bucketIds) ? entry.bucketIds : [entry.bucketId !== undefined ? entry.bucketId : null];
    if (!identity.isRoot && !entryBucketIds.some(function(bid) { return isAtOrBelow(bid, identity.bucketIds, byId); })) forbid('config outside your scope');

    if (body.name !== undefined) {
        var name = String(body.name).trim();
        if (!name) badRequest('name cannot be empty');
        entry.name = name;
    }
    if (body.description !== undefined) entry.description = String(body.description);
    if (body.bucketId !== undefined || body.bucketIds !== undefined || body.ownConditions !== undefined || body.orConditions !== undefined) {
        var newBucketIds = Array.isArray(body.bucketIds) ? body.bucketIds :
            (body.bucketId !== undefined ? [body.bucketId] : entryBucketIds);
        if (!identity.isRoot && !newBucketIds.length) forbid('at least one bucket (within your scope) is required');
        newBucketIds.forEach(function(bid) {
            if (!identity.isRoot && !isAtOrBelow(bid, identity.bucketIds, byId)) forbid('target bucket outside your scope');
        });
        // ownConditions defaults to whatever was already stored for the
        // FIRST bucket branch (stripping that branch's own ancestor
        // chain back off) if the caller doesn't send a new value — same
        // "recover the admin-authored portion from the flattened chain"
        // approach the old single-bucket code used, applied to the first
        // group in conditionGroups instead of the old flat conditions.
        var existingGroups = configEntryMatchGroups(entry);
        var firstBucketChainLen = bucketConditionChain(entryBucketIds[0], byId).length;
        var ownConditions = normalizeConditions(Array.isArray(body.ownConditions) ? body.ownConditions :
            (existingGroups[0] || []).slice(firstBucketChainLen));
        ownConditions.forEach(function(c) {
            if (!canUseFieldForIdentity(identity, c.field, byId)) forbid('field "' + c.field + '" not permitted for your admin tier');
        });
        // Past ALL of the (possibly multi-bucket) target's own groups, not
        // just index 1 — slice(1) would misfile a second/third bucket's own
        // ancestor-chain group as if it were an orConditions branch on any
        // multi-bucket config whenever ownConditions/bucketIds get touched
        // without also resupplying orConditions.
        var orConditions = (Array.isArray(body.orConditions) ? body.orConditions :
            existingGroups.slice(entryBucketIds.length)).map(normalizeConditions); // whatever extra OR-branches already existed, past the primary bucket-group(s)
        if (body.orConditions !== undefined && orConditions.length && !identity.isRoot) forbid('additional OR-condition branches (beyond your bucket-scoped ones) are root-only');
        entry.bucketId = newBucketIds.length ? newBucketIds[0] : null;
        entry.bucketIds = newBucketIds;
        entry.conditionGroups = buildConfigConditionGroups(newBucketIds, ownConditions, orConditions, byId);
        delete entry.conditions; // superseded by conditionGroups — configEntryMatchGroups() only falls back to this for entries that HAVEN'T been re-saved under the new shape yet
    }
    var contentUpdated = false;
    if (body.content !== undefined) {
        var contentText = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);
        var parsedContent;
        try { parsedContent = JSON.parse(contentText); } catch (e) { return badRequest('content must be valid JSON'); }
        var existing = await fetchPrivateFileWithSha(env, 'configs/' + id + '.json');
        await writePrivateFile(env, 'configs/' + id + '.json', JSON.stringify(parsedContent, null, 2), existing.sha,
            'admin: ' + identity.label + ' replaced content of config "' + entry.name + '"');
        entry.size = contentText.length;
        // Re-derive from the NEW content, same reasoning as
        // handleAdminCreateConfig — a content replacement can change shape
        // (e.g. re-exported from a newer tool build), so the metadata's
        // configVersion must track the content actually being served now,
        // not whatever it was tagged at before this patch.
        entry.configVersion = parsedContent.configVersion || 1;
        contentUpdated = true;
    }
    entry.updatedBy = identity.label;
    entry.updatedAt = new Date().toISOString();
    await writePrivateFile(env, 'configs/index.json', JSON.stringify(indexLoad.doc, null, 2), indexLoad.sha,
        'admin: ' + identity.label + ' updated config "' + entry.name + '"' + (contentUpdated ? ' (incl. content)' : ''));
    return json({ ok: true, config: configEntryPublic(entry) });
}

async function handleAdminDeleteConfig(request, env, id) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var indexLoad = await loadConfigsIndexDoc(env);
    var idx = indexLoad.doc.configs.findIndex(function(c) { return c.id === id; });
    if (idx === -1) return notFound('config not found');
    var entry = indexLoad.doc.configs[idx];
    if (!identity.isRoot && !configEntryBucketIds(entry).some(function(bid) { return isAtOrBelow(bid, identity.bucketIds, byId); })) forbid('config outside your scope');

    indexLoad.doc.configs.splice(idx, 1);
    await writePrivateFile(env, 'configs/index.json', JSON.stringify(indexLoad.doc, null, 2), indexLoad.sha,
        'admin: ' + identity.label + ' deleted config "' + entry.name + '"');
    try {
        var f = await fetchPrivateFileWithSha(env, 'configs/' + id + '.json');
        if (f.exists) await deletePrivateFile(env, 'configs/' + id + '.json', f.sha, 'admin: ' + identity.label + ' deleted config content for "' + entry.name + '"');
    } catch (e) {
        // index entry is already gone (the part that matters for
        // listing/scope) - a leftover orphaned content file is harmless
        // clutter, not a functional problem.
    }
    return json({ ok: true });
}


// ── /admin/groups ──
async function handleAdminGetGroups(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var accountsById = {};
    (groupsLoad.doc.accounts || []).forEach(function(a) { accountsById[a.id] = a; });
    var visible = (identity.isRoot ? groupsLoad.doc.groups :
        groupsLoad.doc.groups.filter(function(g) { return isAtOrBelow(g.bucketId, identity.bucketIds, byId); }))
        .map(function(g) {
            return {
                id: g.id, bucketId: g.bucketId, label: g.label,
                allowPeerAdminCreation: !!g.allowPeerAdminCreation, allowChildAdminCreation: !!g.allowChildAdminCreation,
                members: (g.memberIds || []).map(function(id) { return accountsById[id]; }).filter(Boolean).map(function(m) {
                    return { id: m.id, email: m.email, label: m.label, mustChangePassword: !!m.mustChangePassword, createdAt: m.createdAt, createdBy: m.createdBy };
                }),
            };
        });
    return json({ groups: visible });
}

async function handleAdminCreateGroup(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var bucketId = body.bucketId;
    if (!bucketId || !byId[bucketId]) return notFound('bucket not found');
    if (!identity.isRoot && !canCreateChildGroupAt(identity, bucketId, byId)) forbid('none of your admin groups are permitted to create a child admin group at this bucket');

    var groupsLoad = await loadAdminGroupsDoc(env);
    var newGroup = {
        id: genId('grp'), bucketId: bucketId, label: String(body.label || 'Admins'),
        allowPeerAdminCreation: !!body.allowPeerAdminCreation, allowChildAdminCreation: !!body.allowChildAdminCreation,
        memberIds: [],
    };
    groupsLoad.doc.groups.push(newGroup);
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' created admin group "' + newGroup.label + '"');
    return json({ ok: true, group: newGroup });
}

// ── Email (Resend) — optional. If RESEND_API_KEY/RESEND_FROM_EMAIL aren't
// configured, account creation/reset falls back to showing a temp password
// once in the admin UI (the original behavior) instead of failing outright
// — the system stays fully functional before Resend is set up, and
// upgrades automatically the moment both are configured. ──
function isEmailSendingConfigured(env) {
    return !!(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
}
async function sendEmail(env, to, subject, html) {
    var res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject: subject, html: html }),
    });
    if (!res.ok) {
        var text = '';
        try { text = await res.text(); } catch (e) {}
        throw new Error('Resend send failed: HTTP ' + res.status + (text ? ' ' + text : ''));
    }
}
var PWSET_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours - a one-time action link, shorter-lived than a 12h session
// kind: 'welcome' (brand-new account) | 'reset'. originBase = the Worker's
// own origin (derived from the incoming request, not hardcoded — see call
// sites — so the link is correct whatever hostname it was actually reached
// through).
async function sendAccountSetupEmail(env, account, kind, originBase) {
    var token = await makeToken(env.ADMIN_SESSION_SECRET, { accountId: account.id, type: 'pwset', exp: Date.now() + PWSET_TOKEN_TTL_MS });
    var link = originBase + '/admin?setToken=' + encodeURIComponent(token);
    var subject = kind === 'reset' ? 'WO Review Tool admin — reset your password' : 'WO Review Tool admin — set your password';
    var intro = kind === 'reset' ? 'A password reset was requested for your WO Review Tool admin account.' : 'An admin account was created for you on the WO Review Tool.';
    var html = '<p>' + intro + '</p><p><a href="' + link + '">Set your password</a></p><p>This link expires in 2 hours and can only be used once. If you didn\'t expect this, you can ignore it.</p>';
    await sendEmail(env, account.email, subject, html);
}

// Shared by handleAdminAddGroupMember/handleAdminCreateRootAccount — builds
// the new account record and either emails a set-password link (Resend
// configured) or generates a temp password shown once (not configured).
async function provisionAccount(env, request, email, label, createdByLabel) {
    var account = {
        id: genId('acc'), email: email, label: String(label || email),
        mustChangePassword: true, createdAt: new Date().toISOString(), createdBy: createdByLabel,
    };
    var result = { account: account };
    if (isEmailSendingConfigured(env)) {
        account.passwordHash = null; // no password until they complete setup via the emailed link
        var originBase = new URL(request.url).origin;
        try {
            await sendAccountSetupEmail(env, account, 'welcome', originBase);
            result.emailSent = true;
        } catch (e) {
            result.emailSent = false;
            result.emailError = String(e && e.message || e);
        }
    } else {
        var tempPassword = genTempPassword();
        account.passwordHash = await hashPassword(tempPassword);
        result.tempPassword = tempPassword;
    }
    return result;
}

async function handleAdminAddGroupMember(request, env, groupId) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var email = String(body.email || '').trim();
    if (!email) badRequest('email required');
    if (!isValidEmail(email)) badRequest('a valid email address is required');

    var groupsLoad = await loadAdminGroupsDoc(env);
    var group = groupsLoad.doc.groups.find(function(g) { return g.id === groupId; });
    if (!group) return notFound('group not found');
    // Peer creation is specifically "add to one of YOUR OWN groups" — not
    // any group in scope — and is governed by THAT group's own flag (an
    // admin can belong to several groups with different flags, so this is
    // never an identity-wide toggle). Root bypasses this entirely.
    if (!identity.isRoot) {
        if (identity.groupIds.indexOf(groupId) === -1) forbid('you can only add members to one of your own groups');
        if (!group.allowPeerAdminCreation) forbid('this group is not permitted to create peer admins');
    }

    // An existing account (found by email) LINKS into this group instead of
    // being rejected as "taken" — that's exactly what multi-group
    // membership means: the same person administering more than one
    // bucket. A brand-new email still provisions a new account as before.
    var existing = findAccountByEmail(groupsLoad.doc, email);
    if (existing) {
        if (existing.isRootAccount) return json({ ok: false, error: 'that email belongs to a root account, not a scoped admin' }, 409);
        if (group.memberIds.indexOf(existing.account.id) !== -1) return json({ ok: false, error: 'that account is already a member of this group' }, 409);
        group.memberIds.push(existing.account.id);
        await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
            'admin: ' + identity.label + ' added existing account "' + email + '" to group "' + group.label + '"');
        return json({ ok: true, member: { id: existing.account.id, email: existing.account.email, label: existing.account.label }, linked: true });
    }

    var provisioned = await provisionAccount(env, request, email, body.label, identity.label);
    var member = provisioned.account;
    groupsLoad.doc.accounts.push(member);
    group.memberIds.push(member.id);
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' added account "' + email + '" to group "' + group.label + '"');
    return json(Object.assign({ ok: true, member: { id: member.id, email: email, label: member.label } },
        provisioned.tempPassword ? { tempPassword: provisioned.tempPassword } : { emailSent: provisioned.emailSent, emailError: provisioned.emailError }));
}

// ── Login (email/password -> signed session token) ──
async function handleAdminLogin(request, env) {
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var email = String(body.email || '').trim();
    var password = String(body.password || '');
    if (!email || !password) return badRequest('email and password required');

    var groupsDoc = (await loadAdminGroupsDoc(env)).doc;
    var found = findAccountByEmail(groupsDoc, email);
    // Always run a full password derivation, even for an email that doesn't
    // exist or has no password yet (against a dummy hash) - a login that
    // short-circuits on "no such account" is a timing side-channel an
    // attacker can use to enumerate valid admin emails without ever
    // guessing a password.
    var hashToCheck = (found && found.account.passwordHash) ? found.account.passwordHash : DUMMY_PASSWORD_HASH;
    var ok = await verifyPassword(password, hashToCheck);

    if (found && !found.account.passwordHash) {
        // Deliberately a more specific message than "invalid" here - a
        // real usability need (an account mid-setup shouldn't look
        // indistinguishable from a wrong password with no way out), at the
        // documented cost of a slightly stronger enumeration signal than a
        // pure timing-normalized login would give. See PERMISSIONS_GUIDE.md.
        return json({ error: 'account setup not complete — check your email for a setup link, or use "forgot password" to send a new one' }, 403);
    }
    if (!found || !ok) return json({ error: 'invalid username or password' }, 401);

    var isRoot = found.isRootAccount;
    var bucketIds = isRoot ? [] : found.groups.map(function(g) { return g.bucketId; });
    var level = 0;
    if (!isRoot) {
        var bucketsLoad = await loadBucketsDoc(env);
        var byId = bucketsById(bucketsLoad.doc.buckets);
        var depths = bucketIds.map(function(id) { return bucketDepth(id, byId); }).filter(function(d) { return d >= 0; });
        level = depths.length ? Math.min.apply(null, depths) : -1;
    }
    var sessionToken = await makeToken(env.ADMIN_SESSION_SECRET, {
        accountId: found.account.id, isRoot: isRoot, exp: Date.now() + ADMIN_SESSION_TTL_MS,
    });
    return json({
        token: sessionToken, role: isRoot ? 'root' : 'scoped', label: found.account.label,
        level: level, bucketIds: bucketIds, mustChangePassword: !!found.account.mustChangePassword,
    });
}

// ── Change own password (requires current password) ──
async function handleAdminChangeOwnPassword(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    if (!identity.accountId) forbid('the break-glass token has no account to change a password on — log in with a real account first');
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var currentPassword = String(body.currentPassword || '');
    var newPassword = String(body.newPassword || '');
    if (!currentPassword || !newPassword) badRequest('currentPassword and newPassword required');
    if (newPassword.length < 10) badRequest('new password must be at least 10 characters');

    var groupsLoad = await loadAdminGroupsDoc(env);
    var found = findAccountById(groupsLoad.doc, identity.accountId);
    if (!found) return notFound('account not found');
    var ok = await verifyPassword(currentPassword, found.account.passwordHash || DUMMY_PASSWORD_HASH);
    if (!found.account.passwordHash || !ok) return json({ error: 'current password is incorrect' }, 401);

    found.account.passwordHash = await hashPassword(newPassword);
    found.account.mustChangePassword = false;
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' changed their own password');
    return json({ ok: true });
}

// ── Password setup / reset via emailed link (Resend configured) ──
async function handleAdminCompleteSignup(request, env) {
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var data = await verifyToken(env.ADMIN_SESSION_SECRET, body.token);
    if (!data || data.type !== 'pwset') return json({ error: 'invalid or expired link — ask for a new one' }, 401);
    var newPassword = String(body.newPassword || '');
    if (newPassword.length < 10) badRequest('new password must be at least 10 characters');

    var groupsLoad = await loadAdminGroupsDoc(env);
    var found = findAccountById(groupsLoad.doc, data.accountId);
    if (!found) return notFound('account not found');
    found.account.passwordHash = await hashPassword(newPassword);
    found.account.mustChangePassword = false;
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + found.account.email + ' completed password setup via emailed link');

    // Log them straight in as a convenience - clicking the emailed link
    // already proved account ownership once, no reason to make them log in
    // again immediately after.
    var isRoot = found.isRootAccount;
    var bucketIds = isRoot ? [] : found.groups.map(function(g) { return g.bucketId; });
    var level = 0;
    if (!isRoot) {
        var bucketsLoad = await loadBucketsDoc(env);
        var byId = bucketsById(bucketsLoad.doc.buckets);
        var depths = bucketIds.map(function(id) { return bucketDepth(id, byId); }).filter(function(d) { return d >= 0; });
        level = depths.length ? Math.min.apply(null, depths) : -1;
    }
    var sessionToken = await makeToken(env.ADMIN_SESSION_SECRET, { accountId: found.account.id, isRoot: isRoot, exp: Date.now() + ADMIN_SESSION_TTL_MS });
    return json({ ok: true, token: sessionToken, role: isRoot ? 'root' : 'scoped', label: found.account.label, level: level, bucketIds: bucketIds });
}

// Self-service "forgot password" - public, always returns the same
// generic response regardless of whether the email matched an account,
// so a caller can't use this to enumerate valid admin emails. A no-op
// (still returns ok:true) if Resend isn't configured yet - there's no
// temp-password fallback here since there's no admin present to show it
// to; use the admin-assisted reset-password endpoint instead.
async function handleAdminForgotPassword(request, env) {
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var email = String(body.email || '').trim();
    if (email && isEmailSendingConfigured(env)) {
        var groupsDoc = (await loadAdminGroupsDoc(env)).doc;
        var found = findAccountByEmail(groupsDoc, email);
        if (found) {
            try {
                var originBase = new URL(request.url).origin;
                await sendAccountSetupEmail(env, found.account, 'reset', originBase);
            } catch (e) {} // swallow - response is identical either way
        }
    }
    return json({ ok: true, message: 'If that email has an admin account, a reset link has been sent.' });
}

// ── Admin-assisted password reset — the fallback when self-service
// "forgot password" isn't available to someone (or Resend isn't
// configured yet): someone with authority over the account's bucket (or
// root) triggers this directly. Same dual-mode as account creation — an
// emailed link if Resend is configured, a temp password shown once if
// not. ──
async function handleAdminResetPassword(request, env, accountId) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var found = findAccountById(groupsLoad.doc, accountId);
    if (!found) return notFound('account not found');
    if (!identity.isRoot) {
        if (found.isRootAccount) forbid('only root can reset a root account\'s password');
        // A password is shared across every group the account belongs to,
        // so resetting it affects all of them at once - require authority
        // over ALL of the account's groups (not just one), otherwise an
        // admin over a minor bucket could reset the password of someone who
        // also has access to a bucket that admin doesn't otherwise control,
        // and use the new password to reach it. An account with zero
        // remaining memberships (every group revoked) is root-only.
        var authorizedOverAll = found.groups.length > 0 &&
            found.groups.every(function(g) { return isAtOrBelow(g.bucketId, identity.bucketIds, byId); });
        if (!authorizedOverAll) forbid('account outside your scope');
    }

    // Admin-assisted reset is email-only now — no plaintext temp-password
    // fallback shown in the admin UI. A temp password sent through a
    // side-channel (Slack, in person) is a weaker credential handoff than a
    // one-time link only the account's own inbox can redeem, and it's a
    // real handoff to get wrong when the account being reset may have
    // access outside the resetting admin's own bucket (see the
    // authorizedOverAll check above). Account CREATION (provisionAccount)
    // is unaffected — it still falls back to a shown-once temp password
    // when Resend isn't configured, since a brand-new account has no
    // password to protect yet.
    if (!isEmailSendingConfigured(env)) {
        return json({ ok: false, error: 'password reset requires email delivery to be configured (RESEND_API_KEY/RESEND_FROM_EMAIL) — there is no temp-password fallback for resets' }, 400);
    }
    found.account.passwordHash = null;
    found.account.mustChangePassword = true;
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' reset the password for "' + found.account.email + '" (email link sent)');
    var originBase = new URL(request.url).origin;
    try {
        await sendAccountSetupEmail(env, found.account, 'reset', originBase);
        return json({ ok: true, email: found.account.email, emailSent: true });
    } catch (e) {
        return json({ ok: true, email: found.account.email, emailSent: false, emailError: String(e && e.message || e) });
    }
}

// ── Root accounts (email/password, full/unscoped access - a normal-use
// alternative to pasting ROOT_ADMIN_TOKEN every time) ──
async function handleAdminGetRootAccounts(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var groupsLoad = await loadAdminGroupsDoc(env);
    return json({
        accounts: groupsLoad.doc.rootAccounts.map(function(a) {
            return { id: a.id, email: a.email, label: a.label, mustChangePassword: !!a.mustChangePassword, createdAt: a.createdAt, createdBy: a.createdBy };
        }),
    });
}
async function handleAdminCreateRootAccount(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var email = String(body.email || '').trim();
    if (!email) badRequest('email required');
    if (!isValidEmail(email)) badRequest('a valid email address is required');

    var groupsLoad = await loadAdminGroupsDoc(env);
    if (emailTaken(groupsLoad.doc, email)) return json({ ok: false, error: 'an account with that email already exists' }, 409);

    var provisioned = await provisionAccount(env, request, email, body.label, identity.label);
    var account = provisioned.account;
    groupsLoad.doc.rootAccounts.push(account);
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' created root account "' + email + '"');
    return json(Object.assign({ ok: true, account: { id: account.id, email: email, label: account.label } },
        provisioned.tempPassword ? { tempPassword: provisioned.tempPassword } : { emailSent: provisioned.emailSent, emailError: provisioned.emailError }));
}
async function handleAdminDeleteRootAccount(request, env, accountId) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var before = groupsLoad.doc.rootAccounts.length;
    groupsLoad.doc.rootAccounts = groupsLoad.doc.rootAccounts.filter(function(a) { return a.id !== accountId; });
    if (groupsLoad.doc.rootAccounts.length === before) return notFound('root account not found');
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' deleted a root account');
    return json({ ok: true });
}

// Rename-only for now (label) - bucketId/flags are deliberately not
// editable here (moving a group to a different bucket or changing its
// delegation flags is a bigger decision than a quick rename; delete and
// recreate covers that, same convention as buckets' own "no parentId
// change via PATCH" rule).
async function handleAdminPatchGroup(request, env, groupId) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }

    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var group = groupsLoad.doc.groups.find(function(g) { return g.id === groupId; });
    if (!group) return notFound('group not found');
    if (!identity.isRoot && !isAtOrBelow(group.bucketId, identity.bucketIds, byId)) forbid('group outside your scope');

    if (body.label !== undefined) {
        var label = String(body.label || '').trim();
        if (!label) return badRequest('label required');
        group.label = label;
    }
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' renamed admin group to "' + group.label + '"');
    return json({ ok: true, group: group });
}

async function handleAdminDeleteGroupMember(request, env, groupId, memberId) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var group = groupsLoad.doc.groups.find(function(g) { return g.id === groupId; });
    if (!group) return notFound('group not found');
    if (!identity.isRoot && !isAtOrBelow(group.bucketId, identity.bucketIds, byId)) forbid('group outside your scope');

    // This revokes the account's membership in THIS group only - it does
    // not delete the account itself, since (now that one account can
    // belong to more than one group) it may still have access elsewhere
    // through a different group.
    var before = group.memberIds.length;
    group.memberIds = group.memberIds.filter(function(id) { return id !== memberId; });
    if (group.memberIds.length === before) return notFound('member not found');
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' revoked a member from group "' + group.label + '"');
    return json({ ok: true });
}

async function handleAdminDeleteGroup(request, env, groupId) {
    var identity = await resolveAdminIdentity(request, env);
    requireAdmin(identity);
    var bucketsLoad = await loadBucketsDoc(env);
    var byId = bucketsById(bucketsLoad.doc.buckets);
    var groupsLoad = await loadAdminGroupsDoc(env);
    var group = groupsLoad.doc.groups.find(function(g) { return g.id === groupId; });
    if (!group) return notFound('group not found');
    if (!identity.isRoot && !isAtOrBelow(group.bucketId, identity.bucketIds, byId)) forbid('group outside your scope');

    groupsLoad.doc.groups = groupsLoad.doc.groups.filter(function(g) { return g.id !== groupId; });
    await writePrivateFile(env, 'adminGroups.json', JSON.stringify(groupsLoad.doc, null, 2), groupsLoad.sha,
        'admin: ' + identity.label + ' deleted admin group "' + group.label + '"');
    return json({ ok: true });
}

// ── /admin/version (private repo, root-only) ──
async function handleAdminGetVersion(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var f = await fetchPrivateFileWithSha(env, 'version.json');
    if (!f.exists) return notFound('version.json not found');
    return json({ doc: JSON.parse(f.text) });
}

async function handleAdminPostVersion(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var doc = body.doc;
    if (!doc || !doc.channels || !Array.isArray(doc.versions)) badRequest('invalid version document');
    var known = doc.versions.map(function(v) { return v.version; });
    if (known.indexOf(doc.latest) === -1) badRequest('"latest" (' + doc.latest + ') does not match any versions[].version');
    Object.keys(doc.channels).forEach(function(ch) {
        if (known.indexOf(doc.channels[ch]) === -1) badRequest('channels.' + ch + ' (' + doc.channels[ch] + ') does not match any versions[].version');
    });

    var f = await fetchPrivateFileWithSha(env, 'version.json');
    await writePrivateFile(env, 'version.json', JSON.stringify(doc, null, 2), f.sha,
        'admin: ' + identity.label + ' updated version.json');
    return json({ ok: true });
}

// ── /admin/packages (private repo, root-only — private issue #3, Phase 4) ──
// Same shape resolvePackagesForUser() reads at runtime: {packages:
// [{id, name, grant, entry}]}. Root-only because a package's grant
// requirement applies globally across every bucket, not one admin's own
// scoped subtree — there's no per-bucket "this package needs a different
// grant here" concept, unlike buckets/groups.
async function handleAdminGetPackages(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var f = await fetchPrivateFileWithSha(env, 'packages.json');
    if (!f.exists) return notFound('packages.json not found');
    return json({ doc: JSON.parse(f.text) });
}

async function handleAdminPostPackages(request, env) {
    var identity = await resolveAdminIdentity(request, env);
    requireRoot(identity);
    var body;
    try { body = await request.json(); } catch (e) { return badRequest('bad request body'); }
    var doc = body.doc;
    if (!doc || !Array.isArray(doc.packages)) badRequest('invalid packages document');
    var seenIds = {};
    doc.packages.forEach(function(p) {
        if (!p.id || typeof p.id !== 'string') badRequest('every package needs a non-empty string id');
        if (seenIds[p.id]) badRequest('duplicate package id "' + p.id + '"');
        seenIds[p.id] = true;
        if (!p.name || typeof p.name !== 'string') badRequest('package "' + p.id + '" needs a non-empty name');
        if (!p.entry || typeof p.entry !== 'string') badRequest('package "' + p.id + '" needs a non-empty entry path');
        // Not enforcing a "grant must already exist elsewhere" check — a
        // package's grant is just a string, same convention as any other
        // grant (admin/dev/beta_N), and root is trusted to type it right,
        // same as bucket/group grant assignment already is.
        if (!p.grant || typeof p.grant !== 'string') badRequest('package "' + p.id + '" needs a non-empty grant (e.g. "admin", "dev", "beta_1", or a new "beta_N"/"pkg:*"-style grant)');
    });

    var f = await fetchPrivateFileWithSha(env, 'packages.json');
    await writePrivateFile(env, 'packages.json', JSON.stringify(doc, null, 2), f.sha,
        'admin: ' + identity.label + ' updated packages.json');
    return json({ ok: true });
}

// ── Admin shell ──
async function handleAdminShell(env, ctx) {
    try {
        var html = await cachedFetchPrivateFile(env, ctx, 'admin.html', null, 15);
        return new Response(html, {
            status: 200,
            headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders()),
        });
    } catch (e) {
        return new Response('Admin page unavailable.', { status: 502, headers: corsHeaders() });
    }
}

// ── Admin routing ──
async function routeAdmin(request, env, ctx, pathname) {
    var method = request.method;
    if (pathname === '/admin' && method === 'GET') return handleAdminShell(env, ctx);
    if (pathname === '/admin/login' && method === 'POST') return handleAdminLogin(request, env);
    if (pathname === '/admin/complete-signup' && method === 'POST') return handleAdminCompleteSignup(request, env);
    if (pathname === '/admin/forgot-password' && method === 'POST') return handleAdminForgotPassword(request, env);
    if (pathname === '/admin/accounts/me/change-password' && method === 'POST') return handleAdminChangeOwnPassword(request, env);
    var mReset = /^\/admin\/accounts\/([^/]+)\/reset-password$/.exec(pathname);
    if (mReset && method === 'POST') return handleAdminResetPassword(request, env, mReset[1]);

    if (pathname === '/admin/root-accounts' && method === 'GET') return handleAdminGetRootAccounts(request, env);
    if (pathname === '/admin/root-accounts' && method === 'POST') return handleAdminCreateRootAccount(request, env);
    var mRootAcc = /^\/admin\/root-accounts\/([^/]+)$/.exec(pathname);
    if (mRootAcc && method === 'DELETE') return handleAdminDeleteRootAccount(request, env, mRootAcc[1]);

    if (pathname === '/admin/permissions' && method === 'GET') return handleAdminGetPermissions(request, env);
    var m1 = /^\/admin\/permissions\/([a-zA-Z]+)$/.exec(pathname);
    if (m1 && method === 'POST') return handleAdminUpsertPermissionEntry(request, env, m1[1]);
    var m2 = /^\/admin\/permissions\/([a-zA-Z]+)\/([^/]+)$/.exec(pathname);
    if (m2 && method === 'DELETE') return handleAdminDeletePermissionEntry(request, env, m2[1], m2[2]);

    if (pathname === '/admin/maximo-hosts' && method === 'POST') return handleAdminSetMaximoHosts(request, env);

    if (pathname === '/admin/buckets' && method === 'GET') return handleAdminGetBuckets(request, env);
    if (pathname === '/admin/buckets' && method === 'POST') return handleAdminCreateBucket(request, env);
    var m4 = /^\/admin\/buckets\/([^/]+)$/.exec(pathname);
    if (m4 && method === 'PATCH') return handleAdminPatchBucket(request, env, m4[1]);
    if (m4 && method === 'DELETE') return handleAdminDeleteBucket(request, env, m4[1]);

    if (pathname === '/admin/configs' && method === 'GET') return handleAdminGetConfigs(request, env);
    if (pathname === '/admin/configs' && method === 'POST') return handleAdminCreateConfig(request, env);
    var mConfigDup = /^\/admin\/configs\/([^/]+)\/duplicate$/.exec(pathname);
    if (mConfigDup && method === 'POST') return handleAdminDuplicateConfig(request, env, mConfigDup[1]);
    var mConfig = /^\/admin\/configs\/([^/]+)$/.exec(pathname);
    if (mConfig && method === 'GET') return handleAdminGetConfigContent(request, env, mConfig[1]);
    if (mConfig && method === 'PATCH') return handleAdminPatchConfig(request, env, mConfig[1]);
    if (mConfig && method === 'DELETE') return handleAdminDeleteConfig(request, env, mConfig[1]);

    if (pathname === '/admin/groups' && method === 'GET') return handleAdminGetGroups(request, env);
    if (pathname === '/admin/groups' && method === 'POST') return handleAdminCreateGroup(request, env);
    var m5 = /^\/admin\/groups\/([^/]+)\/members$/.exec(pathname);
    if (m5 && method === 'POST') return handleAdminAddGroupMember(request, env, m5[1]);
    var m6 = /^\/admin\/groups\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
    if (m6 && method === 'DELETE') return handleAdminDeleteGroupMember(request, env, m6[1], m6[2]);
    var m7 = /^\/admin\/groups\/([^/]+)$/.exec(pathname);
    if (m7 && method === 'PATCH') return handleAdminPatchGroup(request, env, m7[1]);
    if (m7 && method === 'DELETE') return handleAdminDeleteGroup(request, env, m7[1]);

    if (pathname === '/admin/version' && method === 'GET') return handleAdminGetVersion(request, env);
    if (pathname === '/admin/version' && method === 'POST') return handleAdminPostVersion(request, env);

    if (pathname === '/admin/packages' && method === 'GET') return handleAdminGetPackages(request, env);
    if (pathname === '/admin/packages' && method === 'POST') return handleAdminPostPackages(request, env);

    return json({ error: 'not found' }, 404);
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }
        var url = new URL(request.url);
        try {
            if (url.pathname === '/bootstrap' && request.method === 'GET') {
                return await handleBootstrap(env, ctx);
            }
            if (url.pathname === '/check-access' && request.method === 'POST') {
                return await handleCheckAccess(request, env, ctx);
            }
            if (url.pathname === '/tool' && request.method === 'GET') {
                return await handleGetTool(request, env, ctx);
            }
            if (url.pathname === '/loader.js' && request.method === 'GET') {
                return await handleGetLoader(env, ctx);
            }
            if (url.pathname === '/version.json' && request.method === 'GET') {
                return await handleGetVersionJson(env, ctx);
            }
            if (url.pathname === '/org-config-content' && request.method === 'GET') {
                return await handleGetOrgConfigContent(request, env, ctx);
            }
            if (url.pathname === '/package-content' && request.method === 'GET') {
                return await handleGetPackageContent(request, env, ctx);
            }
            if (url.pathname === '/feedback' && request.method === 'POST') {
                return await handleFeedback(request, env);
            }
            if (url.pathname === '/admin' || url.pathname.indexOf('/admin/') === 0) {
                return await routeAdmin(request, env, ctx, url.pathname);
            }
            return json({ error: 'not found' }, 404);
        } catch (err) {
            var status = (err && err.status) || 500;
            return json({ error: status === 500 ? 'server error' : err.message, message: String(err && err.message || err) }, status);
        }
    },
};
