// Black-box test of the REAL loader.js (not a reimplementation): loads it
// into a jsdom window with a mocked fetch, and verifies the new optimistic
// instant-launch behavior:
//   1) a returning user (TOOL_SRC_KEY + RULES_KEY both present) runs the
//      cached tool IMMEDIATELY, before any network call resolves
//   2) the real check-access flow still fires in the background afterward
//   3) a background "granted" refreshes the grant cache/org-configs
//      metadata without disturbing the already-running tool
//   4) a background "denied" (real, positive deny) calls the tool's own
//      live-revoke hook (window.__woForceRevoke), not just loader's own
//      localStorage-only revokeLocal()
//   5) a genuinely fresh install (no RULES_KEY) does NOT run anything until
//      the real check resolves — "if no local config, wait for auth"
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = path.join(__dirname, '..', 'loader.js');
const loaderSrc = readFileSync(LOADER_PATH, 'utf8');

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

function makeDom() {
    return new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
}

function tick(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Test 1: optimistic instant launch, background verify GRANTS ──
async function testOptimisticGrant() {
    const dom = makeDom();
    const w = dom.window;
    const calls = [];
    let resolveCheckAccess;
    const checkAccessPromise = new Promise(function(res) { resolveCheckAccess = res; });

    w.fetch = function(url, opts) {
        var u = String(url);
        calls.push(u);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser', email: 'someuser@abbvie.com', country: 'IE', insertSite: 'AVWP' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: ['username'] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return checkAccessPromise.then(function() {
                return { ok: true, json: () => Promise.resolve({ granted: true, grants: ['user'], token: 'tok', configs: [{ id: 'c1', name: 'Cfg' }] }) };
            });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };

    w.localStorage.setItem('__wo_tool_src', 'window.__toolRan = (window.__toolRan||0) + 1;');
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ rules: [{ id: 'r1' }] }));
    w.localStorage.setItem('__wo_grants', JSON.stringify(['user']));

    // Simulates wo_tool.js's own exported window.__woSetStatus hook (the
    // marker tool source above doesn't define one, since it's not real
    // wo_tool.js) — tracks every status text loader.js's background
    // verification pushes into the panel's own status line.
    const statusCalls = [];
    w.__woSetStatus = function(text) { statusCalls.push(text); };

    w.eval(loaderSrc);

    // The tool must be running SYNCHRONOUSLY (before any fetch promise has
    // had a chance to resolve) — this is the entire point of the feature.
    check('[grant] tool ran instantly, before check-access resolved', w.__toolRan === 1, w.__toolRan);

    await tick(20); // let bootstrap/whoami's own microtask chain reach check-access
    check('[grant] a background check-access call was made (not skipped)', calls.some(u => u.indexOf('/check-access') !== -1), calls);
    check('[grant] the panel\'s own status line shows verification is happening in the background',
        statusCalls.indexOf('Verifying access…') !== -1, statusCalls);

    resolveCheckAccess();
    await tick(50);

    check('[grant] grant cache was refreshed after background verify succeeded',
        !!w.localStorage.getItem('__wo_grant_cache'), w.localStorage.getItem('__wo_grant_cache'));
    check('[grant] org config metadata cached from the background check',
        JSON.parse(w.localStorage.getItem('__wo_org_configs') || '[]').length === 1);
    check('[grant] tool was NOT re-run/torn down by a granted background result', w.__toolRan === 1, w.__toolRan);
    check('[grant] status line updated to confirm verification completed', statusCalls[statusCalls.length - 1] === 'Access verified.', statusCalls);
}

// ── Test 2: optimistic instant launch, background verify DENIES -> live revoke ──
async function testOptimisticDeny() {
    const dom = makeDom();
    const w = dom.window;
    let resolveCheckAccess;
    const checkAccessPromise = new Promise(function(res) { resolveCheckAccess = res; });
    let forceRevokeCalls = 0;

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return checkAccessPromise.then(function() {
                return { ok: true, json: () => Promise.resolve({ granted: false }) };
            });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };

    w.localStorage.setItem('__wo_tool_src', 'window.__toolRan = (window.__toolRan||0) + 1;');
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ rules: [{ id: 'r1' }] }));
    w.localStorage.setItem('__wo_grants', JSON.stringify(['user']));
    // Simulates wo_tool.js's own exported live-teardown hook.
    w.__woForceRevoke = function() { forceRevokeCalls++; };

    w.eval(loaderSrc);
    check('[deny] tool still ran instantly (optimistic, before the deny was known)', w.__toolRan === 1, w.__toolRan);

    resolveCheckAccess();
    await tick(50);

    check('[deny] a REAL positive deny called the tool\'s own live-revoke hook (__woForceRevoke), not just localStorage cleanup',
        forceRevokeCalls === 1, forceRevokeCalls);
}

// ── Test 3: background verify is INCONCLUSIVE (network error) -> never revokes ──
async function testOptimisticNetworkError() {
    const dom = makeDom();
    const w = dom.window;
    let forceRevokeCalls = 0;

    w.fetch = function() {
        return Promise.reject(new Error('offline'));
    };

    w.localStorage.setItem('__wo_tool_src', 'window.__toolRan = (window.__toolRan||0) + 1;');
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ rules: [{ id: 'r1' }] }));
    w.localStorage.setItem('__wo_grants', JSON.stringify(['user']));
    w.__woForceRevoke = function() { forceRevokeCalls++; };

    w.eval(loaderSrc);
    await tick(50);

    check('[network error] tool ran and stayed up despite the background check failing (fail-open, never revoke on inconclusive)',
        w.__toolRan === 1 && forceRevokeCalls === 0, { ran: w.__toolRan, revokes: forceRevokeCalls });
}

// ── Test 4: fresh install (no RULES_KEY) — must wait for the real check ──
async function testFreshInstallBlocks() {
    const dom = makeDom();
    const w = dom.window;
    let resolveCheckAccess;
    const checkAccessPromise = new Promise(function(res) { resolveCheckAccess = res; });

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return checkAccessPromise.then(function() {
                return { ok: true, json: () => Promise.resolve({ granted: true, grants: ['user'], token: 'tok', configs: [] }) };
            });
        }
        if (u.indexOf('/tool?') !== -1) {
            return Promise.resolve({ ok: true, text: () => Promise.resolve('window.__toolRan = (window.__toolRan||0) + 1;') });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };

    // No __wo_rules_config at all — genuinely fresh install. TOOL_SRC_KEY
    // also absent (the real first-run case), but tested independently of
    // that to isolate the RULES_KEY gate specifically below.

    w.eval(loaderSrc);
    await tick(20);

    check('[fresh install] tool did NOT run before the real check-access resolved', !w.__toolRan, w.__toolRan);

    resolveCheckAccess();
    await tick(50);

    check('[fresh install] tool DID run once the real check-access came back granted', w.__toolRan === 1, w.__toolRan);
}

// ── Test 5: TOOL_SRC_KEY present but RULES_KEY missing — still blocks ──
// (the exact edge case the old inline fast-path check would have gotten
// wrong — see loader.js's proceedWithAccessCheck() comment)
async function testStaleSrcNoRulesBlocks() {
    const dom = makeDom();
    const w = dom.window;
    let resolveCheckAccess;
    const checkAccessPromise = new Promise(function(res) { resolveCheckAccess = res; });

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return checkAccessPromise.then(function() {
                return { ok: true, json: () => Promise.resolve({ granted: true, grants: ['user'], token: 'tok', configs: [] }) };
            });
        }
        if (u.indexOf('/tool?') !== -1) {
            return Promise.resolve({ ok: true, text: () => Promise.resolve('window.__toolRan = (window.__toolRan||0) + 1;') });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };

    w.localStorage.setItem('__wo_tool_src', 'window.__toolRan = (window.__toolRan||0) + 1;');
    // __wo_rules_config deliberately NOT set.

    w.eval(loaderSrc);
    await tick(20);
    check('[stale src, no rules] did NOT instantly run the stale cached tool', !w.__toolRan, w.__toolRan);

    resolveCheckAccess();
    await tick(50);
    check('[stale src, no rules] ran only after the real check-access came back granted', w.__toolRan === 1, w.__toolRan);
}

// ── Test 6: a denied user gets the bucket-resolved contactEmail in the
// banner (not the hardcoded fallback), and it's cached for next time ──
async function testDeniedContactEmailResolved() {
    const dom = makeDom();
    const w = dom.window;

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ granted: false, contactEmail: 'ie-help@abbvie.com' }) });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };
    // No local config at all - genuinely fresh, forces the blocking path.

    w.eval(loaderSrc);
    await tick(50);

    const banner = w.document.getElementById('__wo_loader_banner');
    check('[denied] banner shows the bucket-resolved contact email, not the hardcoded fallback',
        !!banner && banner.textContent.indexOf('ie-help@abbvie.com') !== -1, banner && banner.textContent);
    check('[denied] the resolved contact email was cached for next time',
        w.localStorage.getItem('__wo_contact_email') === 'ie-help@abbvie.com', w.localStorage.getItem('__wo_contact_email'));

    // A denial banner is a dead end for this bookmarklet click - nothing
    // else in loader.js will ever call removeBanner() for it, so it needs
    // its own dismiss control or it sits on the page forever (the bug this
    // covers - see the "message sticks" fix in showBanner()).
    var closeBtn = banner && banner.querySelector('.__wo_close');
    check('[denied] banner has a dismiss control', !!closeBtn);
    if (closeBtn) closeBtn.onclick();
    check('[denied] clicking dismiss removes the banner',
        !w.document.getElementById('__wo_loader_banner'));
}

// ── Test 7: contactEmail: null does NOT clobber a previously-cached real
// value — but ONLY where no revoke/wipe happens. A GRANTED background
// verify with a null resolution is the right case for this (revokeLocal's
// own wipe is deliberately NOT preserving-on-null — see its own comment;
// a revoke is a clean-slate event, an ordinary granted re-check is not). ──
async function testNullContactEmailDoesNotClobberCache() {
    const dom = makeDom();
    const w = dom.window;
    let resolveCheckAccess;
    const checkAccessPromise = new Promise(function(res) { resolveCheckAccess = res; });

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return checkAccessPromise.then(function() {
                return { ok: true, json: () => Promise.resolve({ granted: true, grants: ['user'], token: 'tok', configs: [], contactEmail: null }) };
            });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };

    w.localStorage.setItem('__wo_tool_src', 'window.__toolRan = (window.__toolRan||0) + 1;');
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ rules: [{ id: 'r1' }] }));
    w.localStorage.setItem('__wo_grants', JSON.stringify(['user']));
    w.localStorage.setItem('__wo_contact_email', 'previously-known@abbvie.com');

    w.eval(loaderSrc); // optimistic instant launch, background-verify pending
    resolveCheckAccess();
    await tick(50);

    check('[null contact, granted re-check] a null resolution leaves a previously-cached value alone (no wipe occurred)',
        w.localStorage.getItem('__wo_contact_email') === 'previously-known@abbvie.com', w.localStorage.getItem('__wo_contact_email'));
}

// ── Test 8: revokeLocal's own wipe is a clean-slate event — a real revoke
// with contactEmail: null clears even a previously-known value (does NOT
// preserve stale data through an actual revoke) ──
async function testRevokeWithNullContactClearsStaleCache() {
    const dom = makeDom();
    const w = dom.window;

    w.fetch = function(url) {
        var u = String(url);
        if (u.indexOf('/maximo/oslc/whoami') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ loginID: 'someuser' }) });
        }
        if (u.indexOf('/bootstrap') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ maximoHosts: [], requiredFields: [] }) });
        }
        if (u.indexOf('/check-access') !== -1) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ granted: false, contactEmail: null }) });
        }
        return Promise.reject(new Error('unexpected fetch ' + u));
    };
    // Genuinely fresh install (no local config) - forces the blocking
    // path, whose deny branch calls revokeLocal(decision.contactEmail).
    w.localStorage.setItem('__wo_contact_email', 'stale-from-before@abbvie.com');

    w.eval(loaderSrc);
    await tick(50);

    check('[revoke, null contact] the wipe clears even a previously-cached value — a revoke is a clean-slate event',
        w.localStorage.getItem('__wo_contact_email') === null, w.localStorage.getItem('__wo_contact_email'));
}

(async function main() {
    await testOptimisticGrant();
    await testOptimisticDeny();
    await testOptimisticNetworkError();
    await testFreshInstallBlocks();
    await testStaleSrcNoRulesBlocks();
    await testDeniedContactEmailResolved();
    await testNullContactEmailDoesNotClobberCache();
    await testRevokeWithNullContactClearsStaleCache();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
