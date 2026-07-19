// Black-box test of the REAL access-control/worker.js (not a reimplementation):
// mocks global.fetch (GitHub Contents API + Resend) and global.caches
// (Cloudflare edge cache) with an in-memory store, then drives the actual
// exported `fetch` handler with real Request objects — routing, auth,
// containment, per-bucket field checklists, the ancestor-prepend hardlock, the
// condition-based override/blacklist/allow/extraGrants shape, email-based
// accounts, the dual-mode Resend/temp-password flow, and the auto-admin-grant
// cross-reference all go through the genuine code, not a hand-copied model.
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, '..', 'access-control', 'worker.js');

const env = {
    GITHUB_OWNER: 'WilliamZitzmann',
    GITHUB_REPO: 'WO-Review-Tool-Private',
    GITHUB_PUBLIC_REPO: 'WO-Review-Tool',
    GITHUB_BRANCH: 'main',
    GITHUB_PAT: 'fake-pat',
    TOKEN_SECRET: 'fake-token-secret',
    ROOT_ADMIN_TOKEN: 'root-secret-token-abc123',
    ADMIN_SESSION_SECRET: 'fake-admin-session-secret',
    // RESEND_API_KEY / RESEND_FROM_EMAIL deliberately absent at first —
    // dual-mode fallback (temp password) is the default path; a later
    // section flips these on to exercise the emailed-link path.
};

// ── In-memory "GitHub" ──
const store = new Map(); // key: "owner/repo/path" -> { content: string, sha: string }
let shaCounter = 0;
function key(owner, repo, path) { return owner + '/' + repo + '/' + path; }
function seed(owner, repo, path, obj) {
    var content = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    store.set(key(owner, repo, path), { content: content, sha: 'sha' + (++shaCounter) });
}
function utf8ToBase64(str) {
    var bytes = Buffer.from(str, 'utf8');
    return bytes.toString('base64');
}
function base64ToUtf8(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
}

// ── In-memory "Resend" — captures the last email sent so a test can pull
// the setup-link token out of it (real emails never sent). ──
const sentEmails = [];
function lastEmailTo(addr) {
    for (var i = sentEmails.length - 1; i >= 0; i--) {
        if (sentEmails[i].to === addr) return sentEmails[i];
    }
    return null;
}
function extractSetTokenFromLink(html) {
    var m = /[?&]setToken=([^&"'<\s]+)/.exec(html);
    return m ? decodeURIComponent(m[1]) : null;
}

global.fetch = async function(url, opts) {
    opts = opts || {};
    var u = new URL(url);
    if (u.hostname === 'api.resend.com') {
        var body = JSON.parse(opts.body);
        sentEmails.push({ to: body.to[0], subject: body.subject, html: body.html });
        return { ok: true, status: 200, json: async () => ({ id: 'email_' + sentEmails.length }), text: async () => '' };
    }
    if (u.hostname !== 'api.github.com') throw new Error('unexpected fetch to ' + url);
    var m = /^\/repos\/([^/]+)\/([^/]+)\/(contents\/(.+)|issues)$/.exec(u.pathname);
    if (!m) throw new Error('unhandled github path ' + u.pathname);
    var owner = m[1], repo = m[2];
    if (m[3] === 'issues') {
        return { ok: true, status: 200, json: async () => ({ html_url: 'https://github.com/x/x/issues/1' }) };
    }
    var path = m[4];
    var k = key(owner, repo, path);
    var accept = (opts.headers && opts.headers['Accept']) || '';
    var method = (opts.method || 'GET').toUpperCase();

    if (method === 'GET') {
        var entry = store.get(k);
        if (!entry) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
        if (accept.indexOf('raw') !== -1) {
            return { ok: true, status: 200, text: async () => entry.content };
        }
        return { ok: true, status: 200, json: async () => ({ content: utf8ToBase64(entry.content), sha: entry.sha }) };
    }
    if (method === 'PUT') {
        var body2 = JSON.parse(opts.body);
        var existing = store.get(k);
        if (body2.sha && existing && body2.sha !== existing.sha) {
            return { ok: false, status: 409, json: async () => ({ message: 'sha mismatch' }) };
        }
        if (!body2.sha && existing) {
            return { ok: false, status: 409, json: async () => ({ message: 'file exists, sha required' }) };
        }
        var newSha = 'sha' + (++shaCounter);
        store.set(k, { content: base64ToUtf8(body2.content), sha: newSha });
        return { ok: true, status: 200, json: async () => ({ content: { sha: newSha } }) };
    }
    throw new Error('unhandled method ' + method);
};

// Minimal Cloudflare Cache API stub — regular-user path uses this; tests
// don't depend on caching behavior itself, just need it to not crash.
global.caches = { default: { match: async () => undefined, put: async () => {} } };

const worker = (await import(pathToFileURL(WORKER_PATH).href)).default;

async function call(method, path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var init = { method: method, headers: headers };
    if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
    }
    var req = new Request('https://fake-worker.internal' + path, init);
    var res = await worker.fetch(req, env, { waitUntil: () => {} });
    var text = await res.text();
    var body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: res.status, body: body, headers: res.headers };
}
function rootHeaders() { return { Authorization: 'Bearer ' + env.ROOT_ADMIN_TOKEN }; }
function bearerHeaders(t) { return { Authorization: 'Bearer ' + t }; }
async function login(email, password) {
    return call('POST', '/admin/login', { body: { email: email, password: password } });
}

// ── Old-shape adminGroups.json migration — a real account created BEFORE
// multi-group membership shipped is embedded inline in its group's
// members[] (no top-level accounts[]/memberIds[]), exactly like the live
// adminGroups.json this Worker still had on disk at the moment this
// feature deployed. Runs against a genuinely separate isolated
// owner/repo namespace (same in-memory store, different key prefix) so it
// can't disturb the main sequential flow's own adminGroups.json state. ──
async function testOldShapeMigration() {
    var env2 = Object.assign({}, env, { GITHUB_REPO: 'WO-Review-Tool-Private-migration-test' });
    // This test runs at the very end, after the Resend-configured section
    // has already flipped these on for the shared `env` object it was
    // copied from - strip them explicitly so account provisioning always
    // takes the temp-password path here, regardless of call order.
    delete env2.RESEND_API_KEY;
    delete env2.RESEND_FROM_EMAIL;
    async function call2(method, path, opts) {
        opts = opts || {};
        var headers = opts.headers || {};
        var init = { method: method, headers: headers };
        if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
        var req = new Request('https://fake-worker.internal' + path, init);
        var res = await worker.fetch(req, env2, { waitUntil: () => {} });
        var text = await res.text();
        var body = null;
        try { body = JSON.parse(text); } catch (e) { body = text; }
        return { status: res.status, body: body, headers: res.headers };
    }

    seed(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'buckets.json', {
        buckets: [{ id: 'legacy-co', parentId: null, label: 'Legacy Co', field: 'email', op: 'endsWith', value: '@legacy.example.com' }],
    });
    seed(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'permissions.json', {
        maximoHosts: [], override: [], blacklist: [], allow: [], extraGrants: [],
    });
    seed(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'adminGroups.json', { rootAccounts: [], groups: [] });

    // Build the account through the real API first (so it gets a real
    // PBKDF2 passwordHash, not a hand-rolled one), THEN rewrite the store's
    // JSON back into the old embedded-members shape to simulate "this
    // account predates the migration."
    var mkGroup = await call2('POST', '/admin/groups', {
        headers: { Authorization: 'Bearer ' + env2.ROOT_ADMIN_TOKEN },
        body: { bucketId: 'legacy-co', label: 'Legacy Co Admins', allowPeerAdminCreation: true, allowChildAdminCreation: false },
    });
    var legacyGroupId = mkGroup.body.group.id;
    var addMember = await call2('POST', '/admin/groups/' + legacyGroupId + '/members', {
        headers: { Authorization: 'Bearer ' + env2.ROOT_ADMIN_TOKEN },
        body: { email: 'legacy.admin@legacy.example.com', label: 'Legacy Admin' },
    });
    var legacyTempPassword = addMember.body.tempPassword;

    var currentDoc = JSON.parse(store.get(key(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'adminGroups.json')).content);
    var accountsById = {};
    (currentDoc.accounts || []).forEach(function(a) { accountsById[a.id] = a; });
    var oldShapeDoc = {
        rootAccounts: currentDoc.rootAccounts,
        groups: currentDoc.groups.map(function(g) {
            var old = Object.assign({}, g);
            old.members = (g.memberIds || []).map(function(id) { return accountsById[id]; }).filter(Boolean);
            delete old.memberIds;
            return old;
        }),
    };
    check('migration test setup: rewritten doc has the old embedded-members shape (no top-level accounts[])', oldShapeDoc.accounts === undefined && oldShapeDoc.groups[0].members.length === 1);
    seed(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'adminGroups.json', oldShapeDoc);

    // First real read of the old-shape file - this is the migration path's
    // actual first execution against genuinely old data.
    var legacyLogin = await call2('POST', '/admin/login', { body: { email: 'legacy.admin@legacy.example.com', password: legacyTempPassword } });
    check('old-shape account logs in successfully after migration', legacyLogin.status === 200, legacyLogin.body);
    check('...with the correct bucketIds carried over from its old embedded membership',
        Array.isArray(legacyLogin.body.bucketIds) && legacyLogin.body.bucketIds.length === 1 && legacyLogin.body.bucketIds[0] === 'legacy-co',
        legacyLogin.body.bucketIds);
    var legacyToken = legacyLogin.body.token;

    var legacyAction = await call2('POST', '/admin/permissions/allow', {
        headers: { Authorization: 'Bearer ' + legacyToken },
        body: { bucketId: 'legacy-co', ownConditions: [{ field: 'email', op: 'endsWith', value: '@legacy.example.com' }], grants: ['user'] },
    });
    check('old-shape account can act within its migrated scope (not locked out)', legacyAction.status === 200, legacyAction.body);

    // That write only touched permissions.json, not adminGroups.json - self-
    // healing happens on the next write TO adminGroups.json specifically
    // (loadAdminGroupsDoc migrates in-memory on every read, but nothing
    // persists it back to "disk" until something actually writes that
    // file). Trigger one (changing their own password) and confirm THAT
    // persists the migrated shape.
    var legacyChangePw = await call2('POST', '/admin/accounts/me/change-password', {
        headers: { Authorization: 'Bearer ' + legacyToken },
        body: { currentPassword: legacyTempPassword, newPassword: 'a-real-legacy-password-123' },
    });
    check('old-shape account can change its own password (a write to adminGroups.json)', legacyChangePw.status === 200, legacyChangePw.body);

    var persistedDoc = JSON.parse(store.get(key(env2.GITHUB_OWNER, env2.GITHUB_REPO, 'adminGroups.json')).content);
    check('...and THAT write leaves the on-disk file migrated to the new shape (self-healed, not just read-time)',
        Array.isArray(persistedDoc.accounts) && persistedDoc.accounts.length === 1 &&
        Array.isArray(persistedDoc.groups[0].memberIds) && persistedDoc.groups[0].members === undefined,
        persistedDoc);
}

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

// ── Seed initial data (mirrors the real live permissions.json shape post-
// migration + a small AVWP-style hierarchy). Note the override entry has a
// real conditions[] — a SEPARATE seed further down deliberately uses the
// OLD, pre-migration shape (missing conditions) to prove the vacuous-match
// fix, rather than mixing that into this main fixture. ──
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'permissions.json', {
    maximoHosts: [{ hostname: 'maximo.example.com', url: 'https://maximo.example.com/login' }],
    override: [{ id: 'ovr_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'ZITZMWX' }], grants: ['dev'] }],
    blacklist: [{ id: 'bla_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'JAMESXW' }] }],
    allow: [{ id: 'alw_seed', grants: ['user'], bucketId: null, conditions: [{ field: 'insertSite', op: 'eq', value: 'AVWP' }] }],
    extraGrants: [{ id: 'ext_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'ZITZMWX' }], grants: ['dev', 'beta_0'] }],
});
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'buckets.json', {
    buckets: [
        { id: 'abbvie', parentId: null, label: 'AbbVie', field: 'email', op: 'endsWith', value: '@abbvie.com' },
        // Contact set here (mid-tree, not company or site) specifically to
        // prove nearest-ancestor-wins: an AVWP match (no contact of its
        // own) must fall through to THIS one, not skip straight to
        // AbbVie's (which has none in this fixture).
        { id: 'abbvie-ie', parentId: 'abbvie', label: 'Ireland', field: 'country', op: 'eq', value: 'IE', contactEmail: 'ie-help@abbvie.com' },
        { id: 'abbvie-ie-avwp', parentId: 'abbvie-ie', label: 'AVWP', field: 'insertSite', op: 'eq', value: 'AVWP' },
    ],
});
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'adminGroups.json', { rootAccounts: [], groups: [] });
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'admin.html', '<html><body>admin shell</body></html>');

// Org configs (Phase E: wo_tool.js consuming /admin/configs) — one root
// config with NO conditions (matches literally everyone with a granted
// decision, the vacuous-true-is-intentional case) and one AVWP-scoped
// config carrying its full ancestor chain (email/country/insertSite).
// `country` is deliberately NOT referenced anywhere in the permissions.json
// seed above — its presence in /bootstrap's requiredFields can only come
// from computeConfigRequiredFields() scanning these config conditions.
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'configs/index.json', {
    configs: [
        { id: 'cfg_universal', name: 'Universal Defaults', description: 'Applies to everyone', bucketId: null, conditions: [] },
        {
            id: 'cfg_avwp', name: 'AVWP Maintenance', description: 'AVWP site defaults', bucketId: 'abbvie-ie-avwp',
            conditions: [
                { field: 'email', op: 'endsWith', value: '@abbvie.com' },
                { field: 'country', op: 'eq', value: 'IE' },
                { field: 'insertSite', op: 'eq', value: 'AVWP' },
            ],
        },
    ],
});
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'configs/cfg_universal.json', { rules: [{ id: 'r1' }], scan: {}, fields: {}, state: {}, vars: [] });
seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'configs/cfg_avwp.json', { rules: [{ id: 'r2' }], scan: {}, fields: {}, state: {}, vars: [] });
seed(env.GITHUB_OWNER, env.GITHUB_PUBLIC_REPO, 'version.json', {
    latest: '1.0.0', channels: { stable: '1.0.0', beta: '1.0.0' },
    versions: [{ version: '1.0.0', name: 'Initial', changes: [] }],
});

(async function main() {
    // ── Regular-user regression (blacklist-shape + condition-based
    // override/extraGrants didn't break the live path) ──
    var boot = await call('GET', '/bootstrap');
    check('bootstrap returns maximoHosts + requiredFields', boot.status === 200 && Array.isArray(boot.body.requiredFields), boot.body);

    var okUser = await call('POST', '/check-access', { body: { fields: { username: 'someuser', insertSite: 'AVWP' } } });
    check('allow rule grants access', okUser.body.granted === true && okUser.body.grants.includes('user'), okUser.body);

    var blockedUser = await call('POST', '/check-access', { body: { fields: { username: 'JAMESXW', insertSite: 'AVWP' } } });
    check('blacklist entry ({bucketId,conditions} shape) still blocks', blockedUser.body.granted === false, blockedUser.body);

    var deniedUser = await call('POST', '/check-access', { body: { fields: { username: 'randomguy', insertSite: 'ELSEWHERE' } } });
    check('non-matching user denied', deniedUser.body.granted === false, deniedUser.body);

    var overrideUser = await call('POST', '/check-access', { body: { fields: { username: 'ZITZMWX', insertSite: 'NOWHERE' } } });
    check('condition-based override + extraGrants merges correctly (dev + beta_0)',
        overrideUser.body.granted === true && overrideUser.body.grants.includes('dev') && overrideUser.body.grants.includes('beta_0'),
        overrideUser.body);

    // ── Org configs (Phase E: /bootstrap + /check-access resolving
    // /admin/configs entries for wo_tool.js's installer, and the new
    // /org-config-content batch fetch) ──
    check('bootstrap requiredFields includes "country" (only referenced by a config, not by any permissions.json rule)',
        boot.body.requiredFields.includes('country'), boot.body.requiredFields);

    var nonAvwpButGranted = await call('POST', '/check-access', {
        body: { fields: { username: 'ZITZMWX', email: 'zitzmwx@abbvie.com', country: 'US', insertSite: 'NOWHERE' } },
    });
    check('override-granted user outside the AVWP bucket only matches the universal (conditions-less) config, not the AVWP one',
        nonAvwpButGranted.body.granted === true &&
        nonAvwpButGranted.body.configs.length === 1 &&
        nonAvwpButGranted.body.configs[0].id === 'cfg_universal',
        nonAvwpButGranted.body.configs);

    var avwpUser = await call('POST', '/check-access', {
        body: { fields: { username: 'someuser', email: 'someuser@abbvie.com', country: 'IE', insertSite: 'AVWP' } },
    });
    var avwpConfigIds = (avwpUser.body.configs || []).map(function(c) { return c.id; }).sort();
    check('AVWP user matches BOTH the universal config and the AVWP-scoped config (every matching rule shows, not just the most specific)',
        avwpUser.body.granted === true && JSON.stringify(avwpConfigIds) === JSON.stringify(['cfg_avwp', 'cfg_universal']),
        avwpUser.body.configs);
    check('config summaries in /check-access do not leak admin-layer bucketId/conditions',
        avwpUser.body.configs.every(function(c) { return !('bucketId' in c) && !('conditions' in c); }),
        avwpUser.body.configs);

    var avwpConfigsById = {};
    avwpUser.body.configs.forEach(function(c) { avwpConfigsById[c.id] = c; });
    check('/check-access resolves a bucket-scoped config\'s label ("AVWP") so wo_tool.js can show "Name - Bucket"',
        avwpConfigsById.cfg_avwp && avwpConfigsById.cfg_avwp.bucket === 'AVWP', avwpConfigsById.cfg_avwp);
    check('...and a root-owned config (bucketId null) resolves bucket: null, not a stray label',
        avwpConfigsById.cfg_universal && avwpConfigsById.cfg_universal.bucket === null, avwpConfigsById.cfg_universal);

    var content = await call('GET', '/org-config-content?token=' + encodeURIComponent(avwpUser.body.token));
    var contentById = {};
    (content.body.configs || []).forEach(function(c) { contentById[c.id] = c; });
    check('/org-config-content returns full content for every matched config, using the same short-lived token',
        content.status === 200 &&
        contentById.cfg_universal && contentById.cfg_universal.content.rules[0].id === 'r1' &&
        contentById.cfg_avwp && contentById.cfg_avwp.content.rules[0].id === 'r2',
        content.body);
    check('/org-config-content ALSO resolves the same bucket label (installOrgConfig() stores its own name FROM this response, not /check-access\'s)',
        contentById.cfg_avwp && contentById.cfg_avwp.bucket === 'AVWP' && contentById.cfg_universal && contentById.cfg_universal.bucket === null,
        { avwp: contentById.cfg_avwp && contentById.cfg_avwp.bucket, universal: contentById.cfg_universal && contentById.cfg_universal.bucket });

    var contentNoMatches = await call('GET', '/org-config-content?token=' + encodeURIComponent(nonAvwpButGranted.body.token));
    check('/org-config-content for a token with only the universal config match returns exactly that one',
        contentNoMatches.body.configs.length === 1 && contentNoMatches.body.configs[0].id === 'cfg_universal',
        contentNoMatches.body);

    var contentBadToken = await call('GET', '/org-config-content?token=garbage');
    check('/org-config-content rejects an invalid token', contentBadToken.status === 403, contentBadToken.body);

    // ── Bucket-level contact email (nearest-ancestor-wins, resolved for
    // BOTH granted and denied /check-access results) ──
    check('granted AVWP user\'s contactEmail falls through to Ireland\'s (AVWP itself has none set)',
        avwpUser.body.contactEmail === 'ie-help@abbvie.com', avwpUser.body.contactEmail);

    var companyOnlyUser = await call('POST', '/check-access', {
        body: { fields: { username: 'randomguy', email: 'randomguy@abbvie.com', country: 'US', insertSite: 'ELSEWHERE' } },
    });
    check('a user matching only the company-level bucket (not Ireland) is NOT granted (no allow rule at that level)',
        companyOnlyUser.body.granted === false, companyOnlyUser.body);
    check('...but still resolves a contact email by walking up from wherever they DO structurally match — here, nothing set at all (AbbVie has no contact in this fixture) so it is null, not a crash',
        companyOnlyUser.body.contactEmail === null, companyOnlyUser.body.contactEmail);

    var noMatchAtAll = await call('POST', '/check-access', {
        body: { fields: { username: 'outsider', email: 'outsider@othercompany.com', country: 'US', insertSite: 'NOWHERE' } },
    });
    check('a whoami matching not even the top-level bucket is denied', noMatchAtAll.body.granted === false, noMatchAtAll.body);
    check('...and resolves no contact email at all (null, not undefined/error)', noMatchAtAll.body.contactEmail === null, noMatchAtAll.body.contactEmail);

    // ── THE VACUOUS-MATCH REGRESSION (the actual bug the pre-migration live
    // permissions.json would have hit under the new condition-based
    // evaluateAccess): an override entry with NO conditions field at all —
    // exactly the shape the real file had before this batch's migration —
    // must NEVER match everyone. evalGroup() must fail-closed on it. ──
    seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'permissions.json', {
        maximoHosts: [{ hostname: 'maximo.example.com', url: 'https://maximo.example.com/login' }],
        override: [{ username: 'ZITZMWX', grants: ['user'], bucketId: null }], // pre-migration shape, no conditions[]
        blacklist: [],
        allow: [],
        extraGrants: {},
    });
    var vacuousMatchAttempt = await call('POST', '/check-access', { body: { fields: { username: 'totally-unrelated-person' } } });
    check('a pre-migration override entry with no conditions[] does NOT match an unrelated user (fail-closed, not vacuous-true)',
        vacuousMatchAttempt.body.granted === false, vacuousMatchAttempt.body);
    var vacuousMatchAttempt2 = await call('POST', '/check-access', { body: { fields: { username: 'ZITZMWX' } } });
    check('...nor does it match the very username it was meant for, since the shape is unreadable to the new code (proves fail-closed, not a lucky pass)',
        vacuousMatchAttempt2.body.granted === false, vacuousMatchAttempt2.body);

    // A write attempting to STORE an entry with empty conditions must be
    // rejected outright by validatePermissionsShape, not merely tolerated
    // at read time.
    var emptyConditionsWrite = await call('POST', '/admin/permissions/allow', {
        headers: rootHeaders(), body: { bucketId: null, ownConditions: [], grants: ['user'] },
    });
    check('writing an allow rule with zero conditions is rejected (400), not silently stored as a vacuous match',
        emptyConditionsWrite.status === 400, emptyConditionsWrite.body);

    // Restore the real fixture for the rest of the suite.
    seed(env.GITHUB_OWNER, env.GITHUB_REPO, 'permissions.json', {
        maximoHosts: [{ hostname: 'maximo.example.com', url: 'https://maximo.example.com/login' }],
        override: [{ id: 'ovr_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'ZITZMWX' }], grants: ['dev'] }],
        blacklist: [{ id: 'bla_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'JAMESXW' }] }],
        allow: [{ id: 'alw_seed', grants: ['user'], bucketId: null, conditions: [{ field: 'insertSite', op: 'eq', value: 'AVWP' }] }],
        extraGrants: [{ id: 'ext_seed', bucketId: null, conditions: [{ field: 'username', op: 'eq', value: 'ZITZMWX' }], grants: ['dev', 'beta_0'] }],
    });

    // ── Admin shell ──
    var shell = await call('GET', '/admin');
    check('admin shell loads with no token, Cache-Control no-store', shell.status === 200 && shell.headers.get('Cache-Control') === 'no-store', shell.headers.get('Cache-Control'));

    // ── Auth ──
    var noAuth = await call('GET', '/admin/permissions');
    check('no token -> 401', noAuth.status === 401, noAuth.body);
    var badAuth = await call('GET', '/admin/permissions', { headers: bearerHeaders('garbage') });
    check('bad token -> 401', badAuth.status === 401, badAuth.body);

    var rootPerms = await call('GET', '/admin/permissions', { headers: rootHeaders() });
    check('root sees full permissions doc', rootPerms.status === 200 && rootPerms.body.role === 'root' && rootPerms.body.override.length === 1, rootPerms.body);

    // ── Buckets: root already created abbvie/abbvie-ie/abbvie-ie-avwp via
    // seed; GET must expose canonicalFields for admin.html's field picker ──
    var bucketsGet = await call('GET', '/admin/buckets', { headers: rootHeaders() });
    check('GET /admin/buckets returns canonicalFields for the field picker',
        bucketsGet.status === 200 && Array.isArray(bucketsGet.body.canonicalFields) && bucketsGet.body.canonicalFields.includes('insertSite'),
        bucketsGet.body.canonicalFields);

    var mkWorkgroup = await call('POST', '/admin/buckets', {
        headers: rootHeaders(),
        body: { parentId: 'abbvie-ie-avwp', label: 'Maintenance', field: 'workgroup', op: 'eq', value: 'Maintenance' },
    });
    check('root creates workgroup bucket', mkWorkgroup.status === 200 && mkWorkgroup.body.bucket.id, mkWorkgroup.body);
    var workgroupId = mkWorkgroup.body.bucket && mkWorkgroup.body.bucket.id;

    // ── Bucket contactEmail: create/patch validation + nearest-ancestor
    // resolution actually preferring the CLOSEST set contact, not always
    // falling all the way to Ireland's ──
    var badContactCreate = await call('POST', '/admin/buckets', {
        headers: rootHeaders(),
        body: { parentId: 'abbvie-ie-avwp', label: 'Bad Contact', field: 'workgroup', op: 'eq', value: 'BadContact', contactEmail: 'not-an-email' },
    });
    check('creating a bucket with an invalid contactEmail is rejected', badContactCreate.status === 400, badContactCreate.body);

    var patchContact = await call('PATCH', '/admin/buckets/' + workgroupId, {
        headers: rootHeaders(), body: { contactEmail: 'maint-lead@abbvie.com' },
    });
    check('root sets a valid contactEmail on the workgroup bucket via PATCH', patchContact.status === 200 && patchContact.body.bucket.contactEmail === 'maint-lead@abbvie.com', patchContact.body);

    var badContactPatch = await call('PATCH', '/admin/buckets/' + workgroupId, {
        headers: rootHeaders(), body: { contactEmail: 'nope' },
    });
    check('patching an invalid contactEmail is rejected', badContactPatch.status === 400, badContactPatch.body);

    var workgroupUser = await call('POST', '/check-access', {
        body: { fields: { username: 'maintguy', email: 'maintguy@abbvie.com', country: 'IE', insertSite: 'AVWP', workgroup: 'Maintenance' } },
    });
    check('a whoami matching the workgroup bucket gets ITS OWN contact, not Ireland\'s (nearest match wins, not always the topmost with one set)',
        workgroupUser.body.contactEmail === 'maint-lead@abbvie.com', workgroupUser.body.contactEmail);

    // ── Admin groups: root creates an AVWP-scoped group + member (email-based) ──
    var mkGroup = await call('POST', '/admin/groups', {
        headers: rootHeaders(),
        body: { bucketId: 'abbvie-ie-avwp', label: 'AVWP Admins', allowPeerAdminCreation: true, allowChildAdminCreation: true },
    });
    check('root creates admin group at AVWP', mkGroup.status === 200, mkGroup.body);
    var avwpGroupId = mkGroup.body.group && mkGroup.body.group.id;

    var addMember = await call('POST', '/admin/groups/' + avwpGroupId + '/members', {
        headers: rootHeaders(), body: { email: 'avwplead@abbvie.com', label: 'AVWP Lead' },
    });
    check('root adds account by email, plaintext temp password returned once (Resend not configured)',
        addMember.status === 200 && typeof addMember.body.tempPassword === 'string' && addMember.body.member.email === 'avwplead@abbvie.com',
        addMember.body);
    var avwpTempPassword = addMember.body.tempPassword;

    var groupsGetAfterAdd = await call('GET', '/admin/groups', { headers: rootHeaders() });
    var avwpGroupFromGet = groupsGetAfterAdd.body.groups.find(function(g) { return g.id === avwpGroupId; });
    check('GET /admin/groups returns member.email (not member.username, a stale field from the pre-rename shape)',
        !!avwpGroupFromGet && avwpGroupFromGet.members[0] && avwpGroupFromGet.members[0].email === 'avwplead@abbvie.com' && avwpGroupFromGet.members[0].username === undefined,
        avwpGroupFromGet);

    var dupeEmail = await call('POST', '/admin/groups/' + avwpGroupId + '/members', {
        headers: rootHeaders(), body: { email: 'avwplead@abbvie.com', label: 'Dupe' },
    });
    check('adding a second account with an already-taken email is rejected (409)', dupeEmail.status === 409, dupeEmail.body);

    var invalidEmail = await call('POST', '/admin/groups/' + avwpGroupId + '/members', {
        headers: rootHeaders(), body: { email: 'not-an-email', label: 'Bad' },
    });
    check('adding an account with an invalid email is rejected (400)', invalidEmail.status === 400, invalidEmail.body);

    var renameGroup = await call('PATCH', '/admin/groups/' + avwpGroupId, {
        headers: rootHeaders(), body: { label: 'AVWP Admins (renamed)' },
    });
    check('root renames the group via PATCH', renameGroup.status === 200 && renameGroup.body.group.label === 'AVWP Admins (renamed)', renameGroup.body);
    var groupsGetAfterRename = await call('GET', '/admin/groups', { headers: rootHeaders() });
    check('rename is reflected on the next GET', groupsGetAfterRename.body.groups.some(function(g) { return g.id === avwpGroupId && g.label === 'AVWP Admins (renamed)'; }), groupsGetAfterRename.body.groups);

    var renameEmptyLabel = await call('PATCH', '/admin/groups/' + avwpGroupId, {
        headers: rootHeaders(), body: { label: '   ' },
    });
    check('renaming to a blank label is rejected (400)', renameEmptyLabel.status === 400, renameEmptyLabel.body);

    var avwpLoginWrongPw = await login('avwplead@abbvie.com', 'totally-wrong-password');
    check('login with wrong password is rejected', avwpLoginWrongPw.status === 401, avwpLoginWrongPw.body);

    var avwpLogin = await login('avwplead@abbvie.com', avwpTempPassword);
    check('login with the temp password succeeds, returns a session token + mustChangePassword', avwpLogin.status === 200 && typeof avwpLogin.body.token === 'string' && avwpLogin.body.mustChangePassword === true, avwpLogin.body);
    var avwpToken = avwpLogin.body.token;

    var badChange = await call('POST', '/admin/accounts/me/change-password', {
        headers: bearerHeaders(avwpToken), body: { currentPassword: 'wrong', newPassword: 'a-real-new-password-123' },
    });
    check('changing password with the wrong current password is rejected', badChange.status === 401, badChange.body);

    var goodChange = await call('POST', '/admin/accounts/me/change-password', {
        headers: bearerHeaders(avwpToken), body: { currentPassword: avwpTempPassword, newPassword: 'a-real-new-password-123' },
    });
    check('changing password with the correct current password succeeds', goodChange.status === 200, goodChange.body);

    var oldPasswordLoginFails = await login('avwplead@abbvie.com', avwpTempPassword);
    check('the old temp password no longer works after changing it', oldPasswordLoginFails.status === 401, oldPasswordLoginFails.body);

    var newPasswordLogin = await login('avwplead@abbvie.com', 'a-real-new-password-123');
    check('the new password logs in, mustChangePassword now false', newPasswordLogin.status === 200 && newPasswordLogin.body.mustChangePassword === false, newPasswordLogin.body);
    avwpToken = newPasswordLogin.body.token;

    // ── Scoped admin identity checks ──
    var scopedPerms = await call('GET', '/admin/permissions', { headers: bearerHeaders(avwpToken) });
    check('scoped admin sees filtered permissions (no override/extraGrants content)', scopedPerms.status === 200 && scopedPerms.body.role === 'scoped' && scopedPerms.body.override === undefined, scopedPerms.body);
    check('scoped admin allow list excludes root-owned entry', Array.isArray(scopedPerms.body.allow) && scopedPerms.body.allow.length === 0, scopedPerms.body.allow);

    var scopedOverrideAttempt = await call('POST', '/admin/permissions/override', {
        headers: bearerHeaders(avwpToken), body: { bucketId: null, ownConditions: [{ field: 'username', op: 'eq', value: 'sneaky' }], grants: ['dev'] },
    });
    check('scoped admin cannot touch override', scopedOverrideAttempt.status === 403, scopedOverrideAttempt.body);

    var scopedRenamesOwnGroup = await call('PATCH', '/admin/groups/' + avwpGroupId, {
        headers: bearerHeaders(avwpToken), body: { label: 'AVWP Admins (self-renamed)' },
    });
    check('scoped admin CAN rename their own group', scopedRenamesOwnGroup.status === 200 && scopedRenamesOwnGroup.body.group.label === 'AVWP Admins (self-renamed)', scopedRenamesOwnGroup.body);

    var scopedExtraGrantsAttempt = await call('POST', '/admin/permissions/extraGrants', {
        headers: bearerHeaders(avwpToken), body: { bucketId: null, ownConditions: [{ field: 'username', op: 'eq', value: 'sneaky' }], grants: ['dev'] },
    });
    check('scoped admin cannot touch extraGrants', scopedExtraGrantsAttempt.status === 403, scopedExtraGrantsAttempt.body);

    // ── Non-root grants filtering: a scoped admin submitting a special
    // grant (dev) on an allow rule gets silently filtered down to ["user"] ──
    var scopedSpecialGrantAttempt = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: 'abbvie-ie-avwp', ownConditions: [{ field: 'insertSite', op: 'eq', value: 'AVWP2' }], grants: ['dev', 'user'] },
    });
    check('non-root admin\'s allow rule requesting a special grant (dev) is filtered down to just ["user"]',
        scopedSpecialGrantAttempt.status === 200 && Array.isArray(scopedSpecialGrantAttempt.body.entry.grants) &&
        scopedSpecialGrantAttempt.body.entry.grants.length === 1 && scopedSpecialGrantAttempt.body.entry.grants[0] === 'user',
        scopedSpecialGrantAttempt.body);
    var filteredGrantEntryId = scopedSpecialGrantAttempt.body.entry && scopedSpecialGrantAttempt.body.entry.id;

    // ── Edit: re-submitting with the same id updates in place, doesn't
    // create a duplicate entry ──
    var editAttempt = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { id: filteredGrantEntryId, bucketId: 'abbvie-ie-avwp', ownConditions: [{ field: 'insertSite', op: 'eq', value: 'AVWP3' }], grants: ['user'] },
    });
    check('editing (POST with an existing id) succeeds and keeps the same id', editAttempt.status === 200 && editAttempt.body.entry.id === filteredGrantEntryId, editAttempt.body);
    var permsAfterEdit = await call('GET', '/admin/permissions', { headers: rootHeaders() });
    var matchingIdCount = permsAfterEdit.body.allow.filter(function(e) { return e.id === filteredGrantEntryId; }).length;
    check('edit did not create a duplicate entry (exactly one entry with that id)', matchingIdCount === 1, permsAfterEdit.body.allow);
    var editedEntry = permsAfterEdit.body.allow.find(function(e) { return e.id === filteredGrantEntryId; });
    check('edit actually changed the own-condition value (AVWP2 -> AVWP3)',
        !!editedEntry && editedEntry.conditions[editedEntry.conditions.length - 1].value === 'AVWP3', editedEntry && editedEntry.conditions);

    // Clean up that scratch entry so it doesn't interfere with later counts.
    await call('DELETE', '/admin/permissions/allow/' + filteredGrantEntryId, { headers: rootHeaders() });

    // ── THE HARDLOCK ──
    var scopedAllow = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: workgroupId, ownConditions: [{ field: 'badgeType', op: 'eq', value: 'contractor' }], grants: ['user'] },
    });
    check('scoped admin can create an allow rule at their own bucket', scopedAllow.status === 200, scopedAllow.body);
    var storedConditions = scopedAllow.body.entry && scopedAllow.body.entry.conditions;
    check('hardlock: stored conditions include the full ancestor chain (incl. the bucket\'s own condition), not just the submitted one',
        Array.isArray(storedConditions) && storedConditions.length === 5 &&
        storedConditions[0].field === 'email' && storedConditions[0].value === '@abbvie.com' &&
        storedConditions[1].field === 'country' && storedConditions[1].value === 'IE' &&
        storedConditions[2].field === 'insertSite' && storedConditions[2].value === 'AVWP' &&
        storedConditions[3].field === 'workgroup' && storedConditions[3].value === 'Maintenance' &&
        storedConditions[4].field === 'badgeType' && storedConditions[4].value === 'contractor',
        storedConditions);

    var outsideBranchUser = await call('POST', '/check-access', {
        body: { fields: { username: 'contractor1', badgeType: 'contractor', email: 'x@other.com', country: 'US', insertSite: 'OTHER' } },
    });
    check('a user matching ONLY the scoped admin\'s own condition (not the ancestor chain) is NOT granted by that rule',
        outsideBranchUser.body.granted === false, outsideBranchUser.body);

    var insideBranchUser = await call('POST', '/check-access', {
        body: { fields: { username: 'contractor2', badgeType: 'contractor', email: 'x@abbvie.com', country: 'IE', insertSite: 'AVWP', workgroup: 'Maintenance' } },
    });
    check('a user matching the FULL ancestor chain + the scoped condition IS granted',
        insideBranchUser.body.granted === true, insideBranchUser.body);

    // ── Per-bucket field checklist (allowedFields) ──
    // Absent/null allowedFields = every field usable by that bucket's own
    // admin tier (backward-compatible default, so existing buckets keep
    // working unchanged on deploy) - the AVWP bucket has no checklist set
    // yet, so the scoped admin can freely author with ANY field, including
    // one that would have been "senior-only" under the old global
    // fieldLevels model.
    var fieldDefaultOpen = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: workgroupId, ownConditions: [{ field: 'country', op: 'eq', value: 'IE' }], grants: ['user'] },
    });
    check('with no allowedFields checklist set, scoped admin can author a rule using any field (permissive default)', fieldDefaultOpen.status === 200, fieldDefaultOpen.body);
    await call('DELETE', '/admin/permissions/allow/' + (fieldDefaultOpen.body.entry && fieldDefaultOpen.body.entry.id), { headers: rootHeaders() });

    // Bucket CRUD (incl. its own field checklist) is strictly-below, never
    // AT, the acting admin's own node - so only a strictly-senior admin
    // (an ancestor, or root) can narrow/widen what a given tier may use;
    // a scoped admin can never self-escalate their own checklist.
    var restrictAvwpFields = await call('PATCH', '/admin/buckets/abbvie-ie-avwp', {
        headers: rootHeaders(), body: { allowedFields: ['insertSite', 'workgroup', 'badgeType'] },
    });
    check('root restricts the AVWP bucket\'s field checklist (country deliberately excluded)',
        restrictAvwpFields.status === 200 && Array.isArray(restrictAvwpFields.body.bucket.allowedFields), restrictAvwpFields.body);

    var fieldViolation = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: workgroupId, ownConditions: [{ field: 'country', op: 'eq', value: 'IE' }], grants: ['user'] },
    });
    check('scoped admin cannot author a rule using a field NOT in their own bucket\'s checklist', fieldViolation.status === 403, fieldViolation.body);

    var fieldStillAllowed = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: workgroupId, ownConditions: [{ field: 'badgeType', op: 'eq', value: 'contractor2' }], grants: ['user'] },
    });
    check('...but a field that IS in the checklist still works', fieldStillAllowed.status === 200, fieldStillAllowed.body);
    await call('DELETE', '/admin/permissions/allow/' + (fieldStillAllowed.body.entry && fieldStillAllowed.body.entry.id), { headers: rootHeaders() });

    var scopedRestrictsOwnBucket = await call('PATCH', '/admin/buckets/abbvie-ie-avwp', {
        headers: bearerHeaders(avwpToken), body: { allowedFields: [] },
    });
    check('scoped admin cannot edit their OWN bucket (incl. its field checklist) - bucket CRUD is strictly below, not at, their own node',
        scopedRestrictsOwnBucket.status === 403, scopedRestrictsOwnBucket.body);

    var clearAvwpFields = await call('PATCH', '/admin/buckets/abbvie-ie-avwp', {
        headers: rootHeaders(), body: { allowedFields: null },
    });
    check('root clears the checklist back to "all fields allowed"',
        clearAvwpFields.status === 200 && clearAvwpFields.body.bucket.allowedFields === null, clearAvwpFields.body);

    // ── Delegation: peer vs child creation ──
    var mkChildGroup = await call('POST', '/admin/groups', {
        headers: bearerHeaders(avwpToken),
        body: { bucketId: workgroupId, label: 'Maintenance Admins', allowPeerAdminCreation: false, allowChildAdminCreation: false },
    });
    check('AVWP admin (allowChildAdminCreation=true) can create a child group at the workgroup bucket', mkChildGroup.status === 200, mkChildGroup.body);
    var maintGroupId = mkChildGroup.body.group && mkChildGroup.body.group.id;

    var addMaintMember = await call('POST', '/admin/groups/' + maintGroupId + '/members', {
        headers: rootHeaders(), body: { email: 'mainttech@abbvie.com', label: 'Maint Tech' },
    });
    var maintLogin = await login('mainttech@abbvie.com', addMaintMember.body.tempPassword);
    var maintToken = maintLogin.body.token;

    var maintTriesChildGroup = await call('POST', '/admin/groups', {
        headers: bearerHeaders(maintToken),
        body: { bucketId: workgroupId, label: 'Sub', allowPeerAdminCreation: false, allowChildAdminCreation: false },
    });
    check('maintenance admin (allowChildAdminCreation=false) cannot create groups', maintTriesChildGroup.status === 403, maintTriesChildGroup.body);

    var maintTriesAddToOwnGroup = await call('POST', '/admin/groups/' + maintGroupId + '/members', {
        headers: bearerHeaders(maintToken), body: { email: 'peer1@abbvie.com', label: 'Peer' },
    });
    check('maintenance admin (allowPeerAdminCreation=false) cannot add a peer to own group', maintTriesAddToOwnGroup.status === 403, maintTriesAddToOwnGroup.body);

    var maintTriesAddToOtherGroup = await call('POST', '/admin/groups/' + avwpGroupId + '/members', {
        headers: bearerHeaders(maintToken), body: { email: 'sneaky1@abbvie.com', label: 'Sneaky' },
    });
    check('maintenance admin cannot add a member to a DIFFERENT (not their own) group even if in scope', maintTriesAddToOtherGroup.status === 403, maintTriesAddToOtherGroup.body);

    // ── Auto-admin-grant cross-reference: mainttech@abbvie.com is now a
    // real admin account (added above). A regular whoami check-access for
    // that same email, matching an ordinary allow rule, should come back
    // with 'admin' ADDED on top — but only because they already have an
    // admin account, never as a standalone grant. ──
    var maintWhoami = await call('POST', '/check-access', {
        body: { fields: { username: 'whoevermainttechis', email: 'mainttech@abbvie.com', insertSite: 'AVWP' } },
    });
    check('a regular tool user whose whoami email matches an admin account gets "admin" added to their grants',
        maintWhoami.body.granted === true && maintWhoami.body.grants.includes('admin') && maintWhoami.body.grants.includes('user'),
        maintWhoami.body);
    var nonAdminWhoami = await call('POST', '/check-access', {
        body: { fields: { username: 'someoneelse', email: 'not-an-admin@abbvie.com', insertSite: 'AVWP' } },
    });
    check('an ordinary user whose email does NOT match any admin account does NOT get "admin"',
        nonAdminWhoami.body.granted === true && !nonAdminWhoami.body.grants.includes('admin'), nonAdminWhoami.body);

    // ── Revocation: any admin at-or-above can revoke, even without peer rights ──
    var revoke = await call('DELETE', '/admin/groups/' + maintGroupId + '/members/' + addMaintMember.body.member.id, { headers: bearerHeaders(avwpToken) });
    check('AVWP admin can revoke a member of a descendant group', revoke.status === 200, revoke.body);

    // ── Config management (admin-side blob storage, same shape as
    // wo_tool.js's Export/Import, condition-based targeting reusing the
    // exact permissions hardlock machinery) ──
    var sampleBlob = { rules: { groups: [] }, scan: {}, fields: {}, state: {}, vars: {} };
    var mkConfigAsScoped = await call('POST', '/admin/configs', {
        headers: bearerHeaders(avwpToken),
        body: { name: 'AVWP Default', description: 'baseline for AVWP', bucketId: 'abbvie-ie-avwp', ownConditions: [], content: sampleBlob },
    });
    check('scoped (AVWP) admin can create a config at their own bucket with NO extra conditions (unlike permissions, blank is allowed)',
        mkConfigAsScoped.status === 200 && mkConfigAsScoped.body.config.id, mkConfigAsScoped.body);
    var avwpConfigId = mkConfigAsScoped.body.config && mkConfigAsScoped.body.config.id;
    check('hardlock applies to configs too: stored conditions include the ancestor chain even though ownConditions was empty',
        avwpConfigId && mkConfigAsScoped.body.config.conditions.length === 3 &&
        mkConfigAsScoped.body.config.conditions[2].field === 'insertSite' && mkConfigAsScoped.body.config.conditions[2].value === 'AVWP',
        mkConfigAsScoped.body.config.conditions);

    var mkConfigOutOfScope = await call('POST', '/admin/configs', {
        headers: bearerHeaders(avwpToken),
        body: { name: 'Sneaky', bucketId: null, ownConditions: [], content: sampleBlob },
    });
    check('scoped admin cannot create a config at root/outside their bucket', mkConfigOutOfScope.status === 403, mkConfigOutOfScope.body);

    var mkConfigBadJson = await call('POST', '/admin/configs', {
        headers: rootHeaders(), body: { name: 'Broken', bucketId: null, ownConditions: [], content: '{not valid json' },
    });
    check('creating a config with unparseable content is rejected (400)', mkConfigBadJson.status === 400, mkConfigBadJson.body);

    var mkConfigRoot = await call('POST', '/admin/configs', {
        headers: rootHeaders(), body: { name: 'Company Default', bucketId: 'abbvie', ownConditions: [], content: { rules: { groups: [{ id: 'g1' }] } } },
    });
    check('root creates a company-level config', mkConfigRoot.status === 200, mkConfigRoot.body);
    var companyConfigId = mkConfigRoot.body.config.id;

    var listAsScoped = await call('GET', '/admin/configs', { headers: bearerHeaders(avwpToken) });
    check('scoped admin only sees configs at-or-below their own bucket (their own, not the company-level one)',
        listAsScoped.status === 200 && listAsScoped.body.configs.some(function(c) { return c.id === avwpConfigId; }) &&
        !listAsScoped.body.configs.some(function(c) { return c.id === companyConfigId; }), listAsScoped.body.configs);

    var listAsRoot = await call('GET', '/admin/configs', { headers: rootHeaders() });
    check('root sees every config', listAsRoot.status === 200 &&
        listAsRoot.body.configs.some(function(c) { return c.id === avwpConfigId; }) &&
        listAsRoot.body.configs.some(function(c) { return c.id === companyConfigId; }), listAsRoot.body.configs);

    var downloadOutOfScope = await call('GET', '/admin/configs/' + companyConfigId, { headers: bearerHeaders(avwpToken) });
    check('scoped admin cannot download a config outside their scope', downloadOutOfScope.status === 403, downloadOutOfScope.body);

    // ── Buckets deliberately DON'T follow the configs/permissions/groups
    // visibility pattern above — GET /admin/buckets returns the FULL tree
    // to every admin (scoped admins need their own branch's ancestors for
    // orientation), while every WRITE endpoint still independently
    // enforces containment. Visibility widened, authorization didn't. ──
    var bucketsAsScoped = await call('GET', '/admin/buckets', { headers: bearerHeaders(avwpToken) });
    check('a scoped (AVWP) admin\'s GET /admin/buckets includes its OWN bucket',
        bucketsAsScoped.status === 200 && bucketsAsScoped.body.buckets.some(function(b) { return b.id === 'abbvie-ie-avwp'; }),
        bucketsAsScoped.body.buckets && bucketsAsScoped.body.buckets.map(function(b) { return b.id; }));
    check('...AND buckets ABOVE it (ancestors it does not control) — the actual behavior change',
        bucketsAsScoped.body.buckets.some(function(b) { return b.id === 'abbvie'; }) &&
        bucketsAsScoped.body.buckets.some(function(b) { return b.id === 'abbvie-ie'; }),
        bucketsAsScoped.body.buckets && bucketsAsScoped.body.buckets.map(function(b) { return b.id; }));
    check('...matches what root sees (same full tree, not a partial one)',
        bucketsAsScoped.body.buckets.length === bucketsGet.body.buckets.length +
            (mkWorkgroup.body.bucket ? 1 : 0), // +1 for the workgroup bucket created after bucketsGet was captured
        { scoped: bucketsAsScoped.body.buckets.length, root: bucketsGet.body.buckets.length });

    var scopedEditsAncestor = await call('PATCH', '/admin/buckets/abbvie-ie', {
        headers: bearerHeaders(avwpToken), body: { label: 'Hijacked' },
    });
    check('but a scoped admin still CANNOT edit an ancestor bucket it can now merely see', scopedEditsAncestor.status === 403, scopedEditsAncestor.body);

    var scopedDeletesAncestor = await call('DELETE', '/admin/buckets/abbvie-ie', { headers: bearerHeaders(avwpToken) });
    check('...nor delete one', scopedDeletesAncestor.status === 403, scopedDeletesAncestor.body);

    var downloadOwn = await call('GET', '/admin/configs/' + avwpConfigId, { headers: bearerHeaders(avwpToken) });
    check('scoped admin can download their own config, gets the exact content back', downloadOwn.status === 200 &&
        JSON.stringify(downloadOwn.body.content) === JSON.stringify(sampleBlob), downloadOwn.body);

    var renamed = await call('PATCH', '/admin/configs/' + avwpConfigId, { headers: bearerHeaders(avwpToken), body: { name: 'AVWP Default (renamed)' } });
    check('scoped admin can rename their own config', renamed.status === 200 && renamed.body.config.name === 'AVWP Default (renamed)', renamed.body);

    var contentReplaced = await call('PATCH', '/admin/configs/' + avwpConfigId, {
        headers: bearerHeaders(avwpToken), body: { content: { rules: { groups: [{ id: 'updated' }] } } },
    });
    check('scoped admin can replace their own config\'s content', contentReplaced.status === 200, contentReplaced.body);
    var downloadAfterReplace = await call('GET', '/admin/configs/' + avwpConfigId, { headers: bearerHeaders(avwpToken) });
    check('downloaded content reflects the replacement', downloadAfterReplace.body.content.rules.groups[0].id === 'updated', downloadAfterReplace.body);

    var dupOutOfScopeSource = await call('POST', '/admin/configs/' + companyConfigId + '/duplicate', {
        headers: bearerHeaders(avwpToken), body: { name: 'Escape attempt', bucketId: 'abbvie-ie-avwp', ownConditions: [] },
    });
    check('scoped admin cannot duplicate a config whose SOURCE is outside their scope (an ancestor bucket they can\'t see into)',
        dupOutOfScopeSource.status === 403, dupOutOfScopeSource.body);

    var dup = await call('POST', '/admin/configs/' + avwpConfigId + '/duplicate', {
        headers: bearerHeaders(avwpToken), body: { name: 'AVWP Default (copy)', bucketId: 'abbvie-ie-avwp', ownConditions: [] },
    });
    check('scoped admin CAN duplicate one of their OWN (in-scope) configs — "site admin duplicates an existing config" use case',
        dup.status === 200 && dup.body.config.bucketId === 'abbvie-ie-avwp', dup.body);
    var dupId = dup.body.config && dup.body.config.id;
    var dupContent = await call('GET', '/admin/configs/' + dupId, { headers: bearerHeaders(avwpToken) });
    check('duplicated config has the SOURCE\'s content, independent copy (not a reference)',
        dupContent.status === 200 && JSON.stringify(dupContent.body.content) === JSON.stringify({ rules: { groups: [{ id: 'updated' }] } }), dupContent.body);

    var dupOutOfScopeTarget = await call('POST', '/admin/configs/' + avwpConfigId + '/duplicate', {
        headers: bearerHeaders(avwpToken), body: { name: 'Escape attempt 2', bucketId: 'abbvie', ownConditions: [] },
    });
    check('scoped admin cannot duplicate INTO a bucket outside their scope', dupOutOfScopeTarget.status === 403, dupOutOfScopeTarget.body);

    var rootDup = await call('POST', '/admin/configs/' + companyConfigId + '/duplicate', {
        headers: rootHeaders(), body: { name: 'Root copy down to AVWP', bucketId: 'abbvie-ie-avwp', ownConditions: [] },
    });
    check('root CAN duplicate a company-level config down into a site bucket (root has no scope restriction)', rootDup.status === 200, rootDup.body);

    var delOutOfScope = await call('DELETE', '/admin/configs/' + companyConfigId, { headers: bearerHeaders(avwpToken) });
    check('scoped admin cannot delete a config outside their scope', delOutOfScope.status === 403, delOutOfScope.body);

    var delOwn = await call('DELETE', '/admin/configs/' + dupId, { headers: bearerHeaders(avwpToken) });
    check('scoped admin can delete their own config', delOwn.status === 200, delOwn.body);
    var listAfterDelete = await call('GET', '/admin/configs', { headers: rootHeaders() });
    check('deleted config no longer appears in the list', !listAfterDelete.body.configs.some(function(c) { return c.id === dupId; }), listAfterDelete.body.configs);

    // ── Version.json (root-only) ──
    var scopedVersionAttempt = await call('GET', '/admin/version', { headers: bearerHeaders(avwpToken) });
    check('scoped admin cannot access version.json', scopedVersionAttempt.status === 403, scopedVersionAttempt.body);

    var rootVersionGet = await call('GET', '/admin/version', { headers: rootHeaders() });
    check('root can read version.json', rootVersionGet.status === 200 && rootVersionGet.body.doc.latest === '1.0.0', rootVersionGet.body);

    var badVersionPost = await call('POST', '/admin/version', {
        headers: rootHeaders(),
        body: { doc: { latest: '9.9.9', channels: { stable: '1.0.0' }, versions: [{ version: '1.0.0', name: 'x', changes: [] }] } },
    });
    check('version.json write rejects "latest" pointing at an unknown version', badVersionPost.status === 400, badVersionPost.body);

    var goodVersionPost = await call('POST', '/admin/version', {
        headers: rootHeaders(),
        body: { doc: { latest: '1.0.0', channels: { stable: '1.0.0', beta: '1.0.0' }, versions: [{ version: '1.0.0', name: 'Initial', changes: [] }] } },
    });
    check('valid version.json write succeeds', goodVersionPost.status === 200, goodVersionPost.body);

    // ── Bucket delete: refuse if children exist, cascade removes subtree + grants ──
    var deleteNoCascade = await call('DELETE', '/admin/buckets/abbvie-ie-avwp', { headers: rootHeaders() });
    check('deleting a bucket with children (workgroup) refuses without cascade', deleteNoCascade.status === 409, deleteNoCascade.body);

    var deleteCascade = await call('DELETE', '/admin/buckets/abbvie-ie-avwp?cascade=true', { headers: rootHeaders() });
    check('cascade delete succeeds', deleteCascade.status === 200, deleteCascade.body);

    var permsAfterCascade = await call('GET', '/admin/permissions', { headers: rootHeaders() });
    var orphanRemains = permsAfterCascade.body.allow.some(function(e) { return e.bucketId === workgroupId; });
    check('cascade delete also removed the grant entry that referenced the deleted bucket', !orphanRemains, permsAfterCascade.body.allow);

    // Under multi-group membership, deleting a group no longer deletes the
    // ACCOUNT (it may still belong to other groups) - so the account still
    // resolves and logs in, just with zero remaining scope. That's still
    // safe: bucketIds is empty, which fails every containment check
    // closed, so a genuinely orphaned account can reach nothing.
    var revokedTokenStillResolves = await call('GET', '/admin/permissions', { headers: bearerHeaders(avwpToken) });
    check('admin whose only group was cascade-deleted still resolves (may belong to others) but with zero scope',
        revokedTokenStillResolves.status === 200 && revokedTokenStillResolves.body.role === 'scoped' &&
        Array.isArray(revokedTokenStillResolves.body.bucketIds) && revokedTokenStillResolves.body.bucketIds.length === 0,
        revokedTokenStillResolves.body);
    var revokedTokenCannotAct = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(avwpToken), body: { bucketId: null, ownConditions: [{ field: 'username', op: 'eq', value: 'x' }], grants: ['user'] },
    });
    check('...and that empty scope still fails closed on writes (403, not a free pass)', revokedTokenCannotAct.status === 403, revokedTokenCannotAct.body);

    // ── Root accounts (email/password alternative to ROOT_ADMIN_TOKEN) ──
    var mkRootAcct = await call('POST', '/admin/root-accounts', { headers: rootHeaders(), body: { email: 'william@example.com', label: 'William' } });
    check('root (via break-glass token) creates a root account by email', mkRootAcct.status === 200 && typeof mkRootAcct.body.tempPassword === 'string', mkRootAcct.body);

    var rootAcctLogin = await login('william@example.com', mkRootAcct.body.tempPassword);
    check('root account logs in with its temp password, gets full root role', rootAcctLogin.status === 200 && rootAcctLogin.body.role === 'root' && rootAcctLogin.body.level === 0, rootAcctLogin.body);
    var williamToken = rootAcctLogin.body.token;

    var williamCanReadPerms = await call('GET', '/admin/permissions', { headers: bearerHeaders(williamToken) });
    check('root-account session token has full root access (not scoped)', williamCanReadPerms.status === 200 && williamCanReadPerms.body.role === 'root', williamCanReadPerms.body);

    var dupeRootEmail = await call('POST', '/admin/root-accounts', { headers: rootHeaders(), body: { email: 'william@example.com', label: 'Duplicate' } });
    check('creating a second root account with an already-taken email is rejected', dupeRootEmail.status === 409, dupeRootEmail.body);

    var reallyNonRoot = await call('POST', '/admin/root-accounts', { headers: bearerHeaders('not-a-real-token'), body: { email: 'x@example.com' } });
    check('an invalid/non-admin token cannot create a root account', reallyNonRoot.status === 401, reallyNonRoot.body);

    // ── maximoHosts admin UI (POST /admin/maximo-hosts, root-only,
    // whole-array replace) — previously only editable via a raw GitHub edit.
    // avwpToken is already revoked by this point (the earlier cascade delete
    // removed its bucket) - a fresh scoped account at "abbvie-ie" (which
    // survived the cascade) proves the root-only gate against a genuinely
    // valid-but-non-root token, not just an expired/garbage one. ──
    var mkIeGroup = await call('POST', '/admin/groups', {
        headers: rootHeaders(), body: { bucketId: 'abbvie-ie', label: 'Ireland Admins for hosts test', allowPeerAdminCreation: false, allowChildAdminCreation: false },
    });
    var addIeMember = await call('POST', '/admin/groups/' + mkIeGroup.body.group.id + '/members', {
        headers: rootHeaders(), body: { email: 'ie-scoped-test@abbvie.com', label: 'IE Scoped Test' },
    });
    var ieLogin = await login('ie-scoped-test@abbvie.com', addIeMember.body.tempPassword);
    var ieScopedToken = ieLogin.body.token;

    var scopedSetHosts = await call('POST', '/admin/maximo-hosts', {
        headers: bearerHeaders(ieScopedToken), body: { hosts: [{ hostname: 'evil.example.com', url: 'https://evil.example.com/login' }] },
    });
    check('a scoped (non-root) admin cannot set maximoHosts', scopedSetHosts.status === 403, scopedSetHosts.body);

    var badUrlHosts = await call('POST', '/admin/maximo-hosts', {
        headers: rootHeaders(), body: { hosts: [{ hostname: 'x.example.com', url: 'not-a-url' }] },
    });
    check('an invalid URL is rejected', badUrlHosts.status === 400, badUrlHosts.body);

    var dupeHosts = await call('POST', '/admin/maximo-hosts', {
        headers: rootHeaders(),
        body: { hosts: [{ hostname: 'x.example.com', url: 'https://x.example.com/login' }, { hostname: 'X.EXAMPLE.COM', url: 'https://x.example.com/login2' }] },
    });
    check('a duplicate hostname (case-insensitive) is rejected', dupeHosts.status === 400, dupeHosts.body);

    var setHostsOk = await call('POST', '/admin/maximo-hosts', {
        headers: rootHeaders(),
        body: { hosts: [{ hostname: 'newhost.example.com', url: 'https://newhost.example.com/maximo/login' }] },
    });
    check('root can set maximoHosts to a new list', setHostsOk.status === 200 && setHostsOk.body.hosts.length === 1, setHostsOk.body);

    var bootAfterHostsChange = await call('GET', '/bootstrap');
    check('the regular /bootstrap path immediately reflects the new maximoHosts (no stale cache in this test\'s mock)',
        bootAfterHostsChange.body.maximoHosts.length === 1 && bootAfterHostsChange.body.maximoHosts[0].hostname === 'newhost.example.com',
        bootAfterHostsChange.body.maximoHosts);

    var permsAfterHostsChange = await call('GET', '/admin/permissions', { headers: rootHeaders() });
    check('GET /admin/permissions (root) reflects the new maximoHosts too',
        permsAfterHostsChange.body.maximoHosts.length === 1 && permsAfterHostsChange.body.maximoHosts[0].hostname === 'newhost.example.com',
        permsAfterHostsChange.body.maximoHosts);

    var clearHosts = await call('POST', '/admin/maximo-hosts', { headers: rootHeaders(), body: { hosts: [] } });
    check('root can clear maximoHosts to an empty list', clearHosts.status === 200 && clearHosts.body.hosts.length === 0, clearHosts.body);

    // ── Email enumeration resistance: wrong-password and unknown-email
    // responses must be indistinguishable in shape (both a plain 401 with
    // the same generic message) ──
    var unknownEmailLogin = await login('this-does-not-exist@example.com', 'whatever');
    var wrongPasswordLogin = await login('william@example.com', 'definitely-wrong');
    check('unknown email and wrong password return the identical error shape',
        unknownEmailLogin.status === 401 && wrongPasswordLogin.status === 401 &&
        JSON.stringify(unknownEmailLogin.body) === JSON.stringify(wrongPasswordLogin.body),
        { unknown: unknownEmailLogin.body, wrongPw: wrongPasswordLogin.body });

    // ── Admin-assisted password reset (Resend not configured -> temp
    // password path) ──
    var mkResetTarget = await call('POST', '/admin/root-accounts', { headers: rootHeaders(), body: { email: 'toreset@example.com', label: 'Reset Target' } });
    var resetResult = await call('POST', '/admin/accounts/' + mkResetTarget.body.account.id + '/reset-password', { headers: rootHeaders() });
    check('root can reset another root account\'s password (temp password path)', resetResult.status === 200 && typeof resetResult.body.tempPassword === 'string', resetResult.body);

    var oldPwStillWorks = await login('toreset@example.com', mkResetTarget.body.tempPassword);
    check('the pre-reset temp password no longer logs in after a reset', oldPwStillWorks.status === 401, oldPwStillWorks.body);

    var newPwWorks = await login('toreset@example.com', resetResult.body.tempPassword);
    check('the newly-reset temp password logs in, with mustChangePassword true', newPwWorks.status === 200 && newPwWorks.body.mustChangePassword === true, newPwWorks.body);

    // ── Multi-group membership: one account can belong to more than one
    // admin group at once, with union (OR) semantics for scope/field
    // containment - a real build request, not just a data-model exercise. ──
    var mkBucketA = await call('POST', '/admin/buckets', {
        headers: rootHeaders(), body: { parentId: 'abbvie-ie', label: 'Galway', field: 'insertSite', op: 'eq', value: 'GALWAY' },
    });
    var bucketAId = mkBucketA.body.bucket && mkBucketA.body.bucket.id;
    check('multi-group setup: create bucket A (Galway)', mkBucketA.status === 200 && !!bucketAId, mkBucketA.body);
    var mkBucketB = await call('POST', '/admin/buckets', {
        headers: rootHeaders(), body: { parentId: 'abbvie-ie', label: 'Cork', field: 'insertSite', op: 'eq', value: 'CORK' },
    });
    var bucketBId = mkBucketB.body.bucket && mkBucketB.body.bucket.id;
    check('multi-group setup: create bucket B (Cork)', mkBucketB.status === 200 && !!bucketBId, mkBucketB.body);
    var mkBucketC = await call('POST', '/admin/buckets', {
        headers: rootHeaders(), body: { parentId: 'abbvie-ie', label: 'Limerick', field: 'insertSite', op: 'eq', value: 'LIMERICK' },
    });
    var bucketCId = mkBucketC.body.bucket && mkBucketC.body.bucket.id;

    var restrictBucketA = await call('PATCH', '/admin/buckets/' + bucketAId, {
        headers: rootHeaders(), body: { allowedFields: ['insertSite'] },
    });
    check('multi-group setup: restrict bucket A to only the insertSite field', restrictBucketA.status === 200, restrictBucketA.body);

    var mkGroupA = await call('POST', '/admin/groups', {
        headers: rootHeaders(), body: { bucketId: bucketAId, label: 'Galway Admins', allowPeerAdminCreation: false, allowChildAdminCreation: false },
    });
    var groupAId = mkGroupA.body.group.id;
    var mkGroupB = await call('POST', '/admin/groups', {
        headers: rootHeaders(), body: { bucketId: bucketBId, label: 'Cork Admins', allowPeerAdminCreation: true, allowChildAdminCreation: false },
    });
    var groupBId = mkGroupB.body.group.id;
    var mkGroupC = await call('POST', '/admin/groups', {
        headers: rootHeaders(), body: { bucketId: bucketCId, label: 'Limerick Admins', allowPeerAdminCreation: false, allowChildAdminCreation: false },
    });
    var groupCId = mkGroupC.body.group.id;

    var addToA = await call('POST', '/admin/groups/' + groupAId + '/members', {
        headers: rootHeaders(), body: { email: 'multi.admin@abbvie.com', label: 'Multi Admin' },
    });
    check('multi-group: adding a brand-new email to group A provisions a new account',
        addToA.status === 200 && typeof addToA.body.tempPassword === 'string', addToA.body);
    var multiTempPassword = addToA.body.tempPassword;

    // The key behavior: adding the SAME (now-existing) email to a DIFFERENT
    // group LINKS the existing account in, instead of rejecting it as
    // "taken" - that's what makes multi-group actually reachable.
    var addToB = await call('POST', '/admin/groups/' + groupBId + '/members', {
        headers: rootHeaders(), body: { email: 'multi.admin@abbvie.com', label: 'ignored - existing label wins' },
    });
    check('multi-group: adding an EXISTING email to a SECOND group links it in (200 + linked:true, not 409)',
        addToB.status === 200 && addToB.body.linked === true, addToB.body);

    var addToADupe = await call('POST', '/admin/groups/' + groupAId + '/members', {
        headers: rootHeaders(), body: { email: 'multi.admin@abbvie.com' },
    });
    check('multi-group: re-adding to a group they already belong to still 409s', addToADupe.status === 409, addToADupe.body);

    var multiLogin = await login('multi.admin@abbvie.com', multiTempPassword);
    check('multi-group: the linked account logs in with its ORIGINAL password (one shared password across every group)', multiLogin.status === 200, multiLogin.body);
    var multiToken = multiLogin.body.token;
    check('multi-group: login response carries BOTH bucketIds, not just one',
        Array.isArray(multiLogin.body.bucketIds) && multiLogin.body.bucketIds.length === 2 &&
        multiLogin.body.bucketIds.indexOf(bucketAId) !== -1 && multiLogin.body.bucketIds.indexOf(bucketBId) !== -1,
        multiLogin.body.bucketIds);

    var actAtA = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(multiToken), body: { bucketId: bucketAId, ownConditions: [{ field: 'insertSite', op: 'eq', value: 'GALWAY' }], grants: ['user'] },
    });
    check('multi-group: can author a rule at bucket A (one of their two groups)', actAtA.status === 200, actAtA.body);
    var actAtB = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(multiToken), body: { bucketId: bucketBId, ownConditions: [{ field: 'insertSite', op: 'eq', value: 'CORK' }], grants: ['user'] },
    });
    check('multi-group: can ALSO author a rule at bucket B (their OTHER group) - union scope, not just the first match', actAtB.status === 200, actAtB.body);

    // Union field checklist: bucket A restricts to just ['insertSite'];
    // bucket B has no restriction. A field bucket A's own checklist would
    // reject must still work here, because it's permitted via bucket B.
    var actAtAWithBField = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(multiToken), body: { bucketId: bucketAId, ownConditions: [{ field: 'workgroup', op: 'eq', value: 'Test' }], grants: ['user'] },
    });
    check('multi-group: a field bucket A\'s checklist would reject is still usable because bucket B has no restriction (union semantics)',
        actAtAWithBField.status === 200, actAtAWithBField.body);

    var groupsAfterLink = await call('GET', '/admin/groups', { headers: rootHeaders() });
    var groupAAfter = groupsAfterLink.body.groups.find(function(g) { return g.id === groupAId; });
    var groupBAfter = groupsAfterLink.body.groups.find(function(g) { return g.id === groupBId; });
    check('multi-group: GET /admin/groups shows the account as a member of group A',
        groupAAfter && groupAAfter.members.some(function(m) { return m.email === 'multi.admin@abbvie.com'; }), groupAAfter);
    check('multi-group: ...AND of group B - same account, two groups, not a copy',
        groupBAfter && groupBAfter.members.some(function(m) { return m.email === 'multi.admin@abbvie.com'; }), groupBAfter);

    // Peer-add is governed by the SPECIFIC group's own flag - group A has
    // it OFF, group B has it ON, same identity, different outcome per group.
    var peerAddViaA = await call('POST', '/admin/groups/' + groupAId + '/members', {
        headers: bearerHeaders(multiToken), body: { email: 'peer.attempt@abbvie.com' },
    });
    check('multi-group: peer-add via group A is forbidden (that group\'s own flag is off)', peerAddViaA.status === 403, peerAddViaA.body);
    var peerAddViaB = await call('POST', '/admin/groups/' + groupBId + '/members', {
        headers: bearerHeaders(multiToken), body: { email: 'peer.attempt@abbvie.com', label: 'Peer' },
    });
    check('multi-group: peer-add via group B succeeds (THAT group\'s own flag is on) - per-group, not identity-wide', peerAddViaB.status === 200, peerAddViaB.body);

    // Revoking membership in ONE group must not affect the others.
    var multiMemberId = groupAAfter.members.find(function(m) { return m.email === 'multi.admin@abbvie.com'; }).id;
    var revokeFromA = await call('DELETE', '/admin/groups/' + groupAId + '/members/' + multiMemberId, { headers: rootHeaders() });
    check('multi-group: revoking membership in group A succeeds', revokeFromA.status === 200, revokeFromA.body);

    var actAtAAfterRevoke = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(multiToken), body: { bucketId: bucketAId, ownConditions: [{ field: 'insertSite', op: 'eq', value: 'GALWAY2' }], grants: ['user'] },
    });
    check('multi-group: after revoking group A, acting at bucket A is now forbidden', actAtAAfterRevoke.status === 403, actAtAAfterRevoke.body);
    var actAtBAfterRevoke = await call('POST', '/admin/permissions/allow', {
        headers: bearerHeaders(multiToken), body: { bucketId: bucketBId, ownConditions: [{ field: 'insertSite', op: 'eq', value: 'CORK2' }], grants: ['user'] },
    });
    check('multi-group: ...but bucket B still works - revoking one group never touches the others (the whole point)', actAtBAfterRevoke.status === 200, actAtBAfterRevoke.body);

    // Reset-password hardening: a shared password affects every group the
    // account belongs to, so resetting it now requires authority over ALL
    // of them. multi.admin currently belongs only to group B (Cork). Link
    // them into group C (Limerick) too, then confirm an admin who only
    // controls group B cannot reset multi.admin's password (they don't
    // control group C, one of multi.admin's groups) - only root can.
    var linkToC = await call('POST', '/admin/groups/' + groupCId + '/members', {
        headers: rootHeaders(), body: { email: 'multi.admin@abbvie.com' },
    });
    check('multi-group setup: link multi.admin into group C too (now in B and C)', linkToC.status === 200 && linkToC.body.linked === true, linkToC.body);

    var peerLogin = await login('peer.attempt@abbvie.com', peerAddViaB.body.tempPassword);
    check('multi-group setup: the peer added via group B logs in', peerLogin.status === 200, peerLogin.body);
    var peerToken = peerLogin.body.token;

    var multiAccountId = groupBAfter.members.find(function(m) { return m.email === 'multi.admin@abbvie.com'; }).id;
    var peerResetAttempt = await call('POST', '/admin/accounts/' + multiAccountId + '/reset-password', { headers: bearerHeaders(peerToken) });
    check('multi-group: an admin scoped only to group B CANNOT reset multi.admin\'s password (multi.admin also has group C, outside their authority)',
        peerResetAttempt.status === 403, peerResetAttempt.body);

    var rootResetAttempt = await call('POST', '/admin/accounts/' + multiAccountId + '/reset-password', { headers: rootHeaders() });
    check('multi-group: root can still reset it regardless', rootResetAttempt.status === 200, rootResetAttempt.body);

    // ── Resend-configured dual mode: flip the two config values on and
    // prove provisioning/reset switches to the emailed-link path with zero
    // code changes, purely from config. ──
    env.RESEND_API_KEY = 'fake-resend-key';
    env.RESEND_FROM_EMAIL = 'onboarding@resend.dev';

    // avwpGroupId's bucket was cascade-deleted earlier in the suite (on
    // purpose, to test cascade behavior) — use root-accounts here instead,
    // which goes through the exact same provisionAccount() dual-mode path.
    var emailedMember = await call('POST', '/admin/root-accounts', {
        headers: rootHeaders(), body: { email: 'emailed.admin@abbvie.com', label: 'Emailed Admin' },
    });
    check('with Resend configured, adding an account returns emailSent:true instead of a temp password',
        emailedMember.status === 200 && emailedMember.body.emailSent === true && emailedMember.body.tempPassword === undefined,
        emailedMember.body);

    var loginBeforeSetup = await login('emailed.admin@abbvie.com', 'anything');
    check('an emailed-but-not-yet-set-up account gives a distinct "check your email" message on login attempt, not a generic invalid-credentials',
        loginBeforeSetup.status === 403, loginBeforeSetup.body);

    var sentMail = lastEmailTo('emailed.admin@abbvie.com');
    check('a setup email was actually captured by the Resend mock', !!sentMail, sentMail);
    var setupToken = sentMail && extractSetTokenFromLink(sentMail.html);
    check('the emailed setup link contains a usable setToken', !!setupToken, sentMail && sentMail.html);

    var completeSignup = await call('POST', '/admin/complete-signup', { body: { token: setupToken, newPassword: 'a-brand-new-password-456' } });
    check('completing signup via the emailed token sets a password and logs the account straight in',
        completeSignup.status === 200 && typeof completeSignup.body.token === 'string', completeSignup.body);

    var loginAfterSetup = await login('emailed.admin@abbvie.com', 'a-brand-new-password-456');
    check('the password chosen during signup completion now logs in normally', loginAfterSetup.status === 200, loginAfterSetup.body);

    var reusedSetupToken = await call('POST', '/admin/complete-signup', { body: { token: setupToken, newPassword: 'yet-another-password-789' } });
    check('re-using the same setup token a second time still resolves (token itself has no single-use consumption flag) — not asserting behavior here, just that it does not crash',
        reusedSetupToken.status === 200 || reusedSetupToken.status === 401, reusedSetupToken.body);

    // forgot-password: identical response regardless of match.
    var forgotKnown = await call('POST', '/admin/forgot-password', { body: { email: 'william@example.com' } });
    var forgotUnknown = await call('POST', '/admin/forgot-password', { body: { email: 'no-such-admin@example.com' } });
    check('forgot-password gives an identical response for a known vs unknown email (enumeration-resistant)',
        forgotKnown.status === 200 && forgotUnknown.status === 200 && JSON.stringify(forgotKnown.body) === JSON.stringify(forgotUnknown.body),
        { known: forgotKnown.body, unknown: forgotUnknown.body });
    check('forgot-password for a known email actually sent a reset email', !!lastEmailTo('william@example.com'), sentEmails.map(function(e) { return e.to; }));

    await testOldShapeMigration();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED of ' + results.length : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
