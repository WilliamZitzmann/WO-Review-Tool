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

    // Keys that are fine to just discard on a revoke — everything else
    // under __wo_ is treated as real user config and gets snapshotted
    // before it's cleared, not just deleted. An exclude-list rather than an
    // allow-list on purpose: new config keys wo_tool.js adds later get
    // captured automatically without this file needing to know their names.
    var EPHEMERAL_KEYS = ['__wo_tool_src', '__wo_dev_unlock', '__wo_known_hosts', '__wo_last_scanned_wo'];
    var REVOKED_BACKUP_KEY = '__wo_revoked_backup';

    // Clears the tool + its config on a confirmed revoke, but preserves two
    // things so a later regrant comes back whole: IndexedDB (__wo_tool_db,
    // the linked backup-file handle) is left completely untouched, and
    // every other __wo_ key is snapshotted into REVOKED_BACKUP_KEY before
    // being cleared, rather than just being deleted outright — a revoke
    // shouldn't cost someone their rules/groups/settings if they regain
    // access later, especially if they never set up a file-linked backup.
    function revokeLocal() {
        var snapshot = {};
        Object.keys(localStorage).forEach(function(k) {
            if (k.indexOf('__wo_') !== 0) return;
            if (EPHEMERAL_KEYS.indexOf(k) !== -1) return;
            if (k === REVOKED_BACKUP_KEY) return;
            snapshot[k] = localStorage.getItem(k);
        });
        localStorage.setItem(REVOKED_BACKUP_KEY, JSON.stringify({
            savedAt: Date.now(),
            data: snapshot
        }));
        Object.keys(localStorage).filter(function(k) {
            return k.indexOf('__wo_') === 0 && k !== REVOKED_BACKUP_KEY;
        }).forEach(function(k) {
            localStorage.removeItem(k);
        });
    }

    // Restores whatever a previous revoke snapshotted, if anything's there —
    // called right before running the tool on any successful grant, so a
    // regrant on the same browser silently comes back with the old config
    // in place instead of starting blank.
    function restoreFromRevokedBackupIfAny() {
        var raw = localStorage.getItem(REVOKED_BACKUP_KEY);
        if (!raw) return;
        try {
            var parsed = JSON.parse(raw);
            Object.keys(parsed.data || {}).forEach(function(k) {
                localStorage.setItem(k, parsed.data[k]);
            });
        } catch (e) {}
        localStorage.removeItem(REVOKED_BACKUP_KEY);
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
                restoreFromRevokedBackupIfAny();
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

    var PREFERRED_HOST_KEY = '__wo_preferred_host';

    function checkDomainThenProceed(hosts, requiredFields) {
        var here = location.hostname;
        var known = (hosts || []).some(function(h) {
            return h.hostname === here;
        });
        if (hosts && hosts.length && !known) {
            redirectToMaximo(hosts);
            return;
        }
        proceedWithAccessCheck(requiredFields);
    }

    function doRedirect(host) {
        // Remembered so a second click (e.g. after landing mid-SSO-flow on
        // an auth domain that also isn't a known host) doesn't have to ask
        // again — same company, same choice.
        localStorage.setItem(PREFERRED_HOST_KEY, host.hostname);
        showBanner('Redirecting to Maximo...');
        // A bookmarklet can't auto-resume after a navigation — nothing is
        // left to re-invoke it once the new page loads. The user has to
        // click the bookmarklet again once Maximo's loaded and they're
        // logged in (same root constraint as "persist across a tab
        // refresh" being out of scope for a plain bookmarklet).
        location.href = host.url;
    }

    // With only one company configured there's nothing to disambiguate —
    // redirect straight there, same behavior as before. With more than one,
    // there's no way to know which company a click from an unrecognized
    // page belongs to (that's exactly the question whoami would answer,
    // and whoami can only be read AFTER landing on that company's own
    // Maximo page) — so ask once, then remember the answer.
    function redirectToMaximo(hosts) {
        if (hosts.length === 1) {
            doRedirect(hosts[0]);
            return;
        }
        var preferredHostname = localStorage.getItem(PREFERRED_HOST_KEY);
        var preferred = hosts.filter(function(h) {
            return h.hostname === preferredHostname;
        })[0];
        if (preferred) {
            doRedirect(preferred);
            return;
        }
        showHostPicker(hosts);
    }

    function showHostPicker(hosts) {
        var old = document.getElementById('__wo_loader_banner');
        if (old) old.remove();
        var box = document.createElement('div');
        box.id = '__wo_loader_banner';
        box.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#2c2c2c;color:#fff;padding:12px 16px;border-radius:6px;font-family:Arial,sans-serif;font-size:13px;max-width:320px;';
        box.innerHTML = '<div style="margin-bottom:8px;">Which Maximo instance is this for?</div>' +
            hosts.map(function(h, i) {
                return '<button type="button" data-host-idx="' + i + '" style="display:block;width:100%;margin-bottom:4px;padding:6px 10px;background:#3a3a3a;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer;text-align:left;">' + h.hostname + '</button>';
            }).join('');
        document.body.appendChild(box);
        Array.prototype.forEach.call(box.querySelectorAll('[data-host-idx]'), function(btn) {
            btn.onclick = function() {
                doRedirect(hosts[parseInt(btn.getAttribute('data-host-idx'), 10)]);
            };
        });
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
