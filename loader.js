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
    var GRANTS_KEY = '__wo_grants'; // same key wo_tool.js's hasGrant()/console unlock commands read
    var ORG_CONFIGS_KEY = '__wo_org_configs'; // same key wo_tool.js's showInstaller()/Setup > Profiles read
    var RULES_KEY = '__wo_rules_config'; // same key wo_tool.js's startupRestore() checks for its first-run gate
    var CONTACT_EMAIL_KEY = '__wo_contact_email'; // same key wo_tool.js reads for its own contact-email display
    // Ultimate fallback ONLY — used before any /check-access response has
    // ever supplied a real one (very first load, or a network error before
    // that ever happened). Every real check-access call returns a
    // bucket-resolved contactEmail (nearest-ancestor-wins — see worker.js's
    // resolveContactForBucket()); once cached, that always wins over this.
    var CONTACT_EMAIL = 'williamzitzmann@abbvie.com';

    // Set by a per-company bookmarklet (see install.html's ?loginUrl=
    // param) before it eval()s this file — a plain `window` property, not
    // a scope-chain trick, so it works regardless of how run() calls eval
    // and reads back identically in a test harness. When present, this
    // bookmarklet is permanently scoped to ONE company's Maximo instance:
    // there's no "which instance" ambiguity to ask about, ever, so the
    // whole maximoHosts-list/picker path below is skipped entirely for it.
    // Absent for the generic bookmarklet (and any old install from before
    // this existed), which falls back to that original behavior unchanged.
    var FIXED_LOGIN_URL = (typeof window !== 'undefined' && window.__wo_fixed_host_url) || null;
    var FIXED_HOSTNAME = null;
    if (FIXED_LOGIN_URL) {
        try {
            FIXED_HOSTNAME = new URL(FIXED_LOGIN_URL).hostname;
        } catch (e) {
            FIXED_LOGIN_URL = null; // malformed - fall back to the normal path rather than redirect nowhere
        }
    }

    function getContactEmail() {
        return localStorage.getItem(CONTACT_EMAIL_KEY) || CONTACT_EMAIL;
    }

    // One shared <style> tag (injected once, idempotent) instead of long
    // repeated cssText strings — also the only way to get a real transition/
    // keyframe animation without a stylesheet. Palette matches wo_tool.js's
    // own panel theme (--wo-bg/--wo-accent/etc in its injected CSS) so the
    // banner and the tool panel that follows it feel like one continuous
    // piece of UI, not two different visual languages stitched together.
    var BANNER_STYLE_ID = '__wo_loader_banner_style';
    function ensureBannerStyles() {
        if (document.getElementById(BANNER_STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = BANNER_STYLE_ID;
        style.textContent =
            '#__wo_loader_banner{position:fixed;top:10px;right:10px;z-index:2147483647;' +
            'display:flex;align-items:flex-start;gap:10px;box-sizing:border-box;' +
            'background:#161b22;color:#f0f3f6;padding:12px 14px;border-radius:8px;' +
            'font-family:"Segoe UI",Arial,sans-serif;font-size:13px;line-height:1.45;max-width:320px;' +
            'border:1px solid #30363d;box-shadow:0 6px 20px rgba(0,0,0,.45);' +
            'opacity:0;transform:translateY(-6px);transition:opacity .16s ease,transform .16s ease;}' +
            '#__wo_loader_banner.__wo_show{opacity:1;transform:translateY(0);}' +
            '#__wo_loader_banner.__wo_error{border-color:rgba(248,81,73,.45);}' +
            '#__wo_loader_banner .__wo_spinner{flex:0 0 auto;width:14px;height:14px;margin-top:2px;' +
            'border-radius:50%;border:2px solid #30363d;border-top-color:#58a6ff;' +
            'animation:__wo_spin .7s linear infinite;}' +
            '@keyframes __wo_spin{to{transform:rotate(360deg);}}' +
            '#__wo_loader_banner .__wo_icon{flex:0 0 auto;width:14px;line-height:14px;margin-top:1px;font-size:14px;color:#f85149;}' +
            '#__wo_loader_banner .__wo_text{flex:1 1 auto;min-width:0;}' +
            '#__wo_loader_banner .__wo_close{flex:0 0 auto;cursor:pointer;color:#9aa4af;font-size:16px;line-height:1;margin:-2px -2px 0 4px;}' +
            '#__wo_loader_banner .__wo_close:hover{color:#f0f3f6;}' +
            '#__wo_loader_banner button{font-family:inherit;}';
        document.head.appendChild(style);
    }

    function ensureBannerEl() {
        var el = document.getElementById('__wo_loader_banner');
        if (!el) {
            ensureBannerStyles();
            el = document.createElement('div');
            el.id = '__wo_loader_banner';
            document.body.appendChild(el);
        }
        return el;
    }

    // Kicks the entrance transition off on the next frame — adding the
    // class in the same tick the element/styles are created would skip the
    // transition entirely (nothing to animate FROM yet).
    function showBannerEl(el) {
        requestAnimationFrame(function() { el.classList.add('__wo_show'); });
        return el;
    }

    // isError banners (access denied, offline-with-no-cached-tool) are dead
    // ends for THIS bookmarklet click — nothing in loader.js ever calls
    // removeBanner() for them on its own (there's no cached tool to fall
    // back into and re-verify from), so without a manual dismiss they sit
    // on the page indefinitely, even after the underlying issue is fixed,
    // until the next full page reload. A close button is the only way out
    // that doesn't require rechecking access on some ambient timer.
    // Non-error calls get a small spinner instead — every non-error message
    // this file ever shows ("Checking access...", "Redirecting to
    // Maximo...") is a transient in-progress state, never a final one (a
    // successful outcome just removes the banner and launches the tool),
    // so "not an error" and "still working" are the same thing here.
    function showBanner(text, isError) {
        var el = ensureBannerEl();
        el.className = isError ? '__wo_error' : '';
        el.innerHTML = (isError ? '<div class="__wo_icon">&#9888;</div>' : '<div class="__wo_spinner"></div>') +
            '<div class="__wo_text"></div>' +
            (isError ? '<div class="__wo_close" title="Dismiss">&times;</div>' : '');
        el.querySelector('.__wo_text').textContent = text;
        if (isError) el.querySelector('.__wo_close').onclick = removeBanner;
        return showBannerEl(el);
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
                // === WHOAMI_FIELDS:START === (auto-synced into wo_tool.js's
                // readWhoamiCanonical() by scripts/sync-whoami-mapping.js on
                // every commit touching either file — edit here, not there)
                username: d.loginID || d.userName || d.personId || d.personid || '',
                email: d.email || d.primaryemail || '',
                country: d.country || '',
                insertSite: d.insertSite || d.defaultSite || '',
                langcode: d.langcode || '',
                displayName: d.displayName || d.displayname || '',
                defaultSiteDescription: d.defaultSiteDescription || '',
                primaryEmail: d.primaryemail || d.email || '',
                city: d.city || '',
                firstName: d.firstname || '',
                lastName: d.lastname || '',
                // Not from whoami at all — the browser's own hostname, a
                // more direct "which company/instance" signal than an
                // incidental email-domain match (see CANONICAL_FIELDS's
                // comment in worker.js).
                maximoHost: location.hostname
                // === WHOAMI_FIELDS:END ===
            };
        });
    }

    // Keys that are fine to just discard on a revoke — everything else
    // under __wo_ is treated as real user config and gets snapshotted
    // before it's cleared, not just deleted. An exclude-list rather than an
    // allow-list on purpose: new config keys wo_tool.js adds later get
    // captured automatically without this file needing to know their names.
    // __wo_org_configs and __wo_contact_email were both missing here for a
    // while (a real gap, not intentional) — both are re-derived from the
    // next successful check-access, not real user config, so a revoke
    // snapshotting them as if they were worth restoring was just dead
    // weight in the backup blob. This line is AUTO-SYNCED into wo_tool.js
    // by scripts/sync-whoami-mapping.js — edit here, not there.
    var EPHEMERAL_KEYS = ['__wo_tool_src', '__wo_dev_unlock', '__wo_grants', '__wo_known_hosts', '__wo_last_scanned_wo', '__wo_grant_cache', '__wo_org_configs', '__wo_contact_email']; // === SYNC:EPHEMERAL_KEYS ===
    var REVOKED_BACKUP_KEY = '__wo_revoked_backup';

    // Short-lived local cache of the last access decision — a deliberate
    // speed/freshness tradeoff: skips all 3 network round trips (bootstrap,
    // whoami, check-access) for repeat clicks within the window, at the
    // cost of a revoke taking up to this long to actually land on a
    // browser that already cached a grant, instead of the very next click.
    // wo_tool.js's own update check still runs independently once the
    // cached copy is running, so a real version bump is never blocked by
    // this — only the ACCESS check is skipped, not the tool's own
    // self-update logic.
    var GRANT_CACHE_KEY = '__wo_grant_cache';
    var GRANT_CACHE_TTL_MS = 15 * 60 * 1000;

    function readGrantCache() {
        try {
            var raw = JSON.parse(localStorage.getItem(GRANT_CACHE_KEY) || 'null');
            if (!raw || typeof raw.cachedAt !== 'number') return null;
            if (Date.now() - raw.cachedAt > GRANT_CACHE_TTL_MS) return null;
            return raw;
        } catch (e) {
            return null;
        }
    }

    function writeGrantCache(grants) {
        localStorage.setItem(GRANT_CACHE_KEY, JSON.stringify({
            grants: grants || [],
            cachedAt: Date.now()
        }));
    }

    // Clears the tool + its config on a confirmed revoke, but preserves two
    // things so a later regrant comes back whole: IndexedDB (__wo_tool_db,
    // the linked backup-file handle) is left completely untouched, and
    // every other __wo_ key is snapshotted into REVOKED_BACKUP_KEY before
    // being cleared, rather than just being deleted outright — a revoke
    // shouldn't cost someone their rules/groups/settings if they regain
    // access later, especially if they never set up a file-linked backup.
    //
    // The wipe below deletes EVERY __wo_ key unconditionally, including
    // ephemeral ones (EPHEMERAL_KEYS only controls what's worth
    // snapshotting, not what survives) — so a resolved contactEmail has to
    // be (re-)written AFTER the wipe, via this function's own optional
    // parameter, not cached separately beforehand. That's the whole reason
    // this takes contactEmail as an argument instead of callers caching it
    // themselves first.
    function revokeLocal(contactEmail) {
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
        cacheContactEmail(contactEmail);
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

    // Metadata (id/name/description — never content) for every org-authored
    // config /check-access matched, so wo_tool.js's Setup > Profiles and the
    // first-run installer can always show an up-to-date list with zero
    // network calls of their own. This rides entirely on check-access calls
    // that were ALREADY happening (gated by the 15-min grant cache, same as
    // everything else here) — no new round trip, no new revoke-risk trigger
    // surface. Full config CONTENT is deliberately never fetched here: it's
    // only ever pulled live, at the exact moment a user clicks Install (see
    // wo_tool.js's installOrgConfig()), so there's no stale-token window to
    // manage and no bandwidth spent on configs nobody ends up installing.
    function cacheOrgConfigsMetadata(matchedConfigs) {
        localStorage.setItem(ORG_CONFIGS_KEY, JSON.stringify(matchedConfigs || []));
    }

    // Only ever OVERWRITES the cache with a real, resolved value — called
    // with contactEmail: null/undefined is a no-op, leaving whatever's
    // already cached alone rather than clearing it, since the fallback
    // constant above is strictly worse than stale-but-real contact info.
    // This matters for the granted/inconclusive call sites below, where no
    // wipe happens at all. It does NOT make a null resolution survive an
    // actual revoke, though — revokeLocal() below deletes this key
    // unconditionally as part of its own wipe first, and only calls this
    // function afterward to (maybe) put a value back; a revoke is a
    // deliberate clean-slate event, not somewhere stale data should
    // persist through. Takes the raw email string, not a decision object,
    // specifically so revokeLocal() can call it with the right value AFTER
    // its own wipe without needing to reconstruct a fake decision shape.
    function cacheContactEmail(contactEmail) {
        if (contactEmail) {
            localStorage.setItem(CONTACT_EMAIL_KEY, contactEmail);
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

    // Only ever reached when main() has already determined there's no
    // usable local copy (missing TOOL_SRC_KEY and/or RULES_KEY) — a
    // returning user with both always takes the optimistic instant-launch
    // path below instead (runOptimistically()), never this blocking one.
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
                cacheContactEmail(decision.contactEmail);
                localStorage.setItem(GRANTS_KEY, JSON.stringify(decision.grants || []));
                writeGrantCache(decision.grants);
                restoreFromRevokedBackupIfAny();
                cacheOrgConfigsMetadata(decision.configs);
                return fetchAndRunTool(decision.token);
            }
            // A POSITIVE deny — whoami was read fine, the Worker responded,
            // and the rules say no. This is the ONLY case that revokes
            // anything, per the "never delete on an inconclusive result"
            // rule below. revokeLocal() wipes __wo_contact_email along with
            // everything else, so the resolved contact has to go IN as its
            // argument (re-written after the wipe), not cached separately
            // beforehand.
            revokeLocal(decision.contactEmail);
            showBanner('Access not granted. Request access via ' + getContactEmail(), true);
        }).catch(function() {
            // Inconclusive — network error, whoami unreachable, or the
            // Worker itself is down. NEVER revoke here; fall back to
            // whatever already works, same fail-open policy as the domain
            // list below.
            runCachedToolOrShow('Could not verify access (offline?). Try again once connected' +
                (localStorage.getItem(TOOL_SRC_KEY) ? '.' : ', or contact ' + getContactEmail() + ' for first-time access.'));
        });
    }

    var PREFERRED_HOST_KEY = '__wo_preferred_host';

    // Returns true when the caller should proceed normally (already on the
    // right host); false when it already kicked off a redirect (caller
    // should return immediately without proceeding). FIXED_HOSTNAME takes
    // priority and never consults `hosts` at all — one bookmarklet, one
    // instance, no ambiguity. Falls back to the original maximoHosts-list
    // check (including the multi-instance picker) only when no fixed host
    // was set.
    function resolveHostAndMaybeRedirect(hosts) {
        if (FIXED_HOSTNAME) {
            if (location.hostname === FIXED_HOSTNAME) return true;
            doRedirect({ hostname: FIXED_HOSTNAME, url: FIXED_LOGIN_URL });
            return false;
        }
        var here = location.hostname;
        var known = (hosts || []).some(function(h) {
            return h.hostname === here;
        });
        if (hosts && hosts.length && !known) {
            redirectToMaximo(hosts);
            return false;
        }
        return true;
    }

    function checkDomainThenProceed(hosts, requiredFields) {
        if (resolveHostAndMaybeRedirect(hosts)) {
            proceedWithAccessCheck(requiredFields);
        }
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
        var box = ensureBannerEl();
        box.className = '';
        box.innerHTML = '<div style="flex:1 1 auto;min-width:0;">' +
            '<div style="margin-bottom:8px;">Which Maximo instance is this for?</div>' +
            hosts.map(function(h, i) {
                return '<button type="button" data-host-idx="' + i + '" style="display:block;width:100%;margin-bottom:4px;padding:7px 10px;background:#1f2630;color:#f0f3f6;border:1px solid #30363d;border-radius:6px;cursor:pointer;text-align:left;font-size:13px;transition:border-color .12s ease;">' + h.hostname + '</button>';
            }).join('') +
            '</div>';
        Array.prototype.forEach.call(box.querySelectorAll('[data-host-idx]'), function(btn) {
            btn.onmouseenter = function() { btn.style.borderColor = '#58a6ff'; };
            btn.onmouseleave = function() { btn.style.borderColor = '#30363d'; };
            btn.onclick = function() {
                doRedirect(hosts[parseInt(btn.getAttribute('data-host-idx'), 10)]);
            };
        });
        showBannerEl(box);
    }

    // Best-effort — the panel may not exist yet (very first paint) or this
    // may be running against an old cached tool source that predates
    // window.__woSetStatus; either way, silently doing nothing is fine,
    // this is a visibility nicety, not something to ever block or error on.
    function setToolStatus(text) {
        if (typeof window.__woSetStatus === 'function') window.__woSetStatus(text);
    }

    // Real, live re-verification — runs AFTER the tool is already showing
    // (see runOptimistically()), never blocking anything. Rate-limited by
    // the same grant cache the old fully-blocking flow used, so a burst of
    // bookmarklet clicks within GRANT_CACHE_TTL_MS doesn't hammer the
    // Worker just to re-confirm what was already confirmed minutes ago.
    function backgroundVerify() {
        if (readGrantCache()) return;
        setToolStatus('Verifying access…');
        getJSON(WORKER_BASE_URL + '/bootstrap').then(function(boot) {
            var hosts = boot.maximoHosts || [];
            if (hosts.length) localStorage.setItem(HOSTS_CACHE_KEY, JSON.stringify(hosts));
            return readWhoami().then(function(whoamiData) {
                var fieldsToSend = boot.requiredFields ? fieldsSubset(boot.requiredFields, whoamiData) : whoamiData;
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
            });
        }).then(function(decision) {
            if (decision.granted) {
                cacheContactEmail(decision.contactEmail);
                localStorage.setItem(GRANTS_KEY, JSON.stringify(decision.grants || []));
                writeGrantCache(decision.grants);
                cacheOrgConfigsMetadata(decision.configs);
                setToolStatus('Access verified.');
                return;
            }
            // A real, positive deny, discovered only AFTER the tool was
            // already optimistically running. loader.js's own revokeLocal()
            // can only clear localStorage for next time — it can't touch
            // the DOM of a session that's already live — so this reaches
            // into the running tool's own revoke machinery (the same one
            // self-update/feedback already use) to actually tear it down
            // now, not just on the next launch. Both revoke paths wipe
            // __wo_contact_email along with everything else, so the
            // resolved contact goes IN as an argument (re-written after
            // the wipe), not cached separately beforehand. No separate
            // setToolStatus() call needed here — the revoke path already
            // shows its own much more prominent banner.
            if (typeof window.__woForceRevoke === 'function') {
                window.__woForceRevoke(decision.contactEmail);
            } else {
                revokeLocal(decision.contactEmail);
            }
        }).catch(function() {
            // Inconclusive (offline, Worker down) — never revoke, same
            // fail-open policy the original blocking flow always had.
        });
    }

    // Optimistic launch: a returning user with both a cached tool source
    // AND a real local config runs INSTANTLY, no network wait at all — the
    // real access decision is re-verified in the background afterward
    // (backgroundVerify()) and can still revoke if it comes back denied.
    // This is the direct fix for auth round trips (bootstrap -> whoami ->
    // check-access -> tool fetch, all sequential) becoming the visible
    // bottleneck on every fresh page load: that chain still runs, it just
    // no longer blocks getting the tool open. Gated on RULES_KEY (not just
    // TOOL_SRC_KEY) specifically so a genuinely fresh install — nothing to
    // optimistically show yet — still waits for the real check, per "if no
    // local config available then they wait for auth."
    function runOptimistically() {
        var cachedHosts = [];
        try {
            cachedHosts = JSON.parse(localStorage.getItem(HOSTS_CACHE_KEY) || '[]');
        } catch (e) {}
        if (!resolveHostAndMaybeRedirect(cachedHosts)) return;

        restoreFromRevokedBackupIfAny();
        removeBanner();
        eval(localStorage.getItem(TOOL_SRC_KEY));
        backgroundVerify();
    }

    function main() {
        if (localStorage.getItem(TOOL_SRC_KEY) && localStorage.getItem(RULES_KEY)) {
            runOptimistically();
            return;
        }
        // No usable local copy yet (fresh install, or a real revoke
        // cleared everything) — must wait for the real check.
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
