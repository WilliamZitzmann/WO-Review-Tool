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
 * Endpoints:
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
 *
 * Required secrets (wrangler secret put ...):
 *   GITHUB_PAT     — fine-grained PAT, read-only, Contents:read on the
 *                    private repo holding wo_tool.js + permissions.json.
 *   TOKEN_SECRET   — random string, signs the short-lived access tokens.
 *
 * Required vars (wrangler.toml [vars]):
 *   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH
 */

const TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes — used almost immediately after issue
const CANONICAL_FIELDS = ['username', 'email', 'country', 'insertSite', 'langcode', 'displayName'];

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
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

async function loadPermissions(env) {
    const raw = await fetchPrivateFile(env, 'permissions.json');
    return JSON.parse(raw);
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

function evalGroup(user, conditions) {
    return (conditions || []).every(function(c) { return evalCondition(user, c); });
}

// Precedence: override -> blacklist -> allow -> default deny.
function evaluateAccess(perms, user) {
    var username = String(user.username || '').toLowerCase();

    var override = (perms.override || []).find(function(o) {
        return String(o.username || '').toLowerCase() === username;
    });
    if (override) {
        return { granted: true, grants: resolveGrants(perms, username, override.grants) };
    }

    var blacklisted = (perms.blacklist || []).some(function(group) {
        return evalGroup(user, group);
    });
    if (blacklisted) {
        return { granted: false };
    }

    var allowMatch = (perms.allow || []).find(function(group) {
        return evalGroup(user, group.conditions);
    });
    if (allowMatch) {
        return { granted: true, grants: resolveGrants(perms, username, allowMatch.grants) };
    }

    return { granted: false };
}

// Merges the base grants a user got from their matching override/allow rule
// with any extra flags called out for them by name in perms.extraGrants —
// this is the server-side replacement for the console
// __woEnableBeta/__woEnableDev commands, not a separate access gate of its
// own. Lets one person hold multiple grants at once (e.g. dev + beta_0)
// without needing a dedicated override entry for every combination.
function resolveGrants(perms, username, baseGrants) {
    var set = {};
    (baseGrants && baseGrants.length ? baseGrants : ['user']).forEach(function(g) { set[g] = true; });
    var extraGrants = perms.extraGrants || {};
    var key = Object.keys(extraGrants).filter(function(k) { return k.toLowerCase() === username; })[0];
    (key ? extraGrants[key] : []).forEach(function(g) { set[g] = true; });
    return Object.keys(set);
}

// Every field name referenced anywhere in the ruleset, plus username always
// (needed for override/tier lookups even if no condition references it
// directly) — the client only ever sends this list, not every whoami field.
function computeRequiredFields(perms) {
    var fields = { username: true };
    function collect(conditions) {
        (conditions || []).forEach(function(c) {
            if (CANONICAL_FIELDS.indexOf(c.field) !== -1) fields[c.field] = true;
        });
    }
    (perms.blacklist || []).forEach(collect);
    (perms.allow || []).forEach(function(group) { collect(group.conditions); });
    return Object.keys(fields);
}

// ── Stateless short-lived signed tokens (HMAC-SHA256, no KV/storage) ──
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

// ── Handlers ──
async function handleBootstrap(env) {
    var perms = await loadPermissions(env);
    return json({
        maximoHosts: perms.maximoHosts || [],
        requiredFields: computeRequiredFields(perms),
    });
}

async function handleCheckAccess(request, env) {
    var body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ granted: false, error: 'bad request' }, 400);
    }
    var user = body.fields || {};
    var perms = await loadPermissions(env);
    var result = evaluateAccess(perms, user);
    if (!result.granted) return json({ granted: false });

    var token = await makeToken(env.TOKEN_SECRET, {
        grants: result.grants,
        exp: Date.now() + TOKEN_TTL_MS,
    });
    return json({ granted: true, grants: result.grants, token: token });
}

async function handleGetTool(request, env) {
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
    var src = await fetchPrivateFile(env, 'wo_tool.js', ref);
    return new Response(src, {
        status: 200,
        headers: Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, corsHeaders()),
    });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders() });
        }
        var url = new URL(request.url);
        try {
            if (url.pathname === '/bootstrap' && request.method === 'GET') {
                return await handleBootstrap(env);
            }
            if (url.pathname === '/check-access' && request.method === 'POST') {
                return await handleCheckAccess(request, env);
            }
            if (url.pathname === '/tool' && request.method === 'GET') {
                return await handleGetTool(request, env);
            }
            return json({ error: 'not found' }, 404);
        } catch (err) {
            return json({ error: 'server error', message: String(err && err.message || err) }, 500);
        }
    },
};
