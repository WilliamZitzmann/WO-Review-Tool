// WO Review Tool — loader.
//
// This is the piece bookmarklet.js actually fetches and runs. It exists so
// the bookmarklet itself (what's pasted into a browser's bookmark bar) can
// stay a permanent, never-changing one-liner — all real logic (domain
// gating, access checking, fetching the real tool) lives here instead,
// where it can be updated freely without ever asking anyone to reinstall
// their bookmark.
//
// Flow: check we're on a known Maximo host (redirect if not) -> read
// Maximo's own whoami -> ask the access-control Worker whether this user
// is allowed -> if yes, fetch the real (now privately-hosted) wo_tool.js
// through a short-lived token and run it. See access-control/README.md for
// what the Worker does and why this isn't a hard security boundary.
(function() {
    var WORKER_BASE_URL = 'https://wo-review-tool-access.williamzitzmann.workers.dev';

    var TOOL_SRC_KEY = '__wo_tool_src'; // same key the tool itself has always used
    var HOSTS_CACHE_KEY = '__wo_known_hosts';
    var DEV_UNLOCK_KEY = '__wo_dev_unlock'; // same key wo_tool.js's console unlock commands use
    var CONTACT_EMAIL = 'williamzitzmann@abbvie.com';

    function showBanner(text, isError) {
        var el = document.getElementById('__wo_loader_banner');
        if (!el) {
            el = document.createElement('div');
            el.id = '__wo_loader_banner';
            el.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#2c2c2c;color:#ff8;padding:10px 16px;border-radius:6px;font-family:Arial,sans-serif;font-size:13px;max-width:320px;';
            document.body.appendChild(el);
        }
        el.style.color = isError ? '#e74c3c' : '#ff8';
        el.textContent = text;
        return el;
    }

    function removeBanner() {
        var el = document.getElementById('__wo_loader_banner');
        if (el) el.remove();
    }

    function getJSON(url) {
        return fetch(url).then(function(r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    // Maximo's oslc/whoami exposes several aliases for the same value
    // (loginID/userName/personId/apicachekey are all the username) -
    // picking the first that exists keeps this working across the minor
    // shape differences seen between Maximo versions/configs.
    function readWhoami() {
        return fetch('/maximo/oslc/whoami', {
            headers: {
                Accept: 'application/json'
            }
        }).then(function(r) {
            if (!r.ok) throw new Error('whoami HTTP ' + r.status);
            return r.json();
        }).then(function(d) {
            return {
                username: d.loginID || d.userName || d.personId || d.personid || '',
                email: d.email || d.primaryemail || '',
                country: d.country || '',
                insertSite: d.insertSite || d.defaultSite || '',
                langcode: d.langcode || '',
                displayName: d.displayName || d.displayname || ''
            };
        });
    }

    // Clears the tool + its config on a confirmed revoke, but deliberately
    // leaves IndexedDB (__wo_tool_db, which holds the linked backup-file
    // handle) untouched — a config file link survives a revoke, so if
    // access is regranted later the reinstalled tool still knows where to
    // load the old backup from.
    function revokeLocal() {
        Object.keys(localStorage).filter(function(k) {
            return k.indexOf('__wo_') === 0;
        }).forEach(function(k) {
            localStorage.removeItem(k);
        });
    }

    function fieldsSubset(required, whoamiData) {
        var out = {};
        required.forEach(function(f) {
            out[f] = whoamiData[f];
        });
        return out;
    }

    function runCachedToolOrShow(message) {
        var cached = localStorage.getItem(TOOL_SRC_KEY);
        if (cached) {
            removeBanner();
            eval(cached);
        } else {
            showBanner(message, true);
        }
    }

    function fetchAndRunTool(token) {
        return fetch(WORKER_BASE_URL + '/tool?token=' + encodeURIComponent(token)).then(function(r) {
            if (!r.ok) throw new Error('tool fetch HTTP ' + r.status);
            return r.text();
        }).then(function(src) {
            localStorage.setItem(TOOL_SRC_KEY, src);
            removeBanner();
            eval(src);
        });
    }

    function proceedWithAccessCheck(requiredFields) {
        showBanner('Checking access...');
        readWhoami().then(function(whoamiData) {
            var fieldsToSend = requiredFields ? fieldsSubset(requiredFields, whoamiData) : whoamiData;
            return fetch(WORKER_BASE_URL + '/check-access', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    fields: fieldsToSend
                })
            }).then(function(r) {
                if (!r.ok) throw new Error('check-access HTTP ' + r.status);
                return r.json();
            });
        }).then(function(decision) {
            if (decision.granted) {
                if (decision.tier === 'beta' || decision.tier === 'dev') {
                    localStorage.setItem(DEV_UNLOCK_KEY, decision.tier);
                } else {
                    localStorage.removeItem(DEV_UNLOCK_KEY);
                }
                return fetchAndRunTool(decision.token);
            }
            // A POSITIVE deny — whoami was read fine, the Worker responded,
            // and the rules say no. This is the ONLY case that revokes
            // anything, per the "never delete on an inconclusive result"
            // rule below.
            revokeLocal();
            showBanner('Access not granted. Request access via ' + CONTACT_EMAIL, true);
        }).catch(function() {
            // Inconclusive — network error, whoami unreachable, or the
            // Worker itself is down. NEVER revoke here; fall back to
            // whatever already works, same fail-open policy as the domain
            // list below.
            runCachedToolOrShow('Could not verify access (offline?). Try again once connected' +
                (localStorage.getItem(TOOL_SRC_KEY) ? '.' : ', or contact ' + CONTACT_EMAIL + ' for first-time access.'));
        });
    }

    function checkDomainThenProceed(hosts, requiredFields) {
        var here = location.hostname;
        var known = (hosts || []).some(function(h) {
            return h.hostname === here;
        });
        if (hosts && hosts.length && !known) {
            showBanner('Redirecting to Maximo...');
            // A bookmarklet can't auto-resume after a navigation — nothing
            // is left to re-invoke it once the new page loads. The user
            // has to click the bookmarklet again once Maximo's loaded and
            // they're logged in (same root constraint as "persist across a
            // tab refresh" being out of scope for a plain bookmarklet).
            location.href = hosts[0].url;
            return;
        }
        proceedWithAccessCheck(requiredFields);
    }

    function main() {
        getJSON(WORKER_BASE_URL + '/bootstrap').then(function(boot) {
            var hosts = boot.maximoHosts || [];
            if (hosts.length) localStorage.setItem(HOSTS_CACHE_KEY, JSON.stringify(hosts));
            checkDomainThenProceed(hosts, boot.requiredFields || null);
        }).catch(function() {
            // Worker unreachable before we even know the host list — fall
            // back to whatever we last saw. If we've never seen one
            // either, just proceed rather than blocking on a network blip.
            var cached = [];
            try {
                cached = JSON.parse(localStorage.getItem(HOSTS_CACHE_KEY) || '[]');
            } catch (e) {}
            checkDomainThenProceed(cached, null);
        });
    }

    main();
})();
