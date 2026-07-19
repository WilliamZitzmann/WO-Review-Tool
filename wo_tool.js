(function __WO_TOOL__() {
    var FKEY = '__wo_field_config',
        RKEY = '__wo_rules_config',
        GSTATE = '__wo_group_state',
        SKEY = '__wo_scan_config',
        VKEY = '__wo_vars_config',
        ORG_CONFIGS_KEY = '__wo_org_configs'; // written by loader.js on every granted check-access — see cacheOrgConfigsMetadata()
    // sessionStorage (not localStorage) — a same-tab, this-instant-only
    // handoff across an update's teardown()+eval(), never meant to survive
    // an actual navigation or outlive this one reload. See
    // applyUpdateNow()/restoreUpdateSnapshotIfAny().
    var UPDATE_SNAPSHOT_KEY = '__wo_update_scan_snapshot';

    function getVars() {
        try {
            return JSON.parse(localStorage.getItem(VKEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveVars(v) {
        localStorage.setItem(VKEY, JSON.stringify(v));
        localStorage.setItem('__wo_config_saved_at', new Date().toISOString());
        autoSaveToFile();
    }

    var PANEL_W = 360;
    var TOOL_VERSION = '0.26.0';
    // Format YYDDD.HHMMz (2-digit year, day-of-year, UTC hour+minute) —
    // computed via `date -u +"%y%j.%H%M"z` and substituted in right before
    // every commit that touches this file, on ANY channel/repo (unlike
    // TOOL_VERSION, which only changes on a tagged stable/beta release).
    // The dev channel always tracks the live tip of main (see
    // resolveUpdateTarget()'s early return for channel==='dev'), so several
    // DIFFERENT dev pushes in a row can share the same TOOL_VERSION with no
    // other way to tell them apart. Surfaced (dev-grant only) via
    // grantsStatusLine() so it rides along on every status message that
    // already reports "running vX" or "up to date", plus a standalone line
    // in Settings > Updates.
    var BUILD_ID = '26200.2202z';
    // Ultimate fallback ONLY — same key/contract as loader.js's
    // CONTACT_EMAIL_KEY (kept in sync manually, independent files). Real
    // value comes from /check-access's bucket-resolved contactEmail
    // (nearest-ancestor-wins — see worker.js's resolveContactForBucket()),
    // cached here whenever this file's own runCheckAccess() gets one.
    var SUPPORT_EMAIL = 'williamzitzmann@abbvie.com';
    var CONTACT_EMAIL_KEY = '__wo_contact_email';
    function getSupportEmail() {
        return localStorage.getItem(CONTACT_EMAIL_KEY) || SUPPORT_EMAIL;
    }

    // The main panel header and Setup titlebar are set to this same fixed
    // height (instead of just letting padding/content size them) so the two
    // line up when the Setup window is snapped beside the docked panel.
    // Matches Maximo's own Carbon header when present, so the tool's chrome
    // reads as part of one continuous toolbar rather than a mismatched
    // overlay; falls back to Carbon's standard 48px otherwise.
    function getHostHeaderHeight() {
        try {
            var h = document.querySelector('.bx--header');
            if (h && h.offsetHeight > 0) return h.offsetHeight;
        } catch (e) {}
        return 48;
    }

    // ── Custom-styled replacements for alert()/confirm()/prompt() ──
    // Appended straight to document.body, like attachTooltip's floating tip
    // and the formula-autocomplete popups — never nested inside #__wo_dock
    // or #__wo_setup_modal, so the SAME dialog works identically whether
    // it's triggered from the main panel (Return/Approve/Close) or from
    // inside Setup. Colors are hardcoded to match the shared dark palette
    // rather than var(--wo-*), since neither scoped root's custom
    // properties would cascade to a document.body child. All three return
    // Promises (never rejecting) since a real DOM dialog can't block the
    // way native alert/confirm/prompt do — every call site that gates
    // further action must move that action into the .then().
    function woEscHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }

    function woEscAttr(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }
    var WO_DLG_BTN_CSS = 'font:inherit;font-weight:700;font-size:11.5px;padding:6px 14px;border-radius:6px;border:1px solid #30363d;background:#1f2630;color:#f0f3f6;cursor:pointer;';
    var WO_DLG_BTN_PRIMARY_CSS = WO_DLG_BTN_CSS + 'background:#58a6ff;color:#04101f;border-color:#58a6ff;';

    // wireFn(overlay, cleanup) wires up the dialog's own controls and
    // returns a keydown handler (or nothing) — cleanup(result) resolves the
    // promise and removes the dialog; guarded against firing twice (a click
    // and the Enter/Escape handler could otherwise both fire for one
    // dismissal). Only one of these is ever open at a time — opening a new
    // one preempts whatever's currently showing by invoking ITS cleanup
    // (not just removing its DOM node), so its document-level keydown
    // listener is torn down too. Otherwise a stale listener from a dialog
    // that got DOM-removed but never resolved would still be live, and two
    // overlapping listeners both firing on one Enter/Escape press could
    // double-resolve (e.g. double-routing a work order).
    var __woActiveDialogCleanup = null;
    function woDialogBase(bodyHtml, wireFn) {
        return new Promise(function(resolve) {
            if (__woActiveDialogCleanup) __woActiveDialogCleanup();
            var old = document.getElementById('__wo_dialog');
            if (old) old.remove();
            var overlay = document.createElement('div');
            overlay.id = '__wo_dialog';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",Arial,sans-serif;';
            overlay.innerHTML = '<div style="background:#161b22;border:1px solid #30363d;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:18px;max-width:360px;width:88%;color:#f0f3f6;">' + bodyHtml + '</div>';
            document.body.appendChild(overlay);
            var settled = false;
            function cleanup(result) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeyDown, true);
                overlay.remove();
                if (__woActiveDialogCleanup === cleanup) __woActiveDialogCleanup = null;
                resolve(result);
            }
            __woActiveDialogCleanup = cleanup;
            var onKeyDown = wireFn(overlay, cleanup) || function() {};
            document.addEventListener('keydown', onKeyDown, true);
        });
    }

    function woAlert(message) {
        return woDialogBase(
            '<div style="font-size:12.5px;line-height:1.5;margin-bottom:16px;white-space:pre-wrap;">' + woEscHtml(message) + '</div>' +
            '<div style="display:flex;justify-content:flex-end;">' +
            '<button id="__wo_dlg_ok" type="button" style="' + WO_DLG_BTN_PRIMARY_CSS + '">OK</button>' +
            '</div>',
            function(overlay, cleanup) {
                var okBtn = overlay.querySelector('#__wo_dlg_ok');
                okBtn.onclick = function() {
                    cleanup();
                };
                okBtn.focus();
                return function(e) {
                    if (e.key === 'Enter' || e.key === 'Escape') cleanup();
                };
            }
        );
    }

    function woConfirm(message) {
        return woDialogBase(
            '<div style="font-size:12.5px;line-height:1.5;margin-bottom:16px;white-space:pre-wrap;">' + woEscHtml(message) + '</div>' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="__wo_dlg_cancel" type="button" style="' + WO_DLG_BTN_CSS + '">Cancel</button>' +
            '<button id="__wo_dlg_ok" type="button" style="' + WO_DLG_BTN_PRIMARY_CSS + '">OK</button>' +
            '</div>',
            function(overlay, cleanup) {
                overlay.querySelector('#__wo_dlg_ok').onclick = function() {
                    cleanup(true);
                };
                overlay.querySelector('#__wo_dlg_cancel').onclick = function() {
                    cleanup(false);
                };
                overlay.querySelector('#__wo_dlg_ok').focus();
                return function(e) {
                    if (e.key === 'Enter') cleanup(true);
                    if (e.key === 'Escape') cleanup(false);
                };
            }
        );
    }

    function woPrompt(message, defaultValue) {
        return woDialogBase(
            '<div style="font-size:12.5px;line-height:1.5;margin-bottom:10px;white-space:pre-wrap;">' + woEscHtml(message) + '</div>' +
            '<input id="__wo_dlg_input" type="text" value="' + woEscAttr(defaultValue || '') + '" style="width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:16px;background:#1f2630;border:1px solid #30363d;border-radius:6px;color:#f0f3f6;font:inherit;font-size:12.5px;">' +
            '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="__wo_dlg_cancel" type="button" style="' + WO_DLG_BTN_CSS + '">Cancel</button>' +
            '<button id="__wo_dlg_ok" type="button" style="' + WO_DLG_BTN_PRIMARY_CSS + '">OK</button>' +
            '</div>',
            function(overlay, cleanup) {
                var input = overlay.querySelector('#__wo_dlg_input');
                overlay.querySelector('#__wo_dlg_ok').onclick = function() {
                    cleanup(input.value);
                };
                overlay.querySelector('#__wo_dlg_cancel').onclick = function() {
                    cleanup(null);
                };
                input.focus();
                input.select();
                return function(e) {
                    if (e.key === 'Enter') cleanup(input.value);
                    if (e.key === 'Escape') cleanup(null);
                };
            }
        );
    }
    // Built-in fallback hotkey — used whenever __wo_settings has never set
    // rescanHotkey (undefined), regardless of which config/profile is loaded.
    // An explicit '' (user hit "Clear" in Setup) is a deliberate choice and
    // is left alone, not overridden.
    // Changed from 'Ctrl+Shift+S' to 'Alt+S' in v0.23.0 — anyone who never
    // customized their Scan hotkey (still on the undefined -> fallback path)
    // gets bumped onto the new combo. Worth a changelog callout, not a
    // silent change.
    var DEFAULT_HOTKEY = 'Alt+S';

    // ── Hotkey registry ──
    // Each action's combo lives as its own plain top-level __wo_settings
    // field (matching the pre-existing rescanHotkey convention) rather than
    // a nested object, so it stays device-level automatically — none of
    // these are in PROFILE_SETTINGS_KEYS, so switching profiles never
    // touches them. Approve ships with NO default combo — it's the one
    // destructive action here a user should still opt into assigning, not
    // something that could fire from a stray keystroke on a fresh install.
    // Return now DOES default to a combo (Alt+R, added in v0.23.0) since its
    // own confirm() dialog is what makes that safe. The Settings UI is the
    // only place that enforces "no two actions share a combo" — this
    // registry and applyHotkeys() just trust that invariant already holds.
    var HOTKEY_ACTIONS = [{
        id: 'rescan',
        settingsKey: 'rescanHotkey',
        label: 'Scan',
        defaultHotkey: DEFAULT_HOTKEY,
        run: function() {
            if (actionsBusy()) return;
            runScan(render);
        }
    }, {
        id: 'return',
        settingsKey: 'returnHotkey',
        label: 'Return',
        defaultHotkey: 'Alt+R',
        run: function() {
            if (actionsBusy()) return;
            woConfirm('Return this work order?\n\nThe return message will be inserted into Memo.').then(function(ok) {
                if (!ok || actionsBusy()) return;
                routing = true;
                setActionsLocked(true);
                routeWorkflow('return');
            });
        }
    }, {
        id: 'approve',
        settingsKey: 'approveHotkey',
        label: 'Approve',
        defaultHotkey: '',
        run: function() {
            if (actionsBusy()) return;
            woConfirm('Approve this work order?\n\nRoutes using Complete Review.').then(function(ok) {
                if (!ok || actionsBusy()) return;
                routing = true;
                setActionsLocked(true);
                routeWorkflow('approve');
            });
        }
    }, {
        id: 'fix',
        settingsKey: 'fixHotkey',
        label: 'Fix',
        defaultHotkey: '',
        betaFeature: 'beta_1', // only registered/assignable at all while this beta feature is on
        run: function() {
            if (actionsBusy()) return;
            runScan(render, 'fix');
        }
    }, {
        id: 'copyReturn',
        settingsKey: 'copyReturnHotkey',
        label: 'Copy',
        defaultHotkey: 'Alt+C',
        run: function() {
            copyReturnMessage();
        }
    }];

    // Whether a hotkey action is currently eligible to be assigned/fired —
    // true for every non-beta action; a beta-gated one also needs its
    // feature switched on (isBetaFeatureOn already folds in the server
    // grant check, so this one call covers both halves).
    function hotkeyActionActive(action) {
        return !action.betaFeature || isBetaFeatureOn(action.betaFeature);
    }

    function hotkeyFor(action, st) {
        var v = st[action.settingsKey];
        return (v !== undefined) ? v : action.defaultHotkey;
    }
    var DEFAULT_CFG = {
        groups: [{
            id: 'g_core',
            title: 'Summary',
            layout: 'vertical',
            fields: ['Work Order :: Work Order', 'Work Order :: Description', 'Work Order :: Asset', 'Work Order :: Location', 'Work Order :: Work Type', 'Work Order :: Status'],
            tables: [],
            ruleRefs: [],
            defaultCollapsed: false
        }, {
            id: 'g_time',
            title: 'Time',
            layout: 'horizontal',
            fields: ['Work Order :: Actual Start', 'Work Order :: Actual Finish', 'Work Order :: Duration'],
            tables: [],
            ruleRefs: ['r_duration'],
            defaultCollapsed: false
        }, {
            id: 'g_lot',
            title: 'Lot',
            layout: 'vertical',
            fields: ['Work Order :: Production Run Lot #'],
            tables: [],
            ruleRefs: ['r_lot'],
            defaultCollapsed: false
        }, {
            id: 'g_downtime',
            title: 'Downtime',
            layout: 'vertical',
            fields: [],
            tables: ['m69f3c12d'],
            ruleRefs: ['r_downtime'],
            defaultCollapsed: true
        }, {
            id: 'g_related',
            title: 'Related WOs',
            layout: 'vertical',
            fields: [],
            tables: ['Related Work Orders'],
            ruleRefs: ['r_related'],
            defaultCollapsed: true
        }, {
            id: 'g_approvers',
            title: 'Approvers',
            layout: 'vertical',
            fields: ['Approvers :: Approval Group 1', 'Approvers :: Approval Group 2', 'Approvers :: Approval Group 3'],
            tables: [],
            ruleRefs: ['r_approver'],
            defaultCollapsed: true
        }, {
            id: 'g_labor',
            title: 'Labor',
            layout: 'vertical',
            fields: [],
            tables: ['Labor'],
            ruleRefs: [],
            defaultCollapsed: false
        }],
        rules: [{
            id: 'r_lot',
            label: 'Lot Present',
            formula: "var lot=(F('Work Order :: Production Run Lot #')||'').trim();\nif(/^n\\/?a$/i.test(lot)) return 'na';\nreturn lot.length>3;",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_duration',
            label: 'Time Valid',
            formula: "var d=hours(F('Work Order :: Duration'));\nvar a=hoursBetween(F('Work Order :: Actual Start'),F('Work Order :: Actual Finish'));\nif(d==null) return 'na';\nif(a==null) return 'na';\nreturn d<=a;",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_downtime',
            label: 'Downtime',
            formula: "var wt=F('Work Order :: Work Type');\nif(!oneOf(wt,['DM'])) return 'na';\nreturn rowCount('m69f3c12d')>0;",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_related',
            label: 'Related WO Attached',
            formula: "var text=[F('Work Order :: Description'),F('Work Order :: Reason for Maintenance'),F('Work Order :: As Found Condition'),F('Work Order :: Work Performed')].join(' ');\nvar self=F('Work Order :: Work Order');\nvar found=matches(text,'\\\\b\\\\d{6}\\\\b').filter(function(f){return f!==self;});\nif(found.length===0) return 'na';\nvar vals=col('Related Work Orders','Work Order');\nreturn found.every(function(f){return vals.some(function(v){return (v||'').indexOf(f)>=0;});});",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_approver',
            label: 'Approver',
            formula: "var lot=(F('Work Order :: Production Run Lot #')||'').trim();\nif(/^n\\/?a$/i.test(lot)||lot.length<=3) return 'na';\nvar loc=F('Work Order :: Location')||'';\nvar field='Approvers :: Approval Group 3';\nif(loc.indexOf('AVWP-B1')===0) field='Approvers :: Approval Group 1';\nelse if(loc.indexOf('AVWP-B2')===0) field='Approvers :: Approval Group 2';\nreturn notEmpty(F(field));",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }],
        tableNames: {},
        customTables: {},
        apiTables: {}
    };
    var DEFAULT_SCAN = {
        woTabId: 'mbf28cd64-tab',
        scans: [{
            id: 's_actuals',
            title: 'Actuals',
            type: 'tab',
            tabId: 'm272f5640-tab',
            waitFor: 'Labor',
            waitTable: 'Labor',
            condition: 'true'
        }, {
            id: 's_related',
            title: 'Related Records',
            type: 'tab',
            tabId: 'm4326cf1d-tab',
            waitFor: 'Related Work Orders',
            condition: 'true'
        }, {
            id: 's_approvers',
            title: 'Approvers',
            type: 'tab',
            tabId: 'm99dd217a-tab',
            waitFor: 'Approval Group 1',
            condition: "var lot=(F('Work Order :: Production Run Lot #')||'').trim();\nif(/^n\\/?a$/i.test(lot)) return false;\nreturn lot.length>3;"
        }, {
            id: 's_downtime',
            title: 'Downtime Dialog',
            type: 'dialog',
            eventType: 'MANDWNTIME',
            app: 'wotrack',
            waitFor: 'Start Date',
            waitTable: 'm69f3c12d',
            condition: "oneOf(F('Work Order :: Work Type'),['DM'])"
        }]
    };

    function findAllDocs() {
        var docs = [{
            doc: document,
            win: window
        }];

        function walk(win) {
            try {
                for (var i = 0; i < win.frames.length; i++) {
                    try {
                        var fw = win.frames[i];
                        docs.push({
                            doc: fw.document,
                            win: fw
                        });
                        walk(fw);
                    } catch (e) {}
                }
            } catch (e) {}
        }
        walk(window);
        return docs;
    }

    function findSendEventWin() {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                if (typeof docs[i].win.sendEvent === 'function') return docs[i].win;
            } catch (e) {}
        }
        return null;
    }

    function findElById(id) {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                var el = docs[i].doc.getElementById(id);
                if (el) return el;
            } catch (e) {}
        }
        return null;
    }

    function findLabelEl(doc, text) {
        var labels = doc.querySelectorAll('label');
        for (var i = 0; i < labels.length; i++) {
            if (labels[i].textContent.trim() === text) {
                var f = labels[i].getAttribute('for');
                if (f) {
                    var el = doc.getElementById(f);
                    if (el) return el;
                }
            }
        }
        return null;
    }

    function textMarkerExists(text) {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                var els = docs[i].doc.querySelectorAll('label,[id$="-lb"],th');
                for (var j = 0; j < els.length; j++) {
                    if (els[j].textContent.trim() === text && els[j].offsetParent !== null) return true;
                }
            } catch (e) {}
        }
        return false;
    }

    function getVal(el) {
        if (!el) return '';
        var tag = el.tagName;
        if (tag === 'INPUT') {
            if (el.type === 'checkbox') return el.checked ? 'Yes' : 'No';
            return el.value != null ? el.value.trim() : '';
        }
        if (tag === 'TEXTAREA') return el.value != null ? el.value.trim() : '';
        if (tag === 'SELECT') return el.value || '';
        var direct = (el.textContent || '').trim();
        if (direct) return direct;
        var inp = el.querySelector('input,textarea,select');
        if (inp) {
            if (inp.type === 'checkbox') return inp.checked ? 'Yes' : 'No';
            return (inp.value || '').trim();
        }
        return '';
    }

    function resolveField(entry) {
        var el = entry.idAtPickTime ? findElById(entry.idAtPickTime) : null;
        if (el) return getVal(el);
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            var found = findLabelEl(docs[i].doc, entry.label);
            if (found) return getVal(found);
        }
        return '';
    }

    function prefixIsTable(doc, prefix) {
        try {
            if (doc.querySelector('[id^="' + prefix + '_ttrow_"]')) return true;
            if (doc.querySelector('[id^="' + prefix + '_tdrow_"]')) return true;
            if (doc.querySelector('[id^="' + prefix + '_tbod_"]')) return true;
        } catch (e) {}
        return false;
    }

    function resolveByColumns(entries) {
        if (!entries || !entries.length) return null;
        var docs = findAllDocs();
        var scores = {},
            visiblePrefixes = {};
        for (var i = 0; i < docs.length; i++) {
            try {
                entries.forEach(function(entry) {
                    var els = docs[i].doc.querySelectorAll('[id$="-lb"]');
                    for (var j = 0; j < els.length; j++) {
                        var id = els[j].id;
                        var marker = '_ttrow_[C:' + entry.colIndex + ']';
                        if (id.indexOf(marker) < 0) continue;
                        if (els[j].textContent.trim() !== entry.columnLabel) continue;
                        var prefix = id.split('_ttrow_')[0];
                        scores[prefix] = (scores[prefix] || 0) + 1;
                        if (els[j].offsetParent !== null) visiblePrefixes[prefix] = true;
                    }
                });
            } catch (e) {}
        }
        var best = null,
            bestScore = 0;
        Object.keys(scores).forEach(function(p) {
            var s = scores[p] + (visiblePrefixes[p] ? 100 : 0);
            if (s > bestScore) {
                bestScore = s;
                best = p;
            }
        });
        if (best && scores[best] >= Math.min(2, entries.length)) return best;
        return null;
    }

    function resolveByBlindScan(preferVisible) {
        var docs = findAllDocs();
        var anyMatch = null;
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                var el = d.querySelector('[id*="_tdrow_"],[id*="_tbod_tempty"]');
                if (el) {
                    var m = el.id.match(/^(.+?)_t(?:drow|bod_tempty)/);
                    if (m) {
                        var prefix = m[1];
                        if (preferVisible) {
                            if (el.offsetParent !== null) return prefix;
                            if (!anyMatch) anyMatch = prefix;
                        } else {
                            return prefix;
                        }
                    }
                }
            } catch (e) {}
        }
        return anyMatch;
    }

    function resolveLiveTablePrefix(tableTitle, fallbackPrefix, entries) {
        if (looksLikePrefix(tableTitle)) {
            var d = findPrefixDoc(tableTitle);
            if (d) return tableTitle;
        }
        var docs = findAllDocs();
        var visibleMatch = null,
            anyMatch = null;
        for (var i = 0; i < docs.length; i++) {
            try {
                var labels = docs[i].doc.querySelectorAll('[id$="-lb"]');
                for (var j = 0; j < labels.length; j++) {
                    if (labels[j].textContent.trim() === tableTitle) {
                        var prefix = labels[j].id.slice(0, -3);
                        if (!prefixIsTable(docs[i].doc, prefix)) continue;
                        if (!anyMatch) anyMatch = prefix;
                        if (labels[j].offsetParent !== null) {
                            visibleMatch = prefix;
                            break;
                        }
                    }
                }
                if (visibleMatch) break;
            } catch (e) {}
        }
        if (visibleMatch) return visibleMatch;
        if (anyMatch) return anyMatch;
        var byCols = resolveByColumns(entries);
        if (byCols) return byCols;
        if (fallbackPrefix && findElById(fallbackPrefix + '-lb')) return fallbackPrefix;
        return null;
    }

    function getCellVal(doc, prefix, col, row) {
        var suffixes = ['_txt-tb', '_txt', '_checkbox-tb', '_statictext-lb', '_hyperlink-lb', '_toggleimage-ti'];
        for (var s = 0; s < suffixes.length; s++) {
            var id = prefix + '_tdrow_[C:' + col + ']' + suffixes[s] + '[R:' + row + ']';
            var el = doc.getElementById(id);
            if (el) {
                var v = getVal(el);
                if (v !== '') return v;
                var tc = (el.textContent || '').trim();
                if (tc) return tc;
            }
        }
        var cel = doc.getElementById(prefix + '_tdrow_[C:' + col + ']-c[R:' + row + ']');
        if (cel) {
            var cv = (cel.textContent || '').trim();
            if (cv) return cv;
        }
        return '';
    }

    function getCellValAllDocs(prefix, col, row) {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            var v = getCellVal(docs[i].doc, prefix, col, row);
            if (v !== '') return v;
        }
        return '';
    }

    function resolveTableRows(tableTitle, entries) {
        var livePrefix = resolveLiveTablePrefix(tableTitle, entries[0] && entries[0].tablePrefix, entries);
        if (!livePrefix) return {
            rows: [],
            error: 'Table "' + tableTitle + '" not rendered'
        };
        var rows = {};
        entries.forEach(function(entry) {
            var docs = findAllDocs();
            for (var i = 0; i < docs.length; i++) {
                try {
                    var all = docs[i].doc.querySelectorAll('[id^="' + livePrefix + '_tdrow_[C:' + entry.colIndex + ']"]');
                    all.forEach(function(c) {
                        var m = c.id.match(/\[R:(\d+)\]$/);
                        if (m) {
                            if (!rows[m[1]]) rows[m[1]] = {};
                            if (!rows[m[1]][entry.columnLabel]) rows[m[1]][entry.columnLabel] = getVal(c);
                        }
                    });
                } catch (e) {}
            }
        });
        if (!entries.length) {
            var docs = findAllDocs();
            var colMap = {};
            docs.forEach(function(x) {
                try {
                    x.doc.querySelectorAll('[id^="' + livePrefix + '_ttrow_"][id$="-lb"]').forEach(function(lbl) {
                        var m = lbl.id.match(/_ttrow_\[C:(\d+)\]_ttitle-lb$/);
                        if (m) colMap[m[1]] = lbl.textContent.trim() || ('Col' + m[1]);
                    });
                } catch (e) {}
            });
            var rowSet = {};
            docs.forEach(function(x) {
                try {
                    x.doc.querySelectorAll('[id^="' + livePrefix + '_tdrow_"]').forEach(function(c) {
                        var rm = c.id.match(/\[R:(\d+)\](?:[^\[]*)$/);
                        if (rm && /^\d+$/.test(rm[1])) rowSet[rm[1]] = true;
                    });
                } catch (e) {}
            });
            var rowIds = Object.keys(rowSet).sort(function(a, b) {
                return +a - +b;
            });
            var colIds = Object.keys(colMap);
            docs.forEach(function(x) {
                try {
                    rowIds.forEach(function(r) {
                        colIds.forEach(function(c) {
                            var label = colMap[c];
                            if (!rows[r]) rows[r] = {};
                            if (!rows[r][label] || rows[r][label] === '') rows[r][label] = getCellVal(x.doc, livePrefix, c, r);
                        });
                    });
                } catch (e) {}
            });
        }
        return {
            rows: Object.keys(rows).sort(function(a, b) {
                return +a - +b;
            }).map(function(k) {
                return rows[k];
            }),
            error: null
        };
    }

    function looksLikePrefix(s) {
        return /^m[0-9a-f]{6,}/.test(s) || (/^[a-z][a-z0-9]{5,}$/.test(s) && s.indexOf(' ') < 0);
    }

    // Built-in friendly names for raw internal table identifiers that ship
    // with the tool's own defaults (e.g. the Downtime dialog's grid has no
    // discoverable header text, so its "table" is the raw Maximo widget
    // prefix). Covers every user out of the box, including ones with an
    // existing saved config from before cfg.tableNames existed — a per-
    // profile override in cfg.tableNames always takes precedence over this.
    var KNOWN_TABLE_NAMES = {
        'm69f3c12d': 'Downtime History'
    };

    // Resolves a raw table identifier (a human title like "Related Work
    // Orders", already fine as-is, OR an opaque internal prefix like
    // "m69f3c12d") to whatever a user should actually see for it: their own
    // per-profile rename (cfg.tableNames), falling back to a built-in known
    // name, falling back to the raw identifier itself. Never changes what's
    // actually STORED anywhere (group.table, scan waitTable, rowDetailFields
    // tablePrefix all keep the raw id as their real value) — this is a
    // display-only lookup, called fresh at render time so a rename in the
    // Tables tab shows up everywhere immediately.
    function friendlyTableName(cfg, id) {
        if (!id) return id;
        var overrides = (cfg && cfg.tableNames) || {};
        return overrides[id] || KNOWN_TABLE_NAMES[id] || id;
    }

    // Read accessor for a group's linked tables. Groups used to carry a
    // single `table` (string|null) field - now `tables` (string[]), so a
    // group can display more than one. Rather than migrating every saved
    // config's stored shape (real risk on a live, single-source-of-truth
    // config with no way to roll back a bad migration), every read goes
    // through this: prefer `group.tables` if present, else wrap the legacy
    // `group.table` in a single-element array, else empty. Never writes
    // anything back - the Groups Setup tab is the only place that writes
    // `group.tables` directly (see its multi-select), at which point that
    // group is on the new shape for good; `group.table` itself is left
    // alone (dead, unread) rather than deleted, since deleting it would be
    // a write this accessor is deliberately not in the business of making.
    function groupTables(group) {
        if (!group) return [];
        if (Array.isArray(group.tables)) return group.tables;
        return group.table ? [group.table] : [];
    }

    function findPrefixDoc(prefix) {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                if (docs[i].doc.querySelector('[id^="' + prefix + '_tdrow_"],[id^="' + prefix + '_tbod_tempty"]')) return docs[i].doc;
            } catch (e) {}
        }
        return null;
    }
    var lastPrefixLog = {};

    function extractSnapshot() {
        var cfg = {};
        try {
            cfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}
        var fields = {},
            tableGroups = {};
        Object.keys(cfg).forEach(function(k) {
            var e = cfg[k];
            if (e.type === 'table-column') {
                if (!tableGroups[e.tableTitle]) tableGroups[e.tableTitle] = [];
                tableGroups[e.tableTitle].push(e);
            } else fields[e.tab + ' :: ' + e.label] = resolveField(e);
        });
        var cfg2 = getCfg();
        cfg2.groups.forEach(function(g) {
            groupTables(g).forEach(function(t) {
                // Custom/API tables (Tables tab) never come from a DOM scan —
                // registering one here would make resolveTableRowsForDisplay()
                // find a (wrongly) already-captured empty cache.tables[t]
                // entry and never fall through to the real custom/API data.
                if ((cfg2.customTables && cfg2.customTables[t]) || (cfg2.apiTables && cfg2.apiTables[t])) return;
                if (!tableGroups[t]) tableGroups[t] = [];
            });
        });
        var tables = {},
            tableErrors = {};
        Object.keys(tableGroups).forEach(function(t) {
            var lp = resolveLiveTablePrefix(t, tableGroups[t][0] && tableGroups[t][0].tablePrefix, tableGroups[t]);
            lastPrefixLog[t] = lp || '(none)';
            var r = resolveTableRows(t, tableGroups[t]);
            tables[t] = r.rows;
            if (r.error) tableErrors[t] = r.error;
        });
        return {
            fields: fields,
            tables: tables,
            tableErrors: tableErrors
        };
    }
    var cache = {
        fields: {},
        tables: {},
        tableErrors: {}
    };
    var hasScanned = false;

    function mergeSnapshot(snap) {
        Object.keys(snap.fields).forEach(function(k) {
            if (snap.fields[k] !== '') cache.fields[k] = snap.fields[k];
            else if (!(k in cache.fields)) cache.fields[k] = '';
        });
        Object.keys(snap.tables).forEach(function(t) {
            if (snap.tables[t].length > 0 || !(t in cache.tables)) cache.tables[t] = snap.tables[t];
        });
        Object.keys(snap.tableErrors).forEach(function(t) {
            if (!cache.tables[t] || cache.tables[t].length === 0) cache.tableErrors[t] = snap.tableErrors[t];
        });
        Object.keys(cache.tableErrors).forEach(function(t) {
            if (cache.tables[t] && cache.tables[t].length > 0) delete cache.tableErrors[t];
        });
    }

    function parseMaxDate(str) {
        if (!str) return null;
        var p = str.trim().split(' ');
        if (p.length < 2) return null;
        var dp = p[0].split('/'),
            tp = p[1].split(':');
        if (dp.length < 3) return null;
        return new Date(+dp[2], +dp[1] - 1, +dp[0], +(tp[0] || 0), +(tp[1] || 0));
    }

    function hoursFn(str) {
        if (!str) return null;
        var s = ('' + str).trim();
        var neg = s.charAt(0) === '-';
        if (neg) s = s.slice(1);
        var p = s.split(':');
        var v;
        if (p.length >= 2) {
            v = (+p[0]) + (+p[1]) / 60;
        } else {
            v = parseFloat(s);
            if (isNaN(v)) return null;
        }
        return neg ? -v : v;
    }

    function hoursBetweenFn(a, b) {
        var d1 = parseMaxDate(a),
            d2 = parseMaxDate(b);
        if (!d1 || !d2) return null;
        return (d2 - d1) / 3600000;
    }

    function isEmptyFn(v) {
        return !v || ('' + v).trim() === '';
    }

    function notEmptyFn(v) {
        return !isEmptyFn(v);
    }

    function oneOfFn(v, arr) {
        return arr.indexOf(v) >= 0;
    }

    function containsFn(t, p) {
        try {
            return new RegExp(p).test(t || '');
        } catch (e) {
            return false;
        }
    }

    function matchesFn(t, p) {
        try {
            var re = new RegExp(p, 'g'),
                out = [],
                m;
            while ((m = re.exec(t || ''))) {
                out.push(m[0]);
                if (m.index === re.lastIndex) re.lastIndex++;
            }
            var s = {},
                u = [];
            out.forEach(function(x) {
                if (!s[x]) {
                    s[x] = 1;
                    u.push(x);
                }
            });
            return u;
        } catch (e) {
            return [];
        }
    }

    function maxLaborHoursFn(tableData, nameCol, hoursCol) {
        nameCol = nameCol || 'Name';
        hoursCol = hoursCol || 'Regular Hours';
        if (!tableData || !tableData.length) return null;
        var totals = {};
        tableData.forEach(function(row) {
            var person = (row[nameCol] || '').trim() || '(unknown)';
            var h = hoursFn(row[hoursCol]);
            if (h === null) return;
            totals[person] = (totals[person] || 0) + h;
        });
        var keys = Object.keys(totals);
        if (!keys.length) return null;
        var max = null;
        keys.forEach(function(k) {
            if (max === null || totals[k] > max) max = totals[k];
        });
        return max;
    }

    function ifBlankFn(val, fallback) {
        return isEmptyFn(val) ? fallback : val;
    }

    function trimFn(s) {
        return (s == null ? '' : String(s)).trim();
    }

    function upperFn(s) {
        return (s == null ? '' : String(s)).toUpperCase();
    }

    function lowerFn(s) {
        return (s == null ? '' : String(s)).toLowerCase();
    }

    function leftFn(s, n) {
        return (s == null ? '' : String(s)).slice(0, n);
    }

    function rightFn(s, n) {
        var str = s == null ? '' : String(s);
        return str.slice(Math.max(0, str.length - n));
    }

    // 0-indexed (like JS's own substr), not Excel's 1-indexed MID - this
    // formula language already mirrors JS elsewhere (regex helpers, real
    // .indexOf semantics in has()), so staying 0-indexed is the less
    // surprising choice here even though the name is Excel's.
    function midFn(s, start, len) {
        return (s == null ? '' : String(s)).substr(start, len);
    }

    function toNumOrNull(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = parseFloat(String(v).replace(/,/g, ''));
        return isNaN(n) ? null : n;
    }

    // Click-to-sort for a group's displayed table (§ render()). Numeric-aware
    // via the same toNumOrNull() sum()/avg()/toNumber() already use, so a
    // column of "1,234"-style numbers sorts numerically instead of
    // lexicographically (which would put "10" before "2") - falls back to a
    // case-insensitive locale compare for anything that isn't numeric.
    // Returns a new array; never mutates the resolved rows in place, since
    // those can be the SAME array reference held in cache.tables (a live
    // scan result) or returned straight through by resolveApiTable()'s
    // cache.
    function sortTableRows(rows, col, dir) {
        var copy = rows.slice();
        copy.sort(function(a, b) {
            var av = a[col],
                bv = b[col];
            var an = toNumOrNull(av),
                bn = toNumOrNull(bv);
            var cmp = (an !== null && bn !== null) ?
                (an - bn) :
                String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv), undefined, { sensitivity: 'base' });
            return cmp * dir;
        });
        return copy;
    }

    // toNumber()/toString() — explicit type conversion for a formula, e.g.
    // a captured Maximo field is always a string even when it looks
    // numeric, so oneOf()/sum()/avg() or a numeric comparison can need this
    // first. Reuses the same comma-stripping toNumOrNull() sum()/avg()
    // already rely on, so "1,234" converts the same way everywhere.
    function toStringFn(v) {
        return v == null ? '' : String(v);
    }

    function sumFn(arr) {
        var total = 0;
        (arr || []).forEach(function(v) {
            var n = toNumOrNull(v);
            if (n !== null) total += n;
        });
        return total;
    }

    function avgFn(arr) {
        var nums = (arr || []).map(toNumOrNull).filter(function(n) {
            return n !== null;
        });
        if (!nums.length) return null;
        return sumFn(nums) / nums.length;
    }

    function todayFn() {
        var d = new Date();

        function pad(n) {
            return (n < 10 ? '0' : '') + n;
        }
        // Same DD/MM/YYYY HH:MM shape parseMaxDate() expects, so this drops
        // straight into hoursBetween()/daysBetween() alongside a captured
        // Maximo date field with no reformatting needed.
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function daysBetweenFn(a, b) {
        var h = hoursBetweenFn(a, b);
        return h === null ? null : h / 24;
    }

    function buildCtx(data) {
        function F(key) {
            if (data.fields.hasOwnProperty(key)) return data.fields[key];
            var suf = ' :: ' + key;
            var fk = Object.keys(data.fields).filter(function(k) {
                return k.slice(-suf.length) === suf;
            })[0];
            return fk ? data.fields[fk] : '';
        }

        // Scanned tables (data.tables, captured from the live Maximo DOM)
        // take priority; a custom table (cfg.customTables, hand-entered in
        // the Tables Setup tab) fills in next when no scanned table exists
        // under that same id — this is what makes a custom lookup table
        // resolve even pre-scan (data.tables is empty before the first
        // scan), since customTables comes from config, not the cache. An
        // API table (cfg.apiTables, beta_2-only) is the last fallback —
        // live REST data resolved through resolveApiTable().
        function T(t) {
            if (data.tables && data.tables.hasOwnProperty(t)) return data.tables[t];
            var cfgNow = getCfg();
            var custom = cfgNow.customTables || {};
            if (custom[t]) return resolveCustomTableRows(custom[t], data);
            var apiDef = (cfgNow.apiTables || {})[t];
            if (apiDef) return resolveApiTable(t, apiDef, data);
            return [];
        }
        return {
            F: F,
            T: T,
            rowCount: function(t) {
                return T(t).length;
            },
            col: function(t, n) {
                return T(t).map(function(r) {
                    return r[n];
                });
            },
            has: function(t, c, v) {
                return T(t).some(function(r) {
                    return (r[c] || '').indexOf(v) >= 0;
                });
            },
            lookup: function(t, keyCol, keyVal, returnCol) {
                var rows = T(t);
                for (var i = 0; i < rows.length; i++) {
                    if (String(rows[i][keyCol]) === String(keyVal)) return rows[i][returnCol];
                }
                return '';
            },
            count: function(t, c, v) {
                return T(t).filter(function(r) {
                    return (r[c] || '').indexOf(v) >= 0;
                }).length;
            },
            isEmpty: isEmptyFn,
            notEmpty: notEmptyFn,
            ifBlank: ifBlankFn,
            toNumber: toNumOrNull,
            toString: toStringFn,
            trim: trimFn,
            upper: upperFn,
            lower: lowerFn,
            left: leftFn,
            right: rightFn,
            mid: midFn,
            sum: sumFn,
            avg: avgFn,
            today: todayFn,
            hours: hoursFn,
            hoursBetween: hoursBetweenFn,
            daysBetween: daysBetweenFn,
            oneOf: oneOfFn,
            contains: containsFn,
            matches: matchesFn,
            maxLaborHours: function(tableTitle, nameCol, hoursCol) {
                return maxLaborHoursFn(T(tableTitle), nameCol, hoursCol);
            },
            whoami: function(field) {
                var s;
                try {
                    s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                } catch (e) {
                    s = {};
                }
                if (!s.whoamiInFormulas) return '';
                return (whoamiCache && whoamiCache[field]) || '';
            },
            domain: domainFn,
            assetWOHistory: assetWOHistoryFn,
            assetDowntimeHistory: assetDowntimeHistoryFn,
            V: function(id) {
                var vars = getVars();
                for (var vi = 0; vi < vars.length; vi++) {
                    if (vars[vi].id === id || vars[vi].label === id) {
                        var vr = runVariable(vars[vi].formula, data);
                        return vr.error ? '' : (vr.value !== null ? vr.value : '');
                    }
                }
                return '';
            }
        };
    }

    var ARGN = ['F', 'T', 'rowCount', 'col', 'has', 'lookup', 'count', 'isEmpty', 'notEmpty', 'ifBlank', 'toNumber', 'toString', 'trim', 'upper', 'lower', 'left', 'right', 'mid', 'sum', 'avg', 'today', 'hours', 'hoursBetween', 'daysBetween', 'oneOf', 'contains', 'matches', 'maxLaborHours', 'whoami', 'domain', 'assetWOHistory', 'assetDowntimeHistory', 'V'];

    // ARGN in lowercase -> canonical casing, e.g. 'daysbetween' -> 'daysBetween'.
    // Built once (ARGN never changes at runtime) rather than per-call.
    var ARGN_LOWER = {};
    ARGN.forEach(function(name) {
        ARGN_LOWER[name.toLowerCase()] = name;
    });

    // A formula author typing a helper name is easy to get wrong on
    // capitalization (daysbetween vs daysBetween) — since the generated
    // Function only binds the exact-case ARGN names as parameters, a
    // mistyped case is a silent ReferenceError at eval time otherwise.
    // Rewrites every bare identifier immediately followed by '(' (i.e. a
    // function call, not some unrelated bare word) to its canonical ARGN
    // casing, case-insensitively matched — this is the one place that
    // actually runs, so every formula entry point (runVariable/runFormula/
    // runActions' action.value/resolveMsg's {{}} interpolation) normalizes
    // through this same function rather than four separate ad hoc fixes.
    // Skips string-literal contents (naive quote-parity scan, same
    // approach as attachFormulaAssist's insideStringLiteral) so a table/
    // column name that happens to collide with a helper name in a quoted
    // arg is never touched.
    function normalizeFormulaFunctionCase(formula) {
        if (!formula) return formula;
        var out = '',
            i = 0,
            len = formula.length,
            inStr = null;
        while (i < len) {
            var c = formula[i];
            if (inStr) {
                out += c;
                if (c === '\\' && i + 1 < len) {
                    out += formula[i + 1];
                    i += 2;
                    continue;
                }
                if (c === inStr) inStr = null;
                i++;
                continue;
            }
            if (c === "'" || c === '"') {
                inStr = c;
                out += c;
                i++;
                continue;
            }
            if (/[A-Za-z_$]/.test(c)) {
                var j = i;
                while (j < len && /[A-Za-z0-9_$]/.test(formula[j])) j++;
                var word = formula.slice(i, j);
                var k = j;
                while (k < len && /\s/.test(formula[k])) k++;
                out += (formula[k] === '(' && ARGN_LOWER.hasOwnProperty(word.toLowerCase())) ? ARGN_LOWER[word.toLowerCase()] : word;
                i = j;
                continue;
            }
            out += c;
            i++;
        }
        return out;
    }

    function runVariable(formula, data) {
        formula = normalizeFormulaFunctionCase(formula);
        var c = buildCtx(data);
        var av = [c.F, c.T, c.rowCount, c.col, c.has, c.lookup, c.count, c.isEmpty, c.notEmpty, c.ifBlank, c.toNumber, c.toString, c.trim, c.upper, c.lower, c.left, c.right, c.mid, c.sum, c.avg, c.today, c.hours, c.hoursBetween, c.daysBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.whoami, c.domain, c.assetWOHistory, c.assetDowntimeHistory, c.V];
        var fn;
        try {
            fn = Function.apply(null, ARGN.concat(['return (' + formula + ');']));
        } catch (e) {
            try {
                fn = Function.apply(null, ARGN.concat([formula]));
            } catch (e2) {
                return {
                    value: null,
                    error: e2.message
                };
            }
        }
        try {
            var r = fn.apply(null, av);
            return {
                value: r != null ? r : null,
                error: null
            };
        } catch (e) {
            return {
                value: null,
                error: e.message
            };
        }
    }

    function runFormula(formula, data) {
        formula = normalizeFormulaFunctionCase(formula);
        var c = buildCtx(data);
        var av = [c.F, c.T, c.rowCount, c.col, c.has, c.lookup, c.count, c.isEmpty, c.notEmpty, c.ifBlank, c.toNumber, c.toString, c.trim, c.upper, c.lower, c.left, c.right, c.mid, c.sum, c.avg, c.today, c.hours, c.hoursBetween, c.daysBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.whoami, c.domain, c.assetWOHistory, c.assetDowntimeHistory, c.V];
        var fn;
        try {
            fn = Function.apply(null, ARGN.concat(['return (' + formula + ');']));
        } catch (e) {
            try {
                fn = Function.apply(null, ARGN.concat([formula]));
            } catch (e2) {
                return {
                    status: 'error',
                    detail: e2.message
                };
            }
        }
        try {
            var r = fn.apply(null, av);
            if (r === 'na') return {
                status: 'na',
                detail: 'Not applicable'
            };
            if (r === 'warn') return {
                status: 'warn',
                detail: 'Warning'
            };
            if (r === true) return {
                status: 'pass',
                detail: 'OK'
            };
            if (r === false) return {
                status: 'fail',
                detail: 'Failed'
            };
            return {
                status: 'na',
                detail: 'Returned: ' + JSON.stringify(r)
            };

        } catch (e) {
            return {
                status: 'error',
                detail: e.message
            };
        }
    }

    function formulaBool(formula, data) {
        var r = runFormula(formula, data);
        return r.status === 'pass';
    }

    // ── Rule message schema migration ──
    // Old shape: rule.passMsg (string), rule.shortPassMsg/shortFailMsg/shortWarnMsg
    // (strings), rule.failMsgs/warnMsgs (arrays of string or {condition,msg}, parsed
    // from a single textarea via a ' :: ' delimiter that collides with qualified
    // field names like "Tab :: Field"), plus per-rule return-message config living
    // separately in __wo_settings.ruleReturnCfg.
    // New shape: rule.pass/fail/warn, each {short, long:[{condition,msg}]}; fail/warn
    // also carry {returnMode, returnCustom} inline instead of in Settings.
    // normalizeCfg() runs on every getCfg() read (not just once at startup) so any
    // path that can put old-shape rules back into RKEY — an old profile switch, a
    // restored backup, a stale pinned version's data — self-heals on the next read
    // instead of silently breaking new-schema consumers.
    function isNewRuleShape(rule) {
        return !!(rule && rule.pass && rule.fail && rule.warn &&
            typeof rule.fail === 'object' && !Array.isArray(rule.fail));
    }

    function normalizeMsgEntry(e) {
        if (typeof e === 'string') return {
            condition: '',
            msg: e
        };
        return {
            condition: (e && e.condition) || '',
            msg: (e && e.msg) || ''
        };
    }

    function normalizeRule(rule, legacyReturnCfg) {
        if (isNewRuleShape(rule)) return rule;
        var oldRet = legacyReturnCfg || {
            fail: 'none',
            warn: 'none',
            custom: ''
        };
        var mode = function(m) {
            return m === 'full' ? 'long' : (m || 'none');
        };
        var out = {
            id: rule.id,
            label: rule.label,
            formula: rule.formula,
            pass: {
                short: rule.shortPassMsg || '',
                long: rule.passMsg ? [{
                    condition: '',
                    msg: rule.passMsg
                }] : []
            },
            fail: {
                short: rule.shortFailMsg || '',
                long: (rule.failMsgs || []).map(normalizeMsgEntry),
                returnMode: mode(oldRet.fail),
                returnCustom: oldRet.custom || ''
            },
            warn: {
                short: rule.shortWarnMsg || '',
                long: (rule.warnMsgs || []).map(normalizeMsgEntry),
                returnMode: mode(oldRet.warn),
                returnCustom: oldRet.custom || ''
            }
        };
        return out;
    }

    // legacyAllOverride lets callers hand in the ruleReturnCfg that actually
    // belongs to `raw` (e.g. a stored profile's own settings) instead of
    // defaulting to whatever's in the live __wo_settings — otherwise migrating
    // a profile that isn't the active one would fold in the WRONG rule's
    // return-message config (whatever the currently-active profile left behind).
    function normalizeCfg(raw, legacyAllOverride) {
        if (!raw || !raw.rules) return raw;
        var anyLegacy = raw.rules.some(function(r) {
            return !isNewRuleShape(r);
        });
        if (!anyLegacy) return raw;
        var legacyAll = legacyAllOverride;
        if (!legacyAll) {
            legacyAll = {};
            try {
                var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                legacyAll = st.ruleReturnCfg || {};
            } catch (e) {}
        }
        var out = {};
        for (var k in raw) {
            if (raw.hasOwnProperty(k)) out[k] = raw[k];
        }
        out.rules = raw.rules.map(function(r) {
            return isNewRuleShape(r) ? r : normalizeRule(r, legacyAll[r.id]);
        });
        return out;
    }

    function getCfg() {
        try {
            var raw = JSON.parse(localStorage.getItem(RKEY) || 'null') || DEFAULT_CFG;
            return normalizeCfg(raw);
        } catch (e) {
            return DEFAULT_CFG;
        }
    }

    function saveCfg(c) {
        localStorage.setItem(RKEY, JSON.stringify(c));
        localStorage.setItem('__wo_config_saved_at', new Date().toISOString());
        autoSaveToFile();
    }


    function getScan() {
        try {
            return JSON.parse(localStorage.getItem(SKEY) || 'null') || DEFAULT_SCAN;
        } catch (e) {
            return DEFAULT_SCAN;
        }
    }

    function saveScan(s) {
        localStorage.setItem(SKEY, JSON.stringify(s));
        localStorage.setItem('__wo_config_saved_at', new Date().toISOString());
        autoSaveToFile();
    }


    function getGS() {
        try {
            return JSON.parse(localStorage.getItem(GSTATE) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveGS(s) {
        localStorage.setItem(GSTATE, JSON.stringify(s));
    }

    function saveFieldCfg(fc) {
        localStorage.setItem(FKEY, JSON.stringify(fc));
        localStorage.setItem('__wo_config_saved_at', new Date().toISOString());
        autoSaveToFile();
    }

    function saveSettingsCfg(st) {
        localStorage.setItem('__wo_settings', JSON.stringify(st));
        autoSaveToFile();
        // Note: settings changes don't update __wo_config_saved_at
        // because they include backup/update prefs that change frequently
        // and don't represent "user config" changes
    }

    // ── IndexedDB helpers ──
    function openIDB() {
        return new Promise(function(resolve, reject) {
            var req = indexedDB.open('__wo_tool_db', 1);
            req.onupgradeneeded = function(e) {
                e.target.result.createObjectStore('kv');
            };
            req.onsuccess = function(e) {
                resolve(e.target.result);
            };
            req.onerror = function() {
                reject(req.error);
            };
        });
    }

    function idbGet(db, key) {
        return new Promise(function(resolve) {
            var tx = db.transaction('kv', 'readonly');
            var req = tx.objectStore('kv').get(key);
            req.onsuccess = function() {
                resolve(req.result);
            };
            req.onerror = function() {
                resolve(null);
            };
        });
    }

    function idbPut(db, key, val) {
        return new Promise(function(resolve) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(val, key);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    }

    function idbDelete(db, key) {
        return new Promise(function(resolve) {
            var tx = db.transaction('kv', 'readwrite');
            tx.objectStore('kv').delete(key);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
    }

    // ── Backup blob builder ──
    function buildBackupBlob() {
        return JSON.stringify({
            configVersion: CURRENT_CONFIG_VERSION,
            rules: getCfg(),
            scan: getScan(),
            fields: JSON.parse(localStorage.getItem(FKEY) || '{}'),
            state: getGS(),
            vars: getVars(),
            settings: JSON.parse(localStorage.getItem('__wo_settings') || '{}'),
            src: localStorage.getItem('__wo_tool_src') || '',
            profiles: getProfiles(),
            activeProfileId: getActiveProfileId(),
            savedAt: new Date().toISOString(),
            version: TOOL_VERSION
        }, null, 2);
    }

    function isPlainObj(x) {
        return !!x && typeof x === 'object' && !Array.isArray(x);
    }

    // Shared shape/version gate for anything that can inject a config blob
    // into the tool (auto-backup file, cross-browser restore, raw-paste
    // Import) — throws a user-facing message instead of letting garbage
    // (wrong file type, hand-edited JSON, a future tool version's shape)
    // partially land in localStorage. Deliberately lenient about *unknown*
    // keys (forward-compatible) but strict about *known* keys having the
    // wrong basic type, since that's the actual "wrong file" signal.
    function validateBackupShape(b) {
        if (!isPlainObj(b)) {
            throw new Error('Not a valid WO Tool config file (expected a JSON object).');
        }
        var v = b.configVersion || 1;
        if (v > CURRENT_CONFIG_VERSION) {
            throw new Error('This config was saved by a newer version of WO Review Tool (config format v' + v +
                ') than this one understands (up to v' + CURRENT_CONFIG_VERSION + '). Update the tool before using it.');
        }
        ['rules', 'scan', 'fields', 'state', 'settings', 'profiles'].forEach(function(key) {
            if (b[key] !== undefined && !isPlainObj(b[key])) {
                throw new Error('Not a valid WO Tool config file (' + key + ' section is malformed).');
            }
        });
        if (b.vars !== undefined && !Array.isArray(b.vars)) {
            throw new Error('Not a valid WO Tool config file (vars section is malformed).');
        }
        if (b.rules !== undefined && b.rules.rules !== undefined && !Array.isArray(b.rules.rules)) {
            throw new Error('Not a valid WO Tool config file (rules section is malformed).');
        }
        if (b.src !== undefined) {
            if (typeof b.src !== 'string') {
                throw new Error('Not a valid WO Tool config file (src must be text).');
            }
            if (b.src) {
                try {
                    new Function(b.src);
                } catch (e) {
                    throw new Error('Backup file\'s embedded tool code is corrupt (' + e.message + ') — refusing to restore it.');
                }
            }
        }
    }

    // ── Auto-save to file ──
    function autoSaveToFile() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (!st.autoBackup) return;
        if (typeof window.showSaveFilePicker === 'undefined') return;
        openIDB().then(function(db) {
            idbGet(db, 'fileHandle').then(function(handle) {
                if (!handle) return;
                handle.queryPermission({
                    mode: 'readwrite'
                }).then(function(perm) {
                    var doWrite = function() {
                        handle.createWritable().then(function(writable) {
                            return writable.write(buildBackupBlob())
                                .then(function() {
                                    return writable.close();
                                });
                        }).catch(function(e) {
                            console.warn('[WO Tool] Auto-backup write failed:', e);
                        });
                    };
                    if (perm === 'granted') {
                        doWrite();
                    } else if (perm === 'prompt') {
                        handle.requestPermission({
                            mode: 'readwrite'
                        }).then(function(p2) {
                            if (p2 === 'granted') doWrite();
                        });
                    }
                }).catch(function(e) {
                    if (e && (e.name === 'NotFoundError' || e.name === 'NotAllowedError')) {
                        handleFileMissing();
                    }
                });
            });
        }).catch(function() {});
    }

    // ── Apply backup object to localStorage ──
    // Throws (via validateBackupShape) before writing anything if the blob
    // is malformed or from a newer configVersion — callers must catch and
    // surface e.message rather than assume this always succeeds.
    function applyBackup(b) {
        validateBackupShape(b);
        if (b.rules) localStorage.setItem(RKEY, JSON.stringify(b.rules));
        if (b.scan) localStorage.setItem(SKEY, JSON.stringify(b.scan));
        if (b.fields) localStorage.setItem(FKEY, JSON.stringify(b.fields));
        if (b.state) localStorage.setItem(GSTATE, JSON.stringify(b.state));
        if (b.vars) localStorage.setItem(VKEY, JSON.stringify(b.vars));
        if (b.settings) localStorage.setItem('__wo_settings', JSON.stringify(b.settings));
        if (b.src) localStorage.setItem('__wo_tool_src', b.src); // ← ADD THIS
        if (b.profiles) localStorage.setItem(PROFILES_KEY, JSON.stringify(b.profiles));
        if (b.activeProfileId) localStorage.setItem(ACTIVE_PROFILE_KEY, b.activeProfileId);
        localStorage.setItem('__wo_config_saved_at', b.savedAt || new Date().toISOString());
    }

    // ── Config profiles ──
    // A profile is a portable, named config subset (rules/scan/fields/state/vars
    // + config-level settings) — deliberately NOT the same thing as a full backup.
    // buildBackupBlob()/applyBackup() remain the full-device backup/restore tools
    // (everything, including src and device settings). Profiles only ever carry
    // the keys below; applying one MERGES into __wo_settings rather than replacing
    // it, so switching profiles can never silently reset your update channel,
    // auto-update/backup preferences, or hotkey.
    var PROFILES_KEY = '__wo_profiles';
    var ACTIVE_PROFILE_KEY = '__wo_active_profile_id';
    // ruleReturnCfg/ruleMessages used to live here (rule return-message config
    // in Settings, keyed by rule id) — that's now folded inline into each rule
    // (rule.fail.returnMode/returnCustom, rule.warn.returnMode/returnCustom) by
    // normalizeCfg(), so it travels with the rules themselves and no longer
    // needs its own profile-settings key.
    var PROFILE_SETTINGS_KEYS = ['msgPrefix', 'msgSuffix', 'msgDelim', 'autoScan'];

    // ── Config version control ──
    // configVersion has existed on every profile since it was added, but
    // nothing ever read it — it was a number that got carried around and
    // never compared against anything. Only shape 1 has ever shipped, so
    // there's nothing to migrate FROM yet; this establishes the mechanism
    // (a version-keyed table of migration steps, run in order, stamping the
    // result) so the day a real breaking change ships, there's already a
    // place to put it instead of another silent shape-sniff like
    // normalizeCfg()'s legacy-rule-shape detection.
    var CURRENT_CONFIG_VERSION = 1;

    // Keyed by the version a migration step upgrades FROM. Add an entry
    // here (and bump CURRENT_CONFIG_VERSION) the next time a profile's
    // on-disk shape needs a real breaking change.
    var CONFIG_MIGRATIONS = {};

    // Runs any migrations needed to bring a profile blob up to
    // CURRENT_CONFIG_VERSION, in order, and stamps the result. No-ops today
    // (CONFIG_MIGRATIONS is empty) but every profile passes through this
    // before being applied, so it's live infrastructure, not a stub.
    //
    // THROWS if p.configVersion is NEWER than this running code's
    // CURRENT_CONFIG_VERSION — a config produced by a newer tool version,
    // in a shape this older code was never taught to migrate FROM (there's
    // nothing to migrate TO here, only forward). Deliberately fails closed
    // instead of the old behavior (silently overwriting configVersion
    // downward and proceeding anyway) - callers must not catch-and-ignore
    // this; let it propagate to a user-facing woAlert(e.message).
    function migrateProfile(p) {
        if (!p) return p;
        var v = p.configVersion || 1;
        if (v > CURRENT_CONFIG_VERSION) {
            throw new Error('This config was saved by a newer version of WO Review Tool (config format v' + v +
                ') than this one understands (up to v' + CURRENT_CONFIG_VERSION + '). Update the tool before using it.');
        }
        while (v < CURRENT_CONFIG_VERSION && CONFIG_MIGRATIONS[v]) {
            p = CONFIG_MIGRATIONS[v](p);
            v++;
            setStatus('Config migrated to v' + v + '.');
        }
        p.configVersion = CURRENT_CONFIG_VERSION;
        return p;
    }

    function getProfiles() {
        try {
            return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveProfiles(p) {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(p));
        localStorage.setItem('__wo_config_saved_at', new Date().toISOString());
        autoSaveToFile();
    }

    function getActiveProfileId() {
        return localStorage.getItem(ACTIVE_PROFILE_KEY) || '';
    }

    // Snapshot the live config into a portable profile blob (config-level only).
    function snapshotProfile(meta) {
        var fullSettings = {};
        try {
            fullSettings = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        var settings = {};
        PROFILE_SETTINGS_KEYS.forEach(function(k) {
            if (fullSettings[k] !== undefined) settings[k] = fullSettings[k];
        });
        return {
            id: meta.id,
            name: meta.name,
            description: meta.description || '',
            configVersion: meta.configVersion || 1,
            rules: getCfg(),
            scan: getScan(),
            fields: JSON.parse(localStorage.getItem(FKEY) || '{}'),
            state: getGS(),
            vars: getVars(),
            settings: settings,
            savedAt: new Date().toISOString()
        };
    }

    // Apply a profile blob to the live config. Settings are MERGED (only the
    // config-level keys are written) so device-level state (channel, pinned
    // version, auto-update/backup prefs, hotkey) is never touched by a profile.
    function applyProfile(p) {
        if (!p) return;
        p = migrateProfile(p);
        if (p.rules) {
            // Normalize using THIS profile's own legacy ruleReturnCfg (if any),
            // not whatever's currently in live __wo_settings — otherwise
            // switching to an old-shape profile would fold in the previously
            // active profile's return-message config instead of its own.
            var legacyReturnCfg = (p.settings && p.settings.ruleReturnCfg) || {};
            localStorage.setItem(RKEY, JSON.stringify(normalizeCfg(p.rules, legacyReturnCfg)));
        }
        if (p.scan) localStorage.setItem(SKEY, JSON.stringify(p.scan));
        if (p.fields) localStorage.setItem(FKEY, JSON.stringify(p.fields));
        if (p.state) localStorage.setItem(GSTATE, JSON.stringify(p.state));
        if (p.vars) localStorage.setItem(VKEY, JSON.stringify(p.vars));
        var st = {};
        try {
            st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        PROFILE_SETTINGS_KEYS.forEach(function(k) {
            if (p.settings && p.settings[k] !== undefined) st[k] = p.settings[k];
        });
        localStorage.setItem('__wo_settings', JSON.stringify(st));
        localStorage.setItem('__wo_config_saved_at', p.savedAt || new Date().toISOString());
        autoSaveToFile();
    }

    // Switch to a locally-saved profile. Persists the currently active profile's
    // live edits back into its own slot first, so switching away never loses work.
    function switchProfile(id) {
        var profiles = getProfiles();
        var curId = getActiveProfileId();
        if (curId && profiles[curId]) {
            profiles[curId] = snapshotProfile(profiles[curId]);
            saveProfiles(profiles);
        }
        var target = profiles[id];
        if (!target) return false;
        // migrateProfile() (inside applyProfile) can throw if target's
        // configVersion is too new for this tool build - deliberately
        // checked BEFORE moving the active-profile pointer, so a rejected
        // switch never leaves ACTIVE_PROFILE_KEY pointing at a profile
        // whose data was never actually written (RKEY/etc. would still
        // hold the OLD profile's content while the pointer claimed the
        // new one - a real inconsistency the old code let happen).
        migrateProfile(target); // throws here, before anything is mutated, if incompatible
        // Set the active pointer BEFORE applyProfile's own auto-save fires, so a
        // linked PC backup file reflects the new active profile immediately
        // rather than lagging one switch behind.
        localStorage.setItem(ACTIVE_PROFILE_KEY, id);
        applyProfile(target);
        return true;
    }

    // Register a profile locally (from a GitHub fetch or a manual save) without
    // switching to it.
    function registerProfile(p) {
        var profiles = getProfiles();
        profiles[p.id] = migrateProfile(p);
        saveProfiles(profiles);
    }

    // Before a re-import overwrites an EXISTING local profile, save whatever it
    // currently holds under a timestamped backup slot — mirrors the "never lose
    // work" guarantee switchProfile() already gives normal profile switches.
    // No-ops on a true first-time import (nothing to protect). If `id` is the
    // currently active profile, the live edits (not just its last save) are
    // what get backed up, since that's what's actually about to be discarded.
    function backupProfileBeforeOverwrite(id) {
        var profiles = getProfiles();
        var existing = profiles[id];
        if (!existing) return null;
        var backupId = id + '_backup_' + Date.now();
        var backupName = (existing.name || id) + ' (before re-import, ' + new Date().toLocaleDateString() + ')';
        var isActive = getActiveProfileId() === id;
        var snap = isActive ?
            snapshotProfile({
                id: backupId,
                name: backupName,
                description: existing.description || '',
                configVersion: existing.configVersion
            }) :
            Object.assign({}, existing, {
                id: backupId,
                name: backupName
            });
        profiles[backupId] = snap;
        saveProfiles(profiles);
        return backupId;
    }


    // ── Admin-managed org configs (worker.js /admin/configs, resolved for
    // this whoami by /check-access and fetched by loader.js) ──
    // Completely separate system from the GitHub preset fetch above: no
    // network call here at all — loader.js already fetched full content
    // (right after check-access, using the same short-lived token) and left
    // it in ORG_CONFIGS_KEY, so this just reads localStorage. Only ever
    // populated on a fresh install (see loader.js's fetchOrgConfigsIfFirstRun),
    // so an empty/missing key here is the normal case, not a failure.
    function getOrgConfigs() {
        try {
            return JSON.parse(localStorage.getItem(ORG_CONFIGS_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    // "Name - Bucket" (e.g. "Default - Ireland") when a bucket label is
    // available (worker.js's resolveConfigBucketLabels()), so two configs
    // that share a name from different sites/companies aren't
    // indistinguishable in the installer or Setup > Profiles. Falls back to
    // a bare name if the bucket couldn't be resolved (root-owned config,
    // buckets.json hiccup, or an org config cached before this field
    // existed) — never shows a stray " - " or "undefined".
    function orgConfigDisplayName(c) {
        return c.name + (c.bucket ? ' - ' + c.bucket : '');
    }

    // Installs an org config through the same profile pipeline every
    // profile switch uses (backup-before-overwrite, register, activate,
    // applyProfile's settings-subset-merge + migration) — never
    // applyBackup, which would also overwrite src/profiles/full settings
    // from the config blob. Content is always fetched LIVE at this exact
    // moment (via fetchOrgConfigsLive(), defined below — re-runs the real
    // check-access decision then /org-config-content with a freshly minted
    // token) rather than from any earlier cache: the metadata list
    // (getOrgConfigs()) can be minutes old, but an actual install always
    // re-verifies eligibility and pulls current content, so there's no
    // stale-token window to manage. The org config's content shape
    // ({rules,scan,fields,state,vars,settings}) is the same "Setup >
    // Export"/profile shape wo_tool.js already produces, just wrapped one
    // level deeper under `.content` by the /org-config-content response —
    // flattened here into a real profile object before it touches the
    // pipeline. `settings` is optional (an admin config authored by hand
    // through admin.html may not include it) — when present it still only
    // ever travels through applyProfile()'s PROFILE_SETTINGS_KEYS
    // whitelist, same safety guarantee as any other profile.
    function installOrgConfig(id) {
        return fetchOrgConfigsLive().then(function(list) {
            var entry = (list || []).filter(function(c) { return c.id === id; })[0];
            if (!entry || !entry.content) return false;
            localStorage.setItem(ORG_CONFIGS_KEY, JSON.stringify(list)); // opportunistic metadata refresh
            var profileId = 'org_' + entry.id;
            var p = {
                id: profileId,
                name: orgConfigDisplayName(entry),
                description: entry.description || '',
                // Read from the uploaded content itself, not hardcoded -
                // an admin config with no configVersion tag at all
                // (uploaded before this field existed) is safely treated
                // as v1, same as migrateProfile()'s own `p.configVersion || 1`
                // fallback for every other profile shape.
                configVersion: entry.content.configVersion || 1,
                rules: entry.content.rules,
                scan: entry.content.scan,
                fields: entry.content.fields,
                state: entry.content.state,
                vars: entry.content.vars,
                settings: entry.content.settings || {},
                savedAt: new Date().toISOString()
            };
            var backupId = backupProfileBeforeOverwrite(profileId);
            registerProfile(p);
            localStorage.setItem(ACTIVE_PROFILE_KEY, p.id); // before applyProfile's auto-save fires
            applyProfile(p);
            return {
                ok: true,
                backupId: backupId
            };
        });
    }


    // ── File missing: clear dead handle and prompt ──
    function handleFileMissing() {
        openIDB().then(function(db) {
            idbDelete(db, 'fileHandle');
        }).catch(function() {});
        showBackupSetupPrompt(
            'Your backup file could not be found (it may have been moved or deleted). ' +
            'Please choose a new location or link an existing backup.'
        );
    }

    // ── Restore permission banner (one-click re-grant) ──
    function showRestorePermissionBanner(handle, db) {
        var old = document.getElementById('__wo_restore_banner');
        if (old) old.remove();
        var banner = document.createElement('div');
        banner.id = '__wo_restore_banner';
        banner.className = 'wo-notice wo-info';
        banner.innerHTML =
            '<div class="wo-notice-title">⚠ Config was reset — backup file found</div>' +
            '<div class="wo-notice-body">Click below to restore your settings from <b>' + (handle.name || 'backup') + '</b></div>' +
            '<div class="wo-notice-actions">' +
            '<button id="__wo_restore_btn" type="button" class="wo-btn wo-btn-primary">Restore</button>' +
            '<button id="__wo_restore_skip" type="button" class="wo-btn-ghost">Start Fresh</button>' +
            '</div>';
        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_restore_btn').onclick = function() {
            handle.requestPermission({
                mode: 'readwrite'
            }).then(function(perm) {
                if (perm !== 'granted') {
                    banner.remove();
                    return;
                }
                handle.getFile().then(function(file) {
                    file.text().then(function(text) {
                        try {
                            var b = JSON.parse(text);
                            applyBackup(b);
                            banner.remove();
                            render();
                            setStatus('Config restored from ' + handle.name);
                        } catch (e) {
                            banner.remove();
                            setStatus('⚠ Could not restore backup: ' + e.message);
                        }
                    });
                }).catch(function(e) {
                    if (e.name === 'NotFoundError') handleFileMissing();
                    banner.remove();
                });
            });
        };
        document.getElementById('__wo_restore_skip').onclick = function() {
            banner.remove();
        };
    }

    // ── Newer backup prompt ──
    function showNewerBackupPrompt(b, fileSavedAt, localSavedAt) {
        var old = document.getElementById('__wo_newer_banner');
        if (old) old.remove();
        var banner = document.createElement('div');
        banner.id = '__wo_newer_banner';
        banner.className = 'wo-notice wo-pass';
        banner.innerHTML =
            '<div class="wo-notice-title">Newer config found in backup file</div>' +
            '<div class="wo-notice-body">' +
            'Backup file: <b>' + fileSavedAt.slice(0, 16).replace('T', ' ') + '</b><br>' +
            'Current config: <b>' + localSavedAt.slice(0, 16).replace('T', ' ') + '</b><br>' +
            'This may be from another browser session. Load the backup?</div>' +
            '<div class="wo-notice-actions">' +
            '<button id="__wo_load_bak_btn" type="button" class="wo-btn wo-btn-pass">Load Backup</button>' +
            '<button id="__wo_keep_local_btn" type="button" class="wo-btn-ghost">Keep Current</button>' +
            '</div>';
        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_load_bak_btn').onclick = function() {
            try {
                applyBackup(b);
            } catch (e) {
                banner.remove();
                return woAlert('Could not load backup: ' + e.message);
            }
            banner.remove();
            render();
            setStatus('Config loaded from backup file');
        };
        document.getElementById('__wo_keep_local_btn').onclick = function() {
            banner.remove();
        };
    }

    // ── No backup configured prompt ──
    function showBackupSetupPrompt(message) {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (st.backupPromptDismissed) return;
        var old = document.getElementById('__wo_backup_setup_banner');
        if (old) old.remove();
        var banner = document.createElement('div');
        banner.id = '__wo_backup_setup_banner';
        banner.className = 'wo-notice wo-fail';
        banner.innerHTML =
            '<div class="wo-notice-title">⚠ No backup protection</div>' +
            '<div class="wo-notice-body">' + message + '</div>' +
            '<div class="wo-notice-actions">' +
            '<button id="__wo_set_new_backup" type="button" class="wo-btn wo-btn-fail">New Location</button>' +
            '<button id="__wo_link_backup" type="button" class="wo-btn">Link Existing</button>' +
            '<button id="__wo_backup_dismiss" type="button" class="wo-btn-ghost">Don\'t ask again</button>' +
            '</div>';
        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_set_new_backup').onclick = function() {
            pickBackupFile().then(function() {
                banner.remove();
            });
        };
        document.getElementById('__wo_link_backup').onclick = function() {
            linkExistingBackupFile().then(function() {
                banner.remove();
            });
        };
        document.getElementById('__wo_backup_dismiss').onclick = function() {
            var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            s.backupPromptDismissed = true;
            saveSettingsCfg(s);
            banner.remove();
        };
    }

    // ── Pick new backup file location ──
    function pickBackupFile() {
        if (typeof window.showSaveFilePicker === 'undefined') {
            return woAlert('File System Access isn\'t supported here — use Chrome or Edge for auto-backup.');
        }
        return window.showSaveFilePicker({
            suggestedName: 'wo_tool_backup.json',
            types: [{
                description: 'JSON Backup',
                accept: {
                    'application/json': ['.json']
                }
            }]
        }).then(function(handle) {
            return openIDB().then(function(db) {
                return idbPut(db, 'fileHandle', handle).then(function() {
                    return handle.createWritable().then(function(writable) {
                        return writable.write(buildBackupBlob()).then(function() {
                            return writable.close();
                        });
                    }).then(function() {
                        var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                        s.autoBackup = true;
                        s.backupPromptDismissed = false;
                        saveSettingsCfg(s);
                        setStatus('Backup saved to ' + handle.name + ' — auto-save enabled');
                        return handle;
                    });
                });
            });
        }).catch(function(e) {
            if (e && e.name !== 'AbortError') setStatus('⚠ Could not set backup file: ' + e.message);
            return null;
        });
    }

    // ── Link existing backup file (for cross-browser use) ──
    function linkExistingBackupFile() {
        if (typeof window.showOpenFilePicker === 'undefined') {
            return woAlert('File System Access isn\'t supported here — use Chrome or Edge.');
        }
        return window.showOpenFilePicker({
            types: [{
                description: 'WO Tool Backup',
                accept: {
                    'application/json': ['.json']
                }
            }]
        }).then(function(handles) {
            var handle = handles[0];
            return openIDB().then(function(db) {
                return idbPut(db, 'fileHandle', handle).then(function() {
                    return handle.requestPermission({
                        mode: 'readwrite'
                    }).then(function(perm) {
                        if (perm !== 'granted') return;
                        return handle.getFile().then(function(file) {
                            return file.text().then(function(text) {
                                var b = JSON.parse(text);
                                applyBackup(b);
                                var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                                s.autoBackup = true;
                                s.backupPromptDismissed = false;
                                saveSettingsCfg(s);
                                setStatus('Config loaded and backup linked to ' + handle.name);
                                render();
                            });
                        });
                    });
                });
            });
        }).catch(function(e) {
            if (e && e.name !== 'AbortError') setStatus('⚠ Could not link file: ' + e.message);
            return null;
        });
    }

    // ── Startup restore (called before first render) ──
    function startupRestore() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        // On a truly fresh install (no config at all yet) the backup-setup nag is
        // deferred to right after the first-run installer instead of firing here,
        // so the two don't race/overlap.
        var hasConfig = !!localStorage.getItem(RKEY);
        if (!st.autoBackup) {
            if (!st.backupPromptDismissed && hasConfig) {
                setTimeout(function() {
                    showBackupSetupPrompt('Auto-backup is not configured. Set up a backup file to protect your config if browser data is cleared.');
                }, 1000);
            }
            return Promise.resolve();
        }
        if (typeof window.showSaveFilePicker === 'undefined') {
            setStatus('⚠ Auto-backup not supported in this browser (use Chrome/Edge)');
            return Promise.resolve();
        }
        return openIDB().then(function(db) {
            return idbGet(db, 'fileHandle').then(function(handle) {
                if (!handle) {
                    setStatus('⚠ No backup file linked');
                    if (hasConfig && !st.backupPromptDismissed) {
                        showBackupSetupPrompt('Auto-backup is enabled but no file is linked. Please set a backup file location.');
                    }
                    return;
                }
                return handle.queryPermission({
                    mode: 'read'
                }).then(function(perm) {
                    if (perm === 'prompt') {
                        setStatus('⚠ Backup file permission needed — click Restore in the panel');
                        showRestorePermissionBanner(handle, db);
                        return;
                    }
                    if (perm !== 'granted') {
                        setStatus('⚠ Backup file permission denied');
                        return;
                    }
                    return handle.getFile().then(function(file) {
                        return file.text().then(function(text) {
                            var b = JSON.parse(text);
                            var localSavedAt = localStorage.getItem('__wo_config_saved_at') || '1970-01-01';
                            var fileSavedAt = b.savedAt || '1970-01-01';
                            var configMissing = !localStorage.getItem(RKEY);
                            if (configMissing) {
                                applyBackup(b);
                                setStatus('Config restored from backup file (' + fileSavedAt.slice(0, 10) + ')');
                            } else if (fileSavedAt > localSavedAt) {
                                setStatus('Backup file is newer — see prompt above');
                                showNewerBackupPrompt(b, fileSavedAt, localSavedAt);
                            } else {
                                setStatus('Backup OK — ' + handle.name + ' (up to date)');
                            }
                        });
                    }).catch(function(e) {
                        if (e && e.name === 'NotFoundError') {
                            setStatus('⚠ Backup file not found — please re-link');
                            handleFileMissing();
                        } else {
                            setStatus('⚠ Backup file error: ' + (e && e.message || 'unknown'));
                        }
                    });
                });
            });
        }).catch(function(e) {
            setStatus('⚠ Backup check error: ' + (e && e.message || 'unknown'));
        });
    }

    // ── Version comparison helper ──
    function versionGt(a, b) {
        var ap = a.split('.').map(Number);
        var bp = b.split('.').map(Number);
        for (var i = 0; i < 3; i++) {
            if ((ap[i] || 0) > (bp[i] || 0)) return true;
            if ((ap[i] || 0) < (bp[i] || 0)) return false;
        }
        return false;
    }

    // "0.17.0-beta1" -> {major:0, minor:17, patch:0} — prerelease suffix stripped.
    function parseVer(v) {
        var base = (v || '').split('-')[0];
        var p = base.split('.').map(Number);
        return {
            major: p[0] || 0,
            minor: p[1] || 0,
            patch: p[2] || 0
        };
    }

    function minorKey(v) {
        var p = parseVer(v);
        return p.major + '.' + p.minor;
    }

    function sameMinor(a, b) {
        return minorKey(a) === minorKey(b);
    }

    // A pin with exactly two numeric parts ("0.17") is a FLOATING minor pin —
    // stays on that major.minor line forever but always resolves to the newest
    // patch published for it. A three-part pin ("0.17.0") is an exact pin:
    // frozen at that build until the user changes it. This is the escape
    // hatch for "the newest patch in this line is itself broken, go back one."
    function isFloatingMinorPin(v) {
        return /^\d+\.\d+$/.test(v || '');
    }

    // Newest non-prerelease tagged version whose major.minor matches `minor`.
    // Prerelease (beta-tagged) builds are never picked up by a floating pin —
    // floating pins mean "stay on this stable line, always patched," not a
    // beta feed, regardless of the caller's dev/beta tier.
    function resolveFloatingMinor(minor, remoteVersions) {
        var candidates = (remoteVersions || [])
            .map(function(v) {
                return v.version;
            })
            .filter(function(v) {
                return !isPrerelease(v) && minorKey(v) === minor;
            });
        if (!candidates.length) return '';
        return candidates.reduce(function(best, v) {
            return versionGt(v, best) ? v : best;
        });
    }

    // Per-entry version.json gating, for the Settings version picker:
    // `entry.grant` (optional — a single grant id, same convention as
    // HOTKEY_ACTIONS' betaFeature, e.g. "dev"/"beta_0"/"beta_1") lets a
    // SPECIFIC version require a specific grant, checked via the real
    // per-flag hasGrant() (so a "beta_1"-gated entry needs that exact grant,
    // not just any beta access) rather than the coarse tier string. The
    // older "-suffix" prerelease convention (checked via `tier`) is honored
    // alongside it, not replaced by it — no version has ever actually
    // shipped with a "-" suffix in practice, but the check is kept for
    // whichever convention a given entry happens to use.
    function isVersionEntryAllowed(entry, tier) {
        if (isPrerelease(entry.version) && tier !== 'beta' && tier !== 'dev') return false;
        if (entry.grant && !hasGrant(entry.grant)) return false;
        return true;
    }

    // Called when whatever version a pin/channel would naively resolve to
    // (`from`) isn't actually listed in the manifest anymore — e.g. an admin
    // trimmed its entry (or a whole channel's target) out of `versions[]`.
    // Git tags are never deleted (see ARCHITECTURE.md §9/§10), so this is
    // purely about respecting the manifest as the curated "available" list,
    // not a fetch failure. Prefers the closest still-available version AT OR
    // ABOVE `from` (a deliberate downgrade-pin should land as close to where
    // it was as possible); only falls back to the single highest available
    // version this tier can use if nothing qualifies above — that's the
    // genuine rollback case (e.g. the tier's whole channel target vanished
    // with nothing newer behind it).
    function resolveNearestAvailable(from, remoteVersions, tier) {
        var allowed = (remoteVersions || [])
            .filter(function(v) {
                return isVersionEntryAllowed(v, tier);
            })
            .map(function(v) {
                return v.version;
            });
        if (!allowed.length) return '';
        var atOrAbove = allowed.filter(function(v) {
            return v === from || versionGt(v, from);
        });
        var pool = atOrAbove.length ? atOrAbove : allowed;
        var pickLowest = atOrAbove.length; // closest-above wants the smallest of the qualifying set; a true rollback wants the overall highest
        return pool.reduce(function(best, v) {
            if (pickLowest) return versionGt(best, v) ? v : best;
            return versionGt(v, best) ? v : best;
        });
    }

    // ── Dev/beta unlock (console-only, deliberately not in Setup UI) ──
    // Stored outside __wo_settings so it never rides along in a shared/exported backup.
    // GRANTS_KEY holds a JSON array (e.g. ["user","dev","beta_0"]) rather
    // than a single tier string — a user can hold more than one grant at
    // once. "beta_0" is a wildcard meaning "all betas"; hasGrant() treats
    // any other "beta_N" as a specific feature flag.
    var GRANTS_KEY = '__wo_grants';
    var DEV_UNLOCK_KEY = '__wo_dev_unlock'; // retired key name, kept only so EPHEMERAL_KEYS still cleans up any leftover value from before this change
    // Same Worker loader.js talks to for the bookmarklet's first load — the
    // tool's own source now lives in a private repo the Worker gates, so
    // every self-update fetch has to go through here too. Without this,
    // once someone had ANY copy running, its own "check for updates" flow
    // would keep pulling fresh versions straight from a public URL forever,
    // with no access check at all — the private-repo gating would only
    // ever have covered the very first install.
    var WORKER_BASE_URL = 'https://wo-review-tool-access.williamzitzmann.workers.dev';

    // `headers` is optional ({name: value}) — deliberately NOT applied by
    // default. This is also the self-update path's own fetch primitive
    // (getWorkerAccessToken()'s /bootstrap call, fetchToolSourceViaWorker()'s
    // /tool call, which returns raw JS source, not JSON) — forcing
    // `Accept: application/json` on every call here would risk that
    // load-critical path on the strength of a header only ever confirmed
    // necessary for Maximo's own /oslc/os/mxapi* endpoints. Callers that
    // need it (see fetchAssetWOHistoryRaw/fetchAssetDowntimeHistoryRaw/
    // __woDumpWO/__woDumpAsset) pass it explicitly instead.
    function xhrGetText(url, headers) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            if (headers) {
                Object.keys(headers).forEach(function(h) {
                    xhr.setRequestHeader(h, headers[h]);
                });
            }
            xhr.onload = function() {
                if (xhr.status === 200) resolve(xhr.responseText);
                else reject(new Error('HTTP ' + xhr.status));
            };
            xhr.onerror = function() {
                reject(new Error('network error'));
            };
            xhr.send();
        });
    }

    function xhrPostJSON(url, body) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onload = function() {
                if (xhr.status === 200) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function() {
                reject(new Error('network error'));
            };
            xhr.send(JSON.stringify(body));
        });
    }

    // Same whoami-field mapping as loader.js's readWhoami() — duplicated
    // rather than shared since this file and loader.js are fetched/run
    // completely independently of each other. The block below is AUTO-
    // SYNCED from loader.js by scripts/sync-whoami-mapping.js (runs from
    // the pre-commit hook whenever either file changes) — edit it in
    // loader.js, not here; a manual edit here gets silently overwritten on
    // the next commit that touches either file.
    function readWhoamiCanonical() {
        return xhrGetText('/maximo/oslc/whoami').then(function(text) {
            var d = JSON.parse(text);
            var canonical = {
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
            // Pass through every scalar field the endpoint actually
            // returned too (its real Maximo name, e.g. loginID/personid),
            // not just the six curated above — so a formula can reach any
            // whoami field without this mapping needing to know about it
            // ahead of time. Canonical names win on a collision. Nested
            // objects/arrays are skipped: this only ever feeds a plain
            // scalar formula helper (whoami(field)), not a table.
            var merged = {};
            Object.keys(d).forEach(function(k) {
                if (d[k] === null || typeof d[k] !== 'object') merged[k] = d[k];
            });
            Object.keys(canonical).forEach(function(k) {
                merged[k] = canonical[k];
            });
            return merged;
        });
    }

    // whoami() in formulas is opt-in (st.whoamiInFormulas, off by default) —
    // unlike the Feedback checkbox, this data never leaves the laptop (it's
    // read from Maximo's own same-origin endpoint), so the risk isn't
    // network exposure, it's a rule/message pasting a name/email into a
    // permanent WO record (Memo, etc.) without the user realizing a formula
    // was pulling it in. Fetched at most once per session (cached), then
    // refreshed defensively at the top of every scan in case the setting
    // was only just turned on.
    var whoamiCache = null;

    function ensureWhoamiCache() {
        var s;
        try {
            s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {
            s = {};
        }
        if (!s.whoamiInFormulas) return Promise.resolve();
        if (whoamiCache) return Promise.resolve();
        return readWhoamiCanonical().then(function(w) {
            whoamiCache = w;
        }).catch(function() {
            whoamiCache = {};
        });
    }

    // Called once at tool startup, and again from the Settings checkbox's
    // own onchange (to cover turning the toggle on mid-session) — NOT from
    // runScan(), since whoami data essentially never changes within a
    // session and ensureWhoamiCache() only ever fetches once anyway (its
    // guard treats "already have a cached value" as done, success or not);
    // a scan-time call would just be a wasted localStorage read at best, or
    // a duplicate in-flight fetch at worst, never an actual refresh. Checks
    // the toggle BEFORE touching ensureWhoamiCache's promise chain at all,
    // so the common case (feature off) costs one localStorage read and
    // nothing else.
    function refreshWhoamiIfEnabled() {
        var s;
        try {
            s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {
            s = {};
        }
        if (!s.whoamiInFormulas) return;
        ensureWhoamiCache().then(render);
    }

    // ── beta_2: Maximo REST Data (experimental) ──
    // Everything below is gated behind isBetaFeatureOn('beta_2') INSIDE each
    // function body (not just hidden in the UI) — same convention as
    // runActions()'s beta_1 gate — so a formula referencing one of these
    // helpers on a non-beta_2 install just gets an inert '' /[] back, never
    // an error. See MAXIMO_DATA_SOURCES.md for what's actually been
    // confirmed to work vs. still unverified; this code follows that
    // document's findings directly (e.g. only startdate/enddate are
    // requested from moddowntimehist since the other fields didn't come
    // back in testing).

    // Maximo's own cached domain/lookup value lists (populated by Maximo's
    // UI into localStorage, one key per domain) — NOT written by this tool.
    // Shape confirmed via __woBeta2Report() across 15 real domains (see
    // domainDecodeRaw() below) — an attributes-indexed {data, attributes}
    // object. The Shape A/B fallbacks below it were speculative guesses
    // from before that confirmation and have never actually matched a real
    // domain list, but are kept in case some other Maximo version differs.
    var KNOWN_DOMAIN_KEYS = ['ABBCLAUSECODE', 'ABBWPRIORITY', 'WOCLASS', 'DOWNCODE', 'LOCASSETSTATUS', 'ABBASPRIORITY', 'HAZTYPE', 'POSTATUS', 'PRSTATUS', 'ASSETTYPE', 'ABVASSETCAT', 'SHIPVIA', 'ABBWOEXECMETHOD', 'CREWID', 'JOBPLANSTATUS'];

    // Raw decode logic, split out from domainFn() so the __woDebugDomains()/
    // __woTestDomain() console tools (below) can exercise the real decode
    // attempt regardless of whether beta_2 happens to be toggled on right
    // now — a debug tool that's itself gated behind the thing it's meant to
    // help you verify would be useless the one time you actually need it
    // (before you've confirmed the feature works, you probably haven't
    // turned it on yet).
    // In-memory cache of each domain's parsed localStorage entry, keyed by
    // domain name. Domain lists are effectively static for a session (only
    // Maximo itself re-caches them, and rarely mid-session) — re-parsing the
    // same JSON blob on every single domain()/domain-table read (e.g. once
    // per row of a scanned table, on every render) was pure waste. Keeps the
    // raw string alongside the parsed value and only re-parses when that
    // string actually changed, rather than never invalidating at all.
    var domainRawCache = {};

    function getDomainRaw(key) {
        if (!key) return null;
        var str = localStorage.getItem(key);
        if (!str) return null;
        var cached = domainRawCache[key];
        if (cached && cached.str === str) return cached.parsed;
        var parsed;
        try {
            parsed = JSON.parse(str);
        } catch (e) {
            parsed = null;
        }
        domainRawCache[key] = { str: str, parsed: parsed };
        return parsed;
    }

    function domainDecodeRaw(key, code) {
        if (!key || code == null || code === '') return '';
        var raw = getDomainRaw(key);
        if (!raw) return '';
        var codeStr = String(code);
        // Real shape, confirmed via __woBeta2Report() across 15 domains on
        // a live install: { data: [[...], ...], attributes: {value: idx,
        // description: idx, ...} } — attributes maps column NAME to its
        // index in each data row, and that mapping varies by domain (e.g.
        // description is index 1 for ABBWPRIORITY but index 2 for WOCLASS,
        // which also has a maxvalue column). value was index 0 in every
        // domain checked, but read it from attributes too rather than
        // hardcoding — the whole point of this shape is that it's
        // self-describing. Prefer "description" over "maxvalue" when a
        // domain has both (maxvalue is usually just an uppercase echo of
        // value, e.g. WOCLASS's ACTIVITY vs. description's nicer "Activity").
        if (Array.isArray(raw.data) && raw.attributes && typeof raw.attributes === 'object') {
            var attrs = raw.attributes;
            var valueIdx = attrs.value;
            var descIdx = attrs.hasOwnProperty('description') ? attrs.description : (attrs.hasOwnProperty('maxvalue') ? attrs.maxvalue : null);
            if (valueIdx == null) return '';
            for (var di = 0; di < raw.data.length; di++) {
                var drow = raw.data[di];
                if (drow && String(drow[valueIdx]) === codeStr) {
                    return descIdx != null && drow[descIdx] != null ? drow[descIdx] : '';
                }
            }
            return '';
        }
        // Shape A: array of {value/code/domainvalue, description/desc/maxvalue}
        // — never actually confirmed on a real domain list, kept as a
        // fallback in case some other Maximo version/config caches these
        // differently.
        if (Array.isArray(raw)) {
            for (var i = 0; i < raw.length; i++) {
                var row = raw[i];
                if (!row || typeof row !== 'object') continue;
                var v = row.value != null ? row.value : (row.code != null ? row.code : row.domainvalue);
                if (v != null && String(v) === codeStr) {
                    return row.description != null ? row.description : (row.desc != null ? row.desc : (row.maxvalue != null ? row.maxvalue : ''));
                }
            }
            return '';
        }
        // Shape B: plain object map { code: description } — also unconfirmed,
        // same fallback reasoning as Shape A above.
        if (typeof raw === 'object' && raw.hasOwnProperty(codeStr)) {
            var v2 = raw[codeStr];
            return typeof v2 === 'object' ? (v2.description || v2.desc || '') : v2;
        }
        return '';
    }

    function domainFn(key, code) {
        if (!isBetaFeatureOn('beta_2')) return '';
        return domainDecodeRaw(key, code);
    }

    // Every domain list is really just a table under the hood (rows + named
    // columns — see domainDecodeRaw's shape comment above), but domain()
    // only ever exposes a single column (description) for a single matched
    // row. This turns the same cached/parsed data into a full array of row
    // objects, so a domain list can be wired up as a Table (Tables tab >
    // API Tables > source: "Domain List") and read with T()/col()/lookup()/
    // count() like any other table — keeping every column (siteid, orgid,
    // maxvalue, ...), not just the one domainDecodeRaw() happens to pick.
    function domainTableRows(key) {
        var raw = getDomainRaw(key);
        if (!raw) return [];
        if (Array.isArray(raw.data) && raw.attributes && typeof raw.attributes === 'object') {
            var attrs = raw.attributes;
            var names = Object.keys(attrs);
            return raw.data.map(function(row) {
                var obj = {};
                names.forEach(function(name) {
                    obj[name] = row[attrs[name]];
                });
                return obj;
            });
        }
        if (Array.isArray(raw)) {
            return raw.map(function(row) {
                return (row && typeof row === 'object') ? row : { value: row };
            });
        }
        if (raw && typeof raw === 'object') {
            return Object.keys(raw).map(function(k) {
                var v = raw[k];
                return (v && typeof v === 'object') ? Object.assign({ value: k }, v) : { value: k, description: v };
            });
        }
        return [];
    }

    // Raw fetchers (Promise-returning, no cache, no beta gate) — the actual
    // network calls, shared by the gated/cached formula helpers below AND
    // the __woProbeAsset() console tool, so probing from the console always
    // exercises the exact same request the formula helper would make.
    // Maximo's /oslc/os/mxapi* endpoints 406 (content negotiation) without
    // this — confirmed via __woBeta2Report(): same URL, same session, 406
    // without it vs. 200 with it. Passed explicitly at each mxapi* call
    // site rather than baked into xhrGetText() itself, since that function
    // is also the self-update path's fetch primitive (bootstrap/tool-source
    // endpoints, which aren't JSON) — see xhrGetText()'s own comment.
    var MXAPI_HEADERS = { Accept: 'application/json' };

    function fetchAssetWOHistoryRaw(assetnum, siteid, limit) {
        limit = limit || 10;
        var url = '/maximo/oslc/os/mxapiwo?oslc.where=' + encodeURIComponent('assetnum="' + assetnum + '" and siteid="' + siteid + '"') +
            '&oslc.select=wonum,description,status,wopriority,reportdate,worktype' +
            '&oslc.orderBy=-reportdate&oslc.pageSize=' + limit + '&lean=1&_format=json';
        return xhrGetText(url, MXAPI_HEADERS).then(function(text) {
            return JSON.parse(text).member || [];
        });
    }

    // Only startdate/enddate requested — downtimecode/remarks/reportedby/
    // positivedowntime were also tried against this same nested-select and
    // never came back (see MAXIMO_DATA_SOURCES.md §2.4); requesting them
    // here would just be dead weight until that's resolved.
    function fetchAssetDowntimeHistoryRaw(assetnum, siteid) {
        var url = '/maximo/oslc/os/mxapiasset?oslc.where=' + encodeURIComponent('assetnum="' + assetnum + '" and siteid="' + siteid + '"') +
            '&oslc.select=' + encodeURIComponent('assetnum,moddowntimehist{startdate,enddate}') +
            '&lean=1&_format=json';
        return xhrGetText(url, MXAPI_HEADERS).then(function(text) {
            var d = JSON.parse(text);
            return (d.member && d.member[0] && d.member[0].moddowntimehist) || [];
        });
    }

    // Per-(assetnum+siteid[+limit]) cache — distinct from whoami's single
    // global cache, since the key here varies with the formula's own
    // arguments. Placeholder-then-replace pattern: the cache slot is set to
    // the empty/default value THE MOMENT the fetch is kicked off (not only
    // once it resolves), so a formula re-evaluated multiple times per
    // render (e.g. once for the rule, once for its message) while the fetch
    // is still in flight reads the placeholder instead of firing a second,
    // redundant request for the same key.
    var betaAssetWoCache = {};
    var betaAssetDowntimeCache = {};

    function assetWOHistoryFn(assetnum, siteid, limit) {
        if (!isBetaFeatureOn('beta_2')) return [];
        if (!assetnum || !siteid) return [];
        limit = limit || 10;
        var key = assetnum + '|' + siteid + '|' + limit;
        if (betaAssetWoCache.hasOwnProperty(key)) return betaAssetWoCache[key];
        betaAssetWoCache[key] = [];
        fetchAssetWOHistoryRaw(assetnum, siteid, limit).then(function(rows) {
            betaAssetWoCache[key] = rows;
            render();
        }).catch(function() {
            // Leave the [] placeholder in place — swallow rather than retry
            // on every subsequent render, same reasoning as whoami's cache.
        });
        return betaAssetWoCache[key];
    }

    function assetDowntimeHistoryFn(assetnum, siteid) {
        if (!isBetaFeatureOn('beta_2')) return [];
        if (!assetnum || !siteid) return [];
        var key = assetnum + '|' + siteid;
        if (betaAssetDowntimeCache.hasOwnProperty(key)) return betaAssetDowntimeCache[key];
        betaAssetDowntimeCache[key] = [];
        fetchAssetDowntimeHistoryRaw(assetnum, siteid).then(function(rows) {
            betaAssetDowntimeCache[key] = rows;
            render();
        }).catch(function() {});
        return betaAssetDowntimeCache[key];
    }

    // ── Custom table formula columns (cfg.customTables[id].columnFormulas) ──
    // A custom table's columns are plain hand-typed values by default (see
    // the Tables Setup tab), but any column can instead be marked a formula
    // column — same formula text evaluated fresh for every row, with R(col)
    // giving it access to that row's OTHER column values (its own table's
    // T()/col()/lookup() would just recurse into itself). Not a general
    // ARGN helper: R only exists inside this one evaluation, built fresh per
    // call below rather than added to the shared ARGN/buildCtx used by
    // runVariable/runFormula/actions/{{}} — those four entry points have no
    // notion of "the current row" to bind it to. normalizeFormulaFunctionCase()
    // is still applied so daysBetween/domain/etc. stay case-insensitive here
    // too, just not R itself (kept uppercase-only, consistent with F/T/V).
    var CT_ROW_ARGN = ARGN.concat(['R']);

    function evalCustomTableColumnFormula(formula, row, data) {
        if (!formula) return '';
        try {
            var c = buildCtx(data);
            var R = function(colName) {
                return row.hasOwnProperty(colName) ? row[colName] : '';
            };
            var av = [c.F, c.T, c.rowCount, c.col, c.has, c.lookup, c.count, c.isEmpty, c.notEmpty, c.ifBlank, c.toNumber, c.toString, c.trim, c.upper, c.lower, c.left, c.right, c.mid, c.sum, c.avg, c.today, c.hours, c.hoursBetween, c.daysBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.whoami, c.domain, c.assetWOHistory, c.assetDowntimeHistory, c.V, R];
            var fn = Function.apply(null, CT_ROW_ARGN.concat(['return (' + normalizeFormulaFunctionCase(formula) + ');']));
            var val = fn.apply(null, av);
            return val == null ? '' : val;
        } catch (e) {
            return '#ERR';
        }
    }

    // T()'s custom-table branch calls this instead of reading t.rows
    // directly, so a table with no formula columns at all (the common case)
    // is untouched — only rows with at least one formula column get rebuilt
    // per read, since a formula column's value can depend on the current WO
    // (F(), V(), other tables) and needs re-evaluating on every read, not
    // just once when the row was typed.
    function resolveCustomTableRows(t, data) {
        var rows = t.rows || [];
        var formulas = t.columnFormulas;
        if (!formulas) return rows;
        var formulaCols = Object.keys(formulas).filter(function(c) {
            return formulas[c];
        });
        if (!formulaCols.length) return rows;
        return rows.map(function(row) {
            var out = {};
            (t.columns || []).forEach(function(col) {
                out[col] = row[col];
            });
            formulaCols.forEach(function(col) {
                out[col] = evalCustomTableColumnFormula(formulas[col], row, data);
            });
            return out;
        });
    }

    // ── API tables (cfg.apiTables, beta_2 only) ──
    // A named table entry (Tables tab, "API Tables" section) that behaves
    // exactly like a scanned or custom table to T()/col()/has()/lookup()/
    // count()/rowCount() — but its rows come from a live REST fetch instead
    // of the DOM or hand-typed data. Definition shape:
    // { source: 'assetWO'|'assetDowntime'|'domain', assetFormula, siteFormula, limit }
    // — assetFormula/siteFormula are themselves formula strings (e.g.
    // F('Work Order :: Asset')), evaluated fresh against the current scan
    // data every time the table is read, since the asset/site a rule needs
    // varies per WO. source: 'domain' is the odd one out here — it isn't a
    // REST fetch at all (domainTableRows() reads the same localStorage-cached
    // domain list domain() does), so it resolves synchronously with no
    // asset/site formulas and no entry in betaApiTableCache below (nothing
    // to await, so nothing to cache a placeholder for).
    var betaApiTableCache = {};

    // Remembered purely as a convenience prefill for the Settings > Debug
    // "Run beta_2 Diagnostics" button (below) — not persisted, just saves
    // retyping the same asset/site on a second run this session.
    var lastDiagAssetnum = '',
        lastDiagSiteid = '';

    // Evaluates one of an API table's own config formulas (assetFormula/
    // siteFormula) — reuses runVariable() exactly like V() does elsewhere
    // in buildCtx (runVariable rebuilds its own fresh buildCtx(data)
    // internally, so this is NOT a re-entrant call into the SAME T()/buildCtx
    // call that's asking for it, just a sibling evaluation of a different
    // formula string against the same underlying data).
    function evalApiTableExpr(formula, data) {
        if (!formula) return '';
        var vr = runVariable(formula, data);
        return vr.error ? '' : (vr.value != null ? vr.value : '');
    }

    function resolveApiTable(id, def, data) {
        if (!isBetaFeatureOn('beta_2')) return [];
        if (def.source === 'domain') return domainTableRows(def.domainKey);
        var assetnum = evalApiTableExpr(def.assetFormula, data);
        var siteid = evalApiTableExpr(def.siteFormula, data);
        if (!assetnum || !siteid) return [];
        var limit = def.limit || 10;
        // Keyed by the RESOLVED assetnum/siteid, not the id alone — the
        // same API table definition can (and normally will) resolve to a
        // different asset/site on every different WO reviewed this session,
        // so caching by id alone would silently keep serving the first WO's
        // data on every WO after it.
        var key = id + '|' + assetnum + '|' + siteid + '|' + limit;
        if (betaApiTableCache.hasOwnProperty(key)) return betaApiTableCache[key];
        betaApiTableCache[key] = [];
        var fetchPromise = def.source === 'assetDowntime' ?
            fetchAssetDowntimeHistoryRaw(assetnum, siteid) :
            fetchAssetWOHistoryRaw(assetnum, siteid, limit);
        fetchPromise.then(function(rows) {
            betaApiTableCache[key] = rows;
            render();
        }).catch(function() {});
        return betaApiTableCache[key];
    }

    // Same fallback chain T()'s buildCtx closure uses (scanned → custom →
    // API), but reachable from render() for displaying a group's linked
    // table(s) - render() has no `data` object shaped for buildCtx, but its
    // own `cache` (which is exactly {fields, tables, ...}) already satisfies
    // what resolveCustomTableRows()/resolveApiTable() need. Before this, a
    // group could only ever display a SCANNED table (cache.tables) even
    // though the Groups tab's own table picker already listed custom and
    // API tables as valid choices — picking one silently rendered "No
    // rows" forever, since nothing read customTables/apiTables at display
    // time. This closes that gap.
    function resolveTableRowsForDisplay(tableId, cfgNow, cache) {
        if (cache.tables && cache.tables.hasOwnProperty(tableId)) return cache.tables[tableId];
        var custom = (cfgNow.customTables || {})[tableId];
        if (custom) return resolveCustomTableRows(custom, cache);
        var apiDef = (cfgNow.apiTables || {})[tableId];
        if (apiDef) return resolveApiTable(tableId, apiDef, cache);
        return [];
    }

    // Clears the tool + its config on a confirmed revoke — deliberately
    // leaves IndexedDB (the linked backup-file handle) untouched, same
    // policy as loader.js, so a config file link survives a revoke.
    // Keys that are fine to just discard — everything else under __wo_ is
    // real user config and gets snapshotted before it's cleared, not just
    // deleted, so a later regrant (via loader.js's matching restore, next
    // time the bookmarklet runs) comes back whole. Same exclude-list and
    // same REVOKED_BACKUP_KEY as loader.js's revokeLocal(). This line is
    // AUTO-SYNCED from loader.js by scripts/sync-whoami-mapping.js (runs
    // from the pre-commit hook whenever either file changes) — edit it in
    // loader.js, not here.
    var EPHEMERAL_KEYS = ['__wo_tool_src', '__wo_dev_unlock', '__wo_grants', '__wo_known_hosts', '__wo_last_scanned_wo', '__wo_grant_cache', '__wo_org_configs', '__wo_contact_email']; // === SYNC:EPHEMERAL_KEYS ===
    var REVOKED_BACKUP_KEY = '__wo_revoked_backup';

    // contactEmail is optional — passed by loader.js's window.__woForceRevoke
    // call (the optimistic-launch background-verify path) with whatever
    // /check-access just resolved. The wipe below deletes __wo_contact_email
    // along with everything else regardless of EPHEMERAL_KEYS (that list
    // only controls what's worth snapshotting, not what survives), so it
    // has to be re-written AFTER the wipe — same reasoning and same fix
    // shape as loader.js's revokeLocal(contactEmail).
    function revokeAccessLocally(contactEmail) {
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
        if (contactEmail) localStorage.setItem(CONTACT_EMAIL_KEY, contactEmail);
        var setupModal = document.getElementById('__wo_setup_modal');
        if (setupModal) setupModal.remove();
        var installerModal = document.getElementById('__wo_installer_modal');
        if (installerModal) installerModal.remove();
        teardown();
        // Nothing re-checks access after this (the running session is
        // already torn down) and no cached tool is left to fall back into
        // on a later page load, so this banner is a dead end for the
        // current page the same way loader.js's own denial banner is —
        // needs its own dismiss, not just a page reload, to go away. Keyed
        // by id so a second revoke in the same page life (shouldn't happen,
        // but teardown() doesn't remove this element) reuses it instead of
        // stacking duplicates.
        var banner = document.getElementById('__wo_revoked_banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = '__wo_revoked_banner';
            banner.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#2c2c2c;color:#e74c3c;padding:10px 16px;padding-right:26px;border-radius:6px;font-family:Arial,sans-serif;font-size:13px;max-width:320px;';
            document.body.appendChild(banner);
        }
        banner.textContent = 'Access no longer granted. Contact ' + getSupportEmail() + ' for access.';
        var closeBtn = document.createElement('span');
        closeBtn.textContent = '×';
        closeBtn.title = 'Dismiss';
        closeBtn.style.cssText = 'position:absolute;top:6px;right:8px;cursor:pointer;color:#ccc;font-size:15px;line-height:1;';
        closeBtn.onclick = function() { banner.remove(); };
        banner.appendChild(closeBtn);
    }

    // Exposed so loader.js can trigger a live teardown of an ALREADY-
    // RUNNING tool instance — needed for the optimistic-launch flow
    // (loader.js runs a cached copy instantly on a local-config hit, then
    // verifies access in the background; if that background check comes
    // back with a real deny, it needs to actually tear down the session
    // it already started, not just clear localStorage for next time,
    // which is all loader.js can do on its own). Same function every
    // other revoke path (self-update, /feedback) already uses.
    window.__woForceRevoke = revokeAccessLocally;

    // Exposed so loader.js can surface its own background access-
    // verification (optimistic launch — see __woForceRevoke above) in the
    // docked panel's own status line, instead of leaving it invisible.
    // setStatus() itself already no-ops safely if the panel hasn't
    // rendered yet (statusEl still undefined at that point), so this is
    // safe to call at any point in loader.js's flow.
    window.__woSetStatus = setStatus;

    // Re-runs the same domain-agnostic access check loader.js does on first
    // load, and returns a fresh short-lived token for the Worker's /tool
    // endpoint. Only a POSITIVE deny revokes anything — a network hiccup or
    // an unreachable Worker just rejects this promise, leaving the
    // currently-running tool untouched (caught by whichever self-update
    // path called this).
    function runCheckAccess() {
        return xhrGetText(WORKER_BASE_URL + '/bootstrap').then(function(bootText) {
            var boot = JSON.parse(bootText);
            return readWhoamiCanonical().then(function(whoamiData) {
                var fields = {};
                (boot.requiredFields || []).forEach(function(f) {
                    fields[f] = whoamiData[f];
                });
                return xhrPostJSON(WORKER_BASE_URL + '/check-access', {
                    fields: fields
                });
            });
        }).then(function(decision) {
            if (!decision.granted) {
                // revokeAccessLocally() wipes __wo_contact_email along with
                // everything else, so the resolved contact goes IN as its
                // argument (re-written after the wipe), not cached here
                // first — caching it here would just get immediately erased.
                revokeAccessLocally(decision.contactEmail);
                throw new Error('access revoked');
            }
            if (decision.contactEmail) localStorage.setItem(CONTACT_EMAIL_KEY, decision.contactEmail);
            localStorage.setItem(GRANTS_KEY, JSON.stringify(decision.grants || []));
            return decision;
        });
    }

    function getWorkerAccessToken() {
        return runCheckAccess().then(function(decision) {
            return decision.token;
        });
    }

    // Existing-user, manual-only counterpart to loader.js's first-run-only
    // eager fetch (ORG_CONFIGS_KEY) — re-runs the live check-access decision
    // and, if any org configs matched, fetches their full content via
    // /org-config-content using the freshly-issued token. Never called
    // automatically; only from the Setup > Profiles "Check for organization
    // configs" button, so an existing user's config is never silently
    // touched — see installOrgConfig()'s backup-before-overwrite for what
    // happens once they actually pick one.
    function fetchOrgConfigsLive() {
        return runCheckAccess().then(function(decision) {
            if (!decision.configs || !decision.configs.length) return [];
            return xhrGetText(WORKER_BASE_URL + '/org-config-content?token=' + encodeURIComponent(decision.token)).then(function(text) {
                var data = JSON.parse(text);
                return data.configs || [];
            });
        });
    }

    // Fetches the tool's own source through the Worker instead of a public
    // raw URL — version omitted/null means "whatever the Worker's default
    // ref currently serves" (the dev-channel case); a specific version
    // string requests that exact tagged release from the private repo.
    function fetchToolSourceViaWorker(version) {
        return getWorkerAccessToken().then(function(token) {
            var url = WORKER_BASE_URL + '/tool?token=' + encodeURIComponent(token);
            if (version) url += '&version=' + encodeURIComponent(version);
            return xhrGetText(url);
        });
    }

    function getGrants() {
        try {
            return JSON.parse(localStorage.getItem(GRANTS_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    // "beta_0" is a wildcard: holding it satisfies any "beta_N" check, not
    // just itself. dev and beta are independent axes — a user can hold both,
    // one, or neither.
    function hasGrant(flag) {
        var grants = getGrants();
        if (grants.indexOf(flag) !== -1) return true;
        if (flag.indexOf('beta_') === 0 && grants.indexOf('beta_0') !== -1) return true;
        return false;
    }

    // Compat shim for the pre-grants call sites (channel gating, pinned-version
    // gating) that only ever needed a single best tier out of {'', 'beta', 'dev'}.
    // New code that needs a SPECIFIC beta flag should call hasGrant() directly.
    function getDevTier() {
        if (hasGrant('dev')) return 'dev';
        if (hasGrant('beta_0')) return 'beta';
        return '';
    }

    // ── Beta feature framework ──
    // Two independent gates, both required for a beta feature to actually
    // do anything: SERVER GRANT (hasGrant(id) — whether permissions.json
    // says this user qualifies at all) and LOCAL ENABLEMENT (st.betaEnabled,
    // a device-level on/off the user flips themselves in the Beta tab).
    // Granted-but-disabled must be indistinguishable from never-granted —
    // every feature's own code checks isBetaFeatureOn(), never hasGrant()
    // alone, so nothing about it can leak through while it's off.
    // Each feature's id IS the beta grant flag it's gated behind (e.g.
    // "beta_1"), so hasGrant()'s existing beta_0-wildcard rule applies here
    // too — a beta_0 holder qualifies for every feature in this list.
    var BETA_FEATURES = [{
        id: 'beta_1',
        label: 'Route / Return / Fix / Approve',
        description: 'Adds a neutral "Route" symbol and a "Fix" action (rescan + reapply fields) next to Return/Approve. Post-scan actions can be limited to run only on Scan, only on Fix, or both.'
    }, {
        id: 'beta_2',
        label: 'Maximo REST Data (experimental)',
        description: 'Formula helpers for asset WO/downtime history pulled live from Maximo\'s own REST API, plus decoding a coded field via one of Maximo\'s cached domain lists (DOWNCODE, HAZTYPE, etc.). Genuinely experimental — data shapes and field reliability are still being verified, see MAXIMO_DATA_SOURCES.md.'
    }];

    function isBetaFeatureOn(id) {
        if (!hasGrant(id)) return false;
        try {
            var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            return !!(st.betaEnabled && st.betaEnabled[id]);
        } catch (e) {
            return false;
        }
    }

    // Whether the Beta tab itself should be visible at all — true the
    // moment a user qualifies for at least one registered feature.
    function hasAnyBetaGrant() {
        return BETA_FEATURES.some(function(f) {
            return hasGrant(f.id);
        });
    }

    window.__woEnableBeta = function() {
        if (hasGrant('dev')) {
            console.log('[WO Tool] Developer mode already unlocked (includes beta). Use window.__woLockDev() to reset.');
            return 'dev';
        }
        localStorage.setItem(GRANTS_KEY, JSON.stringify(['user', 'beta_0']));
        console.log('[WO Tool] Beta features unlocked. Reopen Setup > Settings to see Update Channel.');
        return 'beta';
    };

    window.__woEnableDev = function() {
        localStorage.setItem(GRANTS_KEY, JSON.stringify(['user', 'dev', 'beta_0']));
        console.log('[WO Tool] Developer mode unlocked. Reopen Setup > Settings to see Update Channel.');
        return 'dev';
    };

    window.__woLockDev = function() {
        localStorage.removeItem(GRANTS_KEY);
        localStorage.removeItem(DEV_UNLOCK_KEY);
        var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        s.channel = 'stable';
        s.pinnedVersion = '';
        saveSettingsCfg(s);
        console.log('[WO Tool] Developer mode locked. Channel reset to stable.');
        return 'locked';
    };

    // ── Dev/test affordances for exercising the first-run flow without the
    // manual localStorage/IndexedDB wipe dance every time. ──
    window.__woShowInstaller = function() {
        showInstaller();
        return 'Showing installer.';
    };

    window.__woReset = function() {
        Object.keys(localStorage).filter(function(k) {
            return k.indexOf('__wo_') === 0;
        }).forEach(function(k) {
            localStorage.removeItem(k);
        });
        if (window.indexedDB) indexedDB.deleteDatabase('__wo_tool_db');
        console.log('[WO Tool] Wiped. Reload the page and click the bookmarklet to test a fresh install.');
        return 'wiped';
    };

    // Dev/test affordance for exercising the update-defer-until-idle path
    // (applyUpdateWhenIdle/applyUpdateNow) without needing to trigger and
    // hold open a real, in-progress Maximo scan — `scanning` is otherwise
    // only ever set by runScan() itself. rawInstall is exposed alongside it
    // so a test can drive the exact same choke point every real update path
    // (installUpdate/checkDevUpdate) already goes through, rather than a
    // hand-copied model of it.
    window.__woTestHooks = {
        setScanning: function(v) { scanning = !!v; },
        isScanning: function() { return scanning; },
        rawInstall: rawInstall,
        // For verifying the update-apply snapshot/restore round trip
        // (applyUpdateNow -> sessionStorage -> restoreUpdateSnapshotIfAny)
        // without needing to drive a real scan against a mocked Maximo page.
        setScanState: function(c, hs, log, retMsg) {
            cache = c;
            hasScanned = !!hs;
            if (log !== undefined) scanLog = log;
            if (retMsg !== undefined) currentReturnMsg = retMsg;
        },
        getScanState: function() {
            return { cache: cache, hasScanned: hasScanned, scanLog: scanLog, currentReturnMsg: currentReturnMsg };
        },
        // For testing the configVersion forward-compatibility gate and
        // backup/import shape validation without driving the actual UI.
        applyBackup: applyBackup,
        buildBackupBlob: buildBackupBlob,
        migrateProfile: migrateProfile,
        switchProfile: switchProfile,
        saveProfiles: saveProfiles,
        getProfiles: getProfiles,
        CURRENT_CONFIG_VERSION: CURRENT_CONFIG_VERSION,
        orgConfigDisplayName: orgConfigDisplayName
    };

    // A semver pre-release suffix (e.g. "0.15.1-beta1") marks a beta/dev build.
    // Plain releases ("0.15.0") are available to everyone; pre-releases require unlock.
    function isPrerelease(v) {
        return typeof v === 'string' && v.indexOf('-') !== -1;
    }

    // ── Resolve which version/channel should be running ──
    // Everyone can pick "stable" or pin to any released (non-prerelease) version.
    // Only "beta"/"dev" channels and beta/dev-tagged pins require the console unlock.
    function resolveUpdateTarget(remote) {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        var tier = getDevTier();
        var channel = st.channel || 'stable';
        if (channel === 'dev' && tier !== 'dev') channel = 'stable';
        if (channel === 'beta' && tier !== 'beta' && tier !== 'dev') channel = 'stable';
        if (channel !== 'stable' && channel !== 'dev' && channel !== 'beta') channel = 'stable';

        if (channel === 'dev') {
            return {
                channel: 'dev',
                version: null,
                pinned: false
            };
        }

        var pin = st.pinnedVersion || '';
        if (pin && isPrerelease(pin) && tier !== 'beta' && tier !== 'dev') pin = '';

        var channels = remote.channels || {};
        var pinned = !!pin;
        var version;
        var pinMissing = false;
        var rolledFrom = null;
        if (pinned && isFloatingMinorPin(pin)) {
            version = resolveFloatingMinor(pin, remote.versions);
            if (!version) {
                // The manifest's `versions` array no longer has ANY entry
                // for this minor line — e.g. an admin trimmed old changelog
                // entries. Falling back to channels/latest here would
                // silently jump the user onto a different line than the one
                // they explicitly pinned to, while the UI kept saying
                // "pinned to X.Y (floating)" — a real bug caught in review.
                // Holding at the currently-installed version is the safe
                // default: worst case is a stale build kept one version
                // longer, not an unannounced track-jump. Manifest trimming
                // is otherwise always safe — see ARCHITECTURE.md's update
                // section — this is the one path that isn't.
                version = TOOL_VERSION;
                pinMissing = true;
            }
        } else {
            var naive = pin || channels[channel] || channels.stable || remote.latest;
            var naiveListed = !naive || (remote.versions || []).some(function(v) {
                return v.version === naive;
            });
            if (naive && !naiveListed) {
                // Whatever this exact pin (or channel/latest) would naively
                // resolve to has been trimmed out of the manifest — e.g. an
                // exact pin whose one entry got cleaned up, or (per the
                // user's own example) a whole channel's target version
                // deleted out from under everyone following it. Move to the
                // closest still-available, permission-appropriate version —
                // see resolveNearestAvailable() for the up-then-fallback
                // ordering.
                var fallback = resolveNearestAvailable(naive, remote.versions, tier);
                if (fallback) {
                    rolledFrom = naive;
                    version = fallback;
                    // Deliberately NOT persisted here (no st.pinnedVersion
                    // write) — this function must stay a pure read, same
                    // discipline pinMissing already follows below. Setup's
                    // openSetup() holds its own long-lived `st` closure
                    // (§4.1) that doesn't know about a write made through a
                    // freshly-parsed copy here; if Setup is open when this
                    // runs (checkForUpdate() fires from Save & Apply, which
                    // no longer closes the modal), Setup's next Save & Apply
                    // would re-persist its stale in-memory pin and silently
                    // clobber a write made here. The actual pin reconciliation
                    // happens downstream in installUpdate() instead, which is
                    // safe for a DIFFERENT reason: it only runs once the user
                    // is pinned (target.pinned, auto-installed immediately) and
                    // its write is immediately followed by rawInstall()'s
                    // teardown-and-reload — Setup's stale in-memory `st`
                    // doesn't survive to overwrite it, since the whole page's
                    // JS context is torn down first. Not persisting here isn't
                    // "safe because idempotent" on its own; it's safe because
                    // the one path that DOES need to persist (an active pin)
                    // is handled by that reload-guarded write instead.
                } else {
                    // Nothing in the manifest is usable at all — same
                    // fail-safe as the floating-pin-missing case above: hold
                    // at the currently-installed build rather than error out.
                    version = TOOL_VERSION;
                    pinMissing = true;
                }
            } else {
                version = naive;
            }
        }
        return {
            channel: channel,
            version: version,
            pinned: pinned,
            pinKind: pinned ? (isFloatingMinorPin(pin) ? 'floating' : 'exact') : null,
            pinRaw: (pinned && rolledFrom) ? version : pin,
            pinMissing: pinMissing,
            rolledFrom: rolledFrom
        };
    }

    function dismissUpdateBanner() {
        var b = document.getElementById('__wo_update_banner');
        if (b) b.remove();
    }

    // ── Update check from GitHub ──
    function checkForUpdate() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (st.updateDisabled) {
            setStatus('Update check disabled (see Settings)');
            return;
        }
        var GITHUB_VERSION_URL = WORKER_BASE_URL + '/version.json';
        setStatus('Checking for updates...');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', GITHUB_VERSION_URL, true);
        xhr.onload = function() {
            if (xhr.status !== 200) {
                setStatus('Update check failed (HTTP ' + xhr.status + ') — running v' + TOOL_VERSION);
                return;
            }
            try {
                var remote = JSON.parse(xhr.responseText);
                var target = resolveUpdateTarget(remote);

                if (target.channel === 'dev') {
                    checkDevUpdate();
                    return;
                }

                // Surfaced whenever resolveUpdateTarget() had to move a pin
                // or channel target off a version that's no longer in the
                // manifest — same "never silently track-jump" principle as
                // pinMissing below, just for the rollback/roll-forward case
                // instead of the "nothing left at all" case.
                var rolledNote = target.rolledFrom ? ('v' + target.rolledFrom + ' is no longer available — ') : '';

                if (target.version === TOOL_VERSION) {
                    dismissUpdateBanner();
                    var pinnedLabel = target.pinMissing ?
                        'Pin ' + target.pinRaw + ' has no builds left in the manifest — staying on v' + TOOL_VERSION :
                        (target.pinKind === 'floating' ?
                            'Pinned to ' + target.pinRaw + ' (v' + TOOL_VERSION + ')' :
                            'Pinned to v' + TOOL_VERSION);
                    setStatus(rolledNote + (target.pinned ?
                        pinnedLabel :
                        'Running the latest ' + target.channel + ' version (v' + TOOL_VERSION + ')') + grantsStatusLine());
                    return;
                }

                if (target.pinned) {
                    // Explicit user pin/rollback — install immediately, no prompt,
                    // for BOTH an exact pin and a floating a.b pin (choosing to pin
                    // at all is the opt-in; a floating pin's whole point is to take
                    // its line's newest patch without asking each time).
                    // No banner ever shows while pinned; a stale one from before the
                    // pin was set must not linger and offer a conflicting install.
                    dismissUpdateBanner();
                    setStatus(rolledNote + (target.pinKind === 'floating' ?
                        'Installing v' + target.version + ' (latest ' + target.pinRaw + ')...' :
                        (target.rolledFrom ?
                            'installing closest available v' + target.version + ' instead...' :
                            'Installing pinned v' + target.version + '...')));
                    installUpdate(target.version);
                    return;
                }

                // Unpinned: a same-major.minor bump (a bug-fix patch) auto-installs
                // silently by default — that's the whole point of the patch/minor
                // split, so a hotfix actually reaches people who never open Setup.
                // Anyone can opt out via Settings. A minor/major bump (new features,
                // behavior/schema changes) always prompts unless the separate
                // "auto-install everything" setting is explicitly turned on.
                var isPatchOnly = sameMinor(target.version, TOOL_VERSION) && versionGt(target.version, TOOL_VERSION);
                var patchAutoUpdate = st.autoUpdatePatch !== false;
                if (isPatchOnly && patchAutoUpdate) {
                    setStatus(rolledNote + 'Installing patch update v' + target.version + '...');
                    installUpdate(target.version);
                } else if (st.autoUpdate) {
                    setStatus(rolledNote + 'Auto-installing update v' + target.version + '...');
                    installUpdate(target.version);
                } else {
                    var skipped = st.skippedVersion || '';
                    if (skipped === target.version) {
                        setStatus(rolledNote + 'Update v' + target.version + ' available (skipped — see Settings to re-enable)');
                        return;
                    }
                    setStatus(rolledNote + 'Update available - current version: v' + TOOL_VERSION);
                    showUpdatePrompt(remote, target, isPatchOnly);
                }

            } catch (e) {
                setStatus('Update check error: ' + e.message + ' — running v' + TOOL_VERSION);
            }
        };
        xhr.onerror = function() {
            setStatus('Update check: no connection — running v' + TOOL_VERSION);
        };
        xhr.send();
    }

    // ── Dev channel: tracks tip of the Worker's default ref directly, no version numbers to compare ──
    function checkDevUpdate() {
        fetchToolSourceViaWorker(null).then(function(code) {
            var cached = localStorage.getItem('__wo_tool_src') || '';
            if (code === cached) {
                setStatus('Running latest dev build (main) — v' + TOOL_VERSION + grantsStatusLine());
                return;
            }
            setStatus('Installing latest dev build...');
            rawInstall(code, 'dev (main)');
        }).catch(function(err) {
            if (err && err.message === 'access revoked') return; // already handled/torn down
            setStatus('Dev channel check failed: ' + err.message + ' — running v' + TOOL_VERSION);
        });
    }

    // ── Show update prompt with cumulative changelog ──
    function showUpdatePrompt(remote, target, isPatchOnly) {
        var old = document.getElementById('__wo_update_banner');
        if (old) old.remove();
        var relevantVersions = (remote.versions || []).filter(function(v) {
            return versionGt(v.version, TOOL_VERSION);
        });
        relevantVersions.sort(function(a, b) {
            return versionGt(a.version, b.version) ? -1 : 1;
        });
        var changelogHtml = relevantVersions.map(function(v) {
            return '<div style="margin-bottom:6px;">' +
                '<span style="color:var(--wo-pass);font-weight:700;">v' + v.version + '</span>' +
                (v.name ? ' <span style="color:var(--wo-muted);font-weight:400;">— ' + v.name + '</span>' : '') +
                '<ul style="margin:2px 0 0 16px;padding:0 0 0 16px;color:var(--wo-muted);list-style:disc;">' +
                (v.changes || []).map(function(c) {
                    return '<li>' + c + '</li>';
                }).join('') +
                '</ul></div>';
        }).join('');
        // This banner only ever shows because the relevant auto-install
        // setting (autoUpdatePatch for a same-line patch, autoUpdate for
        // everything else — see the branch above) is currently OFF for
        // this kind of update. The third button reactivates that SAME
        // existing Settings toggle (not a new setting) and installs this
        // update right away, so opting in doesn't also require a separate
        // trip to Settings to get the update you're already looking at.
        var autoBtnLabel = isPatchOnly ? 'Enable Auto-Patch Updates' : 'Enable Automatic Updates';
        var banner = document.createElement('div');
        banner.id = '__wo_update_banner';
        banner.className = 'wo-notice wo-pass';
        banner.innerHTML =
            '<div class="wo-notice-title">Latest ' + target.channel + ' version: v' + target.version + '</div>' +
            '<div style="max-height:120px;overflow-y:auto;margin-bottom:8px;">' + changelogHtml + '</div>' +
            '<div class="wo-notice-actions">' +
            '<button id="__wo_update_btn" type="button" class="wo-btn wo-btn-pass">Install</button>' +
            '<button id="__wo_update_auto" type="button" class="wo-btn-ghost">' + autoBtnLabel + '</button>' +
            '<button id="__wo_update_skip" type="button" class="wo-btn-ghost">Skip</button>' +
            '<button id="__wo_update_disable" type="button" class="wo-btn-ghost">Disable Updates</button>' +
            '</div>';

        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_update_btn').onclick = function() {
            installUpdate(target.version);
        };
        document.getElementById('__wo_update_auto').onclick = function() {
            var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            if (isPatchOnly) s.autoUpdatePatch = true;
            else s.autoUpdate = true;
            localStorage.setItem('__wo_settings', JSON.stringify(s));
            setStatus((isPatchOnly ? 'Auto-patch updates' : 'Automatic updates') + ' enabled. Installing v' + target.version + '...');
            installUpdate(target.version);
        };
        document.getElementById('__wo_update_skip').onclick = function() {
            var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            s.skippedVersion = target.version;
            localStorage.setItem('__wo_settings', JSON.stringify(s));
            banner.remove();
        };

        document.getElementById('__wo_update_disable').onclick = function() {
            var s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            s.updateDisabled = true;
            localStorage.setItem('__wo_settings', JSON.stringify(s));
            banner.remove();
            setStatus('Update check disabled — re-enable in Settings');
        };


    }

    // ── Syntax-check, cache, and switch to a downloaded build ──
    // Failures here must never touch localStorage/eval — the currently
    // running version has to keep working regardless of what went wrong.
    // The download/cache step (localStorage.setItem('__wo_tool_src', ...))
    // always happens immediately, regardless of whether a scan is running —
    // only the actual apply (teardown + eval, the part that's visually
    // disruptive) waits. See applyUpdateWhenIdle().
    function rawInstall(code, label) {
        try {
            new Function(code);
        } catch (e) {
            setStatus('Update (' + label + ') has syntax error — aborted, still running v' + TOOL_VERSION);
            return;
        }
        localStorage.setItem('__wo_tool_src', code);
        applyUpdateWhenIdle(code, label);
    }

    // Hard ceiling on how long a deferred update will wait for `scanning`
    // to clear before applying anyway — a stuck/never-resolving scan (a
    // real bug elsewhere) must not permanently block every future update
    // check from ever landing. 5 minutes comfortably exceeds any real scan
    // (routeWorkflow's own worst-case safety net is 180s).
    var UPDATE_DEFER_MAX_WAIT_MS = 5 * 60 * 1000;

    function applyUpdateWhenIdle(code, label) {
        if (!scanning) {
            applyUpdateNow(code, label);
            return;
        }
        setStatus('Update ready (' + label + ') — will apply once the current scan finishes...');
        var waitedMs = 0;
        var pollMs = 500;
        var waitInterval = setInterval(function() {
            waitedMs += pollMs;
            if (!scanning || waitedMs >= UPDATE_DEFER_MAX_WAIT_MS) {
                clearInterval(waitInterval);
                applyUpdateNow(code, label);
            }
        }, pollMs);
    }

    // The actual apply — unchanged teardown()+eval() mechanism, but now
    // also snapshots whatever's currently on screen (scan results, the
    // status log, the current return message) into sessionStorage right
    // before tearing the panel down, so the freshly-eval'd instance can
    // restore it before its own first render() — see
    // restoreUpdateSnapshotIfAny(). Only bothers snapshotting if there's
    // actually something real to preserve (hasScanned).
    function applyUpdateNow(code, label) {
        setStatus('Update installed (' + label + ')! Reloading...');
        setTimeout(function() {
            if (hasScanned) {
                try {
                    sessionStorage.setItem(UPDATE_SNAPSHOT_KEY, JSON.stringify({
                        cache: cache,
                        scanLog: scanLog,
                        currentReturnMsg: currentReturnMsg,
                        scrollTop: bodyEl ? bodyEl.scrollTop : 0
                    }));
                } catch (e) {} // best-effort - a failed snapshot just means a normal pre-scan reload, never blocks the update itself
            }
            // Any open Setup/installer modal must not survive a hot-reload — its
            // handlers close over the OLD instance and go stale/disconnected once
            // a fresh instance boots, which is what made the tool feel "stuck"
            // after an in-place update.
            var setupModal = document.getElementById('__wo_setup_modal');
            if (setupModal) setupModal.remove();
            var installerModal = document.getElementById('__wo_installer_modal');
            if (installerModal) installerModal.remove();
            teardown();
            eval(code);
        }, 800);
    }

    // Consumes (and always deletes, success or not) whatever applyUpdateNow()
    // left behind — called once, early in boot, before the first render()
    // so a freshly-eval'd instance shows the SAME scan results the old one
    // had, instead of a "press Scan to populate values" blank slate. This
    // is the only reason an update, once applied, is visible ANYWHERE
    // except the status line.
    function restoreUpdateSnapshotIfAny() {
        var raw;
        try {
            raw = sessionStorage.getItem(UPDATE_SNAPSHOT_KEY);
        } catch (e) {
            return;
        }
        if (!raw) return;
        try {
            sessionStorage.removeItem(UPDATE_SNAPSHOT_KEY);
        } catch (e) {}
        try {
            var snap = JSON.parse(raw);
            if (snap.cache) cache = snap.cache;
            if (snap.scanLog) scanLog = snap.scanLog;
            if (snap.currentReturnMsg !== undefined) currentReturnMsg = snap.currentReturnMsg;
            hasScanned = true;
            // bodyEl doesn't exist yet at this point in boot (buildPanel()
            // hasn't run) - the actual scroll restore has to happen just
            // AFTER the first render(), not here. Stashed on window as the
            // simplest handoff across that gap without threading a new
            // parameter through render()/the boot sequence.
            if (snap.scrollTop) {
                window.__wo_pending_scroll_restore = snap.scrollTop;
            }
        } catch (e) {}
    }

    // ── Install update from GitHub ──
    function installUpdate(newVersion) {
        setStatus('Downloading v' + newVersion + '...');
        fetchToolSourceViaWorker(newVersion).then(function(src) {
            // Reconcile an active pin to whatever's actually being installed. This
            // is the single choke point every install path (banner, pinned auto-
            // install, future affordances) goes through — without it, a pinned
            // user who explicitly installs a different version gets silently
            // reverted back to the old pin on the very next automatic check.
            // Only touches the pin if one was already active; unpinned users stay
            // unpinned.
            //
            // Exception: a FLOATING minor pin ("0.17") installing a newer patch
            // in its OWN line ("0.17.1") is that pin doing exactly its job, not
            // an override — reconciling it to the exact patch would silently
            // freeze what's supposed to be an always-auto-patched pin after its
            // very first install, defeating the entire point of choosing it.
            var pinSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            if (pinSt.pinnedVersion && pinSt.pinnedVersion !== newVersion) {
                var pinIsFloatingSameLine = isFloatingMinorPin(pinSt.pinnedVersion) &&
                    minorKey(pinSt.pinnedVersion) === minorKey(newVersion);
                if (!pinIsFloatingSameLine) {
                    pinSt.pinnedVersion = newVersion;
                    localStorage.setItem('__wo_settings', JSON.stringify(pinSt));
                }
            }
            rawInstall(src, 'v' + newVersion);
        }).catch(function(err) {
            if (err && err.message === 'access revoked') return; // already handled/torn down
            setStatus('Update download failed: ' + err.message + ' — still running v' + TOOL_VERSION);
        });
    }

    function statusColor(s) {
        return s === 'pass' ? '#3fb950' :
            s === 'fail' ? '#f85149' :
            s === 'warn' ? '#d29922' :
            s === 'error' ? '#bc8cff' :
            '#9aa4af';
    }

    // Compact glyph for a status, used once a group badge has to represent
    // more than one rule and there's no room left to spell PASS/FAIL out.
    function statusSymbol(s) {
        return s === 'pass' ? '✓' :
            s === 'fail' ? '✕' :
            s === 'warn' ? '!' :
            s === 'error' ? '‼' :
            '?';
    }


    function poll(checkFn, timeoutMs, cb) {
        var start = Date.now();
        (function tick() {
            if (checkFn()) return cb(true);
            if (Date.now() - start > timeoutMs) return cb(false);
            setTimeout(tick, 100);
        })();
    }

    function dismissDialog() {
        var docs = findAllDocs();
        // Pass 1: prefer Cancel or Close (safe dismissal — never submits)
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                var dlgHolder = d.getElementById('dialogholder');
                if (dlgHolder && dlgHolder.offsetParent !== null) {
                    var pbs = dlgHolder.querySelectorAll('button[id$="-pb"], input[type="button"][id$="-pb"]');
                    for (var p = 0; p < pbs.length; p++) {
                        var pt = pbs[p].textContent.trim().toLowerCase();
                        if ((pt === 'cancel' || pt === 'close') && pbs[p].offsetParent !== null) {
                            pbs[p].click();
                            return true;
                        }
                    }
                }
            } catch (e) {}
        }
        // Pass 2: fall back to OK/Done only if no Cancel/Close found
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                var dlgHolder = d.getElementById('dialogholder');
                if (dlgHolder && dlgHolder.offsetParent !== null) {
                    var pbs = dlgHolder.querySelectorAll('button[id$="-pb"], input[type="button"][id$="-pb"]');
                    for (var p = 0; p < pbs.length; p++) {
                        var pt = pbs[p].textContent.trim().toLowerCase();
                        if ((pt === 'ok' || pt === 'done') && pbs[p].offsetParent !== null) {
                            pbs[p].click();
                            return true;
                        }
                    }
                }
            } catch (e) {}
        }
        return false;
    }

    function closeAnyDialog() {
        var docs = findAllDocs();
        // Pass 1: prefer Cancel or Close
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                var dlgHolder = d.getElementById('dialogholder');
                if (dlgHolder && dlgHolder.offsetParent !== null) {
                    var pbs = dlgHolder.querySelectorAll('button[id$="-pb"],input[type="button"][id$="-pb"],button,a,input[type="button"]');
                    for (var p = 0; p < pbs.length; p++) {
                        var pt = pbs[p].textContent.trim().toLowerCase();
                        if ((pt === 'cancel' || pt === 'close') && pbs[p].offsetParent !== null) {
                            pbs[p].click();
                            return true;
                        }
                    }
                }
            } catch (e) {}
        }
        // Pass 2: fall back to OK/Done
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                var dlgHolder = d.getElementById('dialogholder');
                if (dlgHolder && dlgHolder.offsetParent !== null) {
                    var pbs = dlgHolder.querySelectorAll('button[id$="-pb"],input[type="button"][id$="-pb"],button,a,input[type="button"]');
                    for (var p = 0; p < pbs.length; p++) {
                        var pt = pbs[p].textContent.trim().toLowerCase();
                        if ((pt === 'ok' || pt === 'done') && pbs[p].offsetParent !== null) {
                            pbs[p].click();
                            return true;
                        }
                    }
                }
            } catch (e) {}
        }
        return false;
    }

    function dialogIsGone() {
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                var holder = docs[i].doc.getElementById('dialogholder');
                if (!holder || holder.offsetParent === null) continue;
                // Check if there are any visible buttons inside — if not, dialog is effectively gone
                var btns = holder.querySelectorAll('button[id$="-pb"], input[type="button"][id$="-pb"]');
                for (var b = 0; b < btns.length; b++) {
                    if (btns[b].offsetParent !== null) return false;
                }
            } catch (e) {}
        }
        return true;
    }



    function tableEntriesFor(title) {
        var cfg = {};
        try {
            cfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}
        var out = [];
        Object.keys(cfg).forEach(function(k) {
            var e = cfg[k];
            if (e.type === 'table-column' && e.tableTitle === title) out.push(e);
        });
        return out;
    }

    function tableIsReady(title) {
        var entries = tableEntriesFor(title);
        if (!entries.length) {
            if (looksLikePrefix(title)) {
                var docs = findAllDocs();
                for (var i = 0; i < docs.length; i++) {
                    try {
                        var d = docs[i].doc;
                        if (d.querySelector('[id^=\"' + title + '_tdrow_\"],[id^=\"' + title + '_tbod_tempty\"]')) return true;
                    } catch (e) {}
                }
                return false;
            }
            var docs = findAllDocs();
            for (var i = 0; i < docs.length; i++) {
                try {
                    var d = docs[i].doc;
                    var el = d.querySelector('[id*=\"_tdrow_\"],[id*=\"_tbod_tempty\"]');
                    if (el && el.offsetParent !== null) return true;
                } catch (e) {}
            }
            return false;
        }
        var prefix = resolveLiveTablePrefix(title, entries[0] && entries[0].tablePrefix, entries);
        if (!prefix) return false;
        var docs = findAllDocs();
        for (var i = 0; i < docs.length; i++) {
            try {
                var d = docs[i].doc;
                if (d.querySelector('[id^="' + prefix + '_tdrow_"]')) return true;
                if (d.querySelector('[id^="' + prefix + '_tbod_tempty"]')) return true;
            } catch (e) {}
        }
        return false;
    }
    var scanning = false;
    // True for the whole in-flight duration of a Return/Approve route
    // (routeWorkflow) — separate from `scanning` since Scan/Fix already
    // self-guard via that flag, but routeWorkflow previously had no
    // re-entrancy guard at all. Checked together with `scanning` (see
    // actionsBusy()) so a route and a scan/fix can never overlap either —
    // both drive the same shared Maximo tabs/dialogs.
    var routing = false;

    function actionsBusy() {
        return scanning || routing;
    }
    // Disables (and dims) the Scan/Return/Fix/Approve buttons for the
    // duration of actionsBusy() so a second click — or the matching hotkey,
    // see hotkeyActionActive()'s caller in applyHotkeys() — can't fire a
    // second overlapping automation run on top of one already in progress.
    // Buttons are recreated on every render(), so this both flips the live
    // DOM nodes right now AND (via the disabled= at creation time in
    // buildPanel/render) stays correct across any render that happens
    // mid-lock.
    function setActionsLocked(locked) {
        if (!panel) return;
        ['__wo_rescan', '__wo_action_return', '__wo_action_fix', '__wo_action_approve'].forEach(function(id) {
            var b = panel.querySelector('#' + id);
            if (!b) return;
            b.disabled = locked;
            b.style.opacity = locked ? '0.55' : '';
            b.style.cursor = locked ? 'not-allowed' : '';
        });
    }
    // Releases the routing lock — called from every terminal branch inside
    // routeWorkflow (whether it finished cleanly, hit an error, or handed
    // off to the user to click Maximo's own OK button by hand), plus once
    // more from a safety-net timeout in case some branch was missed —
    // better to unlock a little late than to leave Return/Approve/Scan/Fix
    // permanently disabled until the page is reloaded. The timer itself is
    // tracked so it can be cancelled here (a clean finish shouldn't leave a
    // stale timer armed to fire mid-flight during a LATER route) and
    // re-armed fresh at the top of every routeWorkflow() call.
    var __woRouteSafetyTimer = null;
    function finishRoute() {
        if (!routing) return;
        routing = false;
        if (__woRouteSafetyTimer) {
            clearTimeout(__woRouteSafetyTimer);
            __woRouteSafetyTimer = null;
        }
        setActionsLocked(false);
    }
    var scanLog = [];
    // null = no manual edit yet, so Return/Copy use the freshly computed
    // buildReturnMessage() as-is. Once the user types in the return-message
    // box, this holds their exact text instead — the single source of truth
    // both routeWorkflow('return') and copyReturnMessage() read from, since
    // a hotkey can fire while the box itself isn't even rendered (panel
    // collapsed). Reset to null at the top of runScan() so a fresh scan
    // always starts from a freshly computed message again.
    var currentReturnMsg = null;

    // Tells a group's empty/errored table apart from an intentionally-
    // skipped one: finds the scan step (if any) whose waitTable matches this
    // table id, then reads that step's own scanLog outcome for the run that
    // just completed. 'skipped (condition false)' means the step never ran
    // this time on purpose — not a capture failure — so the caller should
    // show plain "No rows", not an error. Same for a step that reported 'OK'
    // but the table came back empty anyway (a legitimately empty result,
    // e.g. no downtime logged this run). Only TIMEOUT/FAILED — or no
    // matching step at all, since that means this table isn't gated by any
    // condition and 0 rows genuinely is unexpected — should read as an error.
    function tableRunStatus(tableId, scanCfg) {
        var step = null;
        var steps = (scanCfg && scanCfg.scans) || [];
        for (var i = 0; i < steps.length; i++) {
            if (steps[i].waitTable === tableId) {
                step = steps[i];
                break;
            }
        }
        if (!step) return 'unknown';
        for (var j = scanLog.length - 1; j >= 0; j--) {
            if (scanLog[j].title === step.title) return scanLog[j].result;
        }
        return 'unknown';
    }
    window.__wo_laborTypeCache = [];

    // mode is 'scan' (default) or 'fix' — Fix is the beta_1-only rescan
    // action (see runScan's mode param). An action's own runOn ('both' —
    // the default, 'scan', or 'fix') decides whether it's eligible to fire
    // on this particular run, independent of its condition formula.
    function runActions(step, mode) {
        // Post-Scan Actions is beta_1-gated end to end (editor + execution)
        // alongside Fix — same reasoning as Fix itself: unproven, so it
        // shouldn't silently write to Maximo for anyone who hasn't
        // opted in. Existing action config is left alone in storage either
        // way; it just goes dormant instead of being deleted.
        if (!isBetaFeatureOn('beta_1')) return;
        var actions = (step && step.actions) || [];
        if (!actions.length) return;
        actions.forEach(function(action) {
            try {
                var runOn = action.runOn || 'both';
                if (runOn === 'scan' && mode === 'fix') return;
                if (runOn === 'fix' && mode !== 'fix') return;
                if (action.condition) {
                    if (!formulaBool(action.condition, cache)) return;
                }
                var val = '';
                try {
                    var c = buildCtx(cache);
                    var av = [c.F, c.T, c.rowCount, c.col, c.has, c.lookup, c.count, c.isEmpty, c.notEmpty, c.ifBlank, c.toNumber, c.toString, c.trim, c.upper, c.lower, c.left, c.right, c.mid, c.sum, c.avg, c.today, c.hours, c.hoursBetween, c.daysBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.whoami, c.domain, c.assetWOHistory, c.assetDowntimeHistory, c.V];
                    var fn = Function.apply(null, ARGN.concat(['return (' + normalizeFormulaFunctionCase(action.value) + ');']));
                    val = fn.apply(null, av);
                    if (val == null) val = '';
                    val = String(val);
                } catch (e) {
                    return;
                }

                if (!val) return;

                var docs = findAllDocs();
                for (var i = 0; i < docs.length; i++) {
                    try {
                        var el = docs[i].doc.getElementById(action.fieldId);
                        if (!el) continue;
                        el.value = val;
                        if (typeof docs[i].win.sendEvent === 'function') {
                            docs[i].win.sendEvent('setvalue', action.fieldId, val);
                        } else {
                            var ev = el.ownerDocument.createEvent('Event');
                            ev.initEvent('change', true, true);
                            el.dispatchEvent(ev);
                        }
                        scanLog.push({
                            title: 'Action',
                            result: 'Set ' + action.fieldId + ' = ' + val
                        });
                        break;
                    } catch (e) {}
                }
            } catch (e) {}
        });
    }

    function collectRowDetailFields(scanStep, onDone) {
        var rdFields = (scanStep && scanStep.rowDetailFields) || [];
        if (!rdFields.length) {
            if (onDone) onDone();
            return;
        }

        // Group fields by tablePrefix+expandColIndex so we only expand each table once
        var tableGroups = {};
        rdFields.forEach(function(rdf) {
            if (rdf.collectCondition) {
                if (!formulaBool(rdf.collectCondition, cache)) return;
            }
            var key = (rdf.tablePrefix || '') + '|' + (rdf.expandColIndex || 0);
            if (!tableGroups[key]) tableGroups[key] = {
                prefix: rdf.tablePrefix,
                col: rdf.expandColIndex || 0,
                fields: []
            };
            tableGroups[key].fields.push(rdf);
        });

        var groupKeys = Object.keys(tableGroups);
        if (!groupKeys.length) {
            if (onDone) onDone();
            return;
        }

        var gi = 0;

        function nextGroup() {
            if (gi >= groupKeys.length) {
                if (onDone) onDone();
                return;
            }
            var grp = tableGroups[groupKeys[gi++]];
            var lp = grp.prefix;

            // Find the frame containing this table
            var d = null;
            var frameDocs = [document];
            try {
                for (var fi = 0; fi < window.frames.length; fi++) {
                    try {
                        var frame = window.frames[fi];
                        if (frame && frame.document) frameDocs.push(frame.document);
                    } catch (e) {}
                }
            } catch (e) {}
            for (var di = 0; di < frameDocs.length; di++) {
                try {
                    if (frameDocs[di].querySelector('[id^="' + lp + '_tdrow_"]')) {
                        d = frameDocs[di];
                        break;
                    }
                } catch (e) {}
            }

            if (!d) {
                nextGroup();
                return;
            }

            // Find table name by looking up the prefix in lastPrefixLog
            var tableName = null;
            Object.keys(cache.tables).forEach(function(tn) {
                if (tableName) return;
                if (tn === lp) {
                    tableName = tn;
                    return;
                }
            });
            if (!tableName) {
                Object.keys(lastPrefixLog).forEach(function(tn) {
                    if (lastPrefixLog[tn] === lp) tableName = tn;
                });
            }

            // Pre-initialize columns on all existing rows
            var rows = tableName ? (cache.tables[tableName] || []) : [];
            grp.fields.forEach(function(rdf) {
                rows.forEach(function(row) {
                    if (!row.hasOwnProperty(rdf.columnName)) row[rdf.columnName] = '';
                });
            });
            if (tableName) cache.tables[tableName] = rows;

            // Find expand buttons (the toggle element, not the _img child)
            var expandBtns = Array.from(
                d.querySelectorAll('[id*="' + lp + '_tdrow_[C:' + grp.col + ']_tgdet-ti[R:"]')
            ).filter(function(b) {
                return /\[R:\d+\]$/.test(b.id);
            });

            if (!expandBtns.length) {
                nextGroup();
                return;
            }

            var i = 0;

            function nextRow() {
                if (i >= expandBtns.length) {
                    nextGroup();
                    return;
                }
                var btn = expandBtns[i++];
                var rowIdx = i - 1;
                btn.click();
                setTimeout(function() {
                    grp.fields.forEach(function(rdf) {
                        var el = d.getElementById(rdf.elementId);
                        var v = el ? (el.value || el.getAttribute('prekeyvalue') || '').trim() : '';
                        if (tableName && cache.tables[tableName] && cache.tables[tableName][rowIdx] !== undefined) {
                            cache.tables[tableName][rowIdx][rdf.columnName] = v.toUpperCase();
                        }
                    });
                    btn.click();
                    setTimeout(nextRow, 300);
                }, 500);
            }
            nextRow();
        }
        nextGroup();
    }

    function openDialogTrigger(t, cb) {
        function survey() {
            var docs = findAllDocs();
            var best = null,
                visible = false,
                count = 0;
            for (var i = 0; i < docs.length; i++) {
                try {
                    var els = docs[i].doc.querySelectorAll('[eventtype="' + t.eventType + '"]');
                    for (var j = 0; j < els.length; j++) {
                        count++;
                        if (els[j].offsetParent !== null) {
                            best = els[j];
                            visible = true;
                        } else if (!best) best = els[j];
                    }
                } catch (e) {}
            }
            return {
                el: best,
                visible: visible,
                count: count
            };
        }
        var s = survey();
        if (s.el) {
            s.el.click();
            return cb(true, 'clicked trigger (found ' + s.count + ', visible: ' + s.visible + ')');
        }
        var sew = findSendEventWin();
        if (sew) {
            try {
                sew.sendEvent(t.eventType, t.app || 'wotrack', '');
            } catch (e) {}
            poll(function() {
                var s2 = survey();
                return !!s2.el;
            }, 2000, function(ok) {
                if (ok) {
                    var s3 = survey();
                    s3.el.click();
                    return cb(true, 'sendEvent built menu, then clicked (visible: ' + s3.visible + ')');
                }
                cb(true, 'trigger absent from DOM; fired sendEvent(' + t.eventType + ') blind');
            });
            return;
        }
        cb(false, 'trigger not in DOM and sendEvent unavailable');
    }


    /* ── message resolution helpers ── */
    function resolveMsg(msg, data) {
        if (typeof msg !== 'string') return String(msg);
        return msg.replace(/\{\{([\s\S]+?)\}\}/g, function(_, expr) {
            try {
                var c = buildCtx(data);
                var av = [c.F, c.T, c.rowCount, c.col, c.has, c.lookup, c.count, c.isEmpty, c.notEmpty, c.ifBlank, c.toNumber, c.toString, c.trim, c.upper, c.lower, c.left, c.right, c.mid, c.sum, c.avg, c.today, c.hours, c.hoursBetween, c.daysBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.whoami, c.domain, c.assetWOHistory, c.assetDowntimeHistory, c.V];

                var fn = Function.apply(null, ARGN.concat(['return (' + normalizeFormulaFunctionCase(expr.trim()) + ');']));
                var r = fn.apply(null, av);
                return r != null ? r : '';
            } catch (e) {
                return '?';
            }
        });
    }

    // Unified resolver for a rule's pass/fail/warn "long" message list — each
    // entry is {condition, msg} with its own dedicated fields (no ' :: ' delimiter
    // parsing), so a condition referencing a qualified field name like
    // "Tab :: Field" can never corrupt the message. Entries whose condition
    // evaluates false are skipped; surviving messages run through resolveMsg()
    // for {{expr}} substitution.
    function resolveMsgList(list, data) {
        var out = [];
        (list || []).forEach(function(entry) {
            if (!entry) return;
            if (typeof entry === 'string') {
                out.push(resolveMsg(entry, data));
                return;
            }
            if (entry.condition && !formulaBool(entry.condition, data)) return;
            if (!entry.msg) return;
            out.push(resolveMsg(entry.msg, data));
        });
        return out;
    }
    /* ── auto-discover all columns from a rendered table prefix ── */
    function discoverTableCols(tableTitle) {
        var docs = findAllDocs();
        var prefix = looksLikePrefix(tableTitle) ? tableTitle : resolveLiveTablePrefix(tableTitle, null, []);
        if (!prefix) return [];
        var colMap = {};
        // Pass 1: header labels
        docs.forEach(function(x) {
            try {
                x.doc.querySelectorAll('[id^="' + prefix + '_ttrow_"]').forEach(function(lbl) {
                    var m = lbl.id.match(/_ttrow_\[C:(\d+)\]_ttitle-lb$/);
                    if (m) colMap[m[1]] = lbl.textContent.trim() || ('Col' + m[1]);
                });
                x.doc.querySelectorAll('[id^="' + prefix + '_ttrow_"]').forEach(function(el) {
                    var m = el.id.match(/_ttrow_\[C:(\d+)\][^\[]*-lb$/);
                    if (m && el.textContent.trim() && !colMap[m[1]]) colMap[m[1]] = el.textContent.trim();
                });
            } catch (e) {}
        });
        // Pass 2: infer column indexes from data cell IDs (catches columns with missing/unrendered headers)
        docs.forEach(function(x) {
            try {
                x.doc.querySelectorAll('[id^="' + prefix + '_tdrow_"]').forEach(function(el) {
                    var m = el.id.match(/_tdrow_\[C:(\d+)\]/);
                    if (m && !colMap[m[1]]) colMap[m[1]] = 'Col' + m[1];
                });
            } catch (e) {}
        });
        if (!Object.keys(colMap).length) return [];
        var fp = prefix;
        return Object.keys(colMap).sort(function(a, b) {
            return +a - +b;
        }).map(function(ci) {
            return {
                colIndex: +ci,
                columnLabel: colMap[ci],
                tablePrefix: fp,
                tableTitle: tableTitle,
                type: 'table-column'
            };
        });
    }
    /* ── snapshot that auto-discovers columns for unconfigured tables ── */
    function extractSnapshotFull() {
        var storedCfg = {};
        try {
            storedCfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}
        var fields = {},
            tableGroups = {};
        Object.keys(storedCfg).forEach(function(k) {
            var e = storedCfg[k];
            if (e.type === 'table-column') {
                if (!tableGroups[e.tableTitle]) tableGroups[e.tableTitle] = [];
                tableGroups[e.tableTitle].push(e);
            } else fields[e.tab + ' :: ' + e.label] = resolveField(e);
        });
        var cfg2 = getCfg();
        cfg2.groups.forEach(function(g) {
            groupTables(g).forEach(function(t) {
                // See extractSnapshot()'s identical guard above - custom/API
                // tables must never be registered as a scan target here.
                if ((cfg2.customTables && cfg2.customTables[t]) || (cfg2.apiTables && cfg2.apiTables[t])) return;
                if (!(t in tableGroups)) tableGroups[t] = [];
            });
        });
        var tables = {},
            tableErrors = {};
        Object.keys(tableGroups).forEach(function(t) {
            var entries = tableGroups[t];
            if (!entries || !entries.length) entries = discoverTableCols(t);
            var lp = looksLikePrefix(t) ? t : resolveLiveTablePrefix(t, (entries[0] && entries[0].tablePrefix) || null, entries);
            if (!lp && entries.length) lp = entries[0].tablePrefix || null;
            lastPrefixLog[t] = lp || '(none)';
            if (!lp) {
                tableErrors[t] = 'Table "' + t + '" not rendered';
                tables[t] = [];
                return;
            }

            // Always re-discover columns; prefer stored/named labels over Col\d+ placeholders
            var freshEntries = discoverTableCols(t);
            if (freshEntries.length) {
                var byCol = {};
                entries.forEach(function(e) {
                    byCol[e.colIndex] = e;
                });
                freshEntries.forEach(function(e) {
                    if (!byCol[e.colIndex] || /^Col\d+$/.test(byCol[e.colIndex].columnLabel)) {
                        byCol[e.colIndex] = e;
                    }
                });
                entries = Object.keys(byCol).sort(function(a, b) {
                    return +a - +b;
                }).map(function(k) {
                    return byCol[k];
                });
            }

            var rowSet = {};
            var docs = findAllDocs();

            docs.forEach(function(x) {
                try {
                    x.doc.querySelectorAll('[id^="' + lp + '_tdrow_"]').forEach(function(el) {
                        var rm = el.id.match(/\[R:(\d+)\](?:[^\[]*)$/);
                        if (rm && /^\d+$/.test(rm[1])) rowSet[rm[1]] = true;
                    });
                } catch (e) {}
            });
            var rowIds = Object.keys(rowSet).sort(function(a, b) {
                return +a - +b;
            });
            var rows = [];
            rowIds.forEach(function(r) {
                var row = {};
                entries.forEach(function(entry) {
                    row[entry.columnLabel] = getCellValAllDocs(lp, entry.colIndex, r);
                });
                rows.push(row);
            });

            tables[t] = rows;
            if (!rows.length) tableErrors[t] = 'Table "' + t + '" - 0 rows (prefix: ' + lp + ')';
        });
        return {
            fields: fields,
            tables: tables,
            tableErrors: tableErrors
        };
    } /* ── patched runScan: capture snapshot inside each step after DOM is ready ── */
    // mode is 'scan' (default) or 'fix' — Fix reruns the exact same scan
    // pipeline, just with a different set of post-scan actions eligible to
    // fire (see runActions). Everything else about a run is identical.
    function runScan(done, mode) {
        if (actionsBusy()) return;
        mode = mode || 'scan';
        scanning = true;
        setActionsLocked(true);
        scanLog = [];
        currentReturnMsg = null;
        cache = {
            fields: {},
            tables: {},
            tableErrors: {}
        };
        // beta_2's REST-backed helpers cache per-argument results (see their
        // definitions) so a formula re-evaluated several times per render
        // doesn't refire the same request — but this tool's whole job is
        // showing CURRENT state, and asset WO/downtime history is exactly
        // the kind of thing that changes between scans (someone logs
        // downtime, you rescan to verify a fix). Clearing all three here
        // means a fresh scan always re-fetches once per referenced asset,
        // instead of quietly serving first-fetch-of-the-session data all day.
        betaAssetWoCache = {};
        betaAssetDowntimeCache = {};
        betaApiTableCache = {};
        var sew = findSendEventWin();
        var scan = getScan();
        setStatus('Reading WO tab...');
        // Capture whatever's on the currently-open tab (normally the WO tab
        // itself, since that's where a scan starts) before evaluating any
        // step's condition — otherwise a condition reading a WO-tab field
        // (e.g. Work Type, Lot #) sees an empty cache and always resolves
        // false, silently skipping that step every time.
        mergeSnapshot(extractSnapshotFull());
        var i = 0;

        // Conditions are evaluated lazily, one step at a time, right before
        // that step runs — NOT pre-filtered as a batch up front. This lets a
        // later step's condition see data captured by an EARLIER step in
        // this same run (e.g. a table read on tab B feeding a condition on
        // tab C), not just whatever was on-screen when the scan started.
        // Scan order (Setup > Scan, now reorderable) is what makes this work:
        // a dependency has to come before whatever reads it.
        function next() {
            if (i >= scan.scans.length) return finish();
            var t = scan.scans[i++];
            if (!formulaBool(t.condition, cache)) {
                scanLog.push({
                    title: t.title,
                    result: 'skipped (condition false)'
                });
                return next();
            }
            var t0 = Date.now();
            setStatus('Scanning: ' + t.title + '...');
            if (t.type === 'dialog') {
                openDialogTrigger(t, function(success, diag) {
                    if (!success) {
                        scanLog.push({
                            title: t.title,
                            result: 'FAILED - ' + (diag || 'could not open trigger for ' + t.eventType)
                        });
                        return next();
                    }
                    scanLog.push({
                        title: t.title + ' (nav)',
                        result: diag || 'trigger clicked'
                    });
                    waitAndExtract();
                });
                return;
            } else {
                if (!sew) {
                    scanLog.push({
                        title: t.title,
                        result: 'FAILED - sendEvent not found in any frame'
                    });
                    return next();
                }
                try {
                    sew.sendEvent('click', t.tabId, '');
                } catch (e) {
                    scanLog.push({
                        title: t.title,
                        result: 'FAILED - sendEvent threw: ' + e.message
                    });
                    return next();
                }
            }
            waitAndExtract();

            function waitAndExtract() {
                var readyFn = t.waitTable ? function() {
                    return tableIsReady(t.waitTable);
                } : function() {
                    return textMarkerExists(t.waitFor);
                };
                poll(readyFn, 8000, function(ok) {
                    var ms = Date.now() - t0;
                    if (ok) {
                        // No setTimeout — poll already confirmed the marker/table is present.
                        mergeSnapshot(extractSnapshotFull());
                        scanLog.push({
                            title: t.title,
                            result: 'OK (' + ms + 'ms)'
                        });
                        afterMarker();
                    } else {
                        scanLog.push({
                            title: t.title,
                            result: 'TIMEOUT waiting for ' +
                                (t.waitTable ? ('table "' + t.waitTable + '"') : ('"' + t.waitFor + '"')) +
                                ' (' + ms + 'ms)'
                        });
                        afterMarker();
                    }
                });

                function afterMarker() {
                    if (t.type === 'dialog') {
                        // If the dialog is already gone (closed on its own after data extract), proceed immediately
                        if (dialogIsGone()) return next();

                        // Otherwise dismiss it
                        var dismissAttempts = 0;
                        var maxAttempts = 20;
                        (function tryDismiss() {
                            if (dialogIsGone()) return next();
                            if (dismissAttempts >= maxAttempts) {
                                scanLog.push({
                                    title: t.title + ' (close)',
                                    result: 'FAILED to dismiss dialog after ' + dismissAttempts + ' attempts'
                                });
                                return next();
                            }
                            dismissAttempts++;
                            dismissDialog();
                            setTimeout(tryDismiss, 150);
                        })();


                    } else {
                        if (t.rowDetailFields && t.rowDetailFields.length) {
                            collectRowDetailFields(t, function() {
                                runActions(t, mode);
                                next();
                            });
                        } else {
                            runActions(t, mode);
                            next();
                        }
                    }


                }

            }
        }

        function finish() {
            setStatus('Returning to WO tab...');
            hasScanned = true;
            var lastScannedWO = cache.fields['Work Order :: Work Order'] || '';
            localStorage.setItem('__wo_last_scanned_wo', lastScannedWO);
            // Check first — WO tab DOM is almost always already present
            if (textMarkerExists('Reported By Name') || textMarkerExists('Work Type')) {
                if (sew) {
                    try {
                        sew.sendEvent('click', scan.woTabId, '');
                    } catch (e) {}
                }
                mergeSnapshot(extractSnapshotFull());
                scanning = false;
                setActionsLocked(false);
                setStatus('Complete ' + new Date().toLocaleTimeString());
                done();
                return;
            }
            // Tab click first, then wait for markers
            if (sew) {
                try {
                    sew.sendEvent('click', scan.woTabId, '');
                } catch (e) {}
            }
            poll(function() {
                return textMarkerExists('Reported By Name') || textMarkerExists('Work Type');
            }, 2000, function() {
                mergeSnapshot(extractSnapshotFull());
                scanning = false;
                setActionsLocked(false);
                setStatus('Complete ' + new Date().toLocaleTimeString());
                done();
            });
        }


        next();
    }
    window.__woDebugTables = function() {
        var docs = findAllDocs();
        var found = {};
        docs.forEach(function(d) {
            try {
                var all = d.doc.querySelectorAll('[id*="_tdrow_"]');
                all.forEach(function(el) {
                    var m = el.id.match(/^(.+?)_tdrow_(\[C:\d+\][^\[]*)(\[R:(\d+)\])?$/);
                    if (m) {
                        var key = m[1];
                        if (!found[key]) found[key] = new Set();
                        found[key].add(m[2]);
                    }
                });
            } catch (e) {}
        });
        Object.keys(found).forEach(function(k) {
            console.log('TABLE PREFIX:', k, '-> column widget patterns seen:', Array.from(found[k]));
        });
        console.log('Also check nearby -lb labels (V=visible, H=hidden):');
        docs.forEach(function(d) {
            try {
                d.doc.querySelectorAll('[id$="-lb"]').forEach(function(l) {
                    if (l.textContent.trim()) console.log((l.offsetParent !== null ? 'V' : 'H'), l.id, '=', l.textContent.trim());
                });
            } catch (e) {}
        });
        console.log('Last resolved table prefixes:', JSON.stringify(lastPrefixLog));
        return 'Done';
    };
    window.__woDebugCache = function() {
        console.log('=== WO Tool Cache ===');
        console.log('Fields:', JSON.stringify(cache.fields, null, 2));
        Object.keys(cache.tables).forEach(function(t) {
            console.log('Table "' + t + '" (' + cache.tables[t].length + ' rows):', JSON.stringify(cache.tables[t].slice(0, 5), null, 2));
        });
        if (Object.keys(cache.tableErrors).length) console.log('Table errors:', JSON.stringify(cache.tableErrors));
        console.log('Prefixes:', JSON.stringify(lastPrefixLog));
        return 'Done';
    };

    // ── beta_2 discovery tools ──
    // Not gated behind isBetaFeatureOn — same reasoning as __woDebugTables/
    // __woDebugCache above: these are console-only, and a debug tool that's
    // itself gated behind the feature it's meant to help you verify would be
    // useless the one time you actually need it (before turning beta_2 on,
    // or to decide whether it's worth turning on at all).

    // Splits a raw OSLC record into plain scalar fields vs. sub-resource
    // collection refs/objects — the same by-hand technique used to explore
    // mxapiwo/mxapiasset from the console (see MAXIMO_DATA_SOURCES.md §2.2),
    // now reusable for any record shape instead of retyping it each time.
    function splitScalarsAndCollections(d) {
        var collections = {},
            scalars = {};
        Object.keys(d).forEach(function(k) {
            var v = d[k];
            if (k.indexOf('_collectionref') !== -1 || (typeof v === 'string' && v.indexOf('_collectionref') !== -1)) return;
            if (Array.isArray(v)) collections[k] = '(inline array, length ' + v.length + ')';
            else if (v !== null && typeof v === 'object') collections[k] = v;
            else scalars[k] = v;
        });
        return {
            scalars: scalars,
            collections: collections
        };
    }

    // Inspects what a Maximo domain-list localStorage key actually contains
    // — confirms/refutes the "shape unconfirmed" caveat in
    // MAXIMO_DATA_SOURCES.md §1 for a real key on this browser, instead of
    // hand-typing JSON.parse(localStorage.getItem(...)) for each one.
    // No args = every KNOWN_DOMAIN_KEYS entry; pass one key to inspect just
    // that one, or your own array of keys to check something not on the
    // known list.
    window.__woDebugDomains = function(keys) {
        keys = keys ? [].concat(keys) : KNOWN_DOMAIN_KEYS;
        keys.forEach(function(key) {
            var raw = localStorage.getItem(key);
            console.group('Domain list: ' + key);
            if (raw === null) {
                console.log('Not present in localStorage on this page.');
                console.groupEnd();
                return;
            }
            var parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                console.log('Not valid JSON — raw value (first 200 chars):', raw.slice(0, 200));
                console.groupEnd();
                return;
            }
            if (Array.isArray(parsed)) {
                console.log('Array of', parsed.length, 'entries. First entry\'s keys:', parsed[0] ? Object.keys(parsed[0]) : '(empty array)');
                console.table(parsed.slice(0, 5));
            } else if (parsed && typeof parsed === 'object') {
                var objKeys = Object.keys(parsed);
                console.log('Plain object with', objKeys.length, 'keys. First few:', objKeys.slice(0, 10));
                console.log('Sample entry —', objKeys[0], ':', parsed[objKeys[0]]);
            } else {
                console.log('Parsed to a', typeof parsed, ':', parsed);
            }
            console.groupEnd();
        });
        return 'Done';
    };

    // Runs the real decode logic (domainDecodeRaw — same code domain() uses
    // in a formula) against a specific key/code, regardless of whether
    // beta_2 is toggled on, and logs which shape branch (if any) matched.
    window.__woTestDomain = function(key, code) {
        window.__woDebugDomains(key);
        var result = domainDecodeRaw(key, code);
        console.log(result ? ('MATCHED — "' + code + '" decodes to: ' + result) : ('NO MATCH for "' + code + '" in ' + key + ' (or the list\'s shape isn\'t one domainDecodeRaw() recognizes — check the group above).'));
        return result;
    };

    // Runs the exact same REST requests assetWOHistory()/assetDowntimeHistory()
    // use (via the shared raw fetchers) — but uncached and gate-free, so you
    // can confirm the calls actually work for a given asset/site before
    // ever touching beta_2 in a formula. Returns a Promise; either await it
    // in the console or let it log on its own.
    window.__woProbeAsset = function(assetnum, siteid, limit) {
        if (!assetnum || !siteid) {
            console.log('Usage: __woProbeAsset(assetnum, siteid, limit?)');
            return Promise.resolve(null);
        }
        console.log('Probing asset', assetnum, 'at site', siteid, '...');
        return Promise.all([
            fetchAssetWOHistoryRaw(assetnum, siteid, limit).catch(function(e) {
                return {
                    error: e.message
                };
            }),
            fetchAssetDowntimeHistoryRaw(assetnum, siteid).catch(function(e) {
                return {
                    error: e.message
                };
            })
        ]).then(function(results) {
            var woHistory = results[0],
                downtimeHistory = results[1];
            console.group('=== WO history (' + (Array.isArray(woHistory) ? woHistory.length : 'ERROR') + ') ===');
            if (Array.isArray(woHistory)) console.table(woHistory);
            else console.log(woHistory);
            console.groupEnd();
            console.group('=== Downtime history (' + (Array.isArray(downtimeHistory) ? downtimeHistory.length : 'ERROR') + ') ===');
            if (Array.isArray(downtimeHistory)) console.table(downtimeHistory);
            else console.log(downtimeHistory);
            console.groupEnd();
            return {
                woHistory: woHistory,
                downtimeHistory: downtimeHistory
            };
        });
    };

    // Full raw dump of the currently open WO — no oslc.select filter at all,
    // so every scalar field and every sub-resource collection ref the
    // record actually carries shows up. This is the "how do I find out what
    // fields exist" discovery technique from MAXIMO_DATA_SOURCES.md §2.2,
    // built in instead of retyped from scratch each time.
    window.__woDumpWO = function() {
        var woId = new URLSearchParams(window.location.search).get('uniqueid');
        if (!woId) {
            console.log('No "uniqueid" in the URL — open a WO tab first.');
            return Promise.resolve(null);
        }
        return xhrGetText('/maximo/oslc/os/mxapiwo/' + woId + '?lean=1&_format=json', MXAPI_HEADERS).then(function(text) {
            var d = JSON.parse(text);
            if (d.Error) {
                console.error('Error:', d.Error);
                return d;
            }
            var split = splitScalarsAndCollections(d);
            console.group('=== WO ' + (d.wonum || woId) + ' — scalar fields (' + Object.keys(split.scalars).length + ') ===');
            console.table(split.scalars);
            console.groupEnd();
            console.group('=== WO — sub-resources / collection refs ===');
            console.log(split.collections);
            console.groupEnd();
            return d;
        });
    };

    // Same full raw dump, for an asset instead of a WO.
    window.__woDumpAsset = function(assetnum, siteid) {
        if (!assetnum || !siteid) {
            console.log('Usage: __woDumpAsset(assetnum, siteid)');
            return Promise.resolve(null);
        }
        var url = '/maximo/oslc/os/mxapiasset?oslc.where=' + encodeURIComponent('assetnum="' + assetnum + '" and siteid="' + siteid + '"') + '&lean=1&_format=json';
        return xhrGetText(url, MXAPI_HEADERS).then(function(text) {
            var d = JSON.parse(text);
            var asset = d.member && d.member[0];
            if (!asset) {
                console.log('No matching asset — full response:', d);
                return d;
            }
            var split = splitScalarsAndCollections(asset);
            console.group('=== Asset ' + assetnum + ' — scalar fields (' + Object.keys(split.scalars).length + ') ===');
            console.table(split.scalars);
            console.groupEnd();
            console.group('=== Asset — sub-resources / collection refs ===');
            console.log(split.collections);
            console.groupEnd();
            return asset;
        });
    };

    // One-click bundle of the two open beta_2 unknowns as of v0.25.1: (1)
    // whether the mxapi* REST calls 406 because they're missing an Accept
    // header (asset/siteid required to test — every mxapi* call so far has
    // 406'd, so this is the prime suspect), and (2) what a real domain
    // list's array-of-arrays rows actually look like (attributes + first
    // two rows), needed before domainDecodeRaw() can be fixed for real
    // instead of guessed from a collapsed console Array(N). Built so the
    // person hitting these bugs can run one thing and paste back the
    // result, rather than hand-typing fetch()/JSON.parse() snippets.
    // Returns a Promise<string> (the report) so both the console command
    // and the Settings button share one implementation.
    function buildBeta2DiagnosticReport(assetnum, siteid) {
        var lines = ['WO Review Tool beta_2 diagnostics — v' + TOOL_VERSION, ''];

        function rawFetch(url, withAcceptHeader) {
            return new Promise(function(resolve) {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                if (withAcceptHeader) xhr.setRequestHeader('Accept', 'application/json');
                xhr.onload = function() {
                    resolve(xhr.status);
                };
                xhr.onerror = function() {
                    resolve('network error');
                };
                xhr.send();
            });
        }

        var restCheck = Promise.resolve();
        if (assetnum && siteid) {
            var url = '/maximo/oslc/os/mxapiwo?oslc.where=' + encodeURIComponent('assetnum="' + assetnum + '" and siteid="' + siteid + '"') + '&oslc.select=wonum&lean=1&_format=json';
            restCheck = Promise.all([
                rawFetch(url, false),
                rawFetch(url, true)
            ]).then(function(statuses) {
                lines.push('=== REST 406 check (asset ' + assetnum + ', site ' + siteid + ') ===');
                lines.push('No Accept header: HTTP ' + statuses[0]);
                lines.push('Accept: application/json: HTTP ' + statuses[1]);
                lines.push('');
            });
        } else {
            lines.push('=== REST 406 check ===', '(skipped — no assetnum/siteid given)', '');
        }

        return restCheck.then(function() {
            lines.push('=== Domain list shapes ===');
            KNOWN_DOMAIN_KEYS.forEach(function(key) {
                var raw = localStorage.getItem(key);
                if (raw === null) {
                    lines.push(key + ': not present on this page');
                    return;
                }
                var parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch (e) {
                    lines.push(key + ': not valid JSON');
                    return;
                }
                if (parsed && Array.isArray(parsed.data)) {
                    lines.push(key + ':');
                    lines.push('  attributes: ' + JSON.stringify(parsed.attributes));
                    lines.push('  row0: ' + JSON.stringify(parsed.data[0]));
                    lines.push('  row1: ' + JSON.stringify(parsed.data[1]));
                } else if (Array.isArray(parsed)) {
                    lines.push(key + ': array of ' + parsed.length + ', first entry: ' + JSON.stringify(parsed[0]));
                } else if (parsed && typeof parsed === 'object') {
                    lines.push(key + ': plain object, keys: ' + Object.keys(parsed).slice(0, 10).join(', '));
                } else {
                    lines.push(key + ': parsed to ' + typeof parsed);
                }
            });
            return lines.join('\n');
        });
    }

    window.__woBeta2Report = function(assetnum, siteid) {
        return buildBeta2DiagnosticReport(assetnum, siteid).then(function(report) {
            console.log(report);
            return report;
        });
    };

    // Per-(group, table) display state: hidden columns + sort. Keyed by
    // table id, not just group id, now that a group can display more than
    // one table (see groupTables()) — two tables in the same group hiding/
    // sorting independently, not sharing one flat state. Replaces the old
    // single-table getGroupHiddenCols()/saveGroupHiddenCols() (gid-only
    // keying) outright rather than migrating it forward — there's no
    // sound way to guess which of a group's now-possibly-several tables an
    // old flat hiddenCols array belonged to, and losing a hidden-column
    // preference is a low-stakes reset (dev channel, easy to redo in one
    // click) compared to guessing wrong and hiding columns on the wrong
    // table.
    function getGroupTableState(gid, tableId) {
        var gs = getGS();
        var g = gs[gid] || {};
        var ts = (g.tableState && g.tableState[tableId]) || {};
        return {
            hiddenCols: ts.hiddenCols || [],
            sortCol: ts.sortCol || '',
            sortDir: ts.sortDir || 1
        };
    }

    function saveGroupTableState(gid, tableId, patch) {
        var gs = getGS();
        if (!gs[gid]) gs[gid] = {};
        if (!gs[gid].tableState) gs[gid].tableState = {};
        var cur = gs[gid].tableState[tableId] || {};
        gs[gid].tableState[tableId] = Object.assign({}, cur, patch);
        saveGS(gs);
    }
    var panel, bodyEl, footerAreaEl, statusEl, summaryEl, updateScrollShadows = function() {};

    // Shared with openSetup()'s own (identical) copy of these three, used
    // by the Setup modal's Rules/Groups/Variables/Scan card drag-reorder.
    // Duplicated here rather than hoisted out of openSetup() so the main
    // panel's group tiles (built by render(), which exists independently
    // of whether Setup has ever been opened) can use the same click-and-
    // drag reorder engine, with other tiles visually collapsing to
    // header-only height and sliding out of the way while dragging —
    // instead of the plain native-HTML5-drag-and-drop border highlight
    // this used to have.
    var cardJustDragged = false;

    // Shared with openSetup()'s own (identical) copy — animates a
    // [data-coll-body] open/closed via a height transition instead of an
    // instant display:none toggle. See that copy for the full rationale.
    function animateBodyToggle(body, expand) {
        if (body._woAnimCleanup) body._woAnimCleanup();
        body.style.overflow = 'hidden';
        if (expand) {
            body.style.display = '';
            var target = body.scrollHeight;
            body.style.height = '0px';
            body.getBoundingClientRect(); // force reflow before transitioning
            body.style.transition = 'height 160ms ease';
            body.style.height = target + 'px';
        } else {
            var current = body.scrollHeight;
            body.style.height = current + 'px';
            body.getBoundingClientRect(); // force reflow before transitioning
            body.style.transition = 'height 160ms ease';
            body.style.height = '0px';
        }
        function onEnd(e) {
            if (e && e.propertyName !== 'height') return;
            clearTimeout(fallbackTimer);
            body.style.transition = '';
            body.style.height = '';
            body.style.overflow = '';
            if (!expand) body.style.display = 'none';
            body.removeEventListener('transitionend', onEnd);
            body._woAnimCleanup = null;
        }
        body.addEventListener('transitionend', onEnd);
        var fallbackTimer = setTimeout(onEnd, 220);
        body._woAnimCleanup = onEnd;
    }

    function startPointerCapture(onMove, onUp, cursor) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:' + (cursor || 'default') + ';';
        document.body.appendChild(overlay);

        function move(e) {
            onMove(e);
        }

        function up(e) {
            overlay.removeEventListener('mousemove', move);
            overlay.removeEventListener('mouseup', up);
            overlay.removeEventListener('mouseleave', up);
            overlay.remove();
            if (onUp) onUp(e);
        }
        overlay.addEventListener('mousemove', move);
        overlay.addEventListener('mouseup', up);
        overlay.addEventListener('mouseleave', up);
    }

    // Click-and-drag reorder by card header. `container` holds all the
    // reorderable siblings (marked via data-reorder-card, set below);
    // `arr` is the live array whose order backs the cards, in the same
    // order they appear in the DOM. See the identical copy inside
    // openSetup() for the full design rationale (threshold-gated arming,
    // header-only collapse-during-drag, cursor-jump compensation).
    function attachCardDrag(headerEl, cardEl, container, arr, idx, rerenderFn) {
        cardEl.setAttribute('data-reorder-card', '');
        headerEl.addEventListener('mousedown', function(downEvent) {
            if (downEvent.button !== 0) return;
            if (downEvent.target.closest('.wo-kebab-wrap,.wo-move-wrap,.wo-vis-btn,.wo-rule-title-input')) return;
            var startX = downEvent.clientX;
            var startY = downEvent.clientY;

            function onEarlyMove(mv) {
                var dx = mv.clientX - startX;
                var dy = mv.clientY - startY;
                if ((dx * dx + dy * dy) < 25) return; // ~5px threshold
                document.removeEventListener('mousemove', onEarlyMove);
                document.removeEventListener('mouseup', onEarlyUp);
                beginDrag(startY);
            }

            function onEarlyUp() {
                document.removeEventListener('mousemove', onEarlyMove);
                document.removeEventListener('mouseup', onEarlyUp);
            }
            document.addEventListener('mousemove', onEarlyMove);
            document.addEventListener('mouseup', onEarlyUp);
        });

        function beginDrag(startY) {
            var cards = Array.prototype.filter.call(container.children, function(el) {
                return el.hasAttribute && el.hasAttribute('data-reorder-card');
            });

            // Smoothly close every OTHER card's body (plus the dragged
            // card's own) instead of an instant display:none snap — with
            // "always open" tiles at the top of the main page, an instant
            // collapse of a couple tall expanded cards is a jarring, whole-
            // page-jumps-under-you moment. The reorder-threshold math below
            // needs the FINAL settled geometry, not a mid-transition one,
            // so arming (measuring rects, enabling the shift logic) waits
            // until the collapse animation has actually finished — until
            // then the dragged card is visually lifted (shadow/elevation)
            // but doesn't yet track the cursor or trigger a reorder.
            cards.forEach(function(c, i) {
                if (i === idx) return;
                var body = c.querySelector('[data-coll-body]');
                if (body && body.style.display !== 'none') animateBodyToggle(body, false);
            });
            var draggedBody = cardEl.querySelector('[data-coll-body]');
            if (draggedBody && draggedBody.style.display !== 'none') animateBodyToggle(draggedBody, false);

            cardEl.style.position = 'relative';
            cardEl.style.zIndex = '10';
            cardEl.style.boxShadow = '0 6px 18px rgba(0,0,0,0.45)';
            cards.forEach(function(c, i) {
                if (i !== idx) c.style.transition = 'transform 150ms ease';
            });

            var armed = false,
                aborted = false;
            var lastMouseY = startY,
                armStartY = startY;
            var draggedRect, headerShiftAmount, origRects, targetIdx = idx;

            var armTimer = setTimeout(function() {
                if (aborted) return;
                armStartY = lastMouseY;
                draggedRect = cardEl.getBoundingClientRect();
                // A shifted sibling needs to land in the dragged card's
                // whole slot, not just its content box — getBoundingClientRect()
                // doesn't include margin-bottom, so omitting it here left
                // every shifted sibling short by exactly one card's margin
                // until the drop-triggered rerender snapped it the rest of
                // the way.
                var cardMarginBottom = parseFloat(getComputedStyle(cardEl).marginBottom) || 0;
                headerShiftAmount = draggedRect.height + cardMarginBottom;
                origRects = cards.map(function(c) {
                    return c.getBoundingClientRect();
                });
                armed = true;
            }, 180);

            function applyShift(newTargetIdx) {
                targetIdx = newTargetIdx;
                cards.forEach(function(c, i) {
                    if (i === idx) return;
                    var shift = 0;
                    if (idx < targetIdx && i > idx && i <= targetIdx) shift = -headerShiftAmount;
                    else if (idx > targetIdx && i >= targetIdx && i < idx) shift = headerShiftAmount;
                    c.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
                });
            }

            startPointerCapture(function(mv) {
                lastMouseY = mv.clientY;
                if (!armed) return;
                var dy = mv.clientY - armStartY;
                cardEl.style.transform = 'translateY(' + dy + 'px)';
                var draggedCenter = draggedRect.top + draggedRect.height / 2 + dy;
                var newTarget = idx;
                for (var i = 0; i < cards.length; i++) {
                    if (i === idx) continue;
                    var center = origRects[i].top + origRects[i].height / 2;
                    if (i < idx && draggedCenter < center) newTarget = Math.min(newTarget, i);
                    if (i > idx && draggedCenter > center) newTarget = Math.max(newTarget, i);
                }
                if (newTarget !== targetIdx) applyShift(newTarget);
            }, function() {
                aborted = true;
                clearTimeout(armTimer);
                cards.forEach(function(c) {
                    c.style.transition = '';
                    c.style.transform = '';
                    c.style.position = '';
                    c.style.zIndex = '';
                    c.style.boxShadow = '';
                });
                if (armed && targetIdx !== idx) {
                    var moved = arr.splice(idx, 1)[0];
                    arr.splice(targetIdx, 0, moved);
                }
                cardJustDragged = true;
                setTimeout(function() {
                    cardJustDragged = false;
                }, 0);
                rerenderFn();
            }, 'grabbing');
        }
    }

    function setStatus(t) {
        if (statusEl) statusEl.textContent = t;
    }

    // A second status line naming which non-default grants are currently
    // active, shown right after a "you're up to date" message so dev/beta
    // access is visible every launch, not just discoverable via console.
    // Empty for plain users — nothing to announce. Dev-grant holders also
    // get BUILD_ID here — see its own comment — so every status message
    // that already reports "running vX"/"up to date" doubles as a build
    // freshness check, without touching each of those call sites.
    function grantsStatusLine() {
        var grants = getGrants().filter(function(g) { return g !== 'user'; });
        var labels = [];
        if (grants.indexOf('dev') !== -1) labels.push('Build ' + BUILD_ID);
        grants.forEach(function(g) {
            if (g === 'dev') {
                labels.push('Dev mode enabled');
            } else if (g === 'beta_0') {
                labels.push('Beta access enabled (all features)');
            } else {
                var m = /^beta_(.+)$/.exec(g);
                labels.push(m ? ('Beta_' + m[1] + ' access enabled') : (g + ' access enabled'));
            }
        });
        if (!labels.length) return '';
        return '\n' + labels.join(' · ');
    }

    // Device-level preference — read fresh each time rather than cached,
    // since it can change via setPanelCollapsed() at any point in the
    // session and startup needs the latest value before the panel exists.
    function getPanelCollapsed() {
        try {
            return !!JSON.parse(localStorage.getItem('__wo_settings') || '{}').panelCollapsed;
        } catch (e) {
            return false;
        }
    }

    function pushLayout(on) {
        document.body.style.marginRight = on ? (getPanelCollapsed() ? 0 : PANEL_W) + 'px' : '';
        window.dispatchEvent(new Event('resize'));
        // Poll until the panel has actually rendered, then fire one more
        // resize so any content that laid out before the panel was inserted
        // reflows. Checks offsetHeight, not offsetWidth — a collapsed panel
        // is deliberately 0-width but is always height:100vh, so width
        // would never resolve true and this would just run out the clock.
        if (on) {
            poll(function() {
                var dock = document.getElementById('__wo_dock');
                return dock && dock.offsetHeight > 0;
            }, 1000, function() {
                window.dispatchEvent(new Event('resize'));
            });
        }
    }

    function teardown() {
        var p = document.getElementById('__wo_dock');
        if (p) p.remove();
        // Setup modal and field browser are separate top-level containers
        // with their own lifetime (snap-resize listeners, etc.) — closing
        // just the main panel left them running/visible after Exit.
        var setupModal = document.getElementById('__wo_setup_modal');
        if (setupModal) {
            if (setupModal._woCleanup) setupModal._woCleanup();
            setupModal.remove();
        }
        var fieldBrowser = document.getElementById('__wo_field_browser');
        if (fieldBrowser) fieldBrowser.remove();
        // Also drop the injected stylesheet — otherwise a hot-reload (teardown()
        // + eval() to a newer version) would keep running whatever CSS the OLD
        // version injected, since injectPanelStyles() only skips re-injecting
        // when it finds one already present.
        var s = document.getElementById('__wo_panel_style');
        if (s) s.remove();
        pushLayout(false);
        panel = null;
        localStorage.removeItem('__wo_last_scanned_wo');
        if (window.__wo_watcher_interval) {
            clearInterval(window.__wo_watcher_interval);
            window.__wo_watcher_interval = null;
        }
    }




    function routeWorkflow(action) {
        // Safety net — 180s comfortably exceeds the worst legitimate case
        // (90s password-wait poll, reached only AFTER the 6s dialog poll,
        // with the 8s page2 poll + 1.5s action-select + 4s memo poll still
        // to come after that — a slow-to-type-password user can genuinely
        // still be mid-route past 100s). Every terminal branch also calls
        // finishRoute() directly the moment it's reached; this just
        // guarantees the lock can never survive past a branch this
        // function's own instrumentation missed. Cancelled+rearmed (not
        // just set) so a stale timer from an earlier, already-finished
        // route can't fire mid-flight during a later one.
        if (__woRouteSafetyTimer) clearTimeout(__woRouteSafetyTimer);
        __woRouteSafetyTimer = setTimeout(finishRoute, 180000);
        var retMsg = action === 'return' ? currentOrComputedReturnMessage() : '';

        var sew = findSendEventWin();
        if (sew) {
            try {
                sew.sendEvent('click', 'ROUTEWF__-tbb', '');
            } catch (e) {}
        }
        var rwBtn = findElById('ROUTEWF__-tbb');
        if (rwBtn) rwBtn.click();

        setStatus('Waiting for Route Workflow dialog...');

        poll(function() {
            var df = findAllDocs();
            for (var i = 0; i < df.length; i++) {
                if (df[i].doc.getElementById('m11eaa01a-tb')) return true;
                if (df[i].doc.getElementById('m66ed908c-tb')) return true;
            }
            return false;
        }, 6000, function(page1Ready) {
            if (!page1Ready) {
                setStatus('Route Workflow dialog did not appear.');
                finishRoute();
                return;
            }
            setStatus('Dialog open. Checking password...');

            function findDialogWin(fieldId) {
                var df = findAllDocs();
                for (var i = 0; i < df.length; i++) {
                    if (df[i].doc.getElementById(fieldId)) return df[i].win;
                }
                return null;
            }

            function readPasswordValue() {
                var df = findAllDocs();
                for (var i = 0; i < df.length; i++) {
                    var p = df[i].doc.getElementById('m11eaa01a-tb');
                    if (!p) continue;
                    if ((p.value || '').trim() !== '') return (p.value || '').trim();
                    try {
                        var v = df[i].win.eval('(document.getElementById("m11eaa01a-tb")||{}).value||""');
                        if ((v || '').trim() !== '') return (v || '').trim();
                    } catch (e) {}
                }
                return '';
            }

            function submitPage1() {
                var dw = findDialogWin('m66ed908c-tb') || findDialogWin('m11eaa01a-tb');
                if (!dw) {
                    setStatus('Could not find dialog frame. Fill manually.');
                    finishRoute();
                    return;
                }

                try {
                    dw.eval([
                        '(function(){',
                        '  var p = document.getElementById("m11eaa01a-tb");',
                        '  if (p && typeof sendEvent === "function") {',
                        '    sendEvent("setvalue", "m11eaa01a-tb", p.value || "");',
                        '  }',
                        '})()'
                    ].join('\n'));
                } catch (e) {}

                setTimeout(function() {
                    var dw2 = findDialogWin('m66ed908c-tb') || findDialogWin('m11eaa01a-tb');
                    if (!dw2) {
                        setStatus('Could not find dialog frame at submit time. Fill manually.');
                        finishRoute();
                        return;
                    }

                    try {
                        dw2.eval([
                            '(function() {',
                            '  var rc = document.getElementById("m66ed908c-tb");',
                            '  if (rc) {',
                            '    rc.value = "reviewed";',
                            '    if (typeof sendEvent === "function") {',
                            '      sendEvent("setvalue", "m66ed908c-tb", "reviewed");',
                            '    } else {',
                            '      var ev = rc.ownerDocument.createEvent("Event");',
                            '      ev.initEvent("change", true, true);',
                            '      rc.dispatchEvent(ev);',
                            '    }',
                            '  }',
                            '  setTimeout(function() {',
                            '    var ok = document.getElementById("me7c4d374-pb");',
                            '    if (ok) ok.click();',
                            '  }, 600);',
                            '})()'
                        ].join('\n'));
                        setStatus('Page 1 submitted. Waiting for action page...');
                    } catch (e) {
                        setStatus('Could not auto-submit page 1: ' + e.message + '. Fill manually.');
                        finishRoute();
                        return;
                    }

                    poll(function() {
                        return !!(findElById('m71741679-rb') || findElById('m67326ef-rb'));
                    }, 8000, function(page2Ready) {
                        if (!page2Ready) {
                            setStatus('Action page did not appear. Select action manually.');
                            finishRoute();
                            return;
                        }

                        setTimeout(function() {
                            setStatus('Action page open. Selecting action...');

                            function findPage2Frame() {
                                var df = findAllDocs();
                                for (var i = 0; i < df.length; i++) {
                                    if (df[i].doc.getElementById('m71741679-rb') ||
                                        df[i].doc.getElementById('m67326ef-rb')) {
                                        return df[i];
                                    }
                                }
                                return null;
                            }

                            var p2 = findPage2Frame();
                            if (!p2) {
                                setStatus('Cannot find action page frame. Select manually.');
                                finishRoute();
                                return;
                            }

                            if (action === 'return') {

                                function clickReturnRadio(attempt) {
                                    var p2r = findPage2Frame();
                                    if (!p2r) {
                                        setStatus('Lost page 2 frame.');
                                        finishRoute();
                                        return;
                                    }
                                    try {
                                        p2r.win.eval([
                                            '(function(){',
                                            '  var rb = document.getElementById("m67326ef-rb");',
                                            '  if (!rb) return;',
                                            '  rb.click();',
                                            '  if (typeof sendEvent === "function") {',
                                            '    sendEvent("click", "m67326ef-rb", "");',
                                            '  }',
                                            '})()'
                                        ].join('\n'));
                                    } catch (e) {
                                        setStatus('Could not select Return radio: ' + e.message);
                                        finishRoute();
                                        return;
                                    }
                                    setTimeout(function() {
                                        var p2check = findPage2Frame();
                                        var rb = p2check && p2check.doc.getElementById('m67326ef-rb');
                                        if (rb && rb.checked) {
                                            pollForMemo();
                                        } else if (attempt < 5) {
                                            setStatus('Return radio not checked yet, retrying (' + (attempt + 1) + ')...');
                                            setTimeout(function() {
                                                clickReturnRadio(attempt + 1);
                                            }, 300);
                                        } else {
                                            setStatus('Return radio did not stick — select manually.');
                                            finishRoute();
                                        }
                                    }, 400);
                                }

                                function pollForMemo() {
                                    setStatus('Return selected. Waiting for Memo field...');
                                    poll(function() {
                                        var p2b = findPage2Frame();
                                        if (!p2b) return false;
                                        var el = p2b.doc.getElementById('m2f1ccb1b-tb');
                                        return !!(el && el.offsetParent !== null);
                                    }, 4000, function(memoReady) {
                                        if (!memoReady) {
                                            setStatus('Return selected. Memo field not found — fill manually.');
                                            finishRoute();
                                            return;
                                        }
                                        var p2c = findPage2Frame();
                                        if (!p2c) {
                                            setStatus('Lost page 2 frame. Fill memo manually.');
                                            finishRoute();
                                            return;
                                        }
                                        try {
                                            p2c.win.__wo_pending_memo = retMsg;
                                        } catch (e) {
                                            setStatus('Cannot write to dialog frame. Fill memo manually.');
                                            finishRoute();
                                            return;
                                        }
                                        try {
                                            p2c.win.eval([
                                                '(function(){',
                                                '  var msg = window.__wo_pending_memo || "";',
                                                '  delete window.__wo_pending_memo;',
                                                '  var el = document.getElementById("m2f1ccb1b-tb");',
                                                '  if (!el) return;',
                                                '  el.value = msg;',
                                                '  if (typeof sendEvent === "function") {',
                                                '    sendEvent("setvalue", "m2f1ccb1b-tb", msg);',
                                                '  } else {',
                                                '    var ec = el.ownerDocument.createEvent("Event");',
                                                '    ec.initEvent("change", true, true);',
                                                '    el.dispatchEvent(ec);',
                                                '  }',
                                                '})()'
                                            ].join('\n'));
                                            setStatus('Return selected and memo filled. Click OK to complete.');
                                        } catch (e) {
                                            setStatus('Could not fill memo: ' + e.message + '. Fill manually.');
                                        }
                                        finishRoute();
                                    });
                                }

                                clickReturnRadio(0);

                            } else {
                                try {
                                    p2.win.eval([
                                        '(function(){',
                                        '  var rb = document.getElementById("m71741679-rb");',
                                        '  if (!rb) return;',
                                        '  rb.click();',
                                        '  if (typeof sendEvent === "function") {',
                                        '    sendEvent("click", "m71741679-rb", "");',
                                        '  }',
                                        '})()'
                                    ].join('\n'));
                                } catch (e) {}
                                setStatus('Approve selected. Click OK to complete.');
                                finishRoute();
                            }

                        }, 1500);
                    });
                }, 400);
            }

            var existingPw = readPasswordValue();
            if (existingPw) {
                setStatus('Password detected. Submitting page 1...');
                submitPage1();
            } else {
                setStatus('Please fill your password — will continue automatically.');
                poll(function() {
                    return readPasswordValue() !== '';
                }, 90000, function(pwFilled) {
                    if (!pwFilled) {
                        setStatus('Timed out waiting for password. Fill manually.');
                        finishRoute();
                        return;
                    }
                    submitPage1();
                });
            }
        });
    }


    // ── "Signal" visual system for the docked panel ──
    // Every selector is scoped under #__wo_dock so these rules can never win
    // specificity against Maximo's own page styles, and Maximo's styles can
    // never leak into the tool (inline styles elsewhere still win locally —
    // this stylesheet only covers STATIC repeated component patterns; colors
    // that depend on rule status, computed field-row widths, and drag-hover
    // feedback stay inline at their call sites, driven by statusColor()).
    // Injected once into <head>, guarded so repeated buildPanel() calls
    // (hot-reload, teardown+reinit) never stack duplicate <style> tags.

    // Reusable "sleek" floating tooltip — a small styled div matching the
    // rest of the panel, replacing native title= attributes (which render
    // the browser's own unstyled tooltip). textOrFn may be a plain string
    // or a function returning one; passing a function means the tooltip
    // text is recomputed fresh on every hover instead of being frozen at
    // whatever it was when attachTooltip() was first called — needed for
    // things like the Scan button, whose hotkey can change after the fact.
    function attachTooltip(el, textOrFn, onlyIfTruncated) {
        if (!el) return;
        el.addEventListener('mouseenter', function() {
            if (onlyIfTruncated && el.scrollWidth <= el.clientWidth) return;
            var text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
            if (!text) return;
            var old = document.getElementById('__wo_tip_float');
            if (old) old.remove();
            var tt = document.createElement('div');
            tt.id = '__wo_tip_float';
            tt.style.cssText = 'position:fixed;z-index:9999999;background:#1f2630;color:#f0f3f6;font-size:11px;font-family:"Segoe UI",Arial,sans-serif;padding:6px 9px;border-radius:6px;max-width:240px;white-space:pre-wrap;box-shadow:0 4px 14px rgba(0,0,0,.5);border:1px solid #30363d;pointer-events:none;';
            tt.textContent = text;
            document.body.appendChild(tt);
            var r = el.getBoundingClientRect();
            tt.style.top = (r.bottom + 4) + 'px';
            // The panel is right-docked, so most of its icons sit close to
            // the browser's right edge. Clamping left to a fixed distance
            // from that edge (the old behavior) shifted the tooltip's
            // whole box away from the icon instead of just keeping it
            // on-screen — for an icon already within that distance, the
            // tooltip would land far to its left, visibly disconnected.
            // Anchor from whichever edge of the icon actually has room for
            // the tooltip's real (measured) width instead.
            var ttRect = tt.getBoundingClientRect();
            if (r.left + ttRect.width > window.innerWidth - 8) {
                tt.style.left = 'auto';
                tt.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
            } else {
                tt.style.left = Math.max(4, r.left) + 'px';
            }
        });
        el.addEventListener('mouseleave', function() {
            var old = document.getElementById('__wo_tip_float');
            if (old) old.remove();
        });
    }

    // Shared by buildPanel() (initial bind) — applyHotkeys() no longer needs
    // to separately update the tooltip text on a hotkey change, since
    // attachTooltip() re-runs this function fresh on every hover rather
    // than freezing whatever text was current when it was first bound.
    function scanBtnTooltipText() {
        var st = {};
        try {
            st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        var hk = (st.rescanHotkey !== undefined) ? st.rescanHotkey : DEFAULT_HOTKEY;
        return hk ? 'Scan (' + hk + ')' : 'Scan';
    }

    // Collapses the panel to a 0-width strip with just a small protruding
    // handle (position:absolute, so it tracks the panel's own left edge —
    // at width:0 that edge coincides with the fixed right:0 viewport edge,
    // so the handle ends up sitting right at the screen edge regardless of
    // collapsed/expanded state). Persisted as a device-level setting so it
    // survives a reload, same as the hotkey.
    function setPanelCollapsed(collapsed) {
        if (!panel) return;
        panel.classList.toggle('is-collapsed', collapsed);
        panel.style.width = (collapsed ? 0 : PANEL_W) + 'px';
        document.body.style.marginRight = (collapsed ? 0 : PANEL_W) + 'px';
        window.dispatchEvent(new Event('resize'));
        var btn = panel.querySelector('#__wo_collapse_btn');
        if (btn) {
            btn.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
            btn.textContent = collapsed ? '◀' : '▶';
        }
        var s = {};
        try {
            s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        s.panelCollapsed = collapsed;
        localStorage.setItem('__wo_settings', JSON.stringify(s));
    }

    // Hides just the step-by-step #__wo_scanlog (the "reading WO tab...",
    // "scanning: X..." lines) to reclaim vertical space once you already
    // trust the process - #__wo_status (e.g. "Scan Complete 11:02") and
    // #__wo_summary (the rule output) stay visible either way, so the
    // things you actually came to check are never hidden by this.
    // Persisted the same way panelCollapsed is, so it survives a reload.
    function setScanLogMinimized(minimized) {
        if (!panel) return;
        var scanLogEl = panel.querySelector('#__wo_scanlog');
        if (scanLogEl) scanLogEl.style.display = minimized ? 'none' : '';
        var btn = panel.querySelector('#__wo_scanlog_toggle');
        if (btn) {
            btn.setAttribute('aria-label', minimized ? 'Show scan log' : 'Minimize scan log');
            btn.textContent = minimized ? '+' : '−';
        }
        var s = {};
        try {
            s = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        s.scanLogMinimized = minimized;
        localStorage.setItem('__wo_settings', JSON.stringify(s));
    }

    function injectPanelStyles() {
        if (document.getElementById('__wo_panel_style')) return;
        var css = "" +
            // Host pages (esp. IBM Maximo/Carbon) ship their own aggressive,
            // broadly-targeted CSS for plain elements (button/input/svg/div)
            // that otherwise bleeds through our rules by cascade order or
            // specificity, making the panel look different per domain.
            // `all:revert` clears every authored (host-page) declaration on
            // our own elements back to the browser's UA baseline BEFORE any
            // of our own rules below apply — it does not affect inline
            // styles (panel positioning) or CSS custom properties. SVG
            // icons and their descendants are excluded from it: confirmed
            // by an isolated browser test that Chromium computes the
            // correct cascaded stroke/fill for a reverted presentation
            // attribute (getComputedStyle agrees) but never actually PAINTS
            // it — the element renders invisible regardless of what CSS
            // says it should look like. Every icon in the tool was
            // invisible for exactly this reason. Icons still need
            // protecting from host CSS bleed-through, so that's handled by
            // the plain (non-revert) rules just below instead.
            // A single :not() with a comma list, not two chained :not()s —
            // two chained :not(svg):not(svg *) each add their own
            // specificity (they sum), which outranks a plain type selector
            // like `select{...}` or `textarea{resize:...}` and silently
            // reverted it back to browser-default styling despite the rule
            // existing. One :not() with a selector list only counts the
            // specificity of its most specific branch, which ties with
            // plain type selectors and lets source order (ours wins, we're
            // declared later) decide instead.
            "#__wo_dock,#__wo_dock *:not(svg,svg *){all:revert;box-sizing:border-box;}" +
            "#__wo_dock svg{fill:none;color:inherit;}" +
            "#__wo_dock svg [stroke]{stroke:currentColor;}" +
            // Deliberately no equivalent `fill:currentColor` rule — confirmed
            // in a browser that Chromium has a real bug where an SVG `fill`
            // override doesn't repaint correctly against a competing
            // host-page rule (getComputedStyle agrees with the override,
            // the actual paint doesn't), even with !important. `stroke`
            // doesn't have this problem. Every icon in the tool is drawn
            // with stroke only (thick-stroked circles/lines standing in for
            // small filled shapes) for exactly this reason — do the same
            // for any new icon rather than reaching for `fill="currentColor"`.
            "#__wo_dock{--wo-bg:#0d1117;--wo-surface:#161b22;--wo-surface-2:#1f2630;--wo-field:#1f2630;--wo-border:#30363d;--wo-text:#f0f3f6;--wo-muted:#9aa4af;--wo-accent:#58a6ff;--wo-on-accent:#04101f;--wo-pass:#3fb950;--wo-fail:#f85149;--wo-warn:#d29922;--wo-r-panel:8px;--wo-r-card:6px;--wo-r-ctl:6px;font-family:'Segoe UI Semibold','Segoe UI',system-ui,sans-serif;}" +
            // Collapse handle: position:absolute against #__wo_dock's own
            // box (a fixed-position element establishes a containing block
            // for absolute descendants), left:-14px so it protrudes just
            // outside the panel's left edge — at width:0 (collapsed) that
            // edge sits at the true screen edge, so the handle stays
            // visible and clickable in both states without extra logic.
            "#__wo_dock .wo-collapse-btn{position:absolute;left:-14px;top:50%;transform:translateY(-50%);width:14px;height:52px;padding:0;background:var(--wo-surface-2);border:1px solid var(--wo-border);border-right:none;border-radius:6px 0 0 6px;color:var(--wo-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;}" +
            "#__wo_dock .wo-collapse-btn:hover{color:var(--wo-text);background:var(--wo-field);}" +
            "#__wo_dock .wo-collapse-btn:focus-visible{outline:2px solid var(--wo-accent);outline-offset:1px;}" +
            "#__wo_dock.is-collapsed>*:not(.wo-collapse-btn){display:none;}" +
            "#__wo_dock #__wo_groups::-webkit-scrollbar{display:none;}" +
            // Faint gradient overlays hinting there's more to scroll, shown
            // only when there actually is (toggled in updateScrollShadows()
            // on scroll/resize/re-render) rather than a plain scrollbar.
            "#__wo_dock .wo-scroll-shadow{position:absolute;left:0;right:0;height:16px;pointer-events:none;opacity:0;transition:opacity 150ms;}" +
            "#__wo_dock .wo-scroll-shadow-top{top:0;background:linear-gradient(to bottom, rgba(0,0,0,0.35), transparent);}" +
            "#__wo_dock .wo-scroll-shadow-bottom{bottom:0;background:linear-gradient(to top, rgba(0,0,0,0.35), transparent);}" +
            "#__wo_dock .wo-scroll-shadow.is-visible{opacity:1;}" +
            "#__wo_dock .wo-mono{font-family:Consolas,'Cascadia Mono',monospace;font-variant-numeric:tabular-nums;}" +
            "#__wo_dock .wo-head{height:var(--wo-header-h,48px);box-sizing:border-box;background:var(--wo-surface-2);padding:0 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--wo-border);gap:8px;flex-shrink:0;}" +
            "#__wo_dock .wo-head-title{display:flex;flex-direction:column;line-height:1.2;min-width:0;}" +
            "#__wo_dock .wo-head-title b{font-size:13px;font-weight:800;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
            "#__wo_dock .wo-head-title span{font-size:11px;color:var(--wo-muted);font-weight:400;}" +
            "#__wo_dock .wo-head-ver{color:var(--wo-muted);font-size:9.5px;font-family:Consolas,monospace;flex-shrink:0;}" +
            "#__wo_dock .wo-head-actions{display:flex;gap:6px;flex-shrink:0;}" +
            "#__wo_dock .wo-btn{font:inherit;font-weight:700;font-size:11.5px;padding:7px 13px;border-radius:var(--wo-r-ctl);border:1px solid var(--wo-border);background:var(--wo-surface-2);color:var(--wo-text);cursor:pointer;}" +
            "#__wo_dock .wo-btn:hover{border-color:var(--wo-accent);}" +
            "#__wo_dock .wo-btn:focus-visible{outline:3px solid var(--wo-accent);outline-offset:1px;}" +
            "#__wo_dock .wo-btn-primary{background:var(--wo-accent);color:var(--wo-on-accent);border-color:var(--wo-accent);}" +
            "#__wo_dock .wo-btn-danger{color:var(--wo-fail);border-color:var(--wo-fail);}" +
            /* #__wo_status/#__wo_scanlog/#__wo_groups/#__wo_footer_area layout is kept fully inline at creation (see buildPanel()) — not duplicated here. */
            "#__wo_dock .wo-card{background:var(--wo-surface);border:1px solid var(--wo-border);border-radius:var(--wo-r-card);overflow:hidden;margin-bottom:8px;}" +
            "#__wo_dock .__wo_th{background:var(--wo-surface-2);padding:6px 10px;min-height:32px;display:flex;align-items:center;gap:8px;cursor:pointer;}" +
            "#__wo_dock .__wo_th:hover{background:var(--wo-field);}" +
            "#__wo_dock .__wo_th:focus-visible{outline:2px solid var(--wo-accent);outline-offset:-2px;}" +
            "#__wo_dock .wo-th-title{display:flex;align-items:center;gap:6px;flex-shrink:0;font-weight:700;font-size:12px;}" +
            "#__wo_dock .wo-th-title b{white-space:nowrap;}" +
            // .wo-th-actions holds the badge (visible at rest) and the
            // tooltip+hide icons (visible on header hover/focus) OVERLAID
            // in the same footprint — a real swap, not two things sitting
            // side by side. The icon wrapper is opacity/pointer-events
            // toggled rather than display:none specifically so the hide
            // button stays in the tab order and reachable by keyboard at
            // all times (display:none would remove it from the tab order,
            // and then :focus-within could never trigger in the first
            // place — a real chicken-and-egg accessibility trap).
            "#__wo_dock .wo-th-actions{position:relative;display:flex;align-items:center;flex-shrink:0;margin-left:auto;min-height:22px;}" +
            "#__wo_dock .wo-group-badge{display:inline-flex;align-items:center;justify-content:center;width:42px;height:18px;padding:0 4px;border-radius:4px;font-size:9px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;box-sizing:border-box;color:#0d1117;transition:opacity .1s;}" +
            // 2-rule badge: one flat box split evenly in half by a thin
            // divider, one symbol per half.
            "#__wo_dock .wo-badge-multi{display:inline-flex;width:42px;height:18px;border-radius:4px;overflow:hidden;box-sizing:border-box;transition:opacity .1s;}" +
            "#__wo_dock .wo-badge-seg{flex:1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#04101f;}" +
            "#__wo_dock .wo-badge-seg+.wo-badge-seg{border-left:1px solid rgba(4,16,31,.35);}" +
            // 3+ rule badge: fanned rounded-corner blocks (not capsules),
            // worst rule up front and fully legible, the rest stacked
            // behind it in descending z-index so only a colored sliver of
            // each shows.
            "#__wo_dock .wo-badge-pills{position:relative;display:inline-block;width:42px;height:18px;transition:opacity .1s;}" +
            "#__wo_dock .wo-badge-pill{position:absolute;top:0;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#04101f;box-sizing:border-box;box-shadow:0 0 0 1px rgba(0,0,0,.15) inset;}" +
            "#__wo_dock .wo-th-icons{display:flex;align-items:center;justify-content:center;gap:2px;position:absolute;right:0;top:50%;transform:translateY(-50%);min-width:36px;height:18px;box-sizing:border-box;padding:0 3px;border-radius:999px;background:var(--wo-border);opacity:0;pointer-events:none;transition:opacity .1s;}" +
            "#__wo_dock .__wo_th:hover .wo-th-icons,#__wo_dock .wo-th-actions:focus-within .wo-th-icons{opacity:1;pointer-events:auto;}" +
            "#__wo_dock .__wo_th:hover .wo-group-badge,#__wo_dock .wo-th-actions:focus-within .wo-group-badge," +
            "#__wo_dock .__wo_th:hover .wo-badge-multi,#__wo_dock .wo-th-actions:focus-within .wo-badge-multi," +
            "#__wo_dock .__wo_th:hover .wo-badge-pills,#__wo_dock .wo-th-actions:focus-within .wo-badge-pills{opacity:0;}" +
            "#__wo_dock .__wo_tx{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1px solid transparent;border-radius:3px;background:transparent;color:var(--wo-muted);cursor:pointer;flex-shrink:0;}" +
            "#__wo_dock .__wo_tx:hover,#__wo_dock .__wo_tx:focus-visible{color:#fff;background:var(--wo-field);}" +
            "#__wo_dock .__wo_tx:focus-visible{outline:2px solid var(--wo-accent);outline-offset:1px;}" +
            "#__wo_dock .__wo_banner{padding:7px 10px;font-size:11px;color:var(--wo-accent);background:var(--wo-field);border-bottom:1px solid var(--wo-border);}" +
            "#__wo_dock .__wo_tb{padding:10px;display:flex;flex-direction:column;gap:8px;}" +
            "#__wo_dock .wo-rule{display:flex;flex-direction:column;gap:3px;padding:8px 9px;border-radius:var(--wo-r-ctl);background:var(--wo-surface-2);border-left:4px solid var(--wo-border);}" +
            "#__wo_dock .wo-rule-top{display:flex;align-items:center;gap:7px;}" +
            "#__wo_dock .wo-rule-label{flex:1;color:var(--wo-text);font-size:11.5px;}" +
            "#__wo_dock .wo-rule-status{font-size:11px;font-weight:700;}" +
            "#__wo_dock .wo-rule-msg{font-size:10.5px;padding-left:8px;opacity:.92;}" +
            "#__wo_dock .wo-fieldstack{display:flex;flex-direction:column;gap:7px;}" +
            "#__wo_dock .wo-fieldrow{display:flex;flex-direction:row;flex-wrap:nowrap;gap:7px;}" +
            "#__wo_dock .wo-field{min-width:0;}" +
            "#__wo_dock .wo-field-k{display:block;font-size:10px;color:var(--wo-muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:1px;}" +
            "#__wo_dock .wo-field-v{font-size:12px;}" +
            "#__wo_dock .wo-field-v.wo-empty{color:var(--wo-border);}" +
            "#__wo_dock .wo-field-k.wo-varlabel{color:var(--wo-accent);text-transform:none;letter-spacing:0;}" +
            "#__wo_dock .wo-table-bar{display:flex;align-items:center;gap:8px;margin-bottom:4px;}" +
            "#__wo_dock .wo-table-count{color:var(--wo-muted);font-size:10.5px;flex:1;}" +
            "#__wo_dock .__wo_col_toggle_btn{font-size:10.5px;padding:3px 8px;border-radius:var(--wo-r-ctl);border:1px solid var(--wo-border);background:var(--wo-surface-2);color:var(--wo-text);cursor:pointer;}" +
            "#__wo_dock .__wo_col_toggle_btn:hover{border-color:var(--wo-accent);}" +
            "#__wo_dock .__wo_col_panel{background:var(--wo-field);border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:6px 8px;margin-bottom:6px;font-size:11px;line-height:1.9;}" +
            "#__wo_dock .__wo_col_panel label{display:inline-block;margin-right:12px;cursor:pointer;}" +
            "#__wo_dock .wo-table-wrap{overflow-x:auto;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);}" +
            "#__wo_dock table.wo-table{width:100%;border-collapse:collapse;font-size:11px;}" +
            "#__wo_dock table.wo-table th{text-align:left;padding:6px 8px;white-space:nowrap;color:var(--wo-muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em;background:var(--wo-surface-2);border-bottom:1px solid var(--wo-border);}" +
            "#__wo_dock table.wo-table th.__wo_sort_th{cursor:pointer;user-select:none;}" +
            "#__wo_dock table.wo-table th.__wo_sort_th:hover{color:var(--wo-text);}" +
            "#__wo_dock table.wo-table td{padding:6px 8px;border-bottom:1px solid var(--wo-border);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
            "#__wo_dock table.wo-table tr:last-child td{border-bottom:none;}" +
            "#__wo_dock .wo-table-block+.wo-table-block{margin-top:10px;}" +
            "#__wo_dock .wo-table-label{color:var(--wo-muted);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin:6px 0 3px;}" +
            "#__wo_dock .wo-header-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:10.5px;font-weight:400;}" +
            "#__wo_dock .__wo_tip_icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:3px;color:var(--wo-muted);cursor:default;flex-shrink:0;}" +
            "#__wo_dock .__wo_tip_icon:hover{color:#fff;background:var(--wo-field);}" +
            "#__wo_dock .wo-prescan{background:var(--wo-field);border:1px solid var(--wo-border);border-radius:var(--wo-r-card);padding:8px 10px;font-size:11.5px;color:var(--wo-accent);text-align:center;margin-bottom:8px;}" +
            "#__wo_dock .wo-notice{border-radius:var(--wo-r-card);padding:9px 11px;font-size:11.5px;border:1px solid var(--wo-border);background:var(--wo-surface);margin-bottom:6px;}" +
            "#__wo_dock .wo-notice-title{font-weight:700;margin-bottom:4px;}" +
            "#__wo_dock .wo-notice-body{color:var(--wo-muted);margin-bottom:8px;}" +
            "#__wo_dock .wo-notice-actions{display:flex;gap:6px;flex-wrap:wrap;}" +
            "#__wo_dock .wo-notice.wo-info{border-color:var(--wo-accent);}#__wo_dock .wo-notice.wo-info .wo-notice-title{color:var(--wo-accent);}" +
            "#__wo_dock .wo-notice.wo-pass{border-color:var(--wo-pass);}#__wo_dock .wo-notice.wo-pass .wo-notice-title{color:var(--wo-pass);}" +
            "#__wo_dock .wo-notice.wo-fail{border-color:var(--wo-fail);}#__wo_dock .wo-notice.wo-fail .wo-notice-title{color:var(--wo-fail);}" +
            "#__wo_dock .wo-btn-ghost{background:none;border:1px solid transparent;color:var(--wo-muted);cursor:pointer;font:inherit;font-size:11px;padding:6px 8px;border-radius:var(--wo-r-ctl);}" +
            "#__wo_dock .wo-btn-ghost:hover{color:var(--wo-text);}" +
            "#__wo_dock .wo-btn-ghost:focus-visible{outline:2px solid var(--wo-accent);outline-offset:1px;}" +
            "#__wo_dock .wo-qr-wrap{margin-bottom:2px;}" +
            // The box is a <textarea> (editable — see the Alt+C/Route
            // wiring below), so the copy button can no longer live INSIDE
            // it (a textarea can't contain child elements); it's an
            // absolutely-positioned sibling inside this wrapper instead.
            "#__wo_dock .wo-qr-box-wrap{position:relative;}" +
            "#__wo_dock .wo-qr-box{display:block;width:100%;box-sizing:border-box;resize:vertical;background:var(--wo-surface);border:1px solid var(--wo-border);border-radius:var(--wo-r-card);padding:9px 34px 9px 11px;min-height:40px;font:inherit;font-size:11.5px;color:var(--wo-text);word-break:break-word;}" +
            "#__wo_dock .wo-qr-box:focus{outline:2px solid var(--wo-accent);outline-offset:-1px;}" +
            "#__wo_dock .wo-qr-box::placeholder{color:var(--wo-muted);font-style:italic;}" +
            "#__wo_dock .wo-qr-box.wo-empty-text{color:var(--wo-muted);}" +
            "#__wo_dock .wo-qr-box:disabled{opacity:.7;resize:none;}" +
            "#__wo_dock .wo-qr-copy{position:absolute;top:6px;right:6px;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border-radius:var(--wo-r-ctl);}" +
            "#__wo_dock .wo-qr-copy:hover{background:var(--wo-field);color:var(--wo-text);}" +
            "#__wo_dock .wo-qr-copy:disabled{opacity:.35;cursor:default;}" +
            "#__wo_dock .wo-qr-copy:disabled:hover{background:none;}" +
            "#__wo_dock .wo-icon-copy,#__wo_dock .wo-icon-check{display:block;}" +
            "#__wo_dock .wo-icon-check{color:var(--wo-pass);}" +
            "#__wo_dock .wo-action-row{display:flex;gap:7px;margin:8px 0 4px;align-items:stretch;}" +
            "#__wo_dock .wo-btn-block{flex:1;padding:9px;font-size:12.5px;text-align:center;}" +
            // beta_1-only: a plain non-interactive glyph, never a button —
            // no background/border/hover, no click handler. Purely a visual
            // label ahead of Return/Fix/Approve, not one of the actions.
            "#__wo_dock .wo-route-symbol{display:flex;align-items:center;justify-content:center;flex:0 0 auto;width:36px;color:var(--wo-muted);cursor:default;margin-right:-3.5px;}" +
            "#__wo_dock .wo-btn-block.wo-btn-icon{display:inline-flex;align-items:center;justify-content:center;gap:7px;}" +
            "#__wo_dock .wo-btn-pass{background:var(--wo-pass);color:#04210c;border-color:var(--wo-pass);}" +
            "#__wo_dock .wo-btn-warn{background:var(--wo-warn);color:#241900;border-color:var(--wo-warn);}" +
            "#__wo_dock .wo-btn-fail{background:var(--wo-fail);color:#2b0705;border-color:var(--wo-fail);}" +
            "#__wo_dock .wo-showall{width:100%;margin-top:4px;text-align:center;}" +
            "#__wo_dock .wo-footer{text-align:center;color:var(--wo-muted);font-size:10px;padding:8px 0 2px;opacity:.7;}" +
            // Chrome/Edge are both Chromium, so -webkit-scrollbar is reliable
            // here (unlike most cross-browser CSS, this tool is Chrome/Edge-
            // only already — see the File System Access API usage elsewhere).
            // Standard scrollbar-width/-color are included too for forward
            // compatibility; harmless no-ops where unsupported.
            "#__wo_dock #__wo_groups,#__wo_dock #__wo_scanlog{scrollbar-width:thin;scrollbar-color:#30363d #0d1117;}" +
            "#__wo_dock #__wo_groups::-webkit-scrollbar,#__wo_dock #__wo_scanlog::-webkit-scrollbar{width:8px;}" +
            "#__wo_dock #__wo_groups::-webkit-scrollbar-track,#__wo_dock #__wo_scanlog::-webkit-scrollbar-track{background:#0d1117;}" +
            "#__wo_dock #__wo_groups::-webkit-scrollbar-thumb,#__wo_dock #__wo_scanlog::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;}" +
            "#__wo_dock #__wo_groups::-webkit-scrollbar-thumb:hover,#__wo_dock #__wo_scanlog::-webkit-scrollbar-thumb:hover{background:#454d59;}";
        var styleEl = document.createElement('style');
        styleEl.id = '__wo_panel_style';
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
    }

    function buildPanel() {
        var old = document.getElementById('__wo_dock');
        if (old) old.remove();
        injectPanelStyles();
        panel = document.createElement('div');
        panel.id = '__wo_dock';
        // Opening the tool always starts expanded. panelCollapsed used to be
        // honored here too (persisted across reloads, same as the collapse
        // button's own state) — but that meant collapsing it once silently
        // reopened collapsed every time after, easy to mistake for the tool
        // not having loaded. The collapse button/hotkey still work exactly
        // as before for the rest of THIS session; only the initial open no
        // longer restores a collapsed state. Reset the stored flag too (not
        // just the local var) so getPanelCollapsed()'s other reader,
        // pushLayout(), doesn't disagree with the panel's own actual width.
        var startCollapsed = false;
        try {
            var __woSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            if (__woSt.panelCollapsed) {
                __woSt.panelCollapsed = false;
                localStorage.setItem('__wo_settings', JSON.stringify(__woSt));
            }
        } catch (e) {}
        panel.className = startCollapsed ? 'is-collapsed' : '';
        // #__wo_status / #__wo_scanlog / #__wo_groups / #__wo_footer_area are
        // singleton structural containers, not repeated components — their
        // layout-critical properties (background, flex sizing, overflow) are
        // kept fully inline rather than in the shared stylesheet, guaranteed
        // to apply regardless of anything on the host page.
        //
        // The panel is split into three regions instead of one scrolling
        // catch-all: header+status+scanlog always stay fixed at the top;
        // #__wo_groups (the group tiles) is the ONLY scrollable region;
        // #__wo_footer_area (return message, Return/Approve, show-hidden,
        // credit line) is fixed at the bottom. This means the actions you
        // actually need — the return message and the buttons — are always
        // reachable without scrolling, no matter how many groups are
        // expanded above, even if the groups region's own scroll behavior
        // is ever fighting something on the host page.
        panel.style.cssText = 'position:fixed;top:0;right:0;width:' + (startCollapsed ? 0 : PANEL_W) + 'px;height:100vh;background:#0d1117;z-index:999999;font-size:12px;display:flex;flex-direction:column;box-shadow:-4px 0 14px rgba(0,0,0,.5);';
        panel.style.setProperty('--wo-header-h', getHostHeaderHeight() + 'px');
        panel.innerHTML =
            '<button id="__wo_collapse_btn" class="wo-collapse-btn" type="button" aria-label="' + (startCollapsed ? 'Expand panel' : 'Collapse panel') + '">' + (startCollapsed ? '◀' : '▶') + '</button>' +
            '<div class="wo-head">' +
            '<div class="wo-head-title"><b>Will\'s WO</b><span>Review Tool</span></div>' +
            '<div class="wo-head-ver">v' + TOOL_VERSION + '</div>' +
            '<div class="wo-head-actions">' +
            '<button id="__wo_rescan" class="wo-btn wo-btn-primary">Scan</button>' +
            '<button id="__wo_setup" class="wo-btn">Setup</button>' +
            '<button id="__wo_exit" class="wo-btn wo-btn-danger">Exit</button>' +
            '</div>' +
            '</div>' +
            '<div style="position:relative;background:#0d1117;flex-shrink:0;">' +
            '<div id="__wo_status" style="padding:6px 28px 6px 12px;color:#e3b341;font-size:11px;min-height:15px;font-family:Consolas,monospace;white-space:pre-line;"></div>' +
            '<button id="__wo_scanlog_toggle" type="button" aria-label="Minimize scan log" style="position:absolute;top:2px;right:4px;width:18px;height:18px;padding:0;line-height:1;border:1px solid #30363d;border-radius:4px;background:#161b22;color:#9aa4af;font-family:Consolas,monospace;font-size:12px;cursor:pointer;">−</button>' +
            '</div>' +
            '<div id="__wo_scanlog" style="padding:0 12px 6px;font-size:10.5px;color:#9aa4af;max-height:80px;overflow-y:auto!important;font-family:Consolas,monospace;background:#0d1117;flex-shrink:0;"></div>' +
            '<div id="__wo_summary" style="padding:0 12px 6px;font-size:11px;font-family:Consolas,monospace;background:#0d1117;flex-shrink:0;"></div>' +
            // Deliberately NOT display:flex here. That was the actual root
            // cause of the squishing bug across every prior attempt: it
            // turned every child (tile, banner) into a flex item, and flex
            // items default to flex-shrink:1 — they get squeezed to fit
            // instead of the container scrolling past them. The pre-overhaul
            // version was plain block flow (flex:1;overflow:auto, nothing
            // else) and scrolled correctly; this restores exactly that,
            // using margin-bottom on the children for spacing instead of gap.
            // Wrapped in a position:relative sibling so the two scroll-
            // shadow overlays below can pin to top:0/bottom:0 of exactly
            // this box without any manual offset math, regardless of how
            // tall the status/scanlog/summary section above ends up being.
            '<div style="position:relative;flex:1 1 0;min-height:0;display:flex;flex-direction:column;">' +
            '<div id="__wo_groups" style="flex:1 1 0!important;min-height:0!important;height:0!important;overflow-y:auto!important;padding:8px;background:#0d1117;color:#f0f3f6;scrollbar-width:none;"></div>' +
            '<div class="wo-scroll-shadow wo-scroll-shadow-top"></div>' +
            '<div class="wo-scroll-shadow wo-scroll-shadow-bottom"></div>' +
            '</div>' +
            '<div id="__wo_footer_area" style="flex-shrink:0;padding:8px;background:#0d1117;color:#f0f3f6;border-top:1px solid #30363d;"></div>';
        document.body.appendChild(panel);
        bodyEl = panel.querySelector('#__wo_groups');
        footerAreaEl = panel.querySelector('#__wo_footer_area');
        statusEl = panel.querySelector('#__wo_status');
        summaryEl = panel.querySelector('#__wo_summary');
        var scrollShadowTop = panel.querySelector('.wo-scroll-shadow-top');
        var scrollShadowBottom = panel.querySelector('.wo-scroll-shadow-bottom');
        updateScrollShadows = function() {
            if (!bodyEl) return;
            scrollShadowTop.classList.toggle('is-visible', bodyEl.scrollTop > 1);
            scrollShadowBottom.classList.toggle('is-visible', bodyEl.scrollTop + bodyEl.clientHeight < bodyEl.scrollHeight - 1);
        };
        bodyEl.addEventListener('scroll', updateScrollShadows);
        new ResizeObserver(updateScrollShadows).observe(bodyEl);
        panel.querySelector('#__wo_rescan').onclick = function() {
            if (actionsBusy()) return;
            runScan(render);
        };
        panel.querySelector('#__wo_setup').onclick = openSetup;
        panel.querySelector('#__wo_exit').onclick = function() {
            woConfirm('Close WO Validation tool?').then(function(ok) {
                if (ok) teardown();
            });
        };
        panel.querySelector('#__wo_collapse_btn').onclick = function() {
            setPanelCollapsed(!panel.classList.contains('is-collapsed'));
        };
        panel.querySelector('#__wo_scanlog_toggle').onclick = function() {
            var el = panel.querySelector('#__wo_scanlog');
            setScanLogMinimized(!(el && el.style.display === 'none'));
        };
        try {
            setScanLogMinimized(!!JSON.parse(localStorage.getItem('__wo_settings') || '{}').scanLogMinimized);
        } catch (e) {}
        pushLayout(true);
        // Sleek floating tooltip instead of a native title=. Passing the
        // function itself (not its current return value) means the text is
        // recomputed fresh on every hover, so it can never go stale the way
        // a one-time title= string could.
        attachTooltip(panel.querySelector('#__wo_rescan'), scanBtnTooltipText);
        attachTooltip(panel.querySelector('#__wo_collapse_btn'), function() {
            return panel.classList.contains('is-collapsed') ? 'Expand panel' : 'Collapse panel';
        });
        attachTooltip(panel.querySelector('#__wo_scanlog_toggle'), function() {
            var el = panel.querySelector('#__wo_scanlog');
            return (el && el.style.display === 'none') ? 'Show scan log' : 'Minimize scan log';
        });
    }

    function renderScanLog() {
        var el = panel && panel.querySelector('#__wo_scanlog');
        if (!el) return;
        el.innerHTML = scanLog.map(function(l) {
            return '<div>' + l.title + ': ' + l.result + '</div>';
        }).join('');
    }

    function orderedGroups(cfg) {
        var gs = getGS(),
            order = gs.__order || [];
        var byId = {};
        cfg.groups.forEach(function(g) {
            byId[g.id] = g;
        });
        var out = [];
        order.forEach(function(id) {
            if (byId[id]) {
                out.push(byId[id]);
                delete byId[id];
            }
        });
        cfg.groups.forEach(function(g) {
            if (byId[g.id]) out.push(g);
        });
        return out;
    }

    function buildReturnMessage() {
        var st2 = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        var prefix = (st2.msgPrefix || '').trim();
        var suffix = (st2.msgSuffix || '').trim();
        var delim = st2.msgDelim !== undefined ? st2.msgDelim : '. ';
        var cfg3 = getCfg();
        var parts = [];
        cfg3.rules.forEach(function(rule) {
            var res = runFormula(rule.formula, cache);
            if (res.status !== 'fail' && res.status !== 'warn') return;
            var side = res.status === 'warn' ? rule.warn : rule.fail;
            if (!side) return;
            var modeKey2 = side.returnMode || 'none';
            var msg = '';
            if (modeKey2 === 'custom') {
                msg = side.returnCustom ? resolveMsg(side.returnCustom, cache) : '';
            } else if (modeKey2 === 'short') {
                msg = side.short ? resolveMsg(side.short, cache) : (resolveMsgList(side.long, cache)[0] || '');
            } else if (modeKey2 === 'long') {
                // "long" return mode intentionally joins every matching entry
                // (not just the first) — that's the point of "long" vs "short".
                msg = resolveMsgList(side.long, cache).join('; ');
            }
            if (msg) parts.push(msg);
        });
        var body = parts.join(delim);
        // Prefix/suffix only ever wrap an actual message — showing just a
        // greeting + signature with nothing in between reads as broken, not
        // like a real return message.
        if (!body) return '';
        var full = (prefix ? prefix + delim : '') + body + (suffix ? ' ' + suffix : '');
        return full.trim();
    }

    // Single source of truth for "what return message is currently active" —
    // the user's edit if they've made one this scan cycle, otherwise the
    // freshly computed one. Shared by the Copy button, the Alt+C hotkey, and
    // routeWorkflow('return') so all three can never disagree.
    function currentOrComputedReturnMessage() {
        return currentReturnMsg !== null ? currentReturnMsg : buildReturnMessage();
    }

    // Generic clipboard copy (temp textarea + execCommand — same technique
    // copyReturnMessage() below uses for the return message specifically).
    // Kept separate from that one since its animation/status-line side
    // effects are specific to the Quick Return box.
    function copyTextToClipboard(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }

    // Shared by the Copy button's click handler and the Alt+C hotkey action —
    // one clipboard/animation implementation instead of two copies of the
    // temp-textarea/execCommand dance.
    function copyReturnMessage() {
        var msg = currentOrComputedReturnMessage();
        if (!msg) return;
        var ta = document.createElement('textarea');
        ta.value = msg;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        var btn = panel && panel.querySelector('.__wo_qr_copy');
        if (btn) {
            var copyIcon = btn.querySelector('.wo-icon-copy');
            var checkIcon = btn.querySelector('.wo-icon-check');
            if (copyIcon && checkIcon) {
                copyIcon.style.display = 'none';
                checkIcon.style.display = '';
                setTimeout(function() {
                    copyIcon.style.display = '';
                    checkIcon.style.display = 'none';
                }, 1500);
            }
        }
        setStatus('Copied to clipboard.');
    }

    function render() {
        if (!panel) buildPanel();
        renderScanLog();
        var cfg = getCfg(),
            gs = getGS(),
            scanCfgForTables = getScan();
        var results = {};
        cfg.rules.forEach(function(r) {
            var res = runFormula(r.formula, cache);
            res.label = r.label;
            results[r.id] = res;
        });
        bodyEl.innerHTML = '';
        footerAreaEl.innerHTML = '';

        // ── Pre-scan state ──
        var preScan = !hasScanned; // ← all Latin characters

        // ── Rule status summary bar — an at-a-glance count of pass/fail/
        // warn/error across every rule, since scrolling through groups can
        // hide most of them from view at once. Settings > Display can hide
        // this (st.hideSummaryBar). ──
        var summarySt = {};
        try {
            summarySt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        } catch (e) {}
        if (summarySt.hideSummaryBar) {
            summaryEl.style.display = 'none';
        } else {
            summaryEl.style.display = '';
            if (preScan) {
                summaryEl.innerHTML = '';
            } else {
                var summaryCounts = {
                    pass: 0,
                    fail: 0,
                    warn: 0,
                    error: 0
                };
                Object.keys(results).forEach(function(id) {
                    var s = results[id].status;
                    if (summaryCounts.hasOwnProperty(s)) summaryCounts[s]++;
                });
                var summaryParts = [];
                if (summaryCounts.pass) summaryParts.push('<span style="color:#3fb950;">' + summaryCounts.pass + ' ✓</span>');
                if (summaryCounts.fail) summaryParts.push('<span style="color:#f85149;">' + summaryCounts.fail + ' ✗</span>');
                if (summaryCounts.warn) summaryParts.push('<span style="color:#d29922;">' + summaryCounts.warn + ' ⚠</span>');
                if (summaryCounts.error) summaryParts.push('<span style="color:#bc8cff;">' + summaryCounts.error + ' !</span>');
                summaryEl.innerHTML = summaryParts.length ?
                    summaryParts.join(' <span style="color:#30363d;">|</span> ') :
                    '<span style="color:#9aa4af;">—</span>';
            }
        }
        if (preScan) {
            var banner = document.createElement('div');
            banner.className = 'wo-prescan';
            banner.innerHTML = 'Press <b>Scan</b> to populate values';
            bodyEl.appendChild(banner);
        }

        var varCache = {};
        getVars().forEach(function(v) {
            var res = runVariable(v.formula, cache);
            varCache[v.id] = res.error ?
                ('⚠ ' + res.error) :
                (res.value !== null ? String(res.value) : ''); // stringify for display only
        });

        // Filtered to visible groups (and captured as its own array) before
        // the loop, rather than an early-return inside a plain forEach —
        // attachCardDrag's drag-and-shift math needs a stable idx matching
        // each tile's actual position among the tiles that get rendered,
        // which a skip-hidden-groups early return can't give it.
        var visibleGroups = orderedGroups(cfg).filter(function(g) {
            var st2 = gs[g.id] || {};
            return st2.visible !== false;
        });
        visibleGroups.forEach(function(group, groupIdx) {
            var varById = {};
            var st = gs[group.id] || {};
            var collapsed = st.hasOwnProperty('collapsed') ? st.collapsed : !!group.defaultCollapsed;
            var tile = document.createElement('div');
            tile.setAttribute('data-gid', group.id);
            tile.className = 'wo-card' + (collapsed ? ' is-collapsed' : '');
            var refs = group.ruleRefs || [];
            // Every actionable (non-'na') rule this group references, worst
            // priority first — one fixed-total-width badge represents all
            // of them at once instead of collapsing straight to the worst.
            // Priority: error > fail > warn > pass.
            var badgeHtml = '';
            if (!preScan && refs.length) {
                var STATUS_PRIORITY = ['error', 'fail', 'warn', 'pass'];
                var statuses = [];
                refs.forEach(function(id) {
                    var r = results[id];
                    if (!r || r.status === 'na') return;
                    statuses.push({
                        status: r.status,
                        label: r.label
                    });
                });
                statuses.sort(function(a, b) {
                    return STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status);
                });
                var badgeTip = '';
                if (statuses.length === 1) {
                    var only = statuses[0];
                    var badgeText = only.status === 'error' ? 'ERR' : only.status;
                    badgeTip = only.label + ': ' + badgeText;
                    badgeHtml = '<span class="wo-group-badge" style="background:' + statusColor(only.status) + ';">' + badgeText + '</span>';
                } else if (statuses.length === 2) {
                    // Even split, thin divider, symbols instead of text —
                    // there's still room for both to read clearly at 21px.
                    badgeTip = statuses.map(function(s) {
                        return s.label + ': ' + s.status;
                    }).join(' • ');
                    badgeHtml = '<span class="wo-badge-multi">' +
                        statuses.map(function(s) {
                            return '<span class="wo-badge-seg" style="background:' + statusColor(s.status) + ';">' + statusSymbol(s.status) + '</span>';
                        }).join('') +
                        '</span>';
                } else {
                    // 3+ rules: the worst rule is a full rounded-corner
                    // (not capsule-shaped) block up front with its symbol
                    // legible; every other rule is also a full block of the
                    // same shape, each one nudged further right and one
                    // z-index further back, so only a sliver of its color
                    // peeks out from behind the block in front of it — a
                    // fanned stack rather than literal equal slices, still
                    // exactly as wide overall as the 1-rule badge.
                    badgeTip = statuses.map(function(s) {
                        return s.label + ': ' + s.status;
                    }).join(' • ');
                    var BADGE_W = 42,
                        PILL_W = 24;
                    var n = statuses.length;
                    var pillsHtml = statuses.map(function(s, i) {
                        var left = i === 0 ? 0 : Math.round(i * (BADGE_W - PILL_W) / (n - 1));
                        var isPrimary = i === 0;
                        return '<span class="wo-badge-pill' + (isPrimary ? ' is-primary' : '') + '" style="left:' + left + 'px;width:' + PILL_W + 'px;background:' + statusColor(s.status) + ';z-index:' + (n - i) + ';">' + (isPrimary ? statusSymbol(s.status) : '') + '</span>';
                    }).join('');
                    badgeHtml = '<span class="wo-badge-pills">' + pillsHtml + '</span>';
                }
            }
            var tipHtml = '';
            if (group.tooltip) {
                tipHtml = '<span class="__wo_tip_icon" data-tip="' + group.tooltip.replace(/"/g, '&quot;') + '">' +
                    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                    '<circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3"/>' +
                    '<line x1="8" y1="7.1" x2="8" y2="11.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
                    '<circle cx="8" cy="4.9" r="0.45" stroke="currentColor" stroke-width="0.9"/>' +
                    '</svg></span>';
            }

            var bannerHtml = '';
            if (group.expandedMsg) {
                bannerHtml = '<div class="__wo_banner">' + String(group.expandedMsg).replace(/</g, '&lt;') + '</div>';
            }
            var rulesHtml = '';
            if (!preScan) {
                refs.forEach(function(id) {
                    var res = results[id];
                    if (!res) return;
                    var rule = cfg.rules.filter(function(r) {
                        return r.id === id;
                    })[0] || {};
                    var s = res.status;
                    var color = statusColor(s);
                    var statusLabel = '';
                    var subMsgs = [];
                    var dimRow = false;
                    if (s === 'pass') {
                        var passLong = resolveMsgList(rule.pass && rule.pass.long, cache);
                        if (passLong.length) {
                            // Bullets below already say what's going on — the
                            // colored left rail is the status indicator here,
                            // no need for a redundant "Passed" label too.
                            subMsgs = passLong;
                        } else {
                            var passShort = (rule.pass && rule.pass.short) ? resolveMsg(rule.pass.short, cache) : '';
                            // A bare checkmark already means "passed" — only
                            // show text here if the rule has something more
                            // specific to say than the generic "OK" runFormula()
                            // falls back to.
                            statusLabel = '<span class="wo-rule-status" style="color:' + color + ';">' + (passShort ? '✓ ' + String(passShort).replace(/</g, '&lt;') : '✓') + '</span>';
                        }
                    } else if (s === 'fail') {
                        var failLong = resolveMsgList(rule.fail && rule.fail.long, cache);
                        if (failLong.length) {
                            subMsgs = failLong;
                        } else {
                            var failShort = (rule.fail && rule.fail.short) ? resolveMsg(rule.fail.short, cache) : '';
                            statusLabel = '<span class="wo-rule-status" style="color:' + color + ';">' + (failShort ? '✗ ' + String(failShort).replace(/</g, '&lt;') : '✗') + '</span>';
                        }
                    } else if (s === 'warn') {
                        var warnLong = resolveMsgList(rule.warn && rule.warn.long, cache);
                        if (warnLong.length) {
                            subMsgs = warnLong;
                        } else {
                            var warnShort = (rule.warn && rule.warn.short) ? resolveMsg(rule.warn.short, cache) : '';
                            statusLabel = '<span class="wo-rule-status" style="color:' + color + ';">' + (warnShort ? '⚠ ' + String(warnShort).replace(/</g, '&lt;') : '⚠') + '</span>';
                        }
                        // override subHtml color for warn
                    } else if (s === 'na') {
                        // The generic "Not applicable" default carries no
                        // information beyond the status itself — grey out the
                        // whole row instead (border + label + icon all read as
                        // muted) rather than repeating it in text. A formula
                        // that returned something unexpected still surfaces
                        // that diagnostic detail, since that's actually useful
                        // (a misbehaving rule), not boilerplate.
                        if (res.detail === 'Not applicable') {
                            dimRow = true;
                        } else {
                            statusLabel = '<span class="wo-rule-status" style="color:' + color + ';">— ' + String(res.detail).replace(/</g, '&lt;') + '</span>';
                        }
                    } else {
                        statusLabel = '<span class="wo-rule-status" style="color:' + color + ';">⚠ ' + String(res.detail).replace(/</g, '&lt;') + '</span>';
                    }

                    var subColor = (s === 'warn') ? '#d29922' : (s === 'pass' ? '#3fb950' : '#f85149');
                    var subHtml = subMsgs.map(function(m) {
                        return '<div class="wo-rule-msg" style="color:' + subColor + ';">• ' + String(m).replace(/</g, '&lt;') + '</div>';
                    }).join('');

                    rulesHtml += '<div class="wo-rule" style="border-left-color:' + color + ';' + (dimRow ? 'opacity:0.5;' : '') + '">' + '<div class="wo-rule-top">' + '<span class="wo-rule-label">' + String(res.label).replace(/</g, '&lt;') + '</span>' + statusLabel + '</div>' + subHtml + '</div>';
                });
            }
            var bodyHtml = '';

            if (group.fields && group.fields.length || (group.fieldRows && group.fieldRows.length)) {
                var fieldRows = group.fieldRows;
                if (!fieldRows || !fieldRows.length) {
                    fieldRows = group.fields.map(function(f) {
                        return [f];
                    });
                }
                var widthStore = group.fieldRowWidths || {};
                // Build a quick variable lookup
                getVars().forEach(function(v) {
                    varById[v.id] = v;
                });

                bodyHtml += '<div class="wo-fieldstack">';
                fieldRows.forEach(function(row, ri) {
                    bodyHtml += '<div class="wo-fieldrow">';
                    row.forEach(function(fk, fi) {
                        var key = ri + '_' + fi;
                        var w = widthStore[key];
                        var style = w ? 'flex:0 0 ' + w + '%;' : 'flex:1 1 0;';
                        // Check if this is a variable reference
                        var vDef = varById[fk];
                        if (vDef) {
                            var val = varCache[fk];
                            bodyHtml += '<div class="wo-field" style="' + style + '">' +
                                '<span class="wo-field-k wo-varlabel">' + String(vDef.label).replace(/</g, '&lt;') + '</span>' +
                                '<div class="wo-field-v' + (!preScan && val ? '' : ' wo-empty') + '">' + (!preScan && val ? String(val).replace(/</g, '&lt;') : '—') + '</div></div>';
                        } else {
                            var v = cache.fields[fk],
                                lbl = fk.split(' :: ').pop();
                            bodyHtml += '<div class="wo-field" style="' + style + '">' +
                                '<span class="wo-field-k">' + lbl + '</span>' +
                                '<div class="wo-field-v' + (!preScan && v ? '' : ' wo-empty') + '">' + (!preScan && v ? String(v).replace(/</g, '&lt;') : '—') + '</div></div>';
                        }
                    });
                    bodyHtml += '</div>';
                });
                bodyHtml += '</div>';
            }

            if (group.varFields && group.varFields.length) {
                var vars = getVars();
                vars.forEach(function(v) {
                    varById[v.id] = v;
                });
                bodyHtml += '<div class="wo-fieldstack" style="margin-top:' + (group.fields && group.fields.length ? '7' : '0') + 'px;">';
                group.varFields.forEach(function(vid) {
                    var vDef = varById[vid];
                    if (!vDef) return;
                    var val = varCache[vid];
                    bodyHtml += '<div class="wo-field"><span class="wo-field-k wo-varlabel">' + String(vDef.label).replace(/</g, '&lt;') + '</span>' +
                        '<div class="wo-field-v' + (!preScan && val ? '' : ' wo-empty') + '">' + (!preScan && val ? String(val).replace(/</g, '&lt;') : '—') + '</div></div>';
                });
                bodyHtml += '</div>';
            }

            var groupTableIds = groupTables(group);
            groupTableIds.forEach(function(tableId) {
                var rows = resolveTableRowsForDisplay(tableId, cfg, cache);
                var err = cache.tableErrors[tableId];
                var showTableErr = false;
                if (err && !rows.length) {
                    var runStatus = tableRunStatus(tableId, scanCfgForTables);
                    // 'skipped ...' (condition false, intentional) and 'OK ...'
                    // (step ran, table's just genuinely empty) both fall through
                    // to the plain "No rows" branch below, not an error.
                    showTableErr = runStatus === 'unknown' || runStatus.indexOf('TIMEOUT') === 0 || runStatus.indexOf('FAILED') === 0;
                }
                var tableIdEsc = String(tableId).replace(/"/g, '&quot;');
                // Only label each table when a group shows more than one -
                // the single-table case (the vast majority) stays exactly as
                // plain as before, no redundant heading repeating the table
                // name a user already picked in Setup.
                var tableLabelHtml = groupTableIds.length > 1 ?
                    '<div class="wo-table-label">' + String(friendlyTableName(cfg, tableId)).replace(/</g, '&lt;') + '</div>' : '';
                bodyHtml += '<div class="wo-table-block" data-table-id="' + tableIdEsc + '">' + tableLabelHtml;
                if (showTableErr) {
                    bodyHtml += '<div style="color:var(--wo-fail);margin-top:4px;font-size:11px;">Couldn\'t load this table — try rescanning.</div>';
                } else if (rows.length === 0) {
                    bodyHtml += '<div style="color:var(--wo-muted);margin-top:4px;font-size:11px;">No rows</div>';
                } else {
                    var allCols = Object.keys(rows[0]);
                    var tblState = getGroupTableState(group.id, tableId);
                    var hiddenCols = tblState.hiddenCols;
                    var visCols = allCols.filter(function(c) {
                        return hiddenCols.indexOf(c) < 0;
                    });
                    var sortedRows = (tblState.sortCol && allCols.indexOf(tblState.sortCol) >= 0) ?
                        sortTableRows(rows, tblState.sortCol, tblState.sortDir) : rows;
                    bodyHtml += '<div class="wo-table-bar"><span class="wo-table-count">' + rows.length + ' row' + (rows.length !== 1 ? 's' : '') + '</span>' + '<button class="__wo_col_toggle_btn">⚙ Cols</button></div>';
                    bodyHtml += '<div class="__wo_col_panel" style="display:none;">';
                    allCols.forEach(function(c) {
                        var checked = hiddenCols.indexOf(c) < 0;
                        bodyHtml += '<label><input type="checkbox" class="__wo_colcb" data-col="' + c.replace(/"/g, '&quot;') + '" ' + (checked ? 'checked' : '') + '>' + c + '</label>';
                    });
                    bodyHtml += '</div>';
                    bodyHtml += '<div class="wo-table-wrap"><table class="wo-table"><tr>' + visCols.map(function(c) {
                        var arrow = tblState.sortCol === c ? (tblState.sortDir === 1 ? ' ▲' : ' ▼') : '';
                        return '<th class="__wo_sort_th" data-col="' + c.replace(/"/g, '&quot;') + '" title="Click to sort">' + String(c).replace(/</g, '&lt;') + arrow + '</th>';
                    }).join('') + '</tr>';
                    sortedRows.forEach(function(r) {
                        bodyHtml += '<tr>' + visCols.map(function(c) {
                            return '<td title="' + String(r[c] || '').replace(/"/g, '&quot;') + '">' + String(r[c] || '').replace(/</g, '&lt;') + '</td>';
                        }).join('') + '</tr>';
                    });
                    bodyHtml += '</table></div>';
                }
                bodyHtml += '</div>';
            });
            // ── header inline message ──
            // Always emit the wrapping span, even empty — it's the flex:1
            // spacer between the title and the action icons. Without it
            // present (e.g. pre-scan, when dots/hmText are both blank, or
            // any group with no header message configured), the actions
            // cluster has nothing pushing it right and collapses in next to
            // the title instead of staying pinned to the right edge.
            var headerMsgHtml = '<span class="wo-header-msg"></span>';
            if (!preScan && group.headerMsg && group.headerMsg.enabled) {
                var hmRaw = group.headerMsg.value || '';
                var hmText = '';
                if (group.headerMsg.type === 'field') {
                    hmText = cache.fields[hmRaw] || '';
                } else if (group.headerMsg.type === 'variable') {
                    hmText = varCache[hmRaw] || '';
                    // no status color for variables — use neutral
                } else {
                    // type === 'rule' — a specific rule id shows that rule's
                    // message always. Left blank (the default), it instead
                    // auto-picks whichever of the group's own ruleRefs
                    // currently has the worst status — same priority order
                    // as the multi-rule badge (error > fail > warn > pass) —
                    // so a group with several rules still shows a message
                    // without needing one hand-picked ahead of time.
                    var hmRuleId = hmRaw;
                    if (!hmRuleId) {
                        var HM_PRIORITY = ['error', 'fail', 'warn', 'pass'];
                        var hmCandidates = (group.ruleRefs || []).filter(function(id) {
                            return results[id] && results[id].status !== 'na';
                        });
                        hmCandidates.sort(function(a, b) {
                            return HM_PRIORITY.indexOf(results[a].status) - HM_PRIORITY.indexOf(results[b].status);
                        });
                        hmRuleId = hmCandidates[0] || '';
                    }
                    var hmRule = cfg.rules.filter(function(r) {
                        return r.id === hmRuleId;
                    })[0];
                    if (hmRule) {
                        var hmRes = results[hmRuleId];
                        if (hmRes) {
                            if (hmRes.status === 'pass') {
                                var hmShort = (hmRule.pass && hmRule.pass.short) || '';
                                if (hmShort) {
                                    hmText = resolveMsg(String(hmShort), cache);
                                } else {
                                    var hmPassLong = resolveMsgList(hmRule.pass && hmRule.pass.long, cache);
                                    hmText = hmPassLong[0] || '✓';
                                }
                            } else if (hmRes.status === 'fail') {
                                var hmShortFail = (hmRule.fail && hmRule.fail.short) || '';
                                if (hmShortFail) {
                                    hmText = resolveMsg(String(hmShortFail), cache);
                                } else {
                                    var hmFailLong = resolveMsgList(hmRule.fail && hmRule.fail.long, cache);
                                    hmText = hmFailLong[0] || '✗';
                                }
                            } else if (hmRes.status === 'warn') {
                                var hmShortWarn = (hmRule.warn && hmRule.warn.short) || '';
                                if (hmShortWarn) {
                                    hmText = resolveMsg(String(hmShortWarn), cache);
                                } else {
                                    var hmWarnLong = resolveMsgList(hmRule.warn && hmRule.warn.long, cache);
                                    hmText = hmWarnLong[0] || '⚠';
                                }
                            } else if (hmRes.status === 'na') {
                                hmText = '';
                            } else {
                                hmText = '⚠';
                            }
                        }
                    }
                }



                if (hmText) {
                    var hmColor = (group.headerMsg.type === 'rule' && results[hmRuleId]) ?
                        statusColor(results[hmRuleId].status) :
                        (group.headerMsg.type === 'variable' ? '#58a6ff' : 'var(--wo-muted)');

                    headerMsgHtml = '<span class="wo-header-msg" style="color:' + hmColor + ';">' + String(hmText).replace(/</g, '&lt;') + '</span>';
                }
            }
            tile.innerHTML = '<div class="__wo_th" role="button" tabindex="0" aria-expanded="' + (!collapsed) + '" aria-label="Toggle ' + String(group.title).replace(/"/g, '&quot;') + ' details">' +
                '<span class="wo-th-title"><b>' + String(group.title).replace(/</g, '&lt;') + '</b></span>' +
                headerMsgHtml +
                '<span class="wo-th-actions">' + badgeHtml +
                '<span class="wo-th-icons">' + tipHtml +
                '<button class="__wo_tx" type="button" aria-label="Hide this group">' +
                '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
                '<path d="M1.5 8.4C3 5.6 5.4 3.6 8 3.6C10.6 3.6 13 5.6 14.5 8.4C13 11.2 10.6 13.2 8 13.2C5.4 13.2 3 11.2 1.5 8.4Z" stroke="currentColor" stroke-width="1.3"/>' +
                '<circle cx="8" cy="8.4" r="1.9" stroke="currentColor" stroke-width="1.3"/>' +
                '<path d="M2.5 2.5L13.5 14.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
                '</svg></button>' +
                '</span>' +
                '</span>' +
                '</div>' +
                '<div data-coll-body' + (collapsed ? ' style="display:none;"' : '') + '>' + bannerHtml +
                '<div class="__wo_tb">' + rulesHtml + bodyHtml + '</div></div>';

            bodyEl.appendChild(tile);

            attachTooltip(tile.querySelector('.__wo_tip_icon'), group.tooltip);
            attachTooltip(tile.querySelector('.__wo_tx'), 'Hide this group');
            if (hmText) attachTooltip(tile.querySelector('.wo-header-msg'), hmText, true);
            if (badgeTip) attachTooltip(tile.querySelector('.wo-group-badge,.wo-badge-multi,.wo-badge-pills'), badgeTip);
            // One block per table this group displays (see groupTables()) -
            // each carries its own column-toggle panel and sortable headers,
            // independent of any other table in the same group.
            tile.querySelectorAll('.wo-table-block').forEach(function(block) {
                var blockTableId = block.getAttribute('data-table-id');
                var colBtn = block.querySelector('.__wo_col_toggle_btn');
                var colPanel = block.querySelector('.__wo_col_panel');
                if (colBtn && colPanel) {
                    attachTooltip(colBtn, 'Toggle visible columns');
                    colBtn.onclick = function(e) {
                        e.stopPropagation();
                        colPanel.style.display = colPanel.style.display === 'none' ? 'block' : 'none';
                    };
                    colPanel.querySelectorAll('.__wo_colcb').forEach(function(cb) {
                        cb.onchange = function() {
                            var hidden = getGroupTableState(group.id, blockTableId).hiddenCols;
                            var col = cb.getAttribute('data-col');
                            if (!cb.checked && hidden.indexOf(col) < 0) hidden.push(col);
                            if (cb.checked) {
                                hidden = hidden.filter(function(c) {
                                    return c !== col;
                                });
                            }
                            saveGroupTableState(group.id, blockTableId, { hiddenCols: hidden });
                            render();
                        };
                    });
                }
                block.querySelectorAll('.__wo_sort_th').forEach(function(th) {
                    th.onclick = function(e) {
                        e.stopPropagation();
                        var col = th.getAttribute('data-col');
                        var cur = getGroupTableState(group.id, blockTableId);
                        // Same column clicked again → flip direction; a
                        // different column → start ascending, same as
                        // clicking a fresh column header in Excel.
                        var nextDir = cur.sortCol === col ? -cur.sortDir : 1;
                        saveGroupTableState(group.id, blockTableId, { sortCol: col, sortDir: nextDir });
                        render();
                    };
                });
            });

            // The header itself is now the sole collapse control (the old
            // separate arrow button was removed as redundant) \u2014 it needs
            // proper button semantics (role/tabindex/aria-expanded, plus a
            // keydown handler) to stay keyboard- and screen-reader-accessible
            // now that there's no native <button> to fall back on.
            var head = tile.querySelector('.__wo_th');

            function toggleGroupCollapse() {
                var body = tile.querySelector('[data-coll-body]');
                var hidden = body.style.display === 'none';
                animateBodyToggle(body, hidden);
                var nowCollapsed = !hidden;
                tile.classList.toggle('is-collapsed', nowCollapsed);
                head.setAttribute('aria-expanded', String(!nowCollapsed));
                var g2 = getGS();
                if (!g2[group.id]) g2[group.id] = {};
                g2[group.id].collapsed = nowCollapsed;
                saveGS(g2);
                // The animated height transition changes the tile's own
                // (and everything below it's) layout position gradually —
                // keep the scroll-shadow visibility in sync throughout,
                // not just once at the start.
                updateScrollShadows();
                var shadowTimer = setInterval(updateScrollShadows, 16);
                setTimeout(function() {
                    clearInterval(shadowTimer);
                    updateScrollShadows();
                }, 200);
            }
            tile.querySelector('.__wo_tx').onclick = function(e) {
                e.stopPropagation();
                var g2 = getGS();
                if (!g2[group.id]) g2[group.id] = {};
                g2[group.id].visible = false;
                saveGS(g2);
                render();
            };
            head.addEventListener('click', function(e) {
                if (cardJustDragged) return;
                if (e.target.closest('.__wo_tx') || e.target.closest('.__wo_tip_icon')) return;
                toggleGroupCollapse();
            });
            head.addEventListener('keydown', function(e) {
                if (e.target !== head) return; // ignore keydowns bubbling up from the hide button etc.
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleGroupCollapse();
                }
            });
            // Same click-and-drag reorder engine used throughout Setup
            // (attachCardDrag/startPointerCapture, hoisted to this outer
            // scope so both this render() and openSetup() can share it) —
            // other tiles visually collapse to header-only height and slide
            // out of the way while dragging, instead of the old native
            // HTML5 drag-and-drop's plain border-highlight-on-dragover.
            // `visibleGroups` only contains tiles that actually got
            // rendered (hidden groups never had a tile to drag in the
            // first place), so the merge below has to fold its new order
            // back into gs.__order without disturbing hidden groups'
            // relative positions.
            attachCardDrag(head, tile, bodyEl, visibleGroups, groupIdx, function() {
                var newVisibleIds = visibleGroups.map(function(g) {
                    return g.id;
                });
                var visibleIdSet = {};
                newVisibleIds.forEach(function(id) {
                    visibleIdSet[id] = true;
                });
                var fullOrder = orderedGroups(cfg).map(function(g) {
                    return g.id;
                });
                var queue = newVisibleIds.slice();
                var merged = fullOrder.map(function(id) {
                    return visibleIdSet[id] ? queue.shift() : id;
                });
                var g2 = getGS();
                g2.__order = merged;
                saveGS(g2);
                render();
            });
        });
        // ── Quick Return preview box ──
        // Editable — whatever's in this box when Return/Alt+R or the Copy
        // button/Alt+C fires is exactly what gets used (see
        // currentOrComputedReturnMessage()). `currentReturnMsg` (module
        // scope) is the source of truth, not this box's DOM value: it has
        // to be, since Alt+C/Alt+R can fire via hotkey while the panel is
        // collapsed and this box doesn't even exist.
        var qrWrap = document.createElement('div');
        qrWrap.className = 'wo-qr-wrap';

        var retMsg = preScan ? '' : currentOrComputedReturnMessage();
        var qrPlaceholder = preScan ?
            'Scan first to generate return message' :
            'No failed rules — type a message here if you want to include one';
        qrWrap.innerHTML = '<div class="wo-qr-box-wrap">' +
            '<textarea class="wo-qr-box' + (retMsg ? '' : ' wo-empty-text') + '"' + (preScan ? ' disabled' : '') + ' placeholder="' + qrPlaceholder.replace(/"/g, '&quot;') + '">' +
            (retMsg ? retMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;') : '') +
            '</textarea>' +
            '<button class="__wo_qr_copy wo-btn-ghost wo-qr-copy" type="button" aria-label="Copy return message"' + (retMsg ? '' : ' disabled') + '>' +
            '<svg class="wo-icon-copy" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<rect x="5.5" y="5.5" width="8" height="8" rx="1.3" stroke="currentColor" stroke-width="1.3"/>' +
            '<path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/>' +
            '</svg>' +
            '<svg class="wo-icon-check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="display:none;">' +
            '<path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>' +
            '</button>' +
            '</div>';

        footerAreaEl.appendChild(qrWrap);
        // ── Return, Approve, and (beta_1 only) Route symbol + Fix ──
        // Non-beta/dev users must see exactly what's always been here:
        // Return + Approve, nothing else, same classes, same order.
        var actionRow = document.createElement('div');
        actionRow.className = 'wo-action-row';
        var betaRouteOn = isBetaFeatureOn('beta_1');

        if (betaRouteOn) {
            var routeSymbol = document.createElement('span');
            routeSymbol.className = 'wo-route-symbol';
            routeSymbol.setAttribute('aria-hidden', 'true');
            // Three nodes converging into one checked final node — a
            // visual label, not a control: no button element, no
            // border/background, no click handler.
            // viewBox is a tight crop around the actual artwork's bounding
            // box (x/y 30-137.5, +5 padding) — the old "0 0 320 320" viewBox
            // was ~3x the artwork's real extent, so the whole glyph rendered
            // shrunk into one corner with dead space filling the rest of the
            // box. Cropping tight makes the same pixel size look properly
            // filled instead of tiny.
            routeSymbol.innerHTML = '<svg width="24" height="24" viewBox="25 25 118 118" fill="none">' +
                '<g stroke="currentColor" stroke-width="10" stroke-linecap="round">' +
                '<line x1="65" y1="50" x2="95" y2="50"/>' +
                '<line x1="100" y1="60" x2="60" y2="100"/>' +
                '<line x1="65" y1="110" x2="80" y2="110"/>' +
                '</g>' +
                '<g stroke="currentColor">' +
                '<circle cx="50" cy="50" r="15" stroke-width="10"/>' +
                '<circle cx="110" cy="50" r="15" stroke-width="10"/>' +
                '<circle cx="50" cy="110" r="15" stroke-width="10"/>' +
                '<circle cx="110" cy="110" r="25" stroke-width="5"/>' +
                '</g>' +
                '<path d="M100 110 L108 118 L122 101" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>';
            actionRow.appendChild(routeSymbol);
        }

        var returnBtn = document.createElement('button');
        returnBtn.type = 'button';
        returnBtn.id = '__wo_action_return';
        returnBtn.textContent = '↩ Return';
        returnBtn.className = 'wo-btn wo-btn-danger wo-btn-block';
        returnBtn.disabled = actionsBusy();
        returnBtn.onclick = function() {
            if (actionsBusy()) return;
            woConfirm('Return this work order?\n\nThe return message will be inserted into Memo.').then(function(ok) {
                if (!ok || actionsBusy()) return;
                routing = true;
                setActionsLocked(true);
                routeWorkflow('return');
            });
        };
        actionRow.appendChild(returnBtn);

        if (betaRouteOn) {
            var fixBtn = document.createElement('button');
            fixBtn.type = 'button';
            fixBtn.id = '__wo_action_fix';
            // A color emoji glyph here (the previous 🔧) renders in the
            // system emoji font, visibly mismatched against the button's own
            // Segoe UI Semibold text — same reasoning as every other icon in
            // the tool being a stroke-only inline SVG instead of a Unicode
            // symbol or emoji.
            fixBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px;margin-right:4px;" aria-hidden="true"><path d="M11.6 2.7C10.3 2.1 8.7 2.4 7.7 3.4C6.6 4.5 6.4 6.1 7.1 7.4L2.5 12C2 12.5 2 13.3 2.5 13.8C3 14.3 3.8 14.3 4.3 13.8L8.9 9.2C10.2 9.9 11.8 9.7 12.9 8.6C13.9 7.6 14.2 6 13.6 4.7L11.2 7.1C10.6 7.7 9.6 7.7 9 7.1C8.4 6.5 8.4 5.5 9 4.9L11.6 2.7Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>Fix';
            // Not .wo-btn-block (flex:1, equal share with Return/Approve) —
            // "Fix" is a much shorter label and doesn't need that much room.
            fixBtn.className = 'wo-btn wo-btn-warn';
            fixBtn.style.cssText = 'flex:0 0 auto;padding:9px 16px;font-size:12.5px;';
            fixBtn.disabled = actionsBusy();
            fixBtn.onclick = function() {
                if (actionsBusy()) return;
                runScan(render, 'fix');
            };
            actionRow.appendChild(fixBtn);
        }

        var approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.id = '__wo_action_approve';
        approveBtn.textContent = '✓ Approve';
        approveBtn.className = 'wo-btn wo-btn-pass wo-btn-block';
        approveBtn.disabled = actionsBusy();
        approveBtn.onclick = function() {
            if (actionsBusy()) return;
            woConfirm('Approve this work order?\n\nRoutes using Complete Review.').then(function(ok) {
                if (!ok || actionsBusy()) return;
                routing = true;
                setActionsLocked(true);
                routeWorkflow('approve');
            });
        };
        actionRow.appendChild(approveBtn);

        footerAreaEl.appendChild(actionRow);

        var qrBox = qrWrap.querySelector('.wo-qr-box');
        var qrCopyBtn = qrWrap.querySelector('.__wo_qr_copy');
        attachTooltip(qrCopyBtn, function() {
            return qrCopyBtn.disabled ? 'Nothing to copy yet' : 'Copy to clipboard';
        });
        qrCopyBtn.onclick = copyReturnMessage;
        // Typing directly updates the single source of truth Return/Copy
        // both read from (see currentOrComputedReturnMessage()), and keeps
        // the Copy button's enabled state in sync live — typing into an
        // empty ("no failed rules") box should re-enable it immediately,
        // not just on the next render.
        qrBox.oninput = function() {
            currentReturnMsg = qrBox.value;
            var hasMsg = !!qrBox.value;
            qrBox.classList.toggle('wo-empty-text', !hasMsg);
            qrCopyBtn.disabled = !hasMsg;
        };


        var showAll = document.createElement('button');
        showAll.type = 'button';
        showAll.textContent = 'Show hidden tiles';
        showAll.className = 'wo-btn-ghost wo-showall';
        showAll.onclick = function() {
            var g2 = getGS();
            getCfg().groups.forEach(function(g) {
                if (!g2[g.id]) g2[g.id] = {};
                g2[g.id].visible = true;
            });
            saveGS(g2);
            render();
        };
        footerAreaEl.appendChild(showAll);
        // ── Footer ──
        var footer = document.createElement('div');
        footer.className = 'wo-footer';
        footer.textContent = 'Created by William Zitzmann, william.zitzmann@abbvie.com';
        footerAreaEl.appendChild(footer);

        updateScrollShadows();
    }

    function fieldKeyOptions() {
        var cfg = {};
        try {
            cfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}
        var f = [],
            t = {};
        Object.keys(cfg).forEach(function(k) {
            var e = cfg[k];
            if (e.type === 'table-column') t[e.tableTitle] = 1;
            else f.push(e.tab + ' :: ' + e.label);
        });
        // Custom lookup tables (Tables tab, cfg.customTables) are just as
        // valid a T()/lookup() target as a scanned one, so they belong in
        // the same list — the Groups Table dropdown and formula-assist
        // autocomplete both read this one list without knowing/caring which
        // kind a given entry is.
        Object.keys(getCfg().customTables || {}).forEach(function(id) {
            t[id] = 1;
        });
        // API tables (Tables tab, cfg.apiTables, beta_2) — same reasoning:
        // they resolve through the exact same T() fallback chain, so they
        // belong in the same shared list.
        Object.keys(getCfg().apiTables || {}).forEach(function(id) {
            t[id] = 1;
        });
        return {
            fields: f.sort(),
            tables: Object.keys(t).sort()
        };
    }

    // A standalone popup (not nested inside #__wo_dock or #__wo_setup_modal),
    // so it redeclares the same --wo-* palette on its own root — same
    // pattern as the other two top-level containers, each independently
    // isolated from host-page CSS and from each other.
    function injectFieldBrowserStyles() {
        if (document.getElementById('__wo_fb_style')) return;
        var css = "" +
            "#__wo_field_browser,#__wo_field_browser *:not(svg,svg *){all:revert;box-sizing:border-box;}" +
            "#__wo_field_browser svg{fill:none;color:inherit;}" +
            "#__wo_field_browser svg [stroke]{stroke:currentColor;}" +
            "#__wo_field_browser{--wo-bg:#0d1117;--wo-surface:#161b22;--wo-surface-2:#1f2630;--wo-field:#1f2630;--wo-border:#30363d;--wo-text:#f0f3f6;--wo-muted:#9aa4af;--wo-accent:#58a6ff;--wo-on-accent:#04101f;--wo-pass:#3fb950;--wo-fail:#f85149;--wo-warn:#d29922;--wo-r-panel:10px;--wo-r-card:6px;--wo-r-ctl:6px;font-family:'Segoe UI',system-ui,sans-serif;background:var(--wo-bg);color:var(--wo-text);}" +
            "#__wo_field_browser input[type=text],#__wo_field_browser select{font:inherit;font-size:11.5px;background:var(--wo-field);color:var(--wo-text);border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:5px 7px;}" +
            "#__wo_field_browser input[type=text]:focus,#__wo_field_browser select:focus{outline:2px solid var(--wo-accent);outline-offset:-1px;border-color:var(--wo-accent);}" +
            "#__wo_field_browser .wo-btn{font:inherit;font-weight:700;font-size:11.5px;padding:6px 12px;border-radius:var(--wo-r-ctl);border:1px solid var(--wo-border);background:var(--wo-surface-2);color:var(--wo-text);cursor:pointer;}" +
            "#__wo_field_browser .wo-btn:hover{background:var(--wo-field);}" +
            "#__wo_field_browser .wo-btn-ghost{background:none;border:1px solid transparent;color:var(--wo-muted);cursor:pointer;font:inherit;font-size:11px;padding:6px 8px;border-radius:var(--wo-r-ctl);}" +
            "#__wo_field_browser .wo-btn-ghost:hover{color:var(--wo-text);background:var(--wo-field);}" +
            "#__wo_field_browser .wo-btn-pass{background:var(--wo-pass);color:#04210c;border-color:var(--wo-pass);font-weight:800;padding:7px 16px;}" +
            "#__wo_field_browser .wo-fb-row{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:var(--wo-r-ctl);cursor:pointer;margin-bottom:2px;background:var(--wo-field);}" +
            "#__wo_field_browser .wo-fb-row.is-registered{background:rgba(63,185,80,.12);}" +
            "#__wo_field_browser .wo-fb-row:hover{background:var(--wo-surface-2);}" +
            "#__wo_field_browser .wo-fb-label{flex:1;font-size:11px;color:var(--wo-text);}" +
            "#__wo_field_browser .wo-fb-label.is-registered{color:var(--wo-pass);}" +
            "#__wo_field_browser .wo-fb-value{color:var(--wo-muted);font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}";
        var styleEl = document.createElement('style');
        styleEl.id = '__wo_fb_style';
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
    }

    function openFieldBrowser(cfg, opts, onSave) {
        injectFieldBrowserStyles();
        // Scan all frames for label elements and resolve their current values
        var docs = findAllDocs();
        var existing = {};
        try {
            existing = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}

        // Build list of all label→input pairs found on the page
        var found = []; // { tab, label, id, value }
        var seen = {};
        docs.forEach(function(d) {
            var labels = d.doc.querySelectorAll('label');
            labels.forEach(function(lbl) {
                var text = (lbl.textContent || '').trim();
                if (!text || text.length > 80) return;
                var forId = lbl.getAttribute('for');
                var el = forId ? d.doc.getElementById(forId) : null;
                var val = el ? getVal(el) : '';
                // determine tab name
                var tab = 'Work Order';
                var p = lbl;
                while (p && p !== d.doc.body) {
                    var pid = p.id || '';
                    if (/-tab$/.test(pid)) {
                        var tlbl = null;
                        docs.forEach(function(x) {
                            if (!tlbl) {
                                tlbl = x.doc.querySelector('[href="#' + pid + '"],[data-tab="' + pid + '"],[id="' + pid.replace('-tab', '-tabtit') + '"]');
                            }
                        });
                        if (tlbl) tab = tlbl.textContent.trim();
                        else tab = pid.replace(/-tab$/, '');
                        break;
                    }
                    p = p.parentElement;
                }
                var key = tab + ' :: ' + text;
                if (seen[key]) return;
                seen[key] = true;
                found.push({
                    tab: tab,
                    label: text,
                    id: forId || '',
                    value: val,
                    key: key
                });
            });
        });

        // Sort: already-registered first (highlighted), then alphabetical by tab+label
        var alreadyKeys = {};
        Object.keys(existing).forEach(function(k) {
            alreadyKeys[k] = true;
        });
        found.sort(function(a, b) {
            var aIn = !!alreadyKeys[a.key],
                bIn = !!alreadyKeys[b.key];
            if (aIn !== bIn) return aIn ? -1 : 1;
            return (a.tab + a.label).localeCompare(b.tab + b.label);
        });

        // Build browser modal
        var old = document.getElementById('__wo_field_browser');
        if (old) old.remove();
        var bModal = document.createElement('div');
        bModal.id = '__wo_field_browser';
        bModal.style.cssText = 'position:fixed;top:4%;left:8%;width:78%;height:88%;z-index:10000000;border-radius:var(--wo-r-panel,10px);box-shadow:0 6px 30px rgba(0,0,0,.8);display:flex;flex-direction:column;font-size:12px;padding:10px;';

        // Group selector for target
        var grpOptions = '<option value="">-- no group --</option>' +
            cfg.groups.map(function(g, gi) {
                return '<option value="' + gi + '">' + g.title + '</option>';
            }).join('');

        bModal.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<b style="font-size:13px;">Browse Page Fields</b>' +
            '<button id="__fb_close" type="button" class="wo-btn-ghost">✕ Close</button>' +
            '</div>' +
            '<div style="margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<input id="__fb_search" type="text" placeholder="Filter fields..." style="flex:1;min-width:150px;">' +
            '<span style="color:var(--wo-muted);font-size:11px;">Add checked fields to group:</span>' +
            '<select id="__fb_grp">' + grpOptions + '</select>' +
            '</div>' +
            '<div style="color:var(--wo-muted);font-size:10px;margin-bottom:4px;">' +
            '<span style="color:var(--wo-pass);">■</span> Already registered &nbsp;' +
            '<span style="color:var(--wo-text);">■</span> New field &nbsp;' +
            'Tick fields to add, then click Save.</div>' +
            '<div id="__fb_list" style="flex:1;overflow:auto;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:4px;"></div>' +
            '<div style="margin-top:8px;display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="__fb_selall" type="button" class="wo-btn">Select All Visible</button>' +
            '<button id="__fb_selnone" type="button" class="wo-btn">Deselect All</button>' +
            '<button id="__fb_save" type="button" class="wo-btn wo-btn-pass">Save</button>' +
            '</div>';
        document.body.appendChild(bModal);

        var listEl = bModal.querySelector('#__fb_list');
        var searchEl = bModal.querySelector('#__fb_search');

        function renderList(filter) {
            listEl.innerHTML = '';
            var fl = filter ? filter.toLowerCase() : '';
            found.forEach(function(f) {
                if (fl && (f.tab + ' :: ' + f.label).toLowerCase().indexOf(fl) < 0) return;
                var isReg = !!alreadyKeys[f.key];
                var row = document.createElement('label');
                row.className = 'wo-fb-row' + (isReg ? ' is-registered' : '');
                row.innerHTML =
                    '<input type="checkbox" data-fkey="' + f.key.replace(/"/g, '&quot;') + '" ' + (isReg ? 'checked disabled style="opacity:0.5;"' : '') + '>' +
                    '<span class="wo-fb-label' + (isReg ? ' is-registered' : '') + '">' +
                    f.tab.replace(/</g, '&lt;') + ' :: ' + f.label.replace(/</g, '&lt;') +
                    '</span>' +
                    '<span class="wo-fb-value" title="' + String(f.value).replace(/"/g, '&quot;') + '">' +
                    (f.value ? String(f.value).replace(/</g, '&lt;') : '<i style="color:var(--wo-muted);">empty</i>') +
                    '</span>' +
                    '<input type="hidden" data-ftab="' + f.tab.replace(/"/g, '&quot;') + '" data-flabel="' + f.label.replace(/"/g, '&quot;') + '" data-fid="' + f.id.replace(/"/g, '&quot;') + '">';
                listEl.appendChild(row);
            });
        }
        renderList('');

        searchEl.oninput = function() {
            renderList(searchEl.value);
        };

        bModal.querySelector('#__fb_close').onclick = function() {
            bModal.remove();
        };

        bModal.querySelector('#__fb_selall').onclick = function() {
            listEl.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(function(cb) {
                cb.checked = true;
            });
        };
        bModal.querySelector('#__fb_selnone').onclick = function() {
            listEl.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(function(cb) {
                cb.checked = false;
            });
        };

        bModal.querySelector('#__fb_save').onclick = function() {
            var fc = {};
            try {
                fc = JSON.parse(localStorage.getItem(FKEY) || '{}');
            } catch (e) {}
            var gi = parseInt(bModal.querySelector('#__fb_grp').value, 10);
            var grp = !isNaN(gi) ? cfg.groups[gi] : null;
            var added = [];

            listEl.querySelectorAll('input[data-fkey]:not([disabled])').forEach(function(cb) {
                if (!cb.checked) return;
                var row = cb.closest('label');
                if (!row) return;
                var hidTab = row.querySelector('[data-ftab]');
                var hidLabel = row.querySelector('[data-flabel]');
                var hidId = row.querySelector('[data-fid]');
                if (!hidTab || !hidLabel) return;
                var tab = hidTab.getAttribute('data-ftab');
                var label = hidLabel.getAttribute('data-flabel');
                var id = hidId ? hidId.getAttribute('data-fid') : '';
                var key = tab + ' :: ' + label;
                if (!fc[key]) {
                    fc[key] = {
                        type: 'field',
                        tab: tab,
                        label: label,
                        idAtPickTime: id
                    };
                }
                // add to group if one selected
                if (grp) {
                    if (grp.fields.indexOf(key) < 0) {
                        grp.fields.push(key);
                        if (!grp.fieldRows) grp.fieldRows = [];
                        grp.fieldRows.push([key]);
                    }
                }
                if (opts.fields.indexOf(key) < 0) opts.fields.push(key);
                alreadyKeys[key] = true;
                added.push(key);
            });

            saveFieldCfg(fc);
            bModal.remove();
            if (onSave) onSave(added);

        };
    }


    // ── First-run installer: shown once when no local config exists at all. ──
    // Lets a brand-new install pick a starting profile (and, if unlocked, an
    // update channel) instead of silently falling back to a hardcoded default.
    // Resolves once the user installs a profile or explicitly skips — never
    // blocks forever, since Skip always works even offline.
    function showInstaller() {
        return new Promise(function(resolve) {
            var old = document.getElementById('__wo_installer_modal');
            if (old) old.remove();

            var devTier = getDevTier();
            var chOptions = ['stable'];
            if (devTier === 'beta' || devTier === 'dev') chOptions.push('beta');
            if (devTier === 'dev') chOptions.push('dev');

            var modal = document.createElement('div');
            modal.id = '__wo_installer_modal';
            modal.style.cssText = 'position:fixed;top:8%;left:50%;transform:translateX(-50%);width:90%;max-width:520px;background:#111;color:#eee;z-index:9999999;padding:18px;border-radius:8px;box-shadow:0 6px 30px rgba(0,0,0,.7);font-family:Segoe UI,Arial,sans-serif;font-size:12px;max-height:82vh;overflow:auto;';

            modal.innerHTML =
                '<div style="font-size:16px;font-weight:bold;color:#7ec8e3;margin-bottom:4px;">Welcome to WO Review Tool</div>' +
                '<div style="color:#888;margin-bottom:16px;">First-time setup — pick a starting configuration below.</div>' +
                '<div style="border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:12px;">' +
                '<b>Version</b>' +
                '<div style="margin-top:6px;color:#aaa;">Running v' + TOOL_VERSION + ' (stable)</div>' +
                (chOptions.length > 1 ?
                    '<div style="margin-top:8px;"><label style="color:#aaa;">Channel:</label><br>' +
                    '<select id="__inst_channel" style="background:#222;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;margin-top:2px;">' +
                    chOptions.map(function(c) {
                        return '<option value="' + c + '">' + c + '</option>';
                    }).join('') +
                    '</select><div style="color:#555;font-size:10px;margin-top:4px;">Takes effect on the update check right after setup.</div></div>' :
                    '<div style="color:#555;font-size:10px;margin-top:4px;">Stable is the only channel available. Unlock beta/dev in Setup &gt; Settings later if needed.</div>') +
                '</div>' +
                '<div style="border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:12px;">' +
                '<b>Starting configuration</b>' +
                '<div id="__inst_profiles" style="margin-top:8px;color:#888;"></div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                '<button id="__inst_go" style="background:#2ecc71;color:#000;font-weight:bold;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;" disabled>Install</button>' +
                '<button id="__inst_skip" style="background:none;border:1px solid #444;color:#aaa;padding:6px 12px;border-radius:4px;cursor:pointer;">Skip (use basic defaults)</button>' +
                '<span id="__inst_status" style="color:#888;"></span>' +
                '</div>';
            document.body.appendChild(modal);

            var chSel = modal.querySelector('#__inst_channel');
            if (chSel) {
                chSel.onchange = function(e) {
                    var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                    st.channel = e.target.value;
                    saveSettingsCfg(st);
                };
            }

            // The list itself is a pure localStorage read (getOrgConfigs(),
            // metadata only — loader.js cached it from the check-access
            // call that got us here) so it renders immediately with no
            // network wait. Content is only ever fetched live, at the
            // moment Install is clicked (installOrgConfig()).
            var selectedProfileId = '';
            var goBtn = modal.querySelector('#__inst_go');
            var profilesDiv = modal.querySelector('#__inst_profiles');

            var orgConfigs = getOrgConfigs();
            if (!orgConfigs.length) {
                profilesDiv.innerHTML = '<div style="color:#888;">No organization configs are currently available to you. You can skip and start from basic defaults, or load one later in Setup &gt; Profiles once available.</div>';
            } else {
                profilesDiv.innerHTML = orgConfigs.map(function(c, i) {
                    if (i === 0) selectedProfileId = c.id;
                    return '<label style="display:block;padding:6px;border:1px solid #333;border-radius:4px;margin-bottom:6px;cursor:pointer;">' +
                        '<input type="radio" name="__inst_profile" value="' + c.id + '" ' + (i === 0 ? 'checked' : '') + '> ' +
                        '<b>' + orgConfigDisplayName(c) + '</b><br>' +
                        '<span style="color:#888;margin-left:20px;">' + (c.description || '') + '</span>' +
                        '</label>';
                }).join('');
                profilesDiv.querySelectorAll('input[name="__inst_profile"]').forEach(function(r) {
                    r.onchange = function(e) { selectedProfileId = e.target.value; };
                });
                goBtn.disabled = false;
            }

            function finish() {
                modal.remove();
                resolve();
            }

            goBtn.onclick = function() {
                if (!selectedProfileId) return;
                var statusEl = modal.querySelector('#__inst_status');
                statusEl.textContent = 'Installing...';
                goBtn.disabled = true;
                installOrgConfig(selectedProfileId).then(function(result) {
                    var ok = !!(result && result.ok);
                    statusEl.textContent = ok ? 'Done!' : 'Could not install — starting with basic defaults.';
                    setTimeout(finish, ok ? 300 : 1200);
                }).catch(function(e) {
                    // installOrgConfig() re-verifies access live and can reject
                    // (offline, or access no longer granted) — never leave the
                    // installer stuck on "Installing...". A configVersion
                    // mismatch (migrateProfile()) has a specific, useful
                    // message worth surfacing instead of the generic one.
                    statusEl.textContent = (e && /configVersion|newer version/.test(e.message)) ?
                        e.message : 'Could not install — starting with basic defaults.';
                    setTimeout(finish, 1200);
                });
            };

            modal.querySelector('#__inst_skip').onclick = finish;
        });
    }

    // ── "Signal" visual system for the Setup modal ──
    // Same palette as the docked panel (injectPanelStyles()), scoped under
    // #__wo_setup_modal instead of #__wo_dock — deliberately a SEPARATE
    // stylesheet/scope rather than sharing one, since the modal and the
    // panel are different DOM subtrees that can be open independently and
    // neither should be able to leak into the other. Covers the modal shell
    // (title bar, tab bar, content area) and generic form-control patterns
    // (button/input/textarea/select) shared by every tab; each tab's own
    // specific markup is converted separately, tab by tab, since this is a
    // large surface and — like the docked panel redesign — needs to ship in
    // reviewable pieces rather than one unverifiable megachange.
    function injectSetupStyles() {
        if (document.getElementById('__wo_setup_style')) return;
        var css = "" +
            // See the matching comments in injectPanelStyles() — isolates us
            // from host-page CSS (button/input/svg resets, aggressive
            // Carbon/Dojo-style rules on IBM Maximo); svg and its descendants
            // are excluded from the revert (Chromium paints a reverted SVG
            // presentation attribute incorrectly even though computed style
            // is right); and no icon here uses `fill="currentColor"` since
            // that specific override doesn't reliably repaint against a
            // competing host rule either — every icon is stroke-only.
            // See the matching comment in injectPanelStyles() re: single
            // vs chained :not() and why it matters for specificity.
            "#__wo_setup_modal,#__wo_setup_modal *:not(svg,svg *){all:revert;box-sizing:border-box;}" +
            "#__wo_setup_modal svg{fill:none;color:inherit;}" +
            "#__wo_setup_modal svg [stroke]{stroke:currentColor;}" +
            "#__wo_setup_modal{--wo-bg:#0d1117;--wo-surface:#161b22;--wo-surface-2:#1f2630;--wo-field:#1f2630;--wo-border:#30363d;--wo-text:#f0f3f6;--wo-muted:#9aa4af;--wo-accent:#58a6ff;--wo-on-accent:#04101f;--wo-pass:#3fb950;--wo-fail:#f85149;--wo-warn:#d29922;--wo-r-panel:10px;--wo-r-card:6px;--wo-r-ctl:6px;font-family:'Segoe UI',system-ui,sans-serif;background:var(--wo-bg);color:var(--wo-text);}" +
            "#__wo_setup_modal .wo-mono{font-family:Consolas,'Cascadia Mono',monospace;}" +
            // Title bar
            "#__wo_setup_modal .wo-modal-titlebar{height:var(--wo-header-h,48px);box-sizing:border-box;flex-shrink:0;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;padding:0 12px;background:var(--wo-surface-2);border-radius:var(--wo-r-panel) var(--wo-r-panel) 0 0;border-bottom:1px solid var(--wo-border);margin:-10px -10px 0;}" +
            "#__wo_setup_modal .wo-modal-title{font-size:13px;font-weight:800;color:#fff;}" +
            "#__wo_setup_modal .wo-modal-title-actions{display:flex;align-items:center;gap:8px;}" +
            // Tab bar — grouped into content tabs / management tabs / utility
            // actions instead of one flat undifferentiated row of 11 buttons.
            // Chrome-style tabs: the active tab's background matches the
            // content area below it (.wo-modal-content), rounded on top,
            // with a concave "inverted corner" at each bottom corner
            // (radial-gradient pseudo-elements) so it visually flows into
            // the content instead of looking like a separate rounded chip.
            // A thin divider separates adjacent SIBLING tabs, except on
            // either side of the active tab, where the tab's own
            // background already does the separating.
            "#__wo_setup_modal .wo-modal-tabs{position:relative;display:flex;align-items:flex-end;flex-wrap:nowrap;padding:8px 4px 0;}" +
            "#__wo_setup_modal .wo-modal-tabs::after{content:'';position:absolute;left:4px;right:4px;bottom:0;height:1px;background:var(--wo-border);z-index:0;}" +
            "#__wo_setup_modal .wo-tab-group{display:flex;align-items:flex-end;position:relative;z-index:1;flex-shrink:0;}" +
            // A bare flex `gap` between the three tab groups left a floating
            // stretch of blank space at each boundary (e.g. between Scan and
            // Profiles) with nothing to explain it, unlike the tight
            // divider-bordered look tabs have within a group. A matching
            // divider line at each group boundary reads as intentional
            // structure instead of a stray gap.
            "#__wo_setup_modal .wo-tab-group + .wo-tab-group:not(.wo-tab-group-end){margin-left:10px;padding-left:10px;border-left:1px solid var(--wo-border);}" +
            "#__wo_setup_modal .wo-tab-group-end{margin-left:auto;padding-left:10px;border-left:1px solid var(--wo-border);}" +
            "#__wo_setup_modal .wo-tab-btn{position:relative;display:inline-flex;align-items:center;gap:6px;flex-shrink:0;font:inherit;font-weight:600;font-size:11.5px;padding:7px 11px 8px;margin-bottom:-1px;border-radius:7px 7px 0 0;border:none;background:transparent;color:var(--wo-muted);cursor:pointer;}" +
            // Chrome-style separator: a short line only through the middle
            // of the tab (not full-height like a real border), that
            // disappears next to the active tab on either side.
            "#__wo_setup_modal .wo-tab-btn:not(:last-child)::after{content:'';position:absolute;top:50%;right:0;transform:translateY(-50%);width:1px;height:14px;background:var(--wo-border);}" +
            "#__wo_setup_modal .wo-tab-btn:has(+ .wo-tab-btn.is-active)::after{content:none;}" +
            "#__wo_setup_modal .wo-tab-btn:hover{color:var(--wo-text);background:var(--wo-field);}" +
            "#__wo_setup_modal .wo-tab-btn:focus-visible{outline:2px solid var(--wo-accent);outline-offset:-1px;z-index:3;}" +
            "#__wo_setup_modal .wo-tab-btn-ghost{font-weight:400;color:var(--wo-muted);font-size:11px;}" +
            "#__wo_setup_modal .wo-tab-icon{flex-shrink:0;display:block;}" +
            "#__wo_setup_modal .wo-tab-btn.wo-tab-mode-icon .wo-tab-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;}" +
            "#__wo_setup_modal .wo-tab-btn.wo-tab-mode-icon{padding-left:9px;padding-right:9px;gap:0;}" +
            "#__wo_setup_modal .wo-tab-btn.wo-tab-mode-word .wo-tab-icon{display:none;}" +
            "#__wo_setup_modal .wo-tab-btn.is-active{z-index:2;color:var(--wo-text);background:var(--wo-surface);}" +
            // top/transform reset explicitly: the tab-separator rule above
            // only defines a ::after (not a ::before), and without this the
            // right-side curve alone inherited its top:50%/translateY(-50%)
            // once the separator rule stopped being fully overridden here —
            // pulling just that one corner up instead of anchoring to the
            // bottom like the left corner already did.
            "#__wo_setup_modal .wo-tab-btn.is-active::before,#__wo_setup_modal .wo-tab-btn.is-active::after{content:'';position:absolute;top:auto;transform:none;bottom:0;width:13px;height:13px;}" +
            "#__wo_setup_modal .wo-tab-btn.is-active::before{left:-13px;background:radial-gradient(circle at top left,transparent 13px,var(--wo-surface) 13.5px);}" +
            "#__wo_setup_modal .wo-tab-btn.is-active::after{right:-13px;background:radial-gradient(circle at top right,transparent 13px,var(--wo-surface) 13.5px);}" +
            "#__wo_setup_modal .wo-modal-content{flex:1;min-height:0;overflow:auto;padding:10px 10px 8px;background:var(--wo-surface);border-radius:0 6px 8px 8px;margin:0 -10px -10px;}" +
            // Snapped to an edge, the modal is flush against the screen
            // boundary — rounded corners there just look like a rendering
            // glitch, so square them off (overrides the inline border-radius
            // set at creation, hence !important).
            "#__wo_setup_modal.is-snapped{border-radius:0!important;}" +
            "#__wo_setup_modal.is-snapped .wo-modal-titlebar{border-radius:0!important;}" +
            "#__wo_setup_modal.is-snapped .wo-modal-content{border-radius:0!important;}" +
            "#__wo_setup_modal .wo-modal-content{scrollbar-width:thin;scrollbar-color:#30363d #0d1117;}" +
            "#__wo_setup_modal .wo-modal-content::-webkit-scrollbar{width:8px;}" +
            "#__wo_setup_modal .wo-modal-content::-webkit-scrollbar-track{background:#0d1117;}" +
            "#__wo_setup_modal .wo-modal-content::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;}" +
            "#__wo_setup_modal .wo-modal-content::-webkit-scrollbar-thumb:hover{background:#454d59;}" +
            // Generic form controls — buttons/inputs/textareas/selects used
            // throughout every tab's own markup.
            "#__wo_setup_modal .wo-btn{font:inherit;font-weight:700;font-size:11.5px;padding:6px 12px;border-radius:var(--wo-r-ctl);border:1px solid var(--wo-border);background:var(--wo-surface-2);color:var(--wo-text);cursor:pointer;}" +
            "#__wo_setup_modal .wo-btn:hover{border-color:var(--wo-accent);}" +
            "#__wo_setup_modal .wo-btn:focus-visible{outline:2px solid var(--wo-accent);outline-offset:1px;}" +
            "#__wo_setup_modal .wo-btn-primary{background:var(--wo-accent);color:var(--wo-on-accent);border-color:var(--wo-accent);}" +
            "#__wo_setup_modal .wo-btn-primary:disabled{background:var(--wo-surface-2);color:var(--wo-muted);border-color:var(--wo-border);cursor:default;opacity:.6;}" +
            "#__wo_setup_modal .wo-btn-danger{color:var(--wo-fail);border-color:var(--wo-fail);}" +
            "#__wo_setup_modal .wo-btn-pass{background:var(--wo-pass);color:#04210c;border-color:var(--wo-pass);}" +
            "#__wo_setup_modal .wo-btn-ghost{background:none;border:1px solid transparent;color:var(--wo-muted);cursor:pointer;font:inherit;font-size:11px;padding:6px 8px;border-radius:var(--wo-r-ctl);}" +
            "#__wo_setup_modal .wo-btn-ghost:hover{color:var(--wo-text);background:var(--wo-field);}" +
            // Small "this only does something if the beta feature is on"
            // marker — reused wherever a beta feature's own settings live
            // inline (not centralized), so it's visually obvious without a
            // trip to the Beta tab.
            "#__wo_setup_modal .wo-beta-pill{display:inline-block;padding:1px 5px;border-radius:3px;background:#8957e5;color:#fff;font-size:8.5px;font-weight:800;letter-spacing:.03em;vertical-align:middle;}" +
            "#__wo_setup_modal input[type=text],#__wo_setup_modal input[type=number],#__wo_setup_modal textarea,#__wo_setup_modal select{font:inherit;font-size:11.5px;background:var(--wo-field);color:var(--wo-text);border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:5px 7px;}" +
            // Every plain textarea only grows/shrinks vertically — a
            // textarea that can also stretch wider than its container
            // (the browser default) breaks the panel's own width and looks
            // broken when snapped narrow.
            "#__wo_setup_modal textarea{resize:vertical;scrollbar-width:thin;scrollbar-color:#30363d var(--wo-field);}" +
            // When a textarea's content overflows and a vertical scrollbar
            // appears, the browser paints a solid corner swatch behind the
            // resize grip where the scrollbar track meets the resize handle.
            // Left at its UA default that swatch is a bright, boxy square
            // that doesn't match the field's own background — flatten it so
            // the grip just floats on the field color like the rest of it.
            "#__wo_setup_modal textarea::-webkit-scrollbar{width:8px;}" +
            "#__wo_setup_modal textarea::-webkit-scrollbar-track{background:var(--wo-field);}" +
            "#__wo_setup_modal textarea::-webkit-scrollbar-thumb{background:#30363d;border-radius:4px;}" +
            "#__wo_setup_modal textarea::-webkit-scrollbar-thumb:hover{background:#454d59;}" +
            "#__wo_setup_modal textarea::-webkit-scrollbar-corner{background:var(--wo-field);}" +
            // The resize grip itself is a SEPARATE pseudo-element from the
            // scrollbar corner (::-webkit-resizer, not ::-webkit-scrollbar-
            // corner) — flattening only the corner left this one still
            // drawing its own boxy default backing behind the grip icon.
            "#__wo_setup_modal textarea::-webkit-resizer{background:var(--wo-field);}" +
            "#__wo_setup_modal input[type=text]:focus,#__wo_setup_modal input[type=number]:focus,#__wo_setup_modal textarea:focus,#__wo_setup_modal select:focus{outline:2px solid var(--wo-accent);outline-offset:-1px;border-color:var(--wo-accent);}" +
            "#__wo_setup_modal textarea.wo-code{font-family:Consolas,'Cascadia Mono',monospace;background:#010409;color:#7ee787;border-color:var(--wo-border);resize:vertical;scrollbar-color:#30363d #010409;}" +
            "#__wo_setup_modal textarea.wo-code::-webkit-scrollbar-track,#__wo_setup_modal textarea.wo-code::-webkit-scrollbar-corner,#__wo_setup_modal textarea.wo-code::-webkit-resizer{background:#010409;}" +
            // Padding lives on the head and body separately, NOT on .wo-card
            // itself — a card that's collapsed only renders its head, so if
            // the card carried the padding, a collapsed card would show a
            // visible gap of empty padding above/below the header row for
            // no reason. This way a collapsed card hugs its header tightly.
            "#__wo_setup_modal .wo-card{border:1px solid var(--wo-border);border-radius:var(--wo-r-card);margin-bottom:9px;background:var(--wo-surface);overflow:hidden;}" +
            // max-height (not just min-height) forcibly clamps this row to
            // one line's worth regardless of what's docked in it — a hard
            // guarantee that Rules/Groups/Variables/Scan headers all render
            // pixel-identical, since a min-height alone can't stop a row
            // from silently growing taller than another for reasons that
            // are hard to isolate in a static test (a couple of px of
            // difference was reported live but not reproducible here).
            // line-height was 1 (== font-size, 12px) — tight enough that a
            // descender (g/y/p/q/j) rendered right at or past the bottom
            // edge of this box's fixed 34px height, and the overflow:hidden
            // that keeps the header uniformly thick across tabs (see the
            // comment above) clipped it off. line-height:34px instead
            // vertically centers the text in the exact box height, which
            // gives descenders the room they need without loosening the
            // fixed-height/overflow guard that solves the original
            // uneven-header-thickness problem.
            "#__wo_setup_modal .wo-card-head{display:flex;align-items:center;gap:6px;padding:6px 10px;height:34px;max-height:34px;box-sizing:border-box;overflow:hidden;line-height:34px;cursor:pointer;user-select:none;background:var(--wo-surface-2);}" +
            "#__wo_setup_modal .wo-card-head:hover{background:var(--wo-field);}" +
            "#__wo_setup_modal .wo-card>[data-coll-body]{padding:0 10px 10px;}" +
            "#__wo_setup_modal .wo-card-arrow{font-size:9px;color:var(--wo-muted);min-width:9px;}" +
            "#__wo_setup_modal .wo-rule-title{flex:1;min-width:0;font-weight:700;font-size:12px;color:var(--wo-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
            "#__wo_setup_modal .wo-rule-title-input{flex:1;min-width:0;font:inherit;font-weight:700;font-size:12px;background:var(--wo-field);border:1px solid var(--wo-accent);border-radius:var(--wo-r-ctl);padding:4px 7px;color:var(--wo-text);}" +
            // Shared subtle inset box for a sub-section within a card body
            // (e.g. a group's header-message settings) — one visual
            // language reused across every tab instead of each tab having
            // its own ad hoc bordered div.
            "#__wo_setup_modal .wo-subbox{border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:8px;background:var(--wo-field);}" +
            "#__wo_setup_modal .wo-subbox-accent{border-color:var(--wo-accent);}" +
            // Shared editable-rows table (Scan tab's Row Detail Fields /
            // Post-Scan Actions) — one header row instead of repeating each
            // field's label inside every entry.
            // table-layout:fixed makes each column's % width shrink/grow
            // proportionally as the modal is resized. min-width gives the
            // columns a floor before that shrinking would start mangling
            // header text mid-word — past that floor the wrapper's own
            // overflow-x:auto takes over with a horizontal scrollbar instead.
            "#__wo_setup_modal .wo-edit-table{width:100%;min-width:420px;border-collapse:collapse;table-layout:fixed;}" +
            // Headers wrap to a 2nd line at word boundaries only (never
            // mid-word) — down to the table's min-width that's always
            // enough room for at least the longest single word per column.
            "#__wo_setup_modal .wo-edit-table th{text-align:left;font-weight:600;color:var(--wo-muted);font-size:10px;padding:2px 5px 5px;border-bottom:1px solid var(--wo-border);white-space:normal;word-break:normal;overflow-wrap:normal;line-height:1.3;}" +
            "#__wo_setup_modal .wo-edit-table td{padding:3px 5px;vertical-align:top;}" +
            "#__wo_setup_modal .wo-edit-table tr:not(:last-child) td{border-bottom:1px solid var(--wo-border);}" +
            "#__wo_setup_modal .wo-edit-table input,#__wo_setup_modal .wo-edit-table textarea{width:100%;font-size:11px;}" +
            "#__wo_setup_modal .wo-edit-table .wo-edit-table-del{width:26px;text-align:center;padding-left:2px;padding-right:2px;}" +
            // Custom-table editor (Tables tab) — a real bordered grid rather
            // than floating inputs with their own delete buttons, so it
            // reads as a spreadsheet. Every structural edit (add/delete row,
            // add/delete column, clear cell) lives in a right-click context
            // menu (see ctGridContextMenu()) instead of visible per-cell
            // buttons, same reasoning as any other decluttered control here.
            "#__wo_setup_modal .wo-ct-grid-wrap{overflow-x:auto;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);margin-top:6px;}" +
            "#__wo_setup_modal table.wo-ct-grid{width:100%;border-collapse:collapse;table-layout:fixed;}" +
            "#__wo_setup_modal table.wo-ct-grid th,#__wo_setup_modal table.wo-ct-grid td{border:1px solid var(--wo-border);padding:0;}" +
            "#__wo_setup_modal table.wo-ct-grid th{background:var(--wo-surface-2);}" +
            "#__wo_setup_modal table.wo-ct-grid td:hover{background:var(--wo-surface-2);}" +
            "#__wo_setup_modal table.wo-ct-grid th input,#__wo_setup_modal table.wo-ct-grid td input{display:block;width:100%;box-sizing:border-box;border:none;background:none;padding:5px 7px;font-size:11px;color:var(--wo-text);}" +
            "#__wo_setup_modal table.wo-ct-grid th input{font-weight:600;color:var(--wo-muted);font-size:10.5px;}" +
            "#__wo_setup_modal table.wo-ct-grid th input:focus,#__wo_setup_modal table.wo-ct-grid td input:focus{outline:1px solid var(--wo-accent);outline-offset:-1px;background:var(--wo-field);}" +
            "#__wo_setup_modal .wo-th-tip{display:inline-flex;vertical-align:middle;margin-left:5px;color:var(--wo-muted);cursor:default;}" +
            "#__wo_setup_modal .wo-th-tip:hover{color:var(--wo-text);}" +
            // Same show-on-card-hover treatment as .wo-drag-handle/.wo-move-wrap
            // just below — an entry's tooltip icon only exists in the markup
            // at all when it HAS tooltip text (see entryTipIconHtml()), and
            // even then stays invisible until the card (header or body) is
            // hovered/focused, so collapsed lists don't get visually busier
            // for entries that happen to have one set.
            "#__wo_setup_modal .wo-entry-tip-icon{display:inline-flex;vertical-align:middle;margin-left:5px;flex-shrink:0;color:var(--wo-muted);cursor:default;opacity:0!important;}" +
            "#__wo_setup_modal [data-reorder-card]:hover .wo-entry-tip-icon,#__wo_setup_modal [data-reorder-card]:focus-within .wo-entry-tip-icon{opacity:1!important;}" +
            "#__wo_setup_modal .wo-entry-tip-icon:hover{color:var(--wo-text);}" +
            // Visibility toggle: bright/white when the group is currently
            // shown (an "on" state should read as emphasized, not muted),
            // dim once it's hidden.
            // Sized to match .wo-kebab-btn exactly (not the generic
            // .wo-btn-ghost padding, which is taller/wider) — the card
            // header row otherwise stretches to fit whichever button in it
            // is biggest, making Groups cards visibly thicker than Rules.
            "#__wo_setup_modal .wo-vis-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid transparent;flex-shrink:0;color:var(--wo-text);}" +
            "#__wo_setup_modal .wo-vis-btn.is-hidden{color:var(--wo-muted);opacity:0.55;}" +
            // Reserved-width drag handle at the far left of the header —
            // always takes up its slot in the layout (so the title doesn't
            // reflow when it appears) but stays invisible until the card
            // (header OR its expanded body) is hovered, signalling "grab
            // here to reorder" without cluttering every row all the time.
            // !important on the opacity pair: this is exactly the kind of
            // property a host page's own broad selectors fight over, and a
            // plain (non-important) rule can lose that fight even at
            // higher specificity if the host's is also !important.
            "#__wo_setup_modal .wo-drag-handle{display:inline-flex;align-items:center;justify-content:center;width:18px;height:26px;flex-shrink:0;color:var(--wo-muted);opacity:0!important;cursor:grab;}" +
            "#__wo_setup_modal [data-reorder-card]:hover .wo-drag-handle,#__wo_setup_modal [data-reorder-card]:focus-within .wo-drag-handle{opacity:1!important;}" +
            // Move buttons stay invisible until the pointer is anywhere
            // over the card (header or its expanded body) — just an icon
            // that lights up on hover, no visible button chrome at rest.
            // Keyed off [data-reorder-card] (set by attachCardDrag on every
            // card it wires up), not the .wo-card class, so this also
            // covers Variables/Scan whose cards don't use .wo-card styling.
            "#__wo_setup_modal .wo-move-wrap{display:inline-flex;gap:1px;flex-shrink:0;opacity:0!important;}" +
            "#__wo_setup_modal [data-reorder-card]:hover .wo-move-wrap,#__wo_setup_modal [data-reorder-card]:focus-within .wo-move-wrap{opacity:1!important;}" +
            // No background/border box at rest OR on hover — just the icon
            // itself brightening to indicate it's interactive.
            "#__wo_setup_modal .wo-move-btn{display:inline-flex;align-items:center;justify-content:center;width:17px;height:22px;padding:0;border:none;background:none;color:var(--wo-muted);cursor:pointer;flex-shrink:0;}" +
            "#__wo_setup_modal .wo-move-btn:hover,#__wo_setup_modal .wo-move-btn:focus-visible{color:var(--wo-text);}" +
            "#__wo_setup_modal .wo-kebab-wrap{position:relative;flex-shrink:0;margin-left:auto;}" +
            "#__wo_setup_modal .wo-kebab-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:var(--wo-r-ctl);background:transparent;color:var(--wo-muted);cursor:pointer;flex-shrink:0;}" +
            "#__wo_setup_modal .wo-kebab-btn:hover,#__wo_setup_modal .wo-kebab-btn:focus-visible{color:var(--wo-text);background:var(--wo-border);}" +
            // Positioning (top/left/right) is always set inline at creation
            // time (see the kebab/tab-context-menu JS) — this rule is purely
            // visual chrome, shared by the rule kebab menu and the tab
            // display-mode context menu.
            "#__wo_setup_modal .wo-kebab-menu{display:inline-flex;flex-direction:column;gap:1px;background:var(--wo-surface-2);border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);box-shadow:0 8px 24px rgba(0,0,0,.5);padding:4px;z-index:20;}" +
            "#__wo_setup_modal .wo-kebab-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;white-space:nowrap;border:none;background:none;color:var(--wo-text);font:inherit;font-size:11.5px;text-align:left;border-radius:calc(var(--wo-r-ctl) - 2px);cursor:pointer;transition:background .08s;}" +
            "#__wo_setup_modal .wo-kebab-item svg{flex-shrink:0;}" +
            // --wo-field and --wo-surface-2 (the menu's own background) are
            // the exact same color, so a hover background of --wo-field was
            // never visible against the menu — the item you were pointing
            // at never actually looked different from the rest of the menu.
            "#__wo_setup_modal .wo-kebab-item:hover{background:var(--wo-border);}" +
            "#__wo_setup_modal .wo-kebab-item-active{color:var(--wo-accent);}" +
            "#__wo_setup_modal .wo-kebab-check{margin-left:auto;flex-shrink:0;color:var(--wo-accent);}" +
            "#__wo_setup_modal .wo-kebab-item-danger{color:var(--wo-fail);}" +
            "#__wo_setup_modal label{color:var(--wo-muted);}" +
            "#__wo_setup_modal .wo-resize-handle{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;color:var(--wo-muted);z-index:6;}" +
            "#__wo_setup_modal .wo-resize-handle:hover{color:var(--wo-text);}" +
            "#__wo_setup_modal .wo-resize-handle svg{position:absolute;right:2px;bottom:2px;pointer-events:none;}" +
            // Invisible hit zones for the other 3 corners + 4 edges.
            // Corners sit at z-index 6 (above the edges) so the small
            // corner squares win in the region where an edge strip would
            // otherwise overlap them.
            "#__wo_setup_modal .wo-resize-edge{position:absolute;z-index:5;}" +
            "#__wo_setup_modal .wo-resize-edge-n,#__wo_setup_modal .wo-resize-edge-s{left:12px;right:12px;height:6px;cursor:ns-resize;}" +
            "#__wo_setup_modal .wo-resize-edge-n{top:-3px;}" +
            "#__wo_setup_modal .wo-resize-edge-s{bottom:-3px;}" +
            "#__wo_setup_modal .wo-resize-edge-e,#__wo_setup_modal .wo-resize-edge-w{top:12px;bottom:12px;width:6px;cursor:ew-resize;}" +
            "#__wo_setup_modal .wo-resize-edge-e{right:-3px;}" +
            "#__wo_setup_modal .wo-resize-edge-w{left:-3px;}" +
            "#__wo_setup_modal .wo-resize-corner{position:absolute;width:14px;height:14px;z-index:6;}" +
            "#__wo_setup_modal .wo-resize-corner-nw{top:-3px;left:-3px;cursor:nwse-resize;}" +
            "#__wo_setup_modal .wo-resize-corner-ne{top:-3px;right:-3px;cursor:nesw-resize;}" +
            "#__wo_setup_modal .wo-resize-corner-sw{bottom:-3px;left:-3px;cursor:nesw-resize;}";
        var styleEl = document.createElement('style');
        styleEl.id = '__wo_setup_style';
        styleEl.textContent = css;
        document.head.appendChild(styleEl);
    }

    function openSetup() {
        var old = document.getElementById('__wo_setup_modal');
        if (old) {
            if (old._woCleanup) old._woCleanup();
            old.remove();
        }
        injectSetupStyles();
        var opts = fieldKeyOptions();
        var cfg = JSON.parse(JSON.stringify(getCfg()));
        var scan = JSON.parse(JSON.stringify(getScan()));
        // Hoisted to modal scope (not re-read per tab visit) so a staged
        // channel/version change in Settings survives switching to another
        // tab and back, and is only actually persisted on Save & Apply —
        // settingsTab() reads/writes this same object via closure.
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');

        // --- make modal draggable ---
        var modal = document.createElement('div');
        modal.id = '__wo_setup_modal';
        modal.style.cssText = 'position:fixed;top:3%;left:10%;width:75%;height:92%;z-index:9999999;padding:10px;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;font-size:12px;';
        modal.style.setProperty('--wo-header-h', getHostHeaderHeight() + 'px');
        // Minimalist line-icon per tab, keyed by the same id used for the
        // per-tab display-mode override (icon-only / word-only / both).
        var TAB_ICONS = {
            rules: '<path d="M2.6 4.3L3.7 5.4L5.6 3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 4.1H13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M2.6 8.3L3.7 9.4L5.6 7.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 8.1H13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M2.6 12.3L3.7 13.4L5.6 11.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 12.1H13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
            groups: '<rect x="2.5" y="2.5" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="6.5" y="6.5" width="7" height="7" rx="1.2" stroke="currentColor" stroke-width="1.3"/>',
            vars: '<path d="M5.6 2.8C4.1 2.8 3.7 3.6 3.7 4.6V6.4C3.7 7.1 3.4 7.5 2.6 7.7V8.3C3.4 8.5 3.7 8.9 3.7 9.6V11.4C3.7 12.4 4.1 13.2 5.6 13.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10.4 2.8C11.9 2.8 12.3 3.6 12.3 4.6V6.4C12.3 7.1 12.6 7.5 13.4 7.7V8.3C12.6 8.5 12.3 8.9 12.3 9.6V11.4C12.3 12.4 11.9 13.2 10.4 13.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
            scan: '<path d="M2.5 5.5V3.5C2.5 2.9 2.9 2.5 3.5 2.5H5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.5 2.5H12.5C13.1 2.5 13.5 2.9 13.5 3.5V5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M13.5 10.5V12.5C13.5 13.1 13.1 13.5 12.5 13.5H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5.5 13.5H3.5C2.9 13.5 2.5 13.1 2.5 12.5V10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="8" r="1.6" stroke="currentColor" stroke-width="1.3"/>',
            tables: '<rect x="2.3" y="3" width="11.4" height="10" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M2.3 6.3H13.7" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 6.3V13" stroke="currentColor" stroke-width="1.2"/>',
            profiles: '<circle cx="8" cy="5.3" r="2.3" stroke="currentColor" stroke-width="1.3"/><path d="M3 13.2C3.6 10.6 5.5 9.3 8 9.3C10.5 9.3 12.4 10.6 13 13.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
            // 8-tooth flat-topped gear (Chrome/Material "settings" glyph
            // shape) traced as one outline path, not filled — see the
            // comment on the rule kebab icon for why every icon here is
            // stroke-only.
            settings: '<path d="M12.57 6.9L14.24 6.56L14.24 9.44L12.57 9.1L12.01 10.46L13.43 11.39L11.39 13.43L10.46 12.01L9.1 12.57L9.44 14.24L6.56 14.24L6.9 12.57L5.54 12.01L4.61 13.43L2.57 11.39L3.99 10.46L3.43 9.1L1.76 9.44L1.76 6.56L3.43 6.9L3.99 5.54L2.57 4.61L4.61 2.57L5.54 3.99L6.9 3.43L6.56 1.76L9.44 1.76L9.1 3.43L10.46 3.99L11.39 2.57L13.43 4.61L12.01 5.54Z" stroke="currentColor" stroke-width="0.9" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.4" stroke="currentColor" stroke-width="1.2"/>',
            update: '<path d="M12.8 5.2A5 5 0 1 0 13.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.8 2.5V5.2H10.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
            guide: '<path d="M2.5 3.5C2.5 3 2.9 2.7 3.4 2.8C5 3 6.5 3.6 8 4.6C9.5 3.6 11 3 12.6 2.8C13.1 2.7 13.5 3 13.5 3.5V11.5C13.5 12 13.1 12.3 12.6 12.4C11 12.6 9.5 13.2 8 14.2C6.5 13.2 5 12.6 3.4 12.4C2.9 12.3 2.5 12 2.5 11.5V3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 4.6V14.2" stroke="currentColor" stroke-width="1.2"/>',
            // Shield — links out to the Worker-hosted admin management page.
            admin: '<path d="M8 2.4L13 4.2V7.6C13 10.8 10.9 13 8 13.7C5.1 13 3 10.8 3 7.6V4.2L8 2.4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.7 8L7.2 9.5L10.3 6.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
            feedback: '<path d="M2.5 3.7C2.5 3.1 3 2.6 3.6 2.6H12.4C13 2.6 13.5 3.1 13.5 3.7V9.3C13.5 9.9 13 10.4 12.4 10.4H6.5L3.8 12.7C3.5 12.9 3 12.7 3 12.3V10.4H3.6C3 10.4 2.5 9.9 2.5 9.3V3.7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5.8" cy="6.5" r="0.55" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="8" cy="6.5" r="0.55" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="10.2" cy="6.5" r="0.55" fill="none" stroke="currentColor" stroke-width="1.1"/>',
            // Flask/beaker — conventional "beta/experimental" glyph.
            beta: '<path d="M6.3 2.6H9.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M6.9 2.6V6.2L3.4 12.1C3 12.8 3.5 13.7 4.3 13.7H11.7C12.5 13.7 13 12.8 12.6 12.1L9.1 6.2V2.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 10.4H11" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
            exp: '<path d="M8 10V2.5M8 2.5L5.5 5M8 2.5L10.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 10V12.5C2.5 13.1 2.9 13.5 3.5 13.5H12.5C13.1 13.5 13.5 13.1 13.5 12.5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
            imp: '<path d="M8 2.5V10M8 10L5.5 7.5M8 10L10.5 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 10V12.5C2.5 13.1 2.9 13.5 3.5 13.5H12.5C13.1 13.5 13.5 13.1 13.5 12.5V10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
        };
        var tabModes = st.tabDisplayModes || {};
        function tabModeClass(key) {
            var m = tabModes[key];
            return m === 'icon' ? ' wo-tab-mode-icon' : (m === 'word' ? ' wo-tab-mode-word' : '');
        }
        function tabBtn(id, key, label, extraClass) {
            var esc = String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;');
            return '<button id="' + id + '" class="wo-tab-btn' + (extraClass ? ' ' + extraClass : '') + tabModeClass(key) + '" data-tab-key="' + key + '" data-tab-label="' + esc.replace(/"/g, '&quot;') + '">' +
                '<svg class="wo-tab-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + TAB_ICONS[key] + '</svg>' +
                '<span class="wo-tab-label">' + esc + '</span></button>';
        }
        // Tabs are grouped instead of one flat row of 11: content tabs you
        // actually configure, management tabs, then Guide/Export/Import as
        // lighter-weight utility actions pushed to the end. Save & Apply
        // moved into the title bar so it's not lost among 10 other buttons.
        modal.innerHTML =
            '<div class="wo-modal-titlebar" id="__s_titlebar">' +
            '<span class="wo-modal-title">Setup</span>' +
            '<span class="wo-modal-title-actions">' +
            '<button id="__s_formulas" type="button" class="wo-btn-ghost" aria-label="Formula reference">📖</button>' +
            '<button id="__s_save" class="wo-btn wo-btn-primary">Save</button>' +
            '<button id="__s_close" class="wo-btn-ghost" aria-label="Close">✕</button>' +
            '</span>' +
            '</div>' +
            '<div class="wo-modal-tabs">' +
            '<div class="wo-tab-group">' +
            tabBtn('__s_rules', 'rules', 'Rules') +
            tabBtn('__s_groups', 'groups', 'Groups') +
            tabBtn('__s_vars', 'vars', 'Variables') +
            tabBtn('__s_scan', 'scan', 'Scan') +
            tabBtn('__s_tables', 'tables', 'Tables') +
            tabBtn('__s_profiles', 'profiles', 'Profiles') +
            tabBtn('__s_settings', 'settings', 'Settings') +
            (hasAnyBetaGrant() ? tabBtn('__s_beta', 'beta', 'Beta') : '') +
            (hasGrant('dev') ? tabBtn('__s_update', 'update', 'Install') : '') +
            '</div>' +
            '<div class="wo-tab-group wo-tab-group-end">' +
            (hasGrant('admin') ? tabBtn('__s_admin', 'admin', 'Admin', 'wo-tab-btn-ghost') : '') +
            tabBtn('__s_guide', 'guide', 'Guide', 'wo-tab-btn-ghost') +
            tabBtn('__s_feedback', 'feedback', 'Feedback', 'wo-tab-btn-ghost') +
            tabBtn('__s_exp', 'exp', 'Export', 'wo-tab-btn-ghost') +
            tabBtn('__s_imp', 'imp', 'Import', 'wo-tab-btn-ghost') +
            // Hidden until applyResponsiveTabFit() decides even icon-only
            // mode isn't enough room — then it replaces all 4 buttons above,
            // same "..." overflow treatment as a kebab "More actions" menu.
            '<button id="__s_more" type="button" class="wo-tab-btn wo-tab-btn-ghost wo-tab-more-btn" aria-label="More" aria-haspopup="true" style="display:none;">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
            '</button>' +
            '</div>' +
            '</div>' +
            '<div id="__s_content" class="wo-modal-content"></div>' +
            // Bottom-right keeps the visible grab-icon affordance; the other
            // 3 corners + 4 edges are plain invisible hit zones — showing 8
            // icons around the frame would be more visual noise than a
            // resizable panel needs, and the cursor change on hover is
            // enough of a hint once one corner has taught the pattern.
            '<div class="wo-resize-handle" id="__s_resize">' +
            '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
            '<path d="M9 1L1 9M9 5L5 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
            '</svg></div>' +
            '<div class="wo-resize-edge wo-resize-edge-n" id="__s_resize_n"></div>' +
            '<div class="wo-resize-edge wo-resize-edge-s" id="__s_resize_s"></div>' +
            '<div class="wo-resize-edge wo-resize-edge-e" id="__s_resize_e"></div>' +
            '<div class="wo-resize-edge wo-resize-edge-w" id="__s_resize_w"></div>' +
            '<div class="wo-resize-corner wo-resize-corner-nw" id="__s_resize_nw"></div>' +
            '<div class="wo-resize-corner wo-resize-corner-ne" id="__s_resize_ne"></div>' +
            '<div class="wo-resize-corner wo-resize-corner-sw" id="__s_resize_sw"></div>';
        document.body.appendChild(modal);
        attachTooltip(modal.querySelector('#__s_resize'), 'Drag to resize');
        attachTooltip(modal.querySelector('#__s_close'), 'Close');
        attachTooltip(modal.querySelector('#__s_formulas'), 'Formula reference');
        modal.querySelectorAll('.wo-tab-btn[data-tab-key]').forEach(function(b) {
            var isLinkOutTab = b.getAttribute('data-tab-key') === 'guide' || b.getAttribute('data-tab-key') === 'admin';
            attachTooltip(b, function() {
                var label = b.classList.contains('wo-tab-mode-icon') ? b.getAttribute('data-tab-label') : '';
                if (isLinkOutTab) return (label ? label + ' — ' : '') + 'Opens in a new browser tab';
                return label;
            });
        });

        // Right-click a tab to pick how it's displayed: auto (default —
        // participates in the responsive shrink-to-fit below), icon only,
        // word only, or icon + word. Persisted per-tab straight to
        // localStorage (not deferred to Save & Apply) since it's a pure UI
        // preference with no config side effects — deferring it would make
        // the menu feel broken (pick a mode, nothing visibly happens).
        // Icon/Word pins are locked — they never auto-adjust, even if that
        // means the row overflows. An Icon+Word pin is also locked as a
        // preference, but the shrink-to-fit pass below still treats it as a
        // last-resort candidate so the row can always fit.
        function applyTabModeClasses() {
            modal.querySelectorAll('.wo-tab-btn[data-tab-key]').forEach(function(b) {
                b.classList.remove('wo-tab-mode-icon', 'wo-tab-mode-word');
                var m = tabModes[b.getAttribute('data-tab-key')];
                if (m === 'icon') b.classList.add('wo-tab-mode-icon');
                else if (m === 'word') b.classList.add('wo-tab-mode-word');
            });
        }

        function setTabMode(key, mode) {
            if (mode === 'auto') delete tabModes[key];
            else tabModes[key] = mode;
            st.tabDisplayModes = tabModes;
            var liveSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            liveSt.tabDisplayModes = tabModes;
            localStorage.setItem('__wo_settings', JSON.stringify(liveSt));
            applyResponsiveTabFit(true);
        }

        // Keeps the whole tab bar on one row as the modal is resized
        // narrower. Priority = left-to-right tab order (Rules highest,
        // Import lowest) — the lowest-priority AUTO tab shrinks to
        // icon-only first, escalating toward higher-priority ones only if
        // still not enough room. Tabs manually pinned to Icon or Word are
        // skipped entirely (locked, per explicit user choice, even if that
        // means overflow). Tabs manually pinned to Icon+Word are only
        // touched as an absolute last resort, after every auto tab is
        // already shrunk. Always recomputes from the clean pinned-only
        // baseline so growing the modal back out correctly un-shrinks tabs.
        var lastTabFitWidth = -1;

        function applyResponsiveTabFit(force) {
            var bar = modal.querySelector('.wo-modal-tabs');
            if (!bar) return;
            // Shrinking a tab to icon-only changes the bar's content height
            // (align-items:flex-end means the tallest tab sets it), and a
            // height change on the observed element re-fires the
            // ResizeObserver even though nothing about available WIDTH
            // changed. Re-running unconditionally on every fire would reset
            // to full width then immediately re-shrink, flipping the height
            // back — a self-triggering loop. Only recompute when the width
            // actually changed, or when a pin was just edited (force=true).
            if (!force && bar.clientWidth === lastTabFitWidth) return;
            lastTabFitWidth = bar.clientWidth;
            applyTabModeClasses();
            // Clean baseline before recomputing, same reasoning as the
            // icon-shrink pass below: growing the modal back out has to
            // correctly un-collapse this too, not just leave it collapsed
            // forever once it's ever kicked in once.
            var moreBtn = modal.querySelector('#__s_more');
            var endGroupTabs = Array.prototype.slice.call(modal.querySelectorAll('.wo-tab-group-end .wo-tab-btn[data-tab-key]'));
            endGroupTabs.forEach(function(b) {
                b.style.display = '';
            });
            if (moreBtn) moreBtn.style.display = 'none';

            var tabs = Array.prototype.slice.call(modal.querySelectorAll('.wo-tab-btn[data-tab-key]'));
            var autoCandidates = tabs.filter(function(b) {
                return !tabModes[b.getAttribute('data-tab-key')];
            }).reverse();
            var bothPinnedCandidates = tabs.filter(function(b) {
                return tabModes[b.getAttribute('data-tab-key')] === 'both';
            }).reverse();
            var queue = autoCandidates.concat(bothPinnedCandidates);
            var guard = 0;
            while (bar.scrollWidth > bar.clientWidth + 1 && queue.length && guard < tabs.length) {
                var next = queue.shift();
                next.classList.add('wo-tab-mode-icon');
                guard++;
            }
            // Last resort: even with every tab icon-shrunk, the bar still
            // doesn't fit — merge Guide/Feedback/Export/Import into one
            // "..." button (same idea as a kebab "More actions" menu)
            // instead of letting them silently overflow off the edge.
            if (bar.scrollWidth > bar.clientWidth + 1 && moreBtn) {
                endGroupTabs.forEach(function(b) {
                    b.style.display = 'none';
                });
                moreBtn.style.display = '';
            }
        }

        var moreTabBtn = modal.querySelector('#__s_more');
        if (moreTabBtn) {
            attachTooltip(moreTabBtn, 'More');
            moreTabBtn.onclick = function(ev) {
                // Without this, the click bubbles to modal's own
                // `click -> closeRuleMenu` listener (added so clicking
                // anywhere closes an open kebab menu) and closes the menu
                // this handler just opened, in the same event — the "..."
                // menu would visibly never open. Every other kebab
                // trigger avoids this via a wrapping
                // onclick="event.stopPropagation()" span; this button has
                // no such wrapper, so it has to stop propagation itself.
                ev.stopPropagation();
                var wasOpen = !!openRuleMenu;
                closeRuleMenu();
                if (wasOpen) return;
                var hiddenTabs = Array.prototype.slice.call(modal.querySelectorAll('.wo-tab-group-end .wo-tab-btn[data-tab-key]'));
                var menu = document.createElement('div');
                menu.className = 'wo-kebab-menu';
                menu.innerHTML = hiddenTabs.map(function(b) {
                    var key = b.getAttribute('data-tab-key');
                    return '<button type="button" class="wo-kebab-item" data-more-key="' + key + '">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + (TAB_ICONS[key] || '') + '</svg>' +
                        '<span>' + b.getAttribute('data-tab-label') + '</span>' +
                        '</button>';
                }).join('');
                menu.style.position = 'fixed';
                var btnRect = moreTabBtn.getBoundingClientRect();
                menu.style.top = (btnRect.bottom + 4) + 'px';
                menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                modal.appendChild(menu);
                var mr = menu.getBoundingClientRect();
                if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';
                menu.querySelectorAll('[data-more-key]').forEach(function(item) {
                    item.onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var key = item.getAttribute('data-more-key');
                        var realBtn = hiddenTabs.filter(function(b) {
                            return b.getAttribute('data-tab-key') === key;
                        })[0];
                        // Clicking the real (hidden) button reuses its full
                        // bindTab()-wired onclick — no separate switch-tab
                        // logic to duplicate/keep in sync here.
                        if (realBtn) realBtn.click();
                    };
                });
                openRuleMenu = menu;
            };
        }
        var tabBarResizeObserver = new ResizeObserver(function() {
            applyResponsiveTabFit();
        });
        tabBarResizeObserver.observe(modal.querySelector('.wo-modal-tabs'));
        applyResponsiveTabFit(true);

        var tabCtxMenu = null;

        function closeTabCtxMenu() {
            if (tabCtxMenu) {
                tabCtxMenu.remove();
                tabCtxMenu = null;
            }
        }
        modal.addEventListener('contextmenu', function(e) {
            var btn = e.target.closest('.wo-tab-btn[data-tab-key]');
            if (!btn) return;
            e.preventDefault();
            closeTabCtxMenu();
            var key = btn.getAttribute('data-tab-key');
            var current = tabModes[key] || 'auto';
            var options = [
                ['auto', 'Auto', '<path d="M9 3H13V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 13H3V9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3L9 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3 13L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'],
                ['icon', 'Icon', '<rect x="3" y="3" width="10" height="10" rx="2.2" stroke="currentColor" stroke-width="1.3"/>'],
                ['word', 'Word', '<path d="M3 5H13M3 8H13M3 11H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'],
                ['both', 'Icon + Word', '<rect x="2" y="4.3" width="6.4" height="6.4" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 5.3H14M10.5 8H14M10.5 10.7H12.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>']
            ];
            var menu = document.createElement('div');
            menu.className = 'wo-kebab-menu';
            menu.style.position = 'fixed';
            menu.style.right = 'auto';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.innerHTML = options.map(function(o) {
                var isActive = current === o[0];
                return '<button type="button" class="wo-kebab-item' + (isActive ? ' wo-kebab-item-active' : '') + '" data-mode="' + o[0] + '">' +
                    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + o[2] + '</svg>' +
                    '<span>' + o[1] + '</span>' +
                    (isActive ? '<svg class="wo-kebab-check" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
                    '</button>';
            }).join('');
            modal.appendChild(menu);
            var r = menu.getBoundingClientRect();
            if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
            if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
            menu.querySelectorAll('[data-mode]').forEach(function(item) {
                item.onclick = function(ev) {
                    ev.stopPropagation();
                    setTabMode(key, item.getAttribute('data-mode'));
                    closeTabCtxMenu();
                };
            });
            tabCtxMenu = menu;
        });
        modal.addEventListener('click', closeTabCtxMenu);

        // Resize logic — custom handles on all 4 edges + 4 corners rather
        // than native CSS resize:both, for the same reason the drag-to-move
        // uses custom JS: consistent styling/behavior instead of the
        // browser's own resize affordance, and room for min-size clamping.
        // `mode` is any combination of 'n'/'s' with 'e'/'w' (e.g. 'se','n').
        function attachResizeHandle(handleEl, mode, cursor) {
            var startW = 0,
                startH = 0,
                startL = 0,
                startT = 0,
                mx = 0,
                my = 0,
                pinnedLeftResize = false;
            handleEl.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                // Resizing the east edge while pinned left is a deliberate
                // exception: it stays pinned (still full height, still
                // pushing Maximo) and just changes how wide that pin is,
                // rather than treating every resize as "opt out of the
                // snap" — every other handle still clears the snap, since a
                // snapped rect is otherwise meant to track its zone, not a
                // hand-picked size.
                pinnedLeftResize = currentSnap === 'left' && mode === 'e';
                if (!pinnedLeftResize) clearSnap();
                var r = modal.getBoundingClientRect();
                startW = r.width;
                startH = r.height;
                startL = modal.offsetLeft;
                startT = modal.offsetTop;
                mx = e.clientX;
                my = e.clientY;
                startPointerCapture(resize, pinnedLeftResize ? stopPinnedResize : null, cursor);
            });

            function resize(e) {
                var dx = e.clientX - mx;
                var dy = e.clientY - my;
                var newL = startL,
                    newT = startT,
                    newW = startW,
                    newH = startH;
                if (mode.indexOf('e') !== -1) {
                    newW = Math.max(MODAL_MIN_W, Math.min(startW + dx, window.innerWidth - startL));
                } else if (mode.indexOf('w') !== -1) {
                    // Right edge stays fixed — the left edge tracks the
                    // cursor and width is derived from it, not the reverse,
                    // so the two can never drift out of sync.
                    var rightEdge = startL + startW;
                    newL = Math.max(0, Math.min(startL + dx, rightEdge - MODAL_MIN_W));
                    newW = rightEdge - newL;
                }
                if (mode.indexOf('s') !== -1) {
                    newH = Math.max(MODAL_MIN_H, Math.min(startH + dy, window.innerHeight - startT));
                } else if (mode.indexOf('n') !== -1) {
                    var bottomEdge = startT + startH;
                    newT = Math.max(0, Math.min(startT + dy, bottomEdge - MODAL_MIN_H));
                    newH = bottomEdge - newT;
                }
                modal.style.left = newL + 'px';
                modal.style.top = newT + 'px';
                modal.style.width = newW + 'px';
                modal.style.height = newH + 'px';
                if (pinnedLeftResize) {
                    leftSnapWidth = newW;
                    document.body.style.marginLeft = newW + 'px';
                }
            }

            function stopPinnedResize() {
                saveLeftSnapWidth(leftSnapWidth);
            }
        }
        attachResizeHandle(modal.querySelector('#__s_resize'), 'se', 'nwse-resize');
        [
            ['__s_resize_n', 'n', 'ns-resize'],
            ['__s_resize_s', 's', 'ns-resize'],
            ['__s_resize_e', 'e', 'ew-resize'],
            ['__s_resize_w', 'w', 'ew-resize'],
            ['__s_resize_nw', 'nw', 'nwse-resize'],
            ['__s_resize_ne', 'ne', 'nesw-resize'],
            ['__s_resize_sw', 'sw', 'nesw-resize']
        ].forEach(function(spec) {
            var el = modal.querySelector('#' + spec[0]);
            if (el) attachResizeHandle(el, spec[1], spec[2]);
        });

        // Highlights which tab is active — the old flat button row never
        // indicated this at all.
        function activateTab(id) {
            modal.querySelectorAll('.wo-tab-btn').forEach(function(b) {
                b.classList.toggle('is-active', b.id === id);
            });
        }

        // drag logic — clamped so the titlebar (the only handle you can grab
        // to drag the modal back) can never become fully unreachable. Fully
        // contained vertically (0% may go above/below the viewport); up to
        // 75% of its width may go off the left or right edge, since losing
        // some horizontal reach isn't fatal the way losing the handle
        // entirely off the top/bottom is — there's nothing left to grab.
        (function() {
            var tb = modal.querySelector('#__s_titlebar');
            var ox = 0,
                oy = 0,
                mx = 0,
                my = 0,
                tbW = 0,
                tbH = 0;
            var hoverZone = null;
            var preview = null;

            function showPreview(zone) {
                var rect = computeSnapRect(zone);
                // A fresh drag-to-left-edge snap always resets to the
                // narrowest width (see stopdrag()) — the live preview needs
                // to anticipate that too, or it shows the old remembered
                // width right up until the moment you actually drop.
                if (zone === 'left' && currentSnap !== 'left') {
                    rect = {
                        left: 0,
                        top: 0,
                        width: MODAL_MIN_W,
                        height: rect.height
                    };
                }
                if (!preview) {
                    preview = document.createElement('div');
                    preview.id = '__wo_snap_preview';
                    preview.style.cssText = 'position:fixed;z-index:2147483646;background:rgba(88,166,255,.22);border:2px solid rgba(88,166,255,.75);border-radius:8px;pointer-events:none;box-sizing:border-box;';
                    document.body.appendChild(preview);
                }
                preview.style.left = rect.left + 'px';
                preview.style.top = rect.top + 'px';
                preview.style.width = rect.width + 'px';
                preview.style.height = rect.height + 'px';
            }

            function hidePreview() {
                if (preview) {
                    preview.remove();
                    preview = null;
                }
            }
            tb.addEventListener('mousedown', function(e) {
                // Let the title bar's own Save/Close buttons behave like
                // normal buttons — the pointer-capture overlay below would
                // otherwise swallow their mouseup and eat the click.
                if (e.target.closest('button')) return;
                e.preventDefault();
                if (currentSnap) {
                    clearSnap();
                    var std = getStandardRect();
                    modal.style.left = std.left + 'px';
                    modal.style.top = std.top + 'px';
                    modal.style.width = std.width + 'px';
                    modal.style.height = std.height + 'px';
                }
                ox = modal.offsetLeft;
                oy = modal.offsetTop;
                mx = e.clientX;
                my = e.clientY;
                var r = tb.getBoundingClientRect();
                tbW = r.width;
                tbH = r.height;
                hoverZone = null;
                startPointerCapture(drag, stopdrag, 'grabbing');
            });

            function drag(e) {
                var newLeft = ox + e.clientX - mx;
                var newTop = oy + e.clientY - my;
                var minTop = 0;
                var maxTop = Math.max(0, window.innerHeight - tbH);
                newTop = Math.min(Math.max(newTop, minTop), maxTop);
                var minLeft = -0.75 * tbW;
                var maxLeft = window.innerWidth - 0.25 * tbW;
                newLeft = Math.min(Math.max(newLeft, minLeft), maxLeft);
                modal.style.left = newLeft + 'px';
                modal.style.top = newTop + 'px';

                hoverZone = detectSnapZone(e.clientX, e.clientY);
                if (hoverZone) showPreview(hoverZone);
                else hidePreview();
            }

            function stopdrag() {
                hidePreview();
                if (hoverZone) {
                    // A fresh drag-to-edge snap should always land at the
                    // narrowest width, even if a previous left-snap session
                    // was resized wider — that remembered width is only for
                    // reopening Setup while it's still snapped left (see
                    // leftSnapWidth/saveLeftSnapWidth), not for re-snapping
                    // from a floating/unsnapped state. Re-confirming an
                    // already-active left snap (currentSnap is already
                    // 'left') is unaffected, so mid-snap resizing survives.
                    if (hoverZone === 'left' && currentSnap !== 'left') {
                        saveLeftSnapWidth(MODAL_MIN_W);
                    }
                    applySnap(hoverZone);
                }
                hoverZone = null;
            }
        })();

        var content = modal.querySelector('#__s_content');
        // Only channel/pinnedVersion are actually staged until Save & Apply
        // (see the #__st_channel handler's comment) — every other st.*
        // field (betaEnabled, autoScan, autoBackup, tabDisplayModes, the
        // update-prefs checkboxes, etc.) calls saveSettingsCfg() itself the
        // moment it changes. Diffing the WHOLE st object against the
        // open-time snapshot would flag those already-saved fields as
        // pending too — e.g. flipping a Beta toggle would ungrey Save and
        // its tooltip would claim "Will save changes to: Settings" for a
        // change that was already persisted.
        function deferredSettingsSlice(s) {
            return {
                channel: s.channel,
                pinnedVersion: s.pinnedVersion
            };
        }
        // Whole-object snapshot for cfg/scan (every tab mutates those in
        // place via this same closure with no auto-save of its own), but
        // only the deferred slice for st — see deferredSettingsSlice().
        var __woSetupSnapshot = JSON.stringify({
            cfg: cfg,
            scan: scan,
            st: deferredSettingsSlice(st)
        });
        var saveBtn = modal.querySelector('#__s_save');

        function isSetupDirty() {
            return JSON.stringify({
                cfg: cfg,
                scan: scan,
                st: deferredSettingsSlice(st)
            }) !== __woSetupSnapshot;
        }

        // Flushes Setup's live in-memory cfg/scan/st to localStorage without
        // touching anything else Save does (no render/checkForUpdate/tab
        // refresh). Profile actions (Switch, Save Current As New, Start
        // Blank) all read the CURRENT profile via getCfg()/getScan(), which
        // read localStorage — not this closure's live objects — so without
        // this, any unsaved in-Setup edit silently never makes it into the
        // outgoing profile's snapshot, despite the UI explicitly promising
        // "your current config is saved first."
        function flushLiveConfigToStorage() {
            saveCfg(cfg);
            saveScan(scan);
            saveSettingsCfg(st);
        }
        function updateSaveButtonState() {
            saveBtn.disabled = !isSetupDirty();
        }
        updateSaveButtonState();

        // Coarse per-area diff (not per-field) for the Save button's hover
        // tooltip — variables are excluded since those already persist
        // immediately on every edit (see saveVars() call sites) and aren't
        // part of what this button applies. Settings only compares the
        // deferred slice (channel/pinnedVersion) for the same reason — see
        // deferredSettingsSlice()'s comment.
        function setupChangedAreasText() {
            var before;
            try {
                before = JSON.parse(__woSetupSnapshot);
            } catch (e) {
                return '';
            }
            var areas = [];
            if (JSON.stringify(cfg.rules) !== JSON.stringify(before.cfg.rules)) areas.push('Rules');
            if (JSON.stringify(cfg.groups) !== JSON.stringify(before.cfg.groups)) areas.push('Groups');
            if (JSON.stringify(cfg.tableNames || {}) !== JSON.stringify(before.cfg.tableNames || {})) areas.push('Table names');
            if (JSON.stringify(cfg.customTables || {}) !== JSON.stringify(before.cfg.customTables || {})) areas.push('Custom tables');
            if (JSON.stringify(cfg.apiTables || {}) !== JSON.stringify(before.cfg.apiTables || {})) areas.push('API tables');
            if (JSON.stringify(scan) !== JSON.stringify(before.scan)) areas.push('Scan targets & actions');
            if (JSON.stringify(deferredSettingsSlice(st)) !== JSON.stringify(before.st)) areas.push('Update channel/version pin');
            if (!areas.length) return 'No changes to save.';
            return 'Will save changes to:\n' + areas.map(function(a) {
                return '• ' + a;
            }).join('\n');
        }
        attachTooltip(saveBtn, setupChangedAreasText);
        // MutationObserver catches structural edits (add/delete/reorder rows,
        // drag-and-drop, toggle clicks that don't fire input/change) with no
        // per-control wiring; the input/change listener catches keystrokes,
        // which don't touch the DOM tree and so wouldn't trip the observer.
        // Debounced — drag-reorder animations mutate style attributes many
        // times per second, and re-stringifying cfg/scan/st on every single
        // one of those would be wasted work and could jank the drag.
        var __woSaveCheckTimer = null;
        new MutationObserver(function() {
            clearTimeout(__woSaveCheckTimer);
            __woSaveCheckTimer = setTimeout(updateSaveButtonState, 150);
        }).observe(content, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });
        content.addEventListener('input', updateSaveButtonState);
        content.addEventListener('change', updateSaveButtonState);
        var renamingRuleId = null;
        var renamingGroupId = null;
        var renamingVarId = null;
        var renamingScanId = null;
        // Rule/group/variable/scan id -> expanded (true/false). Lives for
        // the lifetime of this modal instance so switching tabs away and
        // back doesn't re-collapse everything; only a fresh openSetup()
        // (new closure) or an explicit re-click of the already-active
        // tab's header clears it.
        var ruleExpandState = {};
        var groupExpandState = {};
        var varExpandState = {};
        var scanExpandState = {};
        var scannedTableExpandState = {};
        var customTableExpandState = {};
        var apiTableExpandState = {};
        // Tab id -> scrollTop of #__s_content, saved just before switching
        // away from a tab and restored right after switching back to it, so
        // returning to a tab doesn't dump you back at the top. Reset only
        // by a fresh openSetup() (i.e. leaving and reopening Setup).
        var tabScrollPos = {};
        var currentTabId = '__s_rules';

        // --- edge snapping ---
        // null | 'left' | 'right' | 'top-left' | 'top-right'. Restored from
        // the last snap the user dropped the window into, so reopening
        // Setup reproduces it; a plain (non-snapped) close/reopen leaves
        // this null and the modal opens at its normal default rect.
        var currentSnap = st.setupSnap || null;
        // 360 is the narrowest the tab bar can actually use once every tab
        // is shrunk to icon-only (measured: ~330px of tabs/dividers + 20px
        // modal padding + slack) — anything higher just strands dead space
        // between the tab groups that resizing can never close.
        var MODAL_MIN_W = 360,
            MODAL_MIN_H = 320;
        // Width used while snapped 'left' — resizable via the east edge
        // without unsnapping (see attachResizeHandle), so it's tracked and
        // persisted separately from the one-time initial snap width.
        var leftSnapWidth = st.leftSnapWidth || MODAL_MIN_W;

        function saveLeftSnapWidth(w) {
            leftSnapWidth = w;
            st.leftSnapWidth = w;
            var liveSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            liveSt.leftSnapWidth = w;
            localStorage.setItem('__wo_settings', JSON.stringify(liveSt));
        }

        function getMainPanelWidth() {
            var dock = document.getElementById('__wo_dock');
            if (!dock) return 0;
            return getPanelCollapsed() ? 0 : PANEL_W;
        }

        // Same geometry used both for the live drag preview and the
        // committed snap, so the window ends up exactly where the preview
        // showed it would.
        function computeSnapRect(zone) {
            var vw = window.innerWidth,
                vh = window.innerHeight;
            var mw = getMainPanelWidth();
            if (zone === 'left') return {
                left: 0,
                top: 0,
                width: leftSnapWidth,
                height: vh
            };
            if (zone === 'right') return {
                left: Math.max(0, vw - (mw || MODAL_MIN_W)),
                top: 0,
                width: mw || MODAL_MIN_W,
                height: vh
            };
            if (zone === 'top-left') return {
                left: 0,
                top: 0,
                width: Math.max(MODAL_MIN_W, vw - mw),
                height: vh
            };
            if (zone === 'top-right') return {
                left: 0,
                top: 0,
                width: vw,
                height: vh
            };
            return null;
        }

        // Windows-Aero-style zones: top strip is split left/right half into
        // the two "top" snaps; otherwise a plain side edge is left/right.
        function detectSnapZone(x, y) {
            var EDGE = 40;
            var vw = window.innerWidth;
            if (y <= EDGE) return x < vw / 2 ? 'top-left' : 'top-right';
            if (x <= EDGE) return 'left';
            if (x >= vw - EDGE) return 'right';
            return null;
        }

        function saveSetupSnap(zone) {
            st.setupSnap = zone;
            var liveSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            liveSt.setupSnap = zone;
            localStorage.setItem('__wo_settings', JSON.stringify(liveSt));
        }

        // Only 'left' displaces Maximo's own layout (mirroring how the main
        // tool panel docks) — 'right' exactly covers where that panel
        // already sits, and the two 'top' zones simply overlay on top of
        // everything, so none of those need an extra push of their own.
        function applySnap(zone) {
            var rect = computeSnapRect(zone);
            if (!rect) return;
            modal.style.left = rect.left + 'px';
            modal.style.top = rect.top + 'px';
            modal.style.width = rect.width + 'px';
            modal.style.height = rect.height + 'px';
            document.body.style.marginLeft = zone === 'left' ? leftSnapWidth + 'px' : '';
            currentSnap = zone;
            modal.classList.add('is-snapped');
            saveSetupSnap(zone);
        }

        function clearSnap() {
            if (!currentSnap) return;
            currentSnap = null;
            modal.classList.remove('is-snapped');
            document.body.style.marginLeft = '';
            saveSetupSnap(null);
        }

        // Matches the modal's own initial (never-snapped) cssText rect —
        // used to snap a currently-snapped window back to its normal size
        // the moment you start dragging it away, rather than having it keep
        // whatever oversized/undersized rect the snap left it at.
        function getStandardRect() {
            return {
                left: window.innerWidth * 0.10,
                top: window.innerHeight * 0.03,
                width: window.innerWidth * 0.75,
                height: window.innerHeight * 0.92
            };
        }

        function onWindowResizeReapplySnap() {
            if (currentSnap) applySnap(currentSnap);
        }
        window.addEventListener('resize', onWindowResizeReapplySnap);
        if (currentSnap) applySnap(currentSnap);

        // Both the resize handle and the titlebar drag capture the pointer
        // via a full-viewport overlay rather than listening on `document`
        // directly: Maximo's UI is built from nested iframes, and a
        // mousemove over an iframe's rendered area is delivered to that
        // iframe's own document, never bubbling up to ours — that's what
        // made dragging "freeze" over large parts of the screen. An overlay
        // in OUR top-level document, drawn above everything (including any
        // iframe), keeps receiving the event regardless of what's visually
        // underneath it.
        function startPointerCapture(onMove, onUp, cursor) {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:' + (cursor || 'default') + ';';
            document.body.appendChild(overlay);

            function move(e) {
                onMove(e);
            }

            function up(e) {
                overlay.removeEventListener('mousemove', move);
                overlay.removeEventListener('mouseup', up);
                overlay.removeEventListener('mouseleave', up);
                overlay.remove();
                if (onUp) onUp(e);
            }
            overlay.addEventListener('mousemove', move);
            overlay.addEventListener('mouseup', up);
            // The overlay spans the whole viewport, so it never receives
            // another mousemove/mouseup once the cursor actually leaves the
            // browser window (there's no way to keep tracking a cursor once
            // it's outside the OS window — the browser simply stops getting
            // mouse events). Rather than leave the drag/resize stuck mid-
            // gesture forever (frozen, or stuck if the button is released
            // outside and the page never finds out), treat the cursor
            // leaving the viewport as the release point and end the
            // gesture there — same effect as if the user had let go right
            // at the edge.
            overlay.addEventListener('mouseleave', up);
        }
        // Rule kebab menus are built fresh on click and position:fixed from
        // the button's own rect (not absolute-inside-the-card) — a rule
        // card is overflow:hidden (see .wo-card comment above) so an
        // absolutely-positioned dropdown anchored inside it gets clipped
        // away entirely whenever the card is collapsed, which is the
        // default state. Same pattern as the tab display-mode menu below.
        var openRuleMenu = null;
        // Set true for one tick right after a card drag reorders and
        // re-renders — see the comment in makeCollapsible().
        var cardJustDragged = false;

        function closeRuleMenu() {
            if (openRuleMenu) {
                openRuleMenu.remove();
                openRuleMenu = null;
            }
        }
        modal.addEventListener('click', closeRuleMenu);

        // Animates a [data-coll-body] open/closed via a height transition
        // instead of an instant display:none toggle — display can't be
        // interpolated, so this measures scrollHeight, transitions an
        // explicit height to/from it (box-sizing:border-box means that
        // height already includes the body's own padding), and only sets
        // display:none once the closing transition actually finishes.
        function animateBodyToggle(body, expand) {
            if (body._woAnimCleanup) body._woAnimCleanup();
            body.style.overflow = 'hidden';
            if (expand) {
                body.style.display = '';
                var target = body.scrollHeight;
                body.style.height = '0px';
                body.getBoundingClientRect(); // force reflow before transitioning
                body.style.transition = 'height 160ms ease';
                body.style.height = target + 'px';
            } else {
                var current = body.scrollHeight;
                body.style.height = current + 'px';
                body.getBoundingClientRect(); // force reflow before transitioning
                body.style.transition = 'height 160ms ease';
                body.style.height = '0px';
            }
            function onEnd(e) {
                if (e && e.propertyName !== 'height') return;
                clearTimeout(fallbackTimer);
                body.style.transition = '';
                body.style.height = '';
                body.style.overflow = '';
                if (!expand) body.style.display = 'none';
                body.removeEventListener('transitionend', onEnd);
                body._woAnimCleanup = null;
            }
            body.addEventListener('transitionend', onEnd);
            // transitionend doesn't fire if the height never actually
            // changed (e.g. an empty card body) — a timeout backstop so the
            // inline height/overflow never gets stuck past the transition's
            // own duration either way.
            var fallbackTimer = setTimeout(onEnd, 220);
            // If the card gets torn down/re-rendered mid-transition (e.g. a
            // reorder fires right after a toggle), finish the state jump
            // immediately rather than leaving a dangling listener/height.
            body._woAnimCleanup = onEnd;
        }

        function makeCollapsible(box, headerText, startCollapsed, onToggle) {
            if (startCollapsed === undefined) startCollapsed = true;
            var header = box.querySelector('[data-coll-header]');
            var body = box.querySelector('[data-coll-body]');
            if (!header || !body) return;
            body.style.display = startCollapsed ? 'none' : '';
            header.style.cursor = 'pointer';
            header.style.userSelect = 'none';
            var arrow = header.querySelector('[data-coll-arrow]');
            if (arrow) arrow.textContent = startCollapsed ? '▶' : '▼';
            header.addEventListener('click', function() {
                // A completed card drag re-renders the whole tab, and the
                // browser then synthesizes a click against whatever now
                // sits under the cursor — which can be a freshly rendered
                // header. cardJustDragged (set by attachCardDrag, cleared
                // next tick) swallows that stray click so a drag can never
                // also toggle collapse as a side effect.
                if (cardJustDragged) return;
                var hidden = body.style.display === 'none';
                animateBodyToggle(body, hidden);
                if (arrow) arrow.textContent = hidden ? '▼' : '▶';
                if (onToggle) onToggle(hidden);
            });
        }

        // Shared reorder control used by Rules/Groups/Variables/Scan card
        // headers — a pair of chevron buttons (stroke-only, same convention
        // as the kebab dots) instead of unicode ▲/▼ text buttons. `arr` is
        // the live array the card's item lives in; swapping entries here is
        // the entire reorder mechanism, since every consumer (main panel
        // tiles, group rule-lists, variable pickers) just iterates these
        // same arrays in order.
        var MOVE_UP_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10L8 6L12 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        var MOVE_DN_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        // A stacked up/down chevron pair — the same "can drag either way"
        // affordance as the move buttons, but purely a visual cue (attachCardDrag
        // listens on the whole header, not this element specifically).
        // Up chevron, two horizontal lines, down chevron — reads as "grab
        // and drag this row up or down" rather than a generic move-arrow.
        var DRAG_HANDLE_HTML = '<span class="wo-drag-handle" aria-hidden="true"><svg width="16" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 4.2L8 1.8L11 4.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 7.2H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5 9.4H11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M5 11.8L8 14.2L11 11.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
        // Same trash-can glyph as the kebab menu's Delete item, reused
        // anywhere a plain "delete this row" icon button is needed outside
        // a kebab menu (table rows, list rows) so delete always reads the
        // same way everywhere in Setup.
        var TRASH_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.5V3.2C6 2.8 6.3 2.5 6.7 2.5H9.3C9.7 2.5 10 2.8 10 3.2V4.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5L5 12.7C5 13.1 5.4 13.5 5.8 13.5H10.2C10.6 13.5 11 13.1 11 12.7L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
        // Small "i" info icon for a column header tooltip — same glyph as
        // the main panel's group-tooltip icon, sized for a table <th>.
        var TH_TIP_SVG = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="7.1" x2="8" y2="11.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.45" stroke="currentColor" stroke-width="0.9"/></svg>';

        function thWithTip(label, tip) {
            return '<span>' + label + '<span class="wo-th-tip" data-th-tip="' + tip.replace(/"/g, '&quot;') + '">' + TH_TIP_SVG + '</span></span>';
        }

        // ── Per-entry tooltip (Rules/Groups/Variables/Scan) ──
        // Same "i" glyph as thWithTip's column-header tooltip, reused so
        // every tooltip affordance in Setup looks identical. Only emitted
        // into the header markup at all when the entry actually HAS tooltip
        // text — an entry with none gets no icon, not a hidden/disabled one
        // (see the "Hide tooltip symbol if no tooltip exists" requirement).
        function entryTipIconHtml(entry) {
            if (!entry || !entry.tooltip) return '';
            return '<span class="wo-entry-tip-icon" data-entry-tip>' + TH_TIP_SVG + '</span>';
        }

        // Wires the floating tooltip onto whichever icon entryTipIconHtml()
        // rendered for this box (a no-op if it rendered nothing).
        function wireEntryTipIcon(box, entry) {
            var el = box.querySelector('[data-entry-tip]');
            if (el) attachTooltip(el, entry.tooltip);
        }

        // Markup for the 4th kebab-menu item every Rules/Groups/Variables/Scan
        // entry gets, alongside Rename/Duplicate/Delete. Label reads "Set
        // Tooltip" when the entry has none yet, "Edit Tooltip" once one exists.
        function editTooltipKebabHtml(entry) {
            var label = (entry && entry.tooltip) ? 'Edit Tooltip' : 'Set Tooltip';
            return '<button data-edit-tip type="button" class="wo-kebab-item">' + TH_TIP_SVG + '<span>' + label + '</span></button>';
        }

        // Wires that item: prompts for the entry's plain-English explanation
        // (shown on hover via entryTipIconHtml/wireEntryTipIcon above),
        // trims it, and re-renders. A plain prompt() rather than an inline
        // editor — this is 4 near-identical call sites and a full inline
        // editor isn't worth the duplication for a single short text field.
        function wireEditTooltipKebabItem(menu, entry, entryLabel, rerenderFn) {
            var btn = menu.querySelector('[data-edit-tip]');
            if (!btn) return;
            btn.onclick = function(ev) {
                ev.stopPropagation();
                closeRuleMenu();
                woPrompt('Tooltip for "' + entryLabel + '" (shown on hover). Leave blank to remove.', entry.tooltip || '').then(function(next) {
                    if (next == null) return;
                    entry.tooltip = next.trim();
                    rerenderFn();
                });
            };
        }

        function moveButtonsHtml(isFirst, isLast, upTitle, dnTitle) {
            upTitle = upTitle || 'Move up';
            dnTitle = dnTitle || 'Move down';
            // At a list boundary, the button for the direction that's not
            // possible is omitted entirely rather than shown dimmed/disabled.
            var upBtn = isFirst ? '' : '<button data-mv-up type="button" class="wo-move-btn" aria-label="' + upTitle + '">' + MOVE_UP_SVG + '</button>';
            var dnBtn = isLast ? '' : '<button data-mv-dn type="button" class="wo-move-btn" aria-label="' + dnTitle + '">' + MOVE_DN_SVG + '</button>';
            return '<span class="wo-move-wrap" onclick="event.stopPropagation()">' + upBtn + dnBtn + '</span>';
        }

        // A move-arrow (or Groups tab's own order-swap) only ever trades two
        // ADJACENT cards, at positions idxLow/idxHigh in the container
        // BEFORE rerenderFn() rebuilds it — a much narrower case than the
        // drag engine's arbitrary reorder, so a full FLIP (First-Last-
        // Invert-Play) is simple here: record both cards' rects before the
        // rerender, rebuild, then slide each new occupant in from the
        // other's old rect instead of letting the swap just jump instantly.
        function animateSwap(container, idxLow, idxHigh, rerenderFn) {
            function getCards() {
                return Array.prototype.filter.call(container.children, function(el) {
                    return el.hasAttribute && el.hasAttribute('data-reorder-card');
                });
            }
            var oldCards = getCards();
            var oldRectLow = oldCards[idxLow] ? oldCards[idxLow].getBoundingClientRect() : null;
            var oldRectHigh = oldCards[idxHigh] ? oldCards[idxHigh].getBoundingClientRect() : null;
            rerenderFn();
            var newCards = getCards();

            function flipFrom(el, oldRect) {
                if (!el || !oldRect) return;
                var newRect = el.getBoundingClientRect();
                var dy = oldRect.top - newRect.top;
                var dx = oldRect.left - newRect.left;
                if (!dy && !dx) return;
                el.style.transition = 'none';
                el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
                el.getBoundingClientRect(); // commit the offset before transitioning off it
                el.style.transition = 'transform 160ms ease';
                el.style.transform = '';
                function onEnd(e) {
                    if (e && e.propertyName !== 'transform') return;
                    clearTimeout(fallbackTimer);
                    el.style.transition = '';
                    el.removeEventListener('transitionend', onEnd);
                }
                el.addEventListener('transitionend', onEnd);
                var fallbackTimer = setTimeout(onEnd, 220);
            }
            // The item now sitting in the top slot used to be down in the
            // bottom slot's rect, and vice versa.
            flipFrom(newCards[idxLow], oldRectHigh);
            flipFrom(newCards[idxHigh], oldRectLow);
        }

        function wireMoveButtons(box, arr, idx, rerenderFn) {
            var container = box.parentElement;
            var upBtn = box.querySelector('[data-mv-up]');
            var dnBtn = box.querySelector('[data-mv-dn]');
            if (upBtn) attachTooltip(upBtn, upBtn.getAttribute('aria-label'));
            if (dnBtn) attachTooltip(dnBtn, dnBtn.getAttribute('aria-label'));
            if (upBtn) upBtn.onclick = function() {
                if (idx === 0) return;
                var tmp = arr[idx - 1];
                arr[idx - 1] = arr[idx];
                arr[idx] = tmp;
                animateSwap(container, idx - 1, idx, rerenderFn);
            };
            if (dnBtn) dnBtn.onclick = function() {
                if (idx === arr.length - 1) return;
                var tmp = arr[idx + 1];
                arr[idx + 1] = arr[idx];
                arr[idx] = tmp;
                animateSwap(container, idx, idx + 1, rerenderFn);
            };
        }

        // Click-and-drag reorder by card header, with the other cards
        // visually sliding out of the way as the dragged card passes over
        // them. `container` holds all the `.wo-card` siblings (plus
        // whatever trailing "+ Add" button); `arr` is the live array whose
        // order backs the cards, in the same order they appear in the DOM.
        //
        // Deliberately does NOT start capturing the pointer on mousedown —
        // that would eat the mouseup that makeCollapsible's click handler
        // needs to toggle the card. Instead this only arms once the cursor
        // has moved a few pixels past mousedown, so a plain click still
        // reaches makeCollapsible untouched, and a real drag never lets a
        // click reach it at all (the capture overlay owns the mouseup).
        function attachCardDrag(headerEl, cardEl, container, arr, idx, rerenderFn) {
            // A data attribute, not the .wo-card class, marks which of
            // container's children are reorderable cards — so this works
            // for tabs (Variables, Scan) whose cards don't use .wo-card
            // styling without side-effects like inheriting its overflow:hidden.
            cardEl.setAttribute('data-reorder-card', '');
            headerEl.addEventListener('mousedown', function(downEvent) {
                if (downEvent.button !== 0) return;
                if (downEvent.target.closest('.wo-kebab-wrap,.wo-move-wrap,.wo-vis-btn,.wo-rule-title-input')) return;
                var startX = downEvent.clientX;
                var startY = downEvent.clientY;

                function onEarlyMove(mv) {
                    var dx = mv.clientX - startX;
                    var dy = mv.clientY - startY;
                    if ((dx * dx + dy * dy) < 25) return; // ~5px threshold
                    document.removeEventListener('mousemove', onEarlyMove);
                    document.removeEventListener('mouseup', onEarlyUp);
                    beginDrag(startY);
                }

                function onEarlyUp() {
                    document.removeEventListener('mousemove', onEarlyMove);
                    document.removeEventListener('mouseup', onEarlyUp);
                }
                document.addEventListener('mousemove', onEarlyMove);
                document.addEventListener('mouseup', onEarlyUp);
            });

            function beginDrag(startY) {
                var cards = Array.prototype.filter.call(container.children, function(el) {
                    return el.hasAttribute && el.hasAttribute('data-reorder-card');
                });

                // Smoothly close every OTHER card's body (plus the dragged
                // card's own) instead of an instant display:none snap, so
                // reordering past a tall expanded neighbor doesn't yank the
                // whole tab shut with no transition. The reorder-threshold
                // math below needs the FINAL settled geometry, not a mid-
                // transition one, so arming (measuring rects, enabling the
                // shift logic) waits until the collapse animation has
                // actually finished — until then the dragged card is
                // visually lifted (shadow/elevation) but doesn't yet track
                // the cursor or trigger a reorder.
                cards.forEach(function(c, i) {
                    if (i === idx) return;
                    var body = c.querySelector('[data-coll-body]');
                    if (body && body.style.display !== 'none') animateBodyToggle(body, false);
                });
                var draggedBody = cardEl.querySelector('[data-coll-body]');
                if (draggedBody && draggedBody.style.display !== 'none') animateBodyToggle(draggedBody, false);

                cardEl.style.position = 'relative';
                cardEl.style.zIndex = '10';
                cardEl.style.boxShadow = '0 6px 18px rgba(0,0,0,0.45)';
                cards.forEach(function(c, i) {
                    if (i !== idx) c.style.transition = 'transform 150ms ease';
                });

                var armed = false,
                    aborted = false;
                var lastMouseY = startY,
                    armStartY = startY;
                var draggedRect, headerShiftAmount, origRects, targetIdx = idx;

                var armTimer = setTimeout(function() {
                    if (aborted) return;
                    armStartY = lastMouseY;
                    draggedRect = cardEl.getBoundingClientRect();
                    // A shifted sibling needs to land in the dragged card's
                    // whole slot, not just its content box — getBoundingClientRect()
                    // doesn't include margin-bottom, so omitting it here left
                    // every shifted sibling short by exactly one card's
                    // margin until the drop-triggered rerender snapped it
                    // the rest of the way.
                    var cardMarginBottom = parseFloat(getComputedStyle(cardEl).marginBottom) || 0;
                    headerShiftAmount = draggedRect.height + cardMarginBottom;
                    origRects = cards.map(function(c) {
                        return c.getBoundingClientRect();
                    });
                    armed = true;
                }, 180);

                function applyShift(newTargetIdx) {
                    targetIdx = newTargetIdx;
                    cards.forEach(function(c, i) {
                        if (i === idx) return;
                        var shift = 0;
                        if (idx < targetIdx && i > idx && i <= targetIdx) shift = -headerShiftAmount;
                        else if (idx > targetIdx && i >= targetIdx && i < idx) shift = headerShiftAmount;
                        c.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
                    });
                }

                startPointerCapture(function(mv) {
                    lastMouseY = mv.clientY;
                    if (!armed) return;
                    var dy = mv.clientY - armStartY;
                    cardEl.style.transform = 'translateY(' + dy + 'px)';
                    var draggedCenter = draggedRect.top + draggedRect.height / 2 + dy;
                    var newTarget = idx;
                    for (var i = 0; i < cards.length; i++) {
                        if (i === idx) continue;
                        var center = origRects[i].top + origRects[i].height / 2;
                        if (i < idx && draggedCenter < center) newTarget = Math.min(newTarget, i);
                        if (i > idx && draggedCenter > center) newTarget = Math.max(newTarget, i);
                    }
                    if (newTarget !== targetIdx) applyShift(newTarget);
                }, function() {
                    aborted = true;
                    clearTimeout(armTimer);
                    cards.forEach(function(c) {
                        c.style.transition = '';
                        c.style.transform = '';
                        c.style.position = '';
                        c.style.zIndex = '';
                        c.style.boxShadow = '';
                    });
                    if (armed && targetIdx !== idx) {
                        var moved = arr.splice(idx, 1)[0];
                        arr.splice(targetIdx, 0, moved);
                    }
                    cardJustDragged = true;
                    setTimeout(function() {
                        cardJustDragged = false;
                    }, 0);
                    rerenderFn();
                }, 'grabbing');
            }
        }

        // Torn down both on an explicit Close/Save and, defensively, if a
        // second openSetup() call ever replaces this modal without one of
        // those firing first — otherwise the resize listener and the
        // left-snap body margin would leak past the modal's own lifetime.
        modal._woCleanup = function() {
            window.removeEventListener('resize', onWindowResizeReapplySnap);
            tabBarResizeObserver.disconnect();
            document.body.style.marginLeft = '';
        };
        // Custom-styled (not native confirm()) prompt shown only when closing
        // with unsaved changes — nested inside #__wo_setup_modal so it picks
        // up that root's own CSS reset/tokens instead of the host page's.
        function showUnsavedChangesDialog(onSave, onDiscard) {
            var old = modal.querySelector('#__s_unsaved_dlg');
            if (old) old.remove();
            var overlay = document.createElement('div');
            overlay.id = '__s_unsaved_dlg';
            overlay.style.cssText = 'position:absolute;inset:0;z-index:20000000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;border-radius:inherit;';
            overlay.innerHTML =
                '<div style="background:var(--wo-surface);border:1px solid var(--wo-border);border-radius:var(--wo-r-panel);box-shadow:0 10px 40px rgba(0,0,0,.6);padding:18px;max-width:320px;width:88%;">' +
                '<div style="font-size:13px;font-weight:800;margin-bottom:8px;">Unsaved changes</div>' +
                '<div style="font-size:12px;color:var(--wo-muted);margin-bottom:16px;line-height:1.5;">Your changes to Setup haven\'t been saved yet. What would you like to do?</div>' +
                '<div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">' +
                '<button id="__s_ud_cancel" type="button" class="wo-btn-ghost">Cancel</button>' +
                '<button id="__s_ud_discard" type="button" class="wo-btn wo-btn-danger">Discard &amp; Exit</button>' +
                '<button id="__s_ud_save" type="button" class="wo-btn wo-btn-primary">Save</button>' +
                '</div>' +
                '</div>';
            modal.appendChild(overlay);
            overlay.querySelector('#__s_ud_cancel').onclick = function() {
                overlay.remove();
            };
            overlay.querySelector('#__s_ud_discard').onclick = function() {
                overlay.remove();
                onDiscard();
            };
            overlay.querySelector('#__s_ud_save').onclick = function() {
                overlay.remove();
                onSave();
            };
        }
        function doCloseSetup() {
            modal._woCleanup();
            modal.remove();
            var fr = document.getElementById('__wo_formula_ref');
            if (fr) fr.remove();
        }
        modal.querySelector('#__s_formulas').onclick = function() {
            openFormulaReferencePopup();
        };
        modal.querySelector('#__s_close').onclick = function() {
            closeTabCtxMenu();
            closeRuleMenu();
            if (isSetupDirty()) {
                showUnsavedChangesDialog(function() {
                    modal.querySelector('#__s_save').click();
                    doCloseSetup();
                }, doCloseSetup);
                return;
            }
            doCloseSetup();
        };
        modal.querySelector('#__s_save').onclick = function() {
            saveCfg(cfg);
            saveScan(scan);
            saveSettingsCfg(st);
            applyHotkeys();
            closeTabCtxMenu();
            closeRuleMenu();
            render();
            checkForUpdate();
            // Stays open and refreshes in place instead of closing — lets you
            // keep working, and re-draws the active tab in case saving itself
            // changed anything relevant (e.g. update-check status). Guide is
            // skipped since it just opens a new browser tab, not a re-render;
            // Feedback is skipped so an in-progress draft doesn't get wiped.
            if (currentTabId !== '__s_guide' && currentTabId !== '__s_feedback' && tabFns[currentTabId]) {
                var savedScroll = content.scrollTop;
                tabFns[currentTabId]();
                content.scrollTop = savedScroll;
            }
            __woSetupSnapshot = JSON.stringify({
                cfg: cfg,
                scan: scan,
                st: st
            });
            updateSaveButtonState();
        };

        modal.querySelector('#__s_exp').onclick = function() {
            // Persist in-memory cfg/scan first so the backup blob reflects current edits
            saveCfg(cfg);
            saveScan(scan);
            var ta = document.createElement('textarea');
            ta.value = buildBackupBlob();
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            woAlert('Config copied to clipboard — save it as a text file.');
        };
        modal.querySelector('#__s_imp').onclick = function() {
            woPrompt('Paste exported config JSON:').then(function(raw) {
                if (!raw) return;
                try {
                    var b = JSON.parse(raw);
                    validateBackupShape(b);
                    if (b.rules) saveCfg(b.rules);
                    if (b.scan) saveScan(b.scan);
                    if (b.fields) saveFieldCfg(b.fields);
                    if (b.state) saveGS(b.state);
                    if (b.vars) saveVars(b.vars);

                    woAlert('Imported. Reopen Setup.').then(function() {
                        modal.remove();
                        render();
                    });
                } catch (e) {
                    woAlert((e instanceof SyntaxError ? 'Invalid JSON: ' : '') + e.message);
                }
            });
        };

        function formulaBox(obj, prop) {
            return '<textarea data-f class="wo-code" style="width:100%;height:80px;margin-top:6px;">' + String(obj[prop]).replace(/</g, '&lt;') + '</textarea>';
        }

        // Formula helper reference — signature + one short explanation per
        // arg, used by both the Excel-style signature tooltip and (for F/T/V)
        // the completion dropdown. Kept in sync with index.html's Formula
        // Reference table — update both if a helper is added/changed.
        var HELPER_REF = {
            F: { sig: "F(field)", args: ["field — \"Tab :: Label\" of a registered field (or just the label, matched by suffix)"], desc: "Get a field's value." },
            T: { sig: "T(table)", args: ["table — captured table name"], desc: "All rows of a captured table, as an array of objects keyed by column header." },
            rowCount: { sig: "rowCount(table)", args: ["table — captured table name"], desc: "Number of rows in a captured table." },
            col: { sig: "col(table, colName)", args: ["table — captured table name", "colName — column header"], desc: "Array of values from one column across all rows." },
            has: { sig: "has(table, colName, value)", args: ["table — captured table name", "colName — column header", "value — value to look for"], desc: "true if any row has that value in that column." },
            lookup: { sig: "lookup(table, keyCol, keyVal, returnCol)", args: ["table — captured table name, or a custom table from the Tables tab", "keyCol — column to search for a match", "keyVal — value to match", "returnCol — column to return from the matching row"], desc: "VLOOKUP-style: finds the first row where keyCol equals keyVal, returns its returnCol value (or '' if no row matches)." },
            count: { sig: "count(table, colName, value)", args: ["table — captured table name", "colName — column header", "value — value to look for"], desc: "Number of rows that have that value in that column." },
            hours: { sig: "hours(str)", args: ["str — \"HH:MM\" or decimal string"], desc: "Parses into a numeric hours value." },
            hoursBetween: { sig: "hoursBetween(a, b)", args: ["a — start datetime \"DD/MM/YYYY HH:MM\"", "b — end datetime, same format"], desc: "Hours between two datetime strings." },
            daysBetween: { sig: "daysBetween(a, b)", args: ["a — start datetime \"DD/MM/YYYY HH:MM\"", "b — end datetime, same format"], desc: "Days (not hours) between two datetime strings." },
            today: { sig: "today()", args: [], desc: "The current date/time as \"DD/MM/YYYY HH:MM\" - drops straight into hoursBetween()/daysBetween() alongside a captured Maximo date." },
            oneOf: { sig: "oneOf(val, arr)", args: ["val — value to check", "arr — array of allowed values"], desc: "true if val is in the array." },
            contains: { sig: "contains(text, pattern)", args: ["text — string to test", "pattern — regex pattern"], desc: "Regex test, returns a boolean." },
            matches: { sig: "matches(text, pattern)", args: ["text — string to search", "pattern — regex pattern"], desc: "Array of unique regex matches." },
            isEmpty: { sig: "isEmpty(v)", args: ["v — value to check"], desc: "true if v is null/undefined/empty string." },
            notEmpty: { sig: "notEmpty(v)", args: ["v — value to check"], desc: "true if v is NOT null/undefined/empty string." },
            ifBlank: { sig: "ifBlank(val, fallback)", args: ["val — value to check", "fallback — used instead if val is empty"], desc: "val if it's non-empty, otherwise fallback." },
            toNumber: { sig: "toNumber(val)", args: ["val — value to convert, e.g. a captured field (always a string)"], desc: "Converts to a number (commas stripped first, e.g. \"1,234\"). Returns null if it doesn't look like a number." },
            toString: { sig: "toString(val)", args: ["val — value to convert"], desc: "Converts to a string. Returns '' for null/undefined." },
            trim: { sig: "trim(str)", args: ["str — text to clean up"], desc: "Removes leading/trailing whitespace." },
            upper: { sig: "upper(str)", args: ["str — text to convert"], desc: "Converts to UPPERCASE." },
            lower: { sig: "lower(str)", args: ["str — text to convert"], desc: "Converts to lowercase." },
            left: { sig: "left(str, n)", args: ["str — text to slice", "n — number of characters"], desc: "The first n characters of str." },
            right: { sig: "right(str, n)", args: ["str — text to slice", "n — number of characters"], desc: "The last n characters of str." },
            mid: { sig: "mid(str, start, len)", args: ["str — text to slice", "start — 0-based starting position", "len — number of characters"], desc: "len characters of str starting at position start." },
            sum: { sig: "sum(arr)", args: ["arr — array of numbers/numeric strings, e.g. from col(...)"], desc: "Total of every numeric value in the array (non-numeric entries are skipped)." },
            avg: { sig: "avg(arr)", args: ["arr — array of numbers/numeric strings, e.g. from col(...)"], desc: "Average of every numeric value in the array, or null if none are numeric." },
            maxLaborHours: { sig: "maxLaborHours(tableTitle, nameCol, hoursCol)", args: ["tableTitle — captured labor table name", "nameCol — column with each person's name", "hoursCol — column with hours"], desc: "The highest total hours attributed to any one person." },
            whoami: { sig: "whoami(field)", args: ["field — username, email, displayName, insertSite, country, langcode, or any other field name Maximo's whoami endpoint returns (e.g. loginID, personid)"], desc: "The current user's Maximo profile field. Requires \"Allow whoami() in formulas\" in Settings > Display." },
            domain: { sig: "domain(key, code)", args: ["key — a Maximo domain list name, e.g. DOWNCODE, HAZTYPE, WOCLASS", "code — the coded value to decode"], desc: "Decodes a code via one of Maximo's own cached domain lists. beta_2 only — returns '' if that beta feature is off." },
            assetWOHistory: { sig: "assetWOHistory(assetnum, siteid, limit)", args: ["assetnum — asset number", "siteid — Maximo site ID", "limit — max rows, default 10"], desc: "Recent work orders for an asset, newest first, fetched live from Maximo's REST API (array of {wonum, description, status, wopriority, reportdate, worktype, ...}). beta_2 only — returns [] if that beta feature is off, or [] until the (async) fetch resolves." },
            assetDowntimeHistory: { sig: "assetDowntimeHistory(assetnum, siteid)", args: ["assetnum — asset number", "siteid — Maximo site ID"], desc: "The asset's full downtime history (not just what's linked to the current WO) as an array of {startdate, enddate}, fetched live from Maximo's REST API. beta_2 only — returns [] if that beta feature is off, or [] until the (async) fetch resolves." },
            V: { sig: "V(id)", args: ["id — a variable's ID or label"], desc: "A variable's computed value." },
            R: { sig: "R(colName)", args: ["colName — another column's header in this same table"], desc: "Only works inside a custom table's own formula column (Tables tab) — reads another column's value from the row currently being computed." }
        };

        // A searchable list of every HELPER_REF entry, reachable from the
        // Setup titlebar (📖) on any tab — added because the only formula
        // reference that existed before this was the external Guide page
        // (williamzitzmann.github.io/.../#s17), which meant leaving Setup
        // entirely and cross-referencing in a separate tab mid-edit.
        function openFormulaReferencePopup() {
            var old = document.getElementById('__wo_formula_ref');
            if (old) old.remove();
            var pop = document.createElement('div');
            pop.id = '__wo_formula_ref';
            pop.style.cssText = 'position:fixed;top:6%;left:50%;transform:translateX(-50%);width:min(560px,88%);height:82%;z-index:10000000;background:var(--wo-bg,#0d1117);color:var(--wo-text,#f0f3f6);border:1px solid var(--wo-border,#30363d);border-radius:10px;box-shadow:0 6px 30px rgba(0,0,0,.8);display:flex;flex-direction:column;font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;padding:10px;';
            pop.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex:0 0 auto;">' +
                '<b style="font-size:13px;">Formula Reference</b>' +
                '<button id="__fr_close" type="button" class="wo-btn-ghost">✕ Close</button>' +
                '</div>' +
                '<input id="__fr_search" type="text" placeholder="Filter functions..." style="flex:0 0 auto;margin-bottom:8px;">' +
                '<div id="__fr_list" style="flex:1;overflow:auto;"></div>';
            document.body.appendChild(pop);

            var listEl = pop.querySelector('#__fr_list');

            function renderList(query) {
                var q = (query || '').trim().toLowerCase();
                var names = Object.keys(HELPER_REF).sort();
                var matches = names.filter(function(name) {
                    if (!q) return true;
                    var ref = HELPER_REF[name];
                    return name.toLowerCase().indexOf(q) >= 0 || ref.desc.toLowerCase().indexOf(q) >= 0;
                });
                listEl.innerHTML = matches.length ? matches.map(function(name) {
                    var ref = HELPER_REF[name];
                    return '<div style="border:1px solid var(--wo-border,#30363d);border-radius:6px;padding:8px 10px;margin-bottom:6px;">' +
                        '<code class="wo-mono" style="font-size:12px;color:var(--wo-accent,#58a6ff);">' + String(ref.sig).replace(/</g, '&lt;') + '</code>' +
                        '<div style="margin-top:4px;">' + String(ref.desc).replace(/</g, '&lt;') + '</div>' +
                        (ref.args && ref.args.length ? '<ul style="margin:5px 0 0 16px;padding:0;color:var(--wo-muted,#9aa4af);">' + ref.args.map(function(a) {
                            return '<li>' + String(a).replace(/</g, '&lt;') + '</li>';
                        }).join('') + '</ul>' : '') +
                        '</div>';
                }).join('') : '<div style="color:var(--wo-muted,#9aa4af);">No functions match.</div>';
            }
            renderList('');
            pop.querySelector('#__fr_search').oninput = function(e) {
                renderList(e.target.value);
            };
            pop.querySelector('#__fr_close').onclick = function() {
                pop.remove();
            };
            pop.querySelector('#__fr_search').focus();
        }

        // Scans backward from the cursor to find the nearest unclosed "("
        // and the identifier immediately before it, plus which comma-
        // separated argument the cursor sits in. One parse feeds both the
        // F(/T(/V( completion dropdown and the Excel-style signature
        // tooltip, so they can never disagree about what's under the cursor.
        function parseFormulaContext(text, pos) {
            var depth = 0,
                i = pos - 1;
            while (i >= 0) {
                var ch = text[i];
                if (ch === ')') depth++;
                else if (ch === '(') {
                    if (depth === 0) break;
                    depth--;
                }
                i--;
            }
            if (i < 0) return null;
            var openParenIdx = i;
            var j = i - 1;
            while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j])) j--;
            var name = text.slice(j + 1, i);
            if (!name) return null;
            var argIndex = 0,
                d2 = 0,
                argStart = openParenIdx + 1;
            for (var k = openParenIdx + 1; k < pos; k++) {
                var c2 = text[k];
                if (c2 === '(') d2++;
                else if (c2 === ')') d2--;
                else if (c2 === ',' && d2 === 0) {
                    argIndex++;
                    argStart = k + 1;
                }
            }
            return {
                func: name,
                argIndex: argIndex,
                argStart: argStart,
                prefix: text.slice(argStart, pos).replace(/^[\s'"]+/, '')
            };
        }

        // Wires an F(/T(/V( completion dropdown + Excel-style signature
        // tooltip onto a single formula/condition field. Only meant for
        // genuine formula fields (rule/variable/scan-target formulas, scan
        // action value/condition, row-detail collect condition, per-entry
        // condition) — never plain text fields like labels or message boxes.
        function attachFormulaAssist(el) {
            var dropdown = null,
                sigTip = null;
            // Excel-style keyboard nav shared by both dropdown flavors (arg
            // completion and function-name completion): ddItems is the
            // currently open dropdown's {el, value} list, ddIndex is which
            // one is highlighted (0 = top match, highlighted by default —
            // matching Excel's own function-name IntelliSense), ddAccept(value)
            // performs whichever insertion that dropdown flavor needs.
            var ddItems = [],
                ddIndex = -1,
                ddAccept = null;

            function closeDropdown() {
                if (dropdown) {
                    dropdown.remove();
                    dropdown = null;
                }
                ddItems = [];
                ddIndex = -1;
                ddAccept = null;
            }

            function setDdIndex(i) {
                if (!ddItems.length) return;
                i = Math.max(0, Math.min(ddItems.length - 1, i));
                ddItems.forEach(function(it, idx) {
                    it.el.style.background = idx === i ? 'rgba(255,255,255,.1)' : 'none';
                });
                ddIndex = i;
                ddItems[i].el.scrollIntoView({ block: 'nearest' });
            }

            function closeSigTip() {
                if (sigTip) {
                    sigTip.remove();
                    sigTip = null;
                }
            }

            function completionSource(func) {
                if (func === 'F') return opts.fields;
                if (func === 'T' || func === 'lookup' || func === 'count') return opts.tables;
                // Once whoamiCache is actually warm (the toggle's been on and
                // a fetch has completed), offer every real field the endpoint
                // returned — not just the six curated names — so a formula
                // can discover/use a field this file never hand-mapped. Cold
                // cache (feature off, or not fetched yet this session) falls
                // back to the fixed curated list so the dropdown isn't just
                // empty for the common case.
                if (func === 'whoami') return whoamiCache ? Object.keys(whoamiCache) : ['username', 'email', 'displayName', 'insertSite', 'country', 'langcode'];
                if (func === 'domain') return KNOWN_DOMAIN_KEYS;
                if (func === 'V') return getVars().map(function(v) {
                    return v.label;
                });
                return null;
            }

            function insertCompletion(ctx, value) {
                var pos = el.selectionStart;
                var before = el.value.slice(0, ctx.argStart);
                var after = el.value.slice(pos);
                var quoted = "'" + value.replace(/'/g, "\\'") + "'";
                el.value = before + quoted + after;
                var newPos = (before + quoted).length;
                el.selectionStart = el.selectionEnd = newPos;
                // Programmatic .value writes don't fire oninput — every one
                // of these fields already has an oninput that persists the
                // edit into cfg/scan, so without this the inserted text
                // would look right but silently not save.
                el.dispatchEvent(new Event('input', { bubbles: true }));
                closeDropdown();
                el.focus();
            }

            // Returns true if it actually rendered a dropdown, false if there
            // was nothing to show (e.g. no known tables yet) — update() uses
            // this to decide whether to fall through to the signature
            // tooltip instead, so argIndex 0 with zero matches still shows
            // SOMETHING rather than going silent until the next comma.
            // `pinBelow` — when the signature tooltip is ALSO being shown
            // for this same call (see update()), both float relative to the
            // same field's bounding rect, so left to their own flip logic
            // they'd land in the same spot. Pins this one below
            // unconditionally so the tooltip (pinned above, see
            // showSigTip()) never overlaps it.
            function showDropdown(ctx, pinBelow) {
                var source = completionSource(ctx.func);
                if (!source || ctx.argIndex !== 0) {
                    closeDropdown();
                    return false;
                }
                var q = ctx.prefix.replace(/['"]/g, '').toLowerCase();
                var matches = source.filter(function(s) {
                    return s.toLowerCase().indexOf(q) >= 0;
                }).slice(0, 8);
                if (!matches.length) {
                    closeDropdown();
                    return false;
                }
                closeDropdown();
                dropdown = document.createElement('div');
                dropdown.className = 'wo-fa-dropdown';
                // Appended to document.body (like attachTooltip's floating
                // tip) rather than nested in #__wo_setup_modal, so its own
                // --wo-* custom properties wouldn't cascade here — hardcoded
                // to match those token values instead.
                dropdown.style.cssText = 'position:fixed;z-index:9999999;background:#1f2630;border:1px solid #30363d;border-radius:6px;max-height:170px;overflow:auto;box-shadow:0 6px 20px rgba(0,0,0,.5);font-size:11px;font-family:"Segoe UI",Arial,sans-serif;';
                ddAccept = function(value) {
                    insertCompletion(ctx, value);
                };
                matches.forEach(function(m, mi) {
                    var item = document.createElement('div');
                    item.textContent = m;
                    item.style.cssText = 'padding:5px 9px;cursor:pointer;color:#f0f3f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                    item.onmouseenter = function() {
                        setDdIndex(mi);
                    };
                    item.onmousedown = function(e) {
                        e.preventDefault();
                        insertCompletion(ctx, m);
                    };
                    dropdown.appendChild(item);
                    ddItems.push({ el: item, value: m });
                });
                document.body.appendChild(dropdown);
                var r = el.getBoundingClientRect();
                dropdown.style.left = Math.max(4, r.left) + 'px';
                dropdown.style.width = Math.min(320, Math.max(180, r.width)) + 'px';
                if (pinBelow) {
                    dropdown.style.top = (r.bottom + 2) + 'px';
                } else {
                    // Flip above the field instead of running off the bottom
                    // of the viewport — the Scan tab's tables put some of
                    // these fields near the bottom of a long scrolled list.
                    var belowSpace = window.innerHeight - r.bottom;
                    if (belowSpace < dropdown.offsetHeight + 8 && r.top > dropdown.offsetHeight + 8) {
                        dropdown.style.top = (r.top - dropdown.offsetHeight - 2) + 'px';
                    } else {
                        dropdown.style.top = (r.bottom + 2) + 'px';
                    }
                }
                setDdIndex(0);
                return true;
            }

            // Finds the plain identifier (if any) immediately touching the
            // cursor, regardless of enclosing structure — this is what lets
            // function-NAME completion work both at the very top of a
            // formula (nothing typed yet at all) and as a fresh argument to
            // an outer call (e.g. hoursBetween(loo -> lookup(...)), unlike
            // parseFormulaContext which only knows about an ENCLOSING call's
            // argument list, not what's actually being typed as its value.
            // A naive quote-parity scan (no escape/comment awareness beyond
            // backslash-escaping) — good enough to tell "cursor is inside an
            // open '...'/"..." string" from "cursor is in bare code", which
            // is all that's needed to stop e.g. lookup('table', 'colu| from
            // suggesting function names while typing a plain column-name
            // string argument.
            function insideStringLiteral(text, pos) {
                var q = null;
                for (var i = 0; i < pos; i++) {
                    var c = text[i];
                    if (q) {
                        if (c === '\\') {
                            i++;
                            continue;
                        }
                        if (c === q) q = null;
                    } else if (c === "'" || c === '"') {
                        q = c;
                    }
                }
                return q !== null;
            }

            function parseBareIdentifierPrefix(text, pos) {
                if (insideStringLiteral(text, pos)) return null;
                var j = pos - 1;
                while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j])) j--;
                var start = j + 1;
                if (start === pos) return null;
                if (text[pos] === '(') return null;
                return {
                    start: start,
                    prefix: text.slice(start, pos)
                };
            }

            function matchingFunctionNames(prefix) {
                var p = prefix.toLowerCase();
                return Object.keys(HELPER_REF).filter(function(name) {
                    return name.toLowerCase().indexOf(p) === 0;
                }).sort();
            }

            function insertFunctionName(idCtx, name) {
                var pos = el.selectionStart;
                var before = el.value.slice(0, idCtx.start);
                var after = el.value.slice(pos);
                var insertText = name + '(';
                el.value = before + insertText + after;
                var newPos = (before + insertText).length;
                el.selectionStart = el.selectionEnd = newPos;
                // Dispatched 'input' re-runs update() via the listener below
                // (same as insertCompletion) — the freshly-opened call's own
                // arg-completion/signature tooltip shows immediately.
                el.dispatchEvent(new Event('input', { bubbles: true }));
                closeDropdown();
                el.focus();
            }

            function showFunctionNameDropdown(idCtx, matches) {
                closeDropdown();
                dropdown = document.createElement('div');
                dropdown.className = 'wo-fa-dropdown';
                dropdown.style.cssText = 'position:fixed;z-index:9999999;background:#1f2630;border:1px solid #30363d;border-radius:6px;max-height:220px;overflow:auto;box-shadow:0 6px 20px rgba(0,0,0,.5);font-size:11px;font-family:"Segoe UI",Arial,sans-serif;';
                ddAccept = function(name) {
                    insertFunctionName(idCtx, name);
                };
                matches.slice(0, 8).forEach(function(name, mi) {
                    var ref = HELPER_REF[name];
                    var item = document.createElement('div');
                    item.style.cssText = 'padding:5px 9px;cursor:pointer;color:#f0f3f6;';
                    item.innerHTML = '<b>' + name + '</b><span style="color:#8b98a5;"> — ' + String(ref.desc).replace(/</g, '&lt;') + '</span>';
                    item.onmouseenter = function() {
                        setDdIndex(mi);
                    };
                    item.onmousedown = function(e) {
                        e.preventDefault();
                        insertFunctionName(idCtx, name);
                    };
                    dropdown.appendChild(item);
                    ddItems.push({ el: item, value: name });
                });
                document.body.appendChild(dropdown);
                var r = el.getBoundingClientRect();
                dropdown.style.left = Math.max(4, r.left) + 'px';
                dropdown.style.width = Math.min(360, Math.max(220, r.width)) + 'px';
                var belowSpace = window.innerHeight - r.bottom;
                if (belowSpace < dropdown.offsetHeight + 8 && r.top > dropdown.offsetHeight + 8) {
                    dropdown.style.top = (r.top - dropdown.offsetHeight - 2) + 'px';
                } else {
                    dropdown.style.top = (r.bottom + 2) + 'px';
                }
                setDdIndex(0);
            }

            // `pinAbove` — set when a value-completion dropdown is ALSO
            // being shown for this same call (e.g. domain(/lookup(/F(),
            // see update()); forces this above the field unconditionally so
            // it never lands in the same spot as the dropdown (pinned below
            // in that case — see showDropdown()). Excel shows both the
            // signature and a value list together for these functions;
            // previously this tool showed only one or the other.
            function showSigTip(ctx, pinAbove) {
                var ref = HELPER_REF[ctx.func];
                if (!ref) {
                    closeSigTip();
                    return;
                }
                closeSigTip();
                sigTip = document.createElement('div');
                sigTip.className = 'wo-fa-sigtip';
                sigTip.style.cssText = 'position:fixed;z-index:9999999;background:#1f2630;color:#f0f3f6;font-size:11px;font-family:Consolas,"Cascadia Mono",monospace;padding:7px 10px;border-radius:6px;max-width:300px;white-space:pre-wrap;box-shadow:0 4px 14px rgba(0,0,0,.5);border:1px solid #30363d;pointer-events:none;';
                var lines = [ref.sig, ''];
                (ref.args || []).forEach(function(a, idx) {
                    lines.push((idx === ctx.argIndex ? '→ ' : '   ') + a);
                });
                lines.push('');
                lines.push(ref.desc);
                sigTip.textContent = lines.join('\n');
                document.body.appendChild(sigTip);
                var r = el.getBoundingClientRect();
                sigTip.style.left = Math.max(4, r.left) + 'px';
                if (pinAbove) {
                    sigTip.style.top = Math.max(4, r.top - sigTip.offsetHeight - 2) + 'px';
                } else {
                    var belowSpace = window.innerHeight - r.bottom;
                    if (belowSpace < sigTip.offsetHeight + 8 && r.top > sigTip.offsetHeight + 8) {
                        sigTip.style.top = (r.top - sigTip.offsetHeight - 2) + 'px';
                    } else {
                        sigTip.style.top = (r.bottom + 2) + 'px';
                    }
                }
            }

            function update() {
                var ctx = parseFormulaContext(el.value, el.selectionStart);
                // A formula author's typed casing (daysbetween vs daysBetween)
                // shouldn't decide whether the dropdown/tooltip recognizes
                // the call at all — canonicalize to the real ARGN/HELPER_REF
                // casing here, once, so every lookup below just works.
                // normalizeFormulaFunctionCase() does the matching rewrite
                // at actual eval time, so the two stay in sync.
                if (ctx && ARGN_LOWER.hasOwnProperty(ctx.func.toLowerCase())) {
                    ctx.func = ARGN_LOWER[ctx.func.toLowerCase()];
                }
                // Value-completion dropdown (F(/T(/V(/lookup(/count(/whoami(/
                // domain( at their first arg) and the signature tooltip are
                // no longer mutually exclusive — Excel shows both a value
                // list AND the signature for these, so when the dropdown
                // renders, the tooltip still shows too (pinned above it,
                // see showSigTip()/showDropdown()'s pinAbove/pinBelow).
                var dropdownShown = false;
                if (ctx) {
                    var source = completionSource(ctx.func);
                    if (source && ctx.argIndex === 0) {
                        dropdownShown = showDropdown(ctx, true);
                    }
                }
                if (!dropdownShown) {
                    // Bare function-NAME typing — either nothing enclosing at
                    // all (top of the formula) or a fresh identifier being
                    // typed as an argument to an outer call. Checked before
                    // falling back to the outer call's own signature tooltip,
                    // since actively typing a name is more useful right now —
                    // this one genuinely can't show alongside a signature
                    // tooltip, since there's no complete outer call yet to
                    // have one.
                    var idCtx = parseBareIdentifierPrefix(el.value, el.selectionStart);
                    if (idCtx && idCtx.prefix) {
                        var nameMatches = matchingFunctionNames(idCtx.prefix);
                        if (nameMatches.length) {
                            closeSigTip();
                            showFunctionNameDropdown(idCtx, nameMatches);
                            return;
                        }
                    }
                    closeDropdown();
                }
                if (ctx) showSigTip(ctx, dropdownShown);
                else closeSigTip();
            }
            el.addEventListener('input', update);
            el.addEventListener('click', update);
            el.addEventListener('keyup', function(e) {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') update();
            });
            el.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    closeDropdown();
                    closeSigTip();
                    return;
                }
                // Excel-style dropdown navigation: while either dropdown is
                // open, arrow keys move the highlight instead of the
                // caret, and Tab/Enter accept the highlighted match instead
                // of leaving the field/inserting a newline — so a match can
                // be picked without ever touching the mouse, same as
                // Excel's own function-name IntelliSense.
                if (!dropdown || !ddItems.length) return;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setDdIndex(ddIndex + 1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setDdIndex(ddIndex - 1);
                } else if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    if (ddAccept && ddIndex >= 0) ddAccept(ddItems[ddIndex].value);
                }
            });
            el.addEventListener('blur', function() {
                // Delayed so a dropdown item's onmousedown (which fires
                // before blur takes effect) still gets a chance to run.
                setTimeout(function() {
                    closeDropdown();
                    closeSigTip();
                }, 120);
            });
        }
        // ── VARIABLES TAB ──
        function varsTab() {
            content.innerHTML = '';
            var vars = getVars();

            vars.forEach(function(v, idx) {
                var box = document.createElement('div');
                box.className = 'wo-card';
                var fo = opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('');
                var isRenaming = renamingVarId === v.id;
                var titleHtml = isRenaming ?
                    '<input type="text" value="' + v.label.replace(/"/g, '&quot;') + '" data-l class="wo-rule-title-input" onclick="event.stopPropagation()">' :
                    '<span class="wo-rule-title">' + String(v.label).replace(/</g, '&lt;') + '</span>';
                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    DRAG_HANDLE_HTML +
                    titleHtml +
                    entryTipIconHtml(v) +
                    moveButtonsHtml(idx === 0, idx === vars.length - 1) +
                    '<span class="wo-kebab-wrap" onclick="event.stopPropagation()">' +
                    '<button data-kebab type="button" class="wo-kebab-btn" aria-label="Variable actions" aria-haspopup="true">' +
                    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
                    '</button>' +
                    '</span>' +
                    '</div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<div style="margin-bottom:6px;color:var(--wo-muted);font-size:10px;">ID: <code class="wo-mono">' + v.id + '</code></div>' +
                    '<div style="margin-bottom:2px;font-size:11px;">Insert field: <select data-vi style="max-width:65%;"><option value="">--</option>' + fo + '</select></div>' +
                    formulaBox(v, 'formula') +
                    '<div style="margin-top:9px;display:flex;align-items:center;gap:9px;"><button data-vt type="button" class="wo-btn">Test</button> <span data-vr class="wo-mono" style="font-size:10.5px;"></span></div>' +
                    '<div style="margin-top:7px;color:var(--wo-muted);font-size:10px;">Formula must return a value (string, number, etc.). Use the same helpers as rules: F(), T(), rowCount(), etc.</div>' +
                    '</div>';

                content.appendChild(box);
                makeCollapsible(box, v.label, !varExpandState[v.id], function(expandedNow) {
                    varExpandState[v.id] = expandedNow;
                });
                wireEntryTipIcon(box, v);
                attachTooltip(box.querySelector('[data-kebab]'), 'More actions');
                wireMoveButtons(box, vars, idx, function() {
                    saveVars(vars);
                    varsTab();
                });
                attachCardDrag(box.querySelector('[data-coll-header]'), box, content, vars, idx, function() {
                    saveVars(vars);
                    varsTab();
                });

                var fa = box.querySelector('[data-f]');
                var titleInput = box.querySelector('[data-l]');
                if (titleInput) {
                    titleInput.oninput = function(e) {
                        v.label = e.target.value;
                        saveVars(vars);
                    };
                    titleInput.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            titleInput.blur();
                        }
                    });
                    titleInput.addEventListener('blur', function() {
                        renamingVarId = null;
                        varsTab();
                    });
                    titleInput.focus();
                    titleInput.select();
                }
                fa.oninput = function() {
                    v.formula = fa.value;
                    saveVars(vars);
                };
                attachFormulaAssist(fa);
                box.querySelector('[data-vi]').onchange = function(e) {
                    if (!e.target.value) return;
                    var sn = "F('" + e.target.value.replace(/'/g, "\\'") + "')";
                    var p = fa.selectionStart || fa.value.length;
                    fa.value = fa.value.slice(0, p) + sn + fa.value.slice(p);
                    v.formula = fa.value;
                    saveVars(vars);
                    e.target.value = '';
                };
                var kebabBtn = box.querySelector('[data-kebab]');
                kebabBtn.onclick = function() {
                    var wasOpen = !!openRuleMenu;
                    closeRuleMenu();
                    if (wasOpen) return;
                    var menu = document.createElement('div');
                    menu.className = 'wo-kebab-menu';
                    menu.innerHTML =
                        '<button data-rename type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.5L13.5 5L5.5 13H3V10.5L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Rename</span>' +
                        '</button>' +
                        '<button data-dup type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/></svg>' +
                        '<span>Duplicate</span>' +
                        '</button>' +
                        editTooltipKebabHtml(v) +
                        '<button data-del type="button" class="wo-kebab-item wo-kebab-item-danger">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.5V3.2C6 2.8 6.3 2.5 6.7 2.5H9.3C9.7 2.5 10 2.8 10 3.2V4.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5L5 12.7C5 13.1 5.4 13.5 5.8 13.5H10.2C10.6 13.5 11 13.1 11 12.7L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Delete</span>' +
                        '</button>';
                    menu.style.position = 'fixed';
                    var btnRect = kebabBtn.getBoundingClientRect();
                    menu.style.top = (btnRect.bottom + 4) + 'px';
                    menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                    modal.appendChild(menu);
                    var mr = menu.getBoundingClientRect();
                    if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';
                    wireEditTooltipKebabItem(menu, v, v.label, varsTab);
                    menu.querySelector('[data-rename]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        renamingVarId = v.id;
                        varsTab();
                    };
                    menu.querySelector('[data-dup]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var copy = JSON.parse(JSON.stringify(v));
                        copy.id = 'v_' + Date.now();
                        copy.label = v.label + ' (copy)';
                        vars.splice(idx + 1, 0, copy);
                        saveVars(vars);
                        varsTab();
                    };
                    menu.querySelector('[data-del]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Delete variable "' + v.label + '"?').then(function(ok) {
                            if (!ok) return;
                            vars.splice(idx, 1);
                            saveVars(vars);
                            varsTab();
                        });
                    };
                    openRuleMenu = menu;
                };
                box.querySelector('[data-vt]').onclick = function() {
                    var res = runVariable(fa.value, cache);
                    var sp = box.querySelector('[data-vr]');
                    if (res.error) {
                        sp.style.color = 'var(--wo-fail)';
                        sp.textContent = '⚠ ' + res.error;
                    } else {
                        sp.style.color = 'var(--wo-accent)';
                        sp.textContent = '→ ' + (res.value !== null ? JSON.stringify(res.value) : '(null)');
                    }
                };
            });

            var addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'wo-btn wo-btn-primary';
            addBtn.textContent = '+ Add Variable';
            addBtn.onclick = function() {
                vars.push({
                    id: 'v_' + Date.now(),
                    label: 'New Variable',
                    formula: "return F('Work Order :: Work Order');"
                });
                saveVars(vars);
                varsTab();
            };
            content.appendChild(addBtn);
        }

        // ── RULES TAB ──
        var RETURN_MODES = [
            ['none', 'None (exclude)'],
            ['short', 'Short message'],
            ['long', 'Long message(s)'],
            ['custom', 'Custom text below']
        ];

        // Builds one collapsible Pass/Fail/Warn section for a rule: a Short
        // (one-line, for the group header) input, a Long list editor — each
        // entry has its OWN condition + message fields (no ' :: ' delimiter
        // parsing, so a condition referencing a qualified field name like
        // "Tab :: Field" can never corrupt the message) — and, for fail/warn,
        // an inline "include in return message" control.
        // Matches a call to any known formula helper (F, T, V, col, etc.)
        // Message boxes are plain string templates — only text inside
        // {{expr}} spans gets evaluated, so a bare call typed directly into
        // one just shows up as literal text, which is almost never intended.
        var HELPER_NAME_RE = /\b(F|T|V|rowCount|col|has|hours|hoursBetween|oneOf|contains|matches|isEmpty|notEmpty|maxLaborHours)\s*\(/;

        function hasUnwrappedHelperCall(text) {
            if (!text) return false;
            var stripped = String(text).replace(/\{\{[\s\S]*?\}\}/g, '');
            return HELPER_NAME_RE.test(stripped);
        }

        // Wires a small inline warning under a plain message-text input,
        // shown live whenever it contains a helper/variable call that isn't
        // wrapped in {{ }} (and so won't actually be evaluated).
        // afterEl lets a caller put the warning below a wrapping row instead
        // of directly after the input itself — needed when the input is one
        // of several flex children in an inline row (e.g. a Long entry's
        // condition/message/remove row), where "afterend" on the input would
        // otherwise land the warning as another flex item in that same row.
        function wireUnwrappedHelperWarning(inputEl, afterEl) {
            var warn = document.createElement('div');
            warn.className = 'wo-unwrapped-warn';
            warn.style.cssText = 'display:none;margin-top:3px;font-size:10px;color:var(--wo-warn);';
            warn.textContent = '⚠ Looks like a formula reference — wrap it in {{ }} to evaluate it, otherwise it will show as plain text.';
            (afterEl || inputEl).insertAdjacentElement('afterend', warn);
            function check() {
                warn.style.display = hasUnwrappedHelperCall(inputEl.value) ? '' : 'none';
            }
            inputEl.addEventListener('input', check);
            check();
        }

        function msgSection(rule, key, label, color, includeReturn) {
            var side = rule[key];
            var sec = document.createElement('div');
            sec.className = 'wo-card';
            sec.style.cssText = 'border-left:3px solid ' + color + ';margin-top:8px;margin-bottom:0;';
            sec.innerHTML =
                '<div data-coll-header class="wo-card-head">' +
                '<span data-coll-arrow class="wo-card-arrow">▶</span>' +
                '<b style="color:' + color + ';font-size:11px;">' + label + '</b>' +
                '</div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<label style="font-size:10px;">' + thWithTip('Short:', 'One line, shown in the group header.') + '</label><br>' +
                '<input type="text" data-short value="' + String(side.short || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;">' +
                '<div style="margin-top:8px;font-size:10px;color:var(--wo-muted);">' + thWithTip('Long:', 'One or more messages, each with its own optional condition. Every matching entry is shown as a bullet list.') + '</div>' +
                '<div data-long-list style="margin-top:5px;display:flex;flex-direction:column;gap:5px;"></div>' +
                '<button data-add-long type="button" class="wo-btn-ghost" style="margin-top:4px;">+ Add message</button>' +
                (includeReturn ?
                    ('<div style="margin-top:9px;border-top:1px solid var(--wo-border);padding-top:8px;">' +
                        '<label style="font-size:10px;">Include in return message:</label>' +
                        '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:10px;">' +
                        RETURN_MODES.map(function(m) {
                            return '<label style="font-size:10px;color:var(--wo-text);display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="radio" name="__ret_' + rule.id + '_' + key + '" data-ret-mode value="' + m[0] + '" ' + ((side.returnMode || 'none') === m[0] ? 'checked' : '') + '> ' + m[1] + '</label>';
                        }).join('') +
                        '</div>' +
                        '<input type="text" data-ret-custom placeholder="Custom text (supports {{expr}})" value="' + String(side.returnCustom || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:6px;">' +
                        '</div>') : '') +
                '</div>';

            makeCollapsible(sec, label);
            sec.querySelectorAll('[data-th-tip]').forEach(function(el) {
                attachTooltip(el, el.getAttribute('data-th-tip'));
            });

            sec.querySelector('[data-short]').oninput = function(e) {
                side.short = e.target.value;
            };
            wireUnwrappedHelperWarning(sec.querySelector('[data-short]'));

            function renderLongList() {
                var wrap = sec.querySelector('[data-long-list]');
                wrap.innerHTML = '';
                (side.long || []).forEach(function(entry, i) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:5px;align-items:center;';
                    row.innerHTML =
                        '<input type="text" placeholder="Condition (optional)" data-cond value="' + String(entry.condition || '').replace(/"/g, '&quot;') + '" class="wo-mono" style="flex:1;min-width:0;font-size:10px;color:var(--wo-accent);">' +
                        '<input type="text" placeholder="Message (supports {{expr}})" data-msg value="' + String(entry.msg || '').replace(/"/g, '&quot;') + '" style="flex:2;min-width:0;">' +
                        '<button data-rm-entry type="button" class="wo-btn-ghost" style="color:var(--wo-fail);flex-shrink:0;padding:4px 7px;">✕</button>';
                    row.querySelector('[data-cond]').oninput = function(e) {
                        entry.condition = e.target.value;
                    };
                    attachFormulaAssist(row.querySelector('[data-cond]'));
                    row.querySelector('[data-msg]').oninput = function(e) {
                        entry.msg = e.target.value;
                    };
                    row.querySelector('[data-rm-entry]').onclick = function() {
                        side.long.splice(i, 1);
                        renderLongList();
                    };
                    wrap.appendChild(row);
                    wireUnwrappedHelperWarning(row.querySelector('[data-msg]'), row);
                });
            }
            renderLongList();
            sec.querySelector('[data-add-long]').onclick = function() {
                if (!side.long) side.long = [];
                side.long.push({
                    condition: '',
                    msg: ''
                });
                renderLongList();
            };

            if (includeReturn) {
                sec.querySelectorAll('[data-ret-mode]').forEach(function(r) {
                    r.onchange = function(e) {
                        if (e.target.checked) side.returnMode = e.target.value;
                    };
                });
                sec.querySelector('[data-ret-custom]').oninput = function(e) {
                    side.returnCustom = e.target.value;
                };
                wireUnwrappedHelperWarning(sec.querySelector('[data-ret-custom]'));
            }
            return sec;
        }

        function rulesTab() {
            content.innerHTML = '';
            cfg.rules.forEach(function(rule, idx) {
                var box = document.createElement('div');
                box.className = 'wo-card';
                var fo = opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('');
                var isRenaming = renamingRuleId === rule.id;
                var titleHtml = isRenaming ?
                    '<input type="text" value="' + rule.label.replace(/"/g, '&quot;') + '" data-l class="wo-rule-title-input" onclick="event.stopPropagation()">' :
                    '<span class="wo-rule-title">' + String(rule.label).replace(/</g, '&lt;') + '</span>';
                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    DRAG_HANDLE_HTML +
                    titleHtml +
                    entryTipIconHtml(rule) +
                    moveButtonsHtml(idx === 0, idx === cfg.rules.length - 1) +
                    '<span class="wo-kebab-wrap" onclick="event.stopPropagation()">' +
                    '<button data-kebab type="button" class="wo-kebab-btn" aria-label="Rule actions" aria-haspopup="true">' +
                    // Drawn as thick-stroked circles (stroke-width roughly
                    // 2x the radius, so the ring fully covers the center)
                    // rather than filled ones — confirmed in a browser that
                    // Chromium has a real bug where an SVG `fill` cascade
                    // override doesn't repaint correctly against a
                    // competing host-page rule, even though its own
                    // getComputedStyle reports the right value; `stroke`
                    // doesn't have this problem.
                    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
                    '</button>' +
                    '</span>' +
                    '</div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<div style="margin-bottom:2px;font-size:11px;">Insert field: <select data-i style="max-width:65%;"><option value="">--</option>' + fo + '</select></div>' +
                    formulaBox(rule, 'formula') +
                    '<div data-msg-sections></div>' +
                    '<div style="margin-top:9px;display:flex;align-items:center;gap:9px;"><button data-t type="button" class="wo-btn">Test</button> <span data-r class="wo-mono" style="font-size:10.5px;"></span></div>' +
                    '<div style="margin-top:7px;color:var(--wo-muted);font-size:10px;line-height:1.5;">Available: F(field) T(table) rowCount(t) col(t,n) has(t,c,v) hours(str) hoursBetween(a,b) oneOf(v,arr) contains(t,p) matches(t,p) isEmpty(v) notEmpty(v) <b>maxLaborHours(tableTitle,nameCol,hoursCol)</b></div>' +
                    '</div>';


                content.appendChild(box);
                makeCollapsible(box, rule.label, !ruleExpandState[rule.id], function(expandedNow) {
                    ruleExpandState[rule.id] = expandedNow;
                });
                wireEntryTipIcon(box, rule);
                attachTooltip(box.querySelector('[data-kebab]'), 'More actions');

                var msgWrap = box.querySelector('[data-msg-sections]');
                msgWrap.appendChild(msgSection(rule, 'pass', '✓ Pass', '#3fb950', false));
                msgWrap.appendChild(msgSection(rule, 'fail', '✗ Fail — must be fixed', '#f85149', true));
                msgWrap.appendChild(msgSection(rule, 'warn', '⚠ Warn — needs reviewer confirmation', '#d29922', true));

                wireMoveButtons(box, cfg.rules, idx, rulesTab);
                attachCardDrag(box.querySelector('[data-coll-header]'), box, content, cfg.rules, idx, rulesTab);

                var fa = box.querySelector('[data-f]');
                var titleInput = box.querySelector('[data-l]');
                if (titleInput) {
                    titleInput.oninput = function(e) {
                        rule.label = e.target.value;
                    };
                    titleInput.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            titleInput.blur();
                        }
                    });
                    titleInput.addEventListener('blur', function() {
                        renamingRuleId = null;
                        rulesTab();
                    });
                    titleInput.focus();
                    titleInput.select();
                }
                fa.oninput = function() {
                    rule.formula = fa.value;
                };
                attachFormulaAssist(fa);

                box.querySelector('[data-i]').onchange = function(e) {
                    if (!e.target.value) return;
                    var sn = "F('" + e.target.value.replace(/'/g, "\\'") + "')";
                    var p = fa.selectionStart || fa.value.length;
                    fa.value = fa.value.slice(0, p) + sn + fa.value.slice(p);
                    rule.formula = fa.value;
                    e.target.value = '';
                };
                var kebabBtn = box.querySelector('[data-kebab]');
                kebabBtn.onclick = function() {
                    var wasOpen = !!openRuleMenu;
                    closeRuleMenu();
                    if (wasOpen) return;
                    var menu = document.createElement('div');
                    menu.className = 'wo-kebab-menu';
                    menu.innerHTML =
                        '<button data-rename type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.5L13.5 5L5.5 13H3V10.5L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Rename</span>' +
                        '</button>' +
                        '<button data-dup type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/></svg>' +
                        '<span>Duplicate</span>' +
                        '</button>' +
                        editTooltipKebabHtml(rule) +
                        '<button data-del type="button" class="wo-kebab-item wo-kebab-item-danger">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.5V3.2C6 2.8 6.3 2.5 6.7 2.5H9.3C9.7 2.5 10 2.8 10 3.2V4.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5L5 12.7C5 13.1 5.4 13.5 5.8 13.5H10.2C10.6 13.5 11 13.1 11 12.7L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Delete</span>' +
                        '</button>';
                    menu.style.position = 'fixed';
                    var btnRect = kebabBtn.getBoundingClientRect();
                    menu.style.top = (btnRect.bottom + 4) + 'px';
                    menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                    modal.appendChild(menu);
                    var mr = menu.getBoundingClientRect();
                    if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';
                    wireEditTooltipKebabItem(menu, rule, rule.label, rulesTab);
                    menu.querySelector('[data-rename]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        renamingRuleId = rule.id;
                        rulesTab();
                    };
                    menu.querySelector('[data-dup]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var copy = JSON.parse(JSON.stringify(rule));
                        copy.id = 'r_' + Date.now();
                        copy.label = rule.label + ' (copy)';
                        cfg.rules.splice(idx + 1, 0, copy);
                        rulesTab();
                    };
                    menu.querySelector('[data-del]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Delete rule "' + rule.label + '"?').then(function(ok) {
                            if (!ok) return;
                            cfg.rules.splice(idx, 1);
                            rulesTab();
                        });
                    };
                    openRuleMenu = menu;
                };
                box.querySelector('[data-t]').onclick = function() {
                    var res = runFormula(fa.value, cache);
                    var sp = box.querySelector('[data-r]');
                    sp.style.color = statusColor(res.status);

                    var statusText = res.status.toUpperCase();
                    var detail = '';

                    if (res.status === 'pass') {
                        var passLongT = resolveMsgList(rule.pass.long, cache);
                        detail = (rule.pass.short ? 'Header: "' + resolveMsg(rule.pass.short, cache) + '"' : 'Header: ✓ OK') +
                            (passLongT.length ? ' | Long: "' + passLongT.join(' / ') + '"' : '');
                    } else if (res.status === 'warn') {
                        var warnLongT = resolveMsgList(rule.warn.long, cache);
                        var shortWarnResolved = rule.warn.short ? resolveMsg(rule.warn.short, cache) : '';
                        detail = 'Header: "' + (shortWarnResolved || (warnLongT[0] ? '⚠ ' + warnLongT[0] : '⚠ Warning')) + '"' +
                            (warnLongT.length ? ' | Long: "' + warnLongT.join(' / ') + '"' : '');
                    } else if (res.status === 'fail') {
                        var failLongT = resolveMsgList(rule.fail.long, cache);
                        var shortFailResolved = rule.fail.short ? resolveMsg(rule.fail.short, cache) : '';
                        detail = 'Header: "' + (shortFailResolved || (failLongT[0] ? '✗ ' + failLongT[0] : '✗ Failed')) + '"' +
                            (failLongT.length ? ' | Long: "' + failLongT.join(' / ') + '"' : '');
                    } else if (res.status === 'na') {
                        detail = 'Not applicable';
                    } else {
                        detail = res.detail;
                    }

                    sp.textContent = statusText + ' — ' + detail;
                };

            });
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'wo-btn wo-btn-primary';
            b.textContent = '+ Add Rule';
            b.onclick = function() {
                cfg.rules.push({
                    id: 'r_' + Date.now(),
                    label: 'New Rule',
                    formula: 'return true;',
                    pass: {
                        short: '',
                        long: []
                    },
                    fail: {
                        short: '',
                        long: [],
                        returnMode: 'none',
                        returnCustom: ''
                    },
                    warn: {
                        short: '',
                        long: [],
                        returnMode: 'none',
                        returnCustom: ''
                    }
                });
                rulesTab();
            };
            content.appendChild(b);
        }

        // ── GROUPS TAB ──
        function groupsTab() {
            content.innerHTML = '';
            var gs = getGS();
            // The main panel already lets users drag-reorder group tiles,
            // persisted separately as gs.__order (see orderedGroups()) rather
            // than in cfg.groups itself. This tab must display and reorder
            // in that same visual order — not cfg.groups' raw array order —
            // or "Groups tab order" and "main panel order" would silently
            // diverge the moment either one has ever been reordered.
            var orderedGrps = orderedGroups(cfg);
            orderedGrps.forEach(function(group, idx) {
                var realIdx = cfg.groups.indexOf(group);
                var vis = gs[group.id] ? gs[group.id].visible !== false : true;
                var box = document.createElement('div');
                box.className = 'wo-card';
                var fc = opts.fields.map(function(f) {
                    return '<label style="display:block;"><input type="checkbox" data-fd="' + f.replace(/"/g, '&quot;') + '" ' + (group.fields.indexOf(f) >= 0 ? 'checked' : '') + '>' + f + '</label>';
                }).join('');
                // Reads through groupTables() (not group.table/group.tables
                // directly) so a group still on the old single-table shape
                // shows its current selection correctly the first time this
                // tab is opened, before any edit has migrated it forward.
                var selectedTables = groupTables(group);
                var to = opts.tables.length ? opts.tables.map(function(t) {
                    var friendly = friendlyTableName(cfg, t);
                    var friendlyEsc = friendly.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return '<label style="display:block;"><input type="checkbox" data-tb="' + t.replace(/"/g, '&quot;') + '" ' + (selectedTables.indexOf(t) >= 0 ? 'checked' : '') + '>' + friendlyEsc + (friendly !== t ? ' (' + t + ')' : '') + '</label>';
                }).join('') : '<div style="color:var(--wo-muted);font-size:11px;">No tables available yet — scan once, or add one in the Tables tab.</div>';
                var rc = cfg.rules.map(function(r) {
                    return '<label style="display:block;"><input type="checkbox" data-rl="' + r.id + '" ' + ((group.ruleRefs || []).indexOf(r.id) >= 0 ? 'checked' : '') + '>' + r.label + '</label>';
                }).join('');

                // Build row layout editor
                var rowsConfig = group.fieldRows || [];
                // flatten group.fields into rows if no rowsConfig exists
                if (!rowsConfig.length && group.fields.length) {
                    rowsConfig = group.fields.map(function(f) {
                        return [f];
                    });
                    group.fieldRows = rowsConfig;
                }

                var isRenaming = renamingGroupId === group.id;
                var titleHtml = isRenaming ?
                    '<input type="text" value="' + group.title.replace(/"/g, '&quot;') + '" data-ti class="wo-rule-title-input" onclick="event.stopPropagation()">' :
                    '<span class="wo-rule-title">' + String(group.title).replace(/</g, '&lt;') + '</span>';
                // Same eye path as the main panel's "Hide this group" — plus
                // the diagonal slash only when currently hidden, so the two
                // states share one glyph instead of two unrelated icons.
                var EYE_PATH = '<path d="M1.5 8.4C3 5.6 5.4 3.6 8 3.6C10.6 3.6 13 5.6 14.5 8.4C13 11.2 10.6 13.2 8 13.2C5.4 13.2 3 11.2 1.5 8.4Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8.4" r="1.9" stroke="currentColor" stroke-width="1.3"/>';
                var visIconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + EYE_PATH + (vis ? '' : '<path d="M2.5 2.5L13.5 14.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>') + '</svg>';

                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    DRAG_HANDLE_HTML +
                    titleHtml +
                    entryTipIconHtml(group) +
                    moveButtonsHtml(idx === 0, idx === orderedGrps.length - 1) +
                    '<button data-vis type="button" class="wo-btn-ghost wo-vis-btn' + (vis ? '' : ' is-hidden') + '" aria-label="' + (vis ? 'Hide this group' : 'Show this group') + '" onclick="event.stopPropagation()">' + visIconSvg + '</button>' +
                    '<span class="wo-kebab-wrap" onclick="event.stopPropagation()">' +
                    '<button data-kebab type="button" class="wo-kebab-btn" aria-label="Group actions" aria-haspopup="true">' +
                    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
                    '</button>' +
                    '</span>' +
                    '</div>' +
                    '<div data-coll-body>' +
                    '<div style="margin-top:4px;"><label>Tooltip:</label><br><input type="text" data-tt value="' + (group.tooltip || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;"></div>' +
                    '<div style="margin-top:4px;"><label>Expanded Message:</label><br><textarea data-em style="width:100%;height:44px;margin-top:2px;color:var(--wo-accent);">' + (group.expandedMsg || '').replace(/</g, '&lt;') + '</textarea></div>' +
                    '<div style="margin-top:6px;"><label><input type="checkbox" data-c ' + (group.defaultCollapsed ? 'checked' : '') + '> Collapsed by default</label></div>' +
                    '<div style="margin-top:6px;max-height:90px;overflow:auto;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:4px;"><b>Tables:</b>' + to + '</div>' +
                    '<div style="margin-top:6px;" id="__roweditor_' + idx + '"><b>Field Rows</b> <button data-addrow type="button" class="wo-btn-ghost" style="margin-left:6px;">+ Add Row</button><div data-rowlist style="margin-top:4px;"></div></div>' +
                    '<div style="margin-top:6px;max-height:90px;overflow:auto;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:4px;"><b>Rules:</b>' + rc + '</div>' +
                    '<div class="wo-subbox" style="margin-top:8px;" id="__hm_block_' + idx + '">' +
                    '<label style="display:flex;align-items:center;gap:6px;font-size:11px;"><input type="checkbox" id="__hm_en_' + idx + '" ' + (group.headerMsg && group.headerMsg.enabled ? 'checked' : '') + '><b>Show inline header message</b></label>' +
                    '<div id="__hm_opts_' + idx + '" style="margin-top:6px;' + (group.headerMsg && group.headerMsg.enabled ? '' : 'display:none;') + '">' +
                    '<div style="margin-bottom:4px;">Type: ' +
                    '<select id="__hm_type_' + idx + '">' +
                    '<option value="field"' + (group.headerMsg && group.headerMsg.type === 'field' ? ' selected' : '') + '>Field value</option>' +
                    '<option value="rule"' + (group.headerMsg && group.headerMsg.type === 'rule' ? ' selected' : '') + '>Rule pass/fail message</option>' +
                    '<option value="variable"' + (group.headerMsg && group.headerMsg.type === 'variable' ? ' selected' : '') + '>Variable value</option>' +
                    '</select></div>' +
                    '<div id="__hm_field_wrap_' + idx + '" style="' + (group.headerMsg && (group.headerMsg.type === 'rule' || group.headerMsg.type === 'variable') ? 'display:none;' : '') + '">' +
                    'Field: <select id="__hm_field_' + idx + '" style="max-width:100%;">' +
                    '<option value="">-- pick field --</option>' +
                    opts.fields.map(function(f) {
                        return '<option value="' + f.replace(/"/g, '&quot;') + '"' + (group.headerMsg && group.headerMsg.value === f ? ' selected' : '') + '>' + f + '</option>';
                    }).join('') +
                    '</select></div>' +
                    '<div id="__hm_rule_wrap_' + idx + '" style="' + (group.headerMsg && group.headerMsg.type === 'rule' ? '' : 'display:none;') + '">' +
                    'Rule: <select id="__hm_rule_' + idx + '" style="max-width:100%;">' +
                    '<option value="">Auto — highest-priority rule in this group (error &gt; fail &gt; warn &gt; pass)</option>' +
                    cfg.rules.map(function(r) {
                        return '<option value="' + r.id + '"' + (group.headerMsg && group.headerMsg.value === r.id ? ' selected' : '') + '>' + r.label + '</option>';
                    }).join('') +
                    '</select>' +
                    '<div style="margin-top:4px;"><label style="font-size:10px;">Short pass message (leave blank to use rule\'s Pass Message):</label><br>' +
                    '<input type="text" id="__hm_short_pass_' + idx + '" value="' + ((group.headerMsg && group.headerMsg.shortPassMsg) ? group.headerMsg.shortPassMsg.replace(/"/g, '&quot;') : '') + '" style="width:100%;margin-top:2px;"></div>' +
                    '<div style="margin-top:4px;"><label style="font-size:10px;">Short fail message (leave blank to use rule\'s Fail Messages):</label><br>' +
                    '<input type="text" id="__hm_short_fail_' + idx + '" value="' + ((group.headerMsg && group.headerMsg.shortFailMsg) ? group.headerMsg.shortFailMsg.replace(/"/g, '&quot;') : '') + '" style="width:100%;margin-top:2px;"></div>' +
                    '</div>' +
                    '<div id="__hm_var_wrap_' + idx + '" style="' + (group.headerMsg && group.headerMsg.type === 'variable' ? '' : 'display:none;') + '">' +
                    'Variable: <select id="__hm_var_' + idx + '" style="color:var(--wo-accent);max-width:100%;">' +
                    '<option value="">-- pick variable --</option>' +
                    getVars().map(function(v) {
                        return '<option value="' + v.id + '"' + (group.headerMsg && group.headerMsg.value === v.id ? ' selected' : '') + '>' + v.label + '</option>';
                    }).join('') +
                    '</select></div>' +
                    '</div>' +
                    '</div>' +
                    '</div>';



                content.appendChild(box);
                makeCollapsible(box, group.title, !groupExpandState[group.id], function(expandedNow) {
                    groupExpandState[group.id] = expandedNow;
                });
                wireEntryTipIcon(box, group);
                attachTooltip(box.querySelector('[data-kebab]'), 'More actions');

                // Swaps within the visual (gs.__order) order, not cfg.groups'
                // raw array order — mirrors the main panel's own drag-drop
                // reorder handler so both stay in sync.
                (function() {
                    var upBtn = box.querySelector('[data-mv-up]');
                    var dnBtn = box.querySelector('[data-mv-dn]');
                    if (upBtn) attachTooltip(upBtn, upBtn.getAttribute('aria-label'));
                    if (dnBtn) attachTooltip(dnBtn, dnBtn.getAttribute('aria-label'));
                    function swapOrder(lowIdx, highIdx) {
                        var ids = orderedGrps.map(function(g) {
                            return g.id;
                        });
                        var tmp = ids[lowIdx];
                        ids[lowIdx] = ids[highIdx];
                        ids[highIdx] = tmp;
                        var g2 = getGS();
                        g2.__order = ids;
                        saveGS(g2);
                        animateSwap(content, lowIdx, highIdx, groupsTab);
                    }
                    if (upBtn) upBtn.onclick = function() {
                        if (idx === 0) return;
                        swapOrder(idx - 1, idx);
                    };
                    if (dnBtn) dnBtn.onclick = function() {
                        if (idx === orderedGrps.length - 1) return;
                        swapOrder(idx, idx + 1);
                    };
                })();

                // attachCardDrag splices orderedGrps in place before calling
                // this callback, so reading it back out here to build the
                // new gs.__order picks up the already-reordered result.
                attachCardDrag(box.querySelector('[data-coll-header]'), box, content, orderedGrps, idx, function() {
                    var ids = orderedGrps.map(function(g) {
                        return g.id;
                    });
                    var g2 = getGS();
                    g2.__order = ids;
                    saveGS(g2);
                    groupsTab();
                });

                var titleInput = box.querySelector('[data-ti]');
                if (titleInput) {
                    titleInput.oninput = function(e) {
                        group.title = e.target.value;
                    };
                    titleInput.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            titleInput.blur();
                        }
                    });
                    titleInput.addEventListener('blur', function() {
                        renamingGroupId = null;
                        groupsTab();
                    });
                    titleInput.focus();
                    titleInput.select();
                }

                var visBtn = box.querySelector('[data-vis]');
                attachTooltip(visBtn, vis ? 'Hide this group' : 'Show this group');
                visBtn.onclick = function(e) {
                    // Assigning .onclick here replaces the inline
                    // onclick="event.stopPropagation()" from the markup
                    // above, so it has to be redone explicitly — otherwise
                    // this click bubbles to the header's own collapse
                    // toggle unconditionally, double-toggling the unhide
                    // case below and wrongly toggling the hide case.
                    e.stopPropagation();
                    var g2 = getGS();
                    if (!g2[group.id]) g2[group.id] = {};
                    var newVis = !vis;
                    g2[group.id].visible = newVis;
                    saveGS(g2);
                    // Hiding also collapses the entry — showing leaves
                    // whatever expand state it already had rather than
                    // forcing it open.
                    if (!newVis) groupExpandState[group.id] = false;
                    groupsTab();
                };

                var kebabBtn = box.querySelector('[data-kebab]');
                kebabBtn.onclick = function() {
                    var wasOpen = !!openRuleMenu;
                    closeRuleMenu();
                    if (wasOpen) return;
                    var menu = document.createElement('div');
                    menu.className = 'wo-kebab-menu';
                    menu.innerHTML =
                        '<button data-rename type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.5L13.5 5L5.5 13H3V10.5L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Rename</span>' +
                        '</button>' +
                        '<button data-dup type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/></svg>' +
                        '<span>Duplicate</span>' +
                        '</button>' +
                        editTooltipKebabHtml(group) +
                        '<button data-del type="button" class="wo-kebab-item wo-kebab-item-danger">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.5V3.2C6 2.8 6.3 2.5 6.7 2.5H9.3C9.7 2.5 10 2.8 10 3.2V4.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5L5 12.7C5 13.1 5.4 13.5 5.8 13.5H10.2C10.6 13.5 11 13.1 11 12.7L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Delete</span>' +
                        '</button>';
                    menu.style.position = 'fixed';
                    var btnRect = kebabBtn.getBoundingClientRect();
                    menu.style.top = (btnRect.bottom + 4) + 'px';
                    menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                    modal.appendChild(menu);
                    var mr = menu.getBoundingClientRect();
                    if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';
                    // Groups already have an inline "Tooltip:" field in the
                    // card body (predates this feature, also feeds the main
                    // panel's group-header hover icon) — this kebab item is
                    // just a second path to the same group.tooltip, kept for
                    // menu consistency with Rules/Variables/Scan.
                    wireEditTooltipKebabItem(menu, group, group.title, groupsTab);
                    menu.querySelector('[data-rename]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        renamingGroupId = group.id;
                        groupsTab();
                    };
                    menu.querySelector('[data-dup]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var copy = JSON.parse(JSON.stringify(group));
                        copy.id = 'g_' + Date.now();
                        copy.title = group.title + ' (copy)';
                        cfg.groups.splice(realIdx + 1, 0, copy);
                        // Place the copy right after the original in the
                        // visual order too, instead of letting it fall back
                        // to the end (orderedGroups() appends any id it
                        // doesn't recognize yet).
                        var g2 = getGS();
                        var ids = orderedGroups(cfg).map(function(g) {
                            return g.id;
                        });
                        var pos = ids.indexOf(group.id);
                        ids.splice(pos + 1, 0, copy.id);
                        g2.__order = ids;
                        saveGS(g2);
                        groupsTab();
                    };
                    menu.querySelector('[data-del]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Delete group "' + group.title + '"?').then(function(ok) {
                            if (!ok) return;
                            cfg.groups.splice(realIdx, 1);
                            groupsTab();
                        });
                    };
                    openRuleMenu = menu;
                };

                // ── header message controls ──
                (function(grp, i) {
                    var enCb = box.querySelector('#__hm_en_' + i);
                    var opts2 = box.querySelector('#__hm_opts_' + i);
                    var typeSel = box.querySelector('#__hm_type_' + i);
                    var fWrap = box.querySelector('#__hm_field_wrap_' + i);
                    var rWrap = box.querySelector('#__hm_rule_wrap_' + i);
                    var fSel = box.querySelector('#__hm_field_' + i);
                    var rSel = box.querySelector('#__hm_rule_' + i);
                    var spInp = box.querySelector('#__hm_short_pass_' + i);
                    var sfInp = box.querySelector('#__hm_short_fail_' + i);
                    var vWrap = box.querySelector('#__hm_var_wrap_' + i);
                    var vSel = box.querySelector('#__hm_var_' + i);


                    function syncHM() {
                        if (!grp.headerMsg) grp.headerMsg = {};
                        grp.headerMsg.enabled = enCb.checked;
                        grp.headerMsg.type = typeSel.value;
                        grp.headerMsg.value = typeSel.value === 'rule' ? rSel.value :
                            typeSel.value === 'variable' ? (vSel ? vSel.value : '') :
                            fSel.value;
                        grp.headerMsg.shortPassMsg = spInp ? spInp.value : '';
                        grp.headerMsg.shortFailMsg = sfInp ? sfInp.value : '';
                    }

                    // update typeSel.onchange to also toggle vWrap:
                    typeSel.onchange = function() {
                        fWrap.style.display = typeSel.value === 'field' ? '' : 'none';
                        rWrap.style.display = typeSel.value === 'rule' ? '' : 'none';
                        if (vWrap) vWrap.style.display = typeSel.value === 'variable' ? '' : 'none';
                        syncHM();
                    };
                    if (vSel) vSel.onchange = syncHM;
                    if (fSel) fSel.onchange = syncHM;
                    if (rSel) rSel.onchange = syncHM;
                    if (spInp) spInp.oninput = syncHM;
                    if (sfInp) sfInp.oninput = syncHM;
                    enCb.onchange = function() {
                        opts2.style.display = enCb.checked ? '' : 'none';
                        syncHM();
                    };
                })(group, idx);

                // render field rows
                function renderRows() {
                    var rl = box.querySelector('[data-rowlist]');
                    rl.innerHTML = '';
                    (group.fieldRows || []).forEach(function(row, ri) {
                        var rd = document.createElement('div');
                        rd.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;flex-wrap:nowrap;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);padding:4px;background:var(--wo-field);';
                        // each field cell
                        row.forEach(function(fk, fi) {
                            var cell = document.createElement('div');
                            cell.style.cssText = 'display:flex;align-items:center;gap:2px;flex:1 1 0;min-width:0;';
                            var sel = document.createElement('select');
                            sel.style.cssText = 'flex:1;min-width:0;font-size:11px;';
                            var varOpts = getVars().map(function(v) {
                                return '<option value="' + v.id.replace(/"/g, '&quot;') + '"' + (v.id === fk ? ' selected' : '') + '>⚙ ' + v.label.replace(/</g, '&lt;') + '</option>';
                            }).join('');
                            var optHtml = '<option value="">-- remove --</option>' +
                                opts.fields.map(function(f) {
                                    return '<option value="' + f.replace(/"/g, '&quot;') + '"' + (f === fk ? ' selected' : '') + '>' + f + '</option>';
                                }).join('') +
                                (varOpts ? '<optgroup label="\u2500\u2500 Variables \u2500\u2500">' + varOpts + '</optgroup>' : '');

                            sel.innerHTML = optHtml;
                            sel.onchange = function() {
                                if (!sel.value) {
                                    row.splice(fi, 1);
                                } else {
                                    row[fi] = sel.value;
                                }
                                group.fields = [].concat.apply([], group.fieldRows);
                                renderRows();
                            };

                            // width % input
                            var widthStore = group.fieldRowWidths || (group.fieldRowWidths = {});
                            var key = ri + '_' + fi;
                            var wInp = document.createElement('input');
                            wInp.type = 'number';
                            wInp.min = '5';
                            wInp.max = '100';
                            wInp.style.cssText = 'width:42px;font-size:10px;padding:1px 3px;';
                            wInp.title = '% width (leave blank for auto)';
                            wInp.placeholder = 'auto';
                            wInp.value = widthStore[key] !== undefined ? widthStore[key] : '';
                            wInp.oninput = function() {
                                var v = parseInt(wInp.value, 10);
                                widthStore[key] = isNaN(v) ? '' : v;
                            };
                            cell.appendChild(sel);
                            cell.appendChild(wInp);
                            rd.appendChild(cell);
                        });
                        var addBtn = document.createElement('button');
                        addBtn.type = 'button';
                        addBtn.textContent = '+';
                        addBtn.className = 'wo-btn-ghost';
                        addBtn.style.cssText = 'font-size:12px;flex-shrink:0;padding:3px 7px;';
                        attachTooltip(addBtn, 'Add field');
                        addBtn.onclick = function() {
                            row.push(opts.fields[0] || '');
                            group.fields = [].concat.apply([], group.fieldRows);
                            renderRows();
                        };
                        var delBtn = document.createElement('button');
                        delBtn.type = 'button';
                        delBtn.innerHTML = TRASH_SVG;
                        delBtn.className = 'wo-btn-ghost wo-kebab-item-danger';
                        delBtn.style.cssText = 'flex-shrink:0;padding:3px 7px;';
                        attachTooltip(delBtn, 'Delete row');
                        delBtn.onclick = function() {
                            group.fieldRows.splice(ri, 1);
                            group.fields = [].concat.apply([], group.fieldRows);
                            renderRows();
                        };
                        rd.appendChild(addBtn);
                        rd.appendChild(delBtn);
                        rl.appendChild(rd);
                    });
                }

                renderRows();
                box.querySelector('[data-addrow]').onclick = function() {
                    if (!group.fieldRows) group.fieldRows = [];
                    group.fieldRows.push([opts.fields[0] || '']);
                    group.fields = [].concat.apply([], group.fieldRows);
                    renderRows();
                };

                box.querySelector('[data-c]').onchange = function(e) {
                    group.defaultCollapsed = e.target.checked;
                };
                box.querySelectorAll('[data-tb]').forEach(function(cb) {
                    cb.onchange = function() {
                        // First edit here migrates this group onto the new
                        // shape for good — groupTables() prefers .tables
                        // whenever it's an array, so once this exists the
                        // legacy .table field is never read again (left in
                        // place, just dead - see groupTables()'s own note on
                        // why nothing here deletes it).
                        var current = groupTables(group);
                        var t = cb.getAttribute('data-tb');
                        if (cb.checked && current.indexOf(t) < 0) current = current.concat([t]);
                        else if (!cb.checked) current = current.filter(function(x) {
                            return x !== t;
                        });
                        group.tables = current;
                    };
                });
                box.querySelector('[data-tt]').oninput = function(e) {
                    group.tooltip = e.target.value || undefined;
                };
                box.querySelector('[data-em]').oninput = function(e) {
                    group.expandedMsg = e.target.value || undefined;
                };
                box.querySelectorAll('[data-rl]').forEach(function(cb) {
                    cb.onchange = function() {
                        var r = cb.getAttribute('data-rl');
                        if (!group.ruleRefs) group.ruleRefs = [];
                        var i = group.ruleRefs.indexOf(r);
                        if (cb.checked && i < 0) group.ruleRefs.push(r);
                        if (!cb.checked && i >= 0) group.ruleRefs.splice(i, 1);
                    };
                });
            });
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = '+ Add Group';
            b.className = 'wo-btn wo-btn-primary';
            b.onclick = function() {
                cfg.groups.push({
                    id: 'g_' + Date.now(),
                    title: 'New Group',
                    layout: 'vertical',
                    fields: [],
                    fieldRows: [],
                    table: null,
                    ruleRefs: [],
                    defaultCollapsed: false
                });
                groupsTab();
            };
            content.appendChild(b);

            // Add new field picker (fields not in any group)
            var addFieldDiv = document.createElement('div');
            addFieldDiv.className = 'wo-subbox';
            addFieldDiv.style.cssText = 'margin-top:12px;';
            addFieldDiv.innerHTML = '<b style="color:var(--wo-muted);">Add a field not yet in any group:</b><br>' +
                '<select id="__new_field_pick" style="margin-top:4px;width:70%;">' +
                '<option value="">-- pick field --</option>' +
                opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('') +
                '</select> into group: <select id="__new_field_grp">' +
                '<option value="">--</option>' +
                cfg.groups.map(function(g, gi) {
                    return '<option value="' + gi + '">' + g.title + '</option>';
                }).join('') +
                '</select> <button id="__new_field_add" type="button" class="wo-btn-ghost">Add</button>';
            content.appendChild(addFieldDiv);
            // Pick from page button
            var pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.textContent = '🔍 Browse Page Fields';
            pickBtn.className = 'wo-btn';
            pickBtn.style.cssText = 'margin-top:8px;';
            pickBtn.onclick = function() {
                openFieldBrowser(cfg, opts, function(added) {
                    if (added.length) groupsTab();
                });
            };
            content.appendChild(pickBtn);


            content.querySelector('#__new_field_add').onclick = function() {
                var f = content.querySelector('#__new_field_pick').value;
                var gi = parseInt(content.querySelector('#__new_field_grp').value, 10);
                if (!f || isNaN(gi)) return;
                var grp = cfg.groups[gi];
                if (grp.fields.indexOf(f) < 0) {
                    grp.fields.push(f);
                    if (!grp.fieldRows) grp.fieldRows = [];
                    grp.fieldRows.push([f]);
                }
                groupsTab();
            };
        }

        // ── SCAN TAB ──
        function scanTab() {
            content.innerHTML = '<div style="margin-bottom:10px;font-size:11px;">WO Tab ID: <input type="text" data-wt value="' + scan.woTabId + '"> <span style="color:var(--wo-muted);">(tab returned to after scan)</span>' +
                '<div style="margin-top:8px;font-weight:700;color:var(--wo-text);">Scan Order</div>' +
                '</div>';
            content.querySelector('[data-wt]').oninput = function(e) {
                scan.woTabId = e.target.value;
            };
            scan.scans.forEach(function(s, idx) {
                var box = document.createElement('div');
                box.className = 'wo-card';
                var isRenaming = renamingScanId === s.id;
                var titleHtml = isRenaming ?
                    '<input type="text" value="' + s.title.replace(/"/g, '&quot;') + '" data-l class="wo-rule-title-input" onclick="event.stopPropagation()">' :
                    '<span class="wo-rule-title">' + String(s.title).replace(/</g, '&lt;') + '</span>';
                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    DRAG_HANDLE_HTML +
                    titleHtml +
                    entryTipIconHtml(s) +
                    moveButtonsHtml(idx === 0, idx === scan.scans.length - 1) +
                    '<span class="wo-kebab-wrap" onclick="event.stopPropagation()">' +
                    '<button data-kebab type="button" class="wo-kebab-btn" aria-label="Scan target actions" aria-haspopup="true">' +
                    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
                    '</button>' +
                    '</span>' +
                    '</div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<div style="margin-bottom:8px;font-size:11px;">Type: <select data-ty><option value="tab" ' + (s.type === 'tab' ? 'selected' : '') + '>Tab</option><option value="dialog" ' + (s.type === 'dialog' ? 'selected' : '') + '>Dialog</option></select></div>' +
                    '<div style="margin-bottom:4px;"><label style="color:var(--wo-muted);font-size:10px;">Tab ID / Event</label><br><input type="text" data-id value="' + (s.tabId || s.eventType || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;"></div>' +
                    '<div style="display:flex;gap:10px;margin-bottom:8px;">' +
                    '<div style="flex:1;min-width:0;"><label style="color:var(--wo-muted);font-size:10px;">Wait for text</label><br><input type="text" data-w value="' + String(s.waitFor).replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;"></div>' +
                    '<div style="flex:1;min-width:0;"><label style="color:var(--wo-muted);font-size:10px;">Wait for table</label><br><input type="text" data-wtb value="' + (s.waitTable || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;"></div>' +
                    '</div>' +
                    '<div style="margin-bottom:2px;color:var(--wo-muted);font-size:10px;">Condition (formula, true = scan this):</div>' +
                    formulaBox(s, 'condition') +
                    '</div>';

                // ── Row Detail Fields editor ──
                var rdfWrap = document.createElement('div');
                rdfWrap.className = 'wo-subbox-accent';
                rdfWrap.style.cssText = 'margin-top:9px;';
                rdfWrap.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><b style="color:var(--wo-accent);font-size:11px;">Row Detail Fields</b> ' +
                    '<span style="color:var(--wo-muted);font-size:10px;">(fields inside expanded row panels)</span>' +
                    '<button id="__rdf_add_' + idx + '" type="button" class="wo-btn-ghost" style="margin-left:auto;font-size:15px;line-height:1;padding:4px 10px;">+</button></div>' +
                    '<div id="__rdf_list_' + idx + '" style="margin-top:6px;overflow-x:auto;"></div>';
                box.querySelector('[data-coll-body]').appendChild(rdfWrap);
                attachTooltip(rdfWrap.querySelector('#__rdf_add_' + idx), 'Add field');
                // ── Actions editor ── beta_1-gated end to end (see runActions'
                // matching check) — untested alongside Fix, so both the editor
                // and execution stay dormant until the user opts in via the
                // Beta tab. Existing action rows are left in storage either way.
                var actionsBetaOn = isBetaFeatureOn('beta_1');
                var actWrap = document.createElement('div');
                actWrap.className = 'wo-subbox';
                actWrap.style.cssText = 'margin-top:9px;';
                if (!actionsBetaOn) {
                    actWrap.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><b style="color:var(--wo-pass);font-size:11px;">Post-Scan Actions</b> <span class="wo-beta-pill" data-beta-pill-tip="Beta feature">BETA</span></div>' +
                        '<div style="color:var(--wo-muted);font-size:10px;margin-top:6px;">Enable the "Fix" beta feature in the Beta tab to configure or run Post-Scan Actions' + ((s.actions && s.actions.length) ? ' — you have ' + s.actions.length + ' saved, left untouched.' : '.') + '</div>';
                    box.querySelector('[data-coll-body]').appendChild(actWrap);
                    actWrap.querySelectorAll('[data-beta-pill-tip]').forEach(function(el) {
                        attachTooltip(el, el.getAttribute('data-beta-pill-tip'));
                    });
                } else {
                    actWrap.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><b style="color:var(--wo-pass);font-size:11px;">Post-Scan Actions</b> ' +
                        '<span style="color:var(--wo-muted);font-size:10px;">(fill fields after this tab is scanned)</span>' +
                        '<span class="wo-beta-pill" data-beta-pill-tip="Beta feature">BETA</span>' +
                        '<button id="__act_add_' + idx + '" type="button" class="wo-btn-ghost" style="margin-left:auto;font-size:15px;line-height:1;padding:4px 10px;">+</button></div>' +
                        '<div id="__act_list_' + idx + '" style="margin-top:6px;overflow-x:auto;"></div>';
                    box.querySelector('[data-coll-body]').appendChild(actWrap);
                    attachTooltip(actWrap.querySelector('#__act_add_' + idx), 'Add action');
                    actWrap.querySelectorAll('[data-beta-pill-tip]').forEach(function(el) {
                        attachTooltip(el, el.getAttribute('data-beta-pill-tip'));
                    });

                    (function() {
                        function renderActList() {
                            var actList = actWrap.querySelector('#__act_list_' + idx);
                            var rows = s.actions || [];
                            if (!rows.length) {
                                actList.innerHTML = '<div style="color:var(--wo-muted);font-size:11px;padding:2px 0;">No actions yet.</div>';
                                return;
                            }
                            var showRunOn = isBetaFeatureOn('beta_1');
                            var html = '<table class="wo-edit-table"><thead><tr>' +
                                '<th style="width:18%;">' + thWithTip('Field Element ID', 'The Maximo element ID of the field to fill, e.g. m12345678-tb') + '</th>' +
                                '<th style="width:26%;">' + thWithTip('Value Expression', "What to put in the field — a variable (V('v_core')) or a formula (F('...'))") + '</th>' +
                                '<th>' + thWithTip('Condition', 'Optional formula — leave blank to always run this action') + '</th>' +
                                (showRunOn ? '<th style="width:15%;">' + thWithTip('Run on', 'Both Scan and Fix (default), Scan only, or Fix only') + ' <span class="wo-beta-pill" data-beta-pill-tip="Beta feature">BETA</span></th>' : '') +
                                '<th class="wo-edit-table-del"></th>' +
                                '</tr></thead><tbody>' +
                                rows.map(function(act) {
                                    return '<tr>' +
                                        '<td><input type="text" data-act-id value="' + (act.fieldId || '').replace(/"/g, '&quot;') + '" placeholder="e.g. m12345678-tb"></td>' +
                                        '<td><input type="text" data-act-val value="' + (act.value || '').replace(/"/g, '&quot;') + '"></td>' +
                                        '<td><input type="text" data-act-cond value="' + (act.condition || '').replace(/"/g, '&quot;') + '"></td>' +
                                        (showRunOn ? '<td><select data-act-runon>' +
                                            '<option value="both"' + (!act.runOn || act.runOn === 'both' ? ' selected' : '') + '>Scan + Fix</option>' +
                                            '<option value="scan"' + (act.runOn === 'scan' ? ' selected' : '') + '>Scan only</option>' +
                                            '<option value="fix"' + (act.runOn === 'fix' ? ' selected' : '') + '>Fix only</option>' +
                                            '</select></td>' : '') +
                                        '<td class="wo-edit-table-del"><button data-act-del type="button" class="wo-btn-ghost wo-kebab-item-danger" style="padding:2px;">' + TRASH_SVG + '</button></td>' +
                                        '</tr>';
                                }).join('') +
                                '</tbody></table>';
                            actList.innerHTML = html;
                            actList.querySelectorAll('[data-th-tip]').forEach(function(el) {
                                attachTooltip(el, el.getAttribute('data-th-tip'));
                            });
                            actList.querySelectorAll('[data-beta-pill-tip]').forEach(function(el) {
                                attachTooltip(el, el.getAttribute('data-beta-pill-tip'));
                            });
                            var trs = actList.querySelectorAll('tbody tr');
                            rows.forEach(function(act, ai) {
                                var row = trs[ai];
                                attachTooltip(row.querySelector('[data-act-del]'), 'Delete action');
                                row.querySelector('[data-act-id]').oninput = function(e) {
                                    act.fieldId = e.target.value;
                                };
                                row.querySelector('[data-act-val]').oninput = function(e) {
                                    act.value = e.target.value;
                                };
                                attachFormulaAssist(row.querySelector('[data-act-val]'));
                                row.querySelector('[data-act-cond]').oninput = function(e) {
                                    act.condition = e.target.value || undefined;
                                };
                                attachFormulaAssist(row.querySelector('[data-act-cond]'));
                                var runonSel = row.querySelector('[data-act-runon]');
                                if (runonSel) {
                                    runonSel.onchange = function(e) {
                                        act.runOn = e.target.value;
                                    };
                                }
                                row.querySelector('[data-act-del]').onclick = function() {
                                    s.actions.splice(ai, 1);
                                    renderActList();
                                };
                            });
                        }
                        renderActList();

                        actWrap.querySelector('#__act_add_' + idx).onclick = function() {
                            if (!s.actions) s.actions = [];
                            s.actions.push({
                                fieldId: '',
                                value: '',
                                condition: ''
                            });
                            renderActList();
                        };
                    })();
                }

                function renderRdfList() {
                    var rdfList = rdfWrap.querySelector('#__rdf_list_' + idx);
                    var rows = s.rowDetailFields || [];
                    if (!rows.length) {
                        rdfList.innerHTML = '<div style="color:var(--wo-muted);font-size:11px;padding:2px 0;">No fields yet.</div>';
                        return;
                    }
                    var html = '<table class="wo-edit-table"><thead><tr>' +
                        '<th style="width:14%;">' + thWithTip('Column Name', "The column header shown in this field's expanded row panel") + '</th>' +
                        '<th style="width:14%;">' + thWithTip('Element ID', 'The Maximo element ID this field reads from') + '</th>' +
                        '<th style="width:13%;">' + thWithTip('Table Prefix', 'The internal Maximo table prefix this field belongs to') + '</th>' +
                        '<th style="width:9%;">' + thWithTip('Expand Col', 'Which column (0-based) triggers the row-expand action') + '</th>' +
                        '<th>' + thWithTip('Collect Condition', 'Optional formula — leave blank to always collect this field') + '</th>' +
                        '<th class="wo-edit-table-del"></th>' +
                        '</tr></thead><tbody>' +
                        rows.map(function(rdf) {
                            return '<tr>' +
                                '<td><input type="text" data-rdf-col value="' + (rdf.columnName || '').replace(/"/g, '&quot;') + '"></td>' +
                                '<td><input type="text" data-rdf-id value="' + (rdf.elementId || '').replace(/"/g, '&quot;') + '"></td>' +
                                '<td><input type="text" data-rdf-prefix value="' + (rdf.tablePrefix || '').replace(/"/g, '&quot;') + '"></td>' +
                                '<td><input type="number" data-rdf-expcol value="' + (rdf.expandColIndex || 0) + '"></td>' +
                                '<td><textarea data-rdf-cond class="wo-code" style="height:34px;font-size:10px;">' + (rdf.collectCondition || '') + '</textarea></td>' +
                                '<td class="wo-edit-table-del"><button data-rdf-del type="button" class="wo-btn-ghost wo-kebab-item-danger" style="padding:2px;">' + TRASH_SVG + '</button></td>' +
                                '</tr>';
                        }).join('') +
                        '</tbody></table>';
                    rdfList.innerHTML = html;
                    rdfList.querySelectorAll('[data-th-tip]').forEach(function(el) {
                        attachTooltip(el, el.getAttribute('data-th-tip'));
                    });
                    var trs = rdfList.querySelectorAll('tbody tr');
                    rows.forEach(function(rdf, ri) {
                        var row = trs[ri];
                        attachTooltip(row.querySelector('[data-rdf-del]'), 'Delete field');
                        row.querySelector('[data-rdf-col]').oninput = function(e) {
                            rdf.columnName = e.target.value;
                        };
                        row.querySelector('[data-rdf-id]').oninput = function(e) {
                            rdf.elementId = e.target.value;
                        };
                        row.querySelector('[data-rdf-prefix]').oninput = function(e) {
                            rdf.tablePrefix = e.target.value;
                        };
                        row.querySelector('[data-rdf-expcol]').oninput = function(e) {
                            rdf.expandColIndex = parseInt(e.target.value, 10) || 0;
                        };
                        row.querySelector('[data-rdf-cond]').oninput = function(e) {
                            rdf.collectCondition = e.target.value || undefined;
                        };
                        attachFormulaAssist(row.querySelector('[data-rdf-cond]'));
                        row.querySelector('[data-rdf-del]').onclick = function() {
                            s.rowDetailFields.splice(ri, 1);
                            renderRdfList();
                        };
                    });
                }
                renderRdfList();

                rdfWrap.querySelector('#__rdf_add_' + idx).onclick = function() {
                    if (!s.rowDetailFields) s.rowDetailFields = [];
                    s.rowDetailFields.push({
                        label: 'New Field',
                        elementId: '',
                        columnName: 'New Column',
                        tablePrefix: 'm4dfd8aef',
                        expandColIndex: 0,
                        collectCondition: ''
                    });
                    renderRdfList();
                };

                content.appendChild(box);
                makeCollapsible(box, s.title, !scanExpandState[s.id], function(expandedNow) {
                    scanExpandState[s.id] = expandedNow;
                });
                wireEntryTipIcon(box, s);
                attachTooltip(box.querySelector('[data-kebab]'), 'More actions');
                wireMoveButtons(box, scan.scans, idx, scanTab);
                attachCardDrag(box.querySelector('[data-coll-header]'), box, content, scan.scans, idx, scanTab);

                var titleInput = box.querySelector('[data-l]');
                if (titleInput) {
                    titleInput.oninput = function(e) {
                        s.title = e.target.value;
                    };
                    titleInput.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            titleInput.blur();
                        }
                    });
                    titleInput.addEventListener('blur', function() {
                        renamingScanId = null;
                        scanTab();
                    });
                    titleInput.focus();
                    titleInput.select();
                }
                box.querySelector('[data-ty]').onchange = function(e) {
                    s.type = e.target.value;
                };
                box.querySelector('[data-id]').oninput = function(e) {
                    if (s.type === 'dialog') s.eventType = e.target.value;
                    else s.tabId = e.target.value;
                };
                box.querySelector('[data-w]').oninput = function(e) {
                    s.waitFor = e.target.value;
                };
                box.querySelector('[data-wtb]').oninput = function(e) {
                    s.waitTable = e.target.value || undefined;
                };
                box.querySelector('[data-f]').oninput = function(e) {
                    s.condition = e.target.value;
                };
                attachFormulaAssist(box.querySelector('[data-f]'));
                var kebabBtn = box.querySelector('[data-kebab]');
                kebabBtn.onclick = function() {
                    var wasOpen = !!openRuleMenu;
                    closeRuleMenu();
                    if (wasOpen) return;
                    var menu = document.createElement('div');
                    menu.className = 'wo-kebab-menu';
                    menu.innerHTML =
                        '<button data-rename type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 2.5L13.5 5L5.5 13H3V10.5L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Rename</span>' +
                        '</button>' +
                        '<button data-dup type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/></svg>' +
                        '<span>Duplicate</span>' +
                        '</button>' +
                        editTooltipKebabHtml(s) +
                        '<button data-del type="button" class="wo-kebab-item wo-kebab-item-danger">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5H13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4.5V3.2C6 2.8 6.3 2.5 6.7 2.5H9.3C9.7 2.5 10 2.8 10 3.2V4.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5L5 12.7C5 13.1 5.4 13.5 5.8 13.5H10.2C10.6 13.5 11 13.1 11 12.7L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
                        '<span>Delete</span>' +
                        '</button>';
                    menu.style.position = 'fixed';
                    var btnRect = kebabBtn.getBoundingClientRect();
                    menu.style.top = (btnRect.bottom + 4) + 'px';
                    menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                    modal.appendChild(menu);
                    var mr = menu.getBoundingClientRect();
                    if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';
                    wireEditTooltipKebabItem(menu, s, s.title, scanTab);
                    menu.querySelector('[data-rename]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        renamingScanId = s.id;
                        scanTab();
                    };
                    menu.querySelector('[data-dup]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var copy = JSON.parse(JSON.stringify(s));
                        copy.id = 's_' + Date.now();
                        copy.title = s.title + ' (copy)';
                        scan.scans.splice(idx + 1, 0, copy);
                        scanTab();
                    };
                    menu.querySelector('[data-del]').onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Delete scan step "' + s.title + '"?').then(function(ok) {
                            if (!ok) return;
                            scan.scans.splice(idx, 1);
                            scanTab();
                        });
                    };
                    openRuleMenu = menu;
                };
            });
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'wo-btn wo-btn-primary';
            b.textContent = '+ Add Scan Target';
            b.onclick = function() {
                scan.scans.push({
                    id: 's_' + Date.now(),
                    title: 'New Scan',
                    type: 'tab',
                    tabId: '',
                    waitFor: '',
                    condition: 'true'
                });
                scanTab();
            };
            content.appendChild(b);
        }

        // ── TABLES TAB ── Lists every table identifier referenced across
        // Groups/Scan/Row-Detail-Fields — both human titles (e.g. "Related
        // Work Orders", discovered live off the page) and raw internal
        // Maximo prefixes (e.g. "m69f3c12d", used when a table has no
        // discoverable header text, like a dialog grid) — and lets each be
        // given a friendly display name via cfg.tableNames. Purely a display
        // layer: renaming here never touches what's actually stored in
        // group.table / waitTable / tablePrefix, so nothing about how a
        // table is matched on the page changes — see friendlyTableName().
        function tablesTab() {
            content.innerHTML = '';
            if (!cfg.tableNames) cfg.tableNames = {};
            if (!cfg.customTables) cfg.customTables = {};

            // id -> { groups: [title...], scans: [title...] }
            var usage = {};
            function noteUsage(id, kind, label) {
                if (!id) return;
                if (!usage[id]) usage[id] = {
                    groups: [],
                    scans: []
                };
                usage[id][kind].push(label);
            }
            cfg.groups.forEach(function(g) {
                groupTables(g).forEach(function(t) {
                    noteUsage(t, 'groups', g.title);
                });
            });
            (scan.scans || []).forEach(function(s) {
                if (s.waitTable) noteUsage(s.waitTable, 'scans', s.title);
                (s.rowDetailFields || []).forEach(function(rdf) {
                    if (rdf.tablePrefix) noteUsage(rdf.tablePrefix, 'scans', s.title + ' (row detail)');
                });
            });

            var scannedIds = Object.keys(usage).sort();
            if (!scannedIds.length) {
                var emptyDiv = document.createElement('div');
                emptyDiv.style.cssText = 'color:var(--wo-muted);font-size:11px;margin-bottom:10px;';
                emptyDiv.textContent = 'No scanned tables referenced yet — set one in a Group\'s Table field or a Scan target\'s Wait for table option.';
                content.appendChild(emptyDiv);
            }

            scannedIds.forEach(function(id) {
                var u = usage[id];
                var box = document.createElement('div');
                box.className = 'wo-card';
                var usedInParts = [];
                if (u.groups.length) usedInParts.push('Groups: ' + u.groups.join(', '));
                if (u.scans.length) usedInParts.push('Scan: ' + u.scans.join(', '));
                var isKnownDefault = !cfg.tableNames[id] && KNOWN_TABLE_NAMES[id];
                var displayLabel = cfg.tableNames[id] || (isKnownDefault ? KNOWN_TABLE_NAMES[id] : id);
                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    '<code class="wo-mono" style="font-size:10.5px;">' + String(displayLabel).replace(/</g, '&lt;') + '</code>' +
                    '</div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<div>' +
                    '<label style="color:var(--wo-muted);font-size:11px;">Display name</label><br>' +
                    '<input type="text" data-name value="' + String(cfg.tableNames[id] || '').replace(/"/g, '&quot;') + '" placeholder="' + String(isKnownDefault ? KNOWN_TABLE_NAMES[id] : id).replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;">' +
                    '</div>' +
                    (usedInParts.length ? '<div style="margin-top:6px;color:var(--wo-muted);font-size:10px;">' + usedInParts.join(' · ') + '</div>' : '') +
                    '</div>';
                content.appendChild(box);
                makeCollapsible(box, displayLabel, !scannedTableExpandState[id], function(expandedNow) {
                    scannedTableExpandState[id] = expandedNow;
                });
                box.querySelector('[data-name]').oninput = function(e) {
                    var v = e.target.value.trim();
                    if (v) cfg.tableNames[id] = v;
                    else delete cfg.tableNames[id];
                };
            });

            // ── Custom tables — hand-entered lookup data, not scraped from
            // Maximo. Same T()/col()/has()/lookup() access as a scanned
            // table (see buildCtx's T() fallback), just sourced from config
            // instead of the DOM. The id is fixed at creation (it's what
            // formulas reference) - only columns/rows/values are editable
            // afterward, to avoid silently breaking a formula that already
            // references the id.
            var customHeader = document.createElement('div');
            customHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px;';
            customHeader.innerHTML = '<span class="wo-rule-title">Custom Tables</span>' +
                '<button type="button" id="__ct_add" class="wo-btn wo-btn-primary" style="font-size:11px;">+ Add Custom Table</button>';
            content.appendChild(customHeader);

            var customIds = Object.keys(cfg.customTables).sort();
            if (!customIds.length) {
                var emptyCustom = document.createElement('div');
                emptyCustom.style.cssText = 'color:var(--wo-muted);font-size:11px;';
                emptyCustom.textContent = 'None yet — use this for lookup data that doesn\'t come from a Maximo scan (e.g. part numbers, cost centers).';
                content.appendChild(emptyCustom);
            }

            // Right-click context menu for a custom table's grid — the ONLY
            // way to add/delete a row/column or clear a cell now (see the
            // CSS comment above .wo-ct-grid-wrap for why the old per-cell
            // buttons were removed). `hit` is {ci} for a header th, or
            // {ci, ri} for a data td. Mirrors the shared openRuleMenu/
            // closeRuleMenu single-open-menu pattern used by every other
            // kebab/context menu in this modal.
            function ctAddRow(t) {
                t.rows.push({});
            }

            function ctAddCol(t) {
                var n = 1;
                while (t.columns.indexOf('Column ' + n) >= 0) n++;
                t.columns.push('Column ' + n);
            }

            function ctGridContextMenu(e, t, hit) {
                e.preventDefault();
                closeRuleMenu();
                var isHeader = hit.ri == null;
                var colName = t.columns[hit.ci];
                var isFormulaCol = !!(t.columnFormulas && t.columnFormulas[colName]);
                var items = [];
                items.push(['addrow', 'Add Row']);
                items.push(['addcol', 'Add Column']);
                // A formula column's cells are computed, not typed - nothing
                // to delete per-cell (clearing it means editing/removing the
                // column formula itself, in the box below the grid).
                if (!isHeader && !isFormulaCol) items.push(['delcell', 'Delete Cell']);
                if (!isHeader) items.push(['delrow', 'Delete Row']);
                if (t.columns.length > 1) items.push(['delcol', 'Delete Column']);
                if (isHeader) items.push(isFormulaCol ? ['rmformula', 'Remove Formula Column'] : ['mkformula', 'Make Formula Column']);
                var menu = document.createElement('div');
                menu.className = 'wo-kebab-menu';
                menu.style.position = 'fixed';
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
                menu.innerHTML = items.map(function(it) {
                    var danger = it[0].indexOf('del') === 0;
                    return '<button type="button" class="wo-kebab-item' + (danger ? ' wo-kebab-item-danger' : '') + '" data-ct-act="' + it[0] + '">' + it[1] + '</button>';
                }).join('');
                modal.appendChild(menu);
                var r = menu.getBoundingClientRect();
                if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 4) + 'px';
                if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
                menu.querySelectorAll('[data-ct-act]').forEach(function(item) {
                    item.onclick = function(ev) {
                        ev.stopPropagation();
                        closeRuleMenu();
                        var act = item.getAttribute('data-ct-act');
                        if (act === 'addrow') {
                            ctAddRow(t);
                        } else if (act === 'addcol') {
                            ctAddCol(t);
                        } else if (act === 'delcell') {
                            delete t.rows[hit.ri][t.columns[hit.ci]];
                        } else if (act === 'delrow') {
                            t.rows.splice(hit.ri, 1);
                        } else if (act === 'delcol') {
                            var name = t.columns[hit.ci];
                            t.columns.splice(hit.ci, 1);
                            t.rows.forEach(function(row) {
                                delete row[name];
                            });
                            if (t.columnFormulas) delete t.columnFormulas[name];
                        } else if (act === 'mkformula') {
                            if (!t.columnFormulas) t.columnFormulas = {};
                            t.columnFormulas[colName] = t.columnFormulas[colName] || '';
                        } else if (act === 'rmformula') {
                            if (t.columnFormulas) delete t.columnFormulas[colName];
                        }
                        tablesTab();
                    };
                });
                openRuleMenu = menu;
            }

            customIds.forEach(function(id) {
                var t = cfg.customTables[id];
                if (!t.columns || !t.columns.length) t.columns = ['Column 1'];
                if (!t.rows) t.rows = [];

                var box = document.createElement('div');
                box.className = 'wo-card';
                var head = '<div data-coll-header class="wo-card-head">' +
                    '<code class="wo-mono" style="font-size:11px;">' + String(id).replace(/</g, '&lt;') + '</code>' +
                    '<div style="display:flex;gap:6px;margin-left:auto;" onclick="event.stopPropagation()">' +
                    '<button type="button" class="__ct_addrow wo-btn-ghost" style="font-size:11px;" title="Add row">+ Row</button>' +
                    '<button type="button" class="__ct_addcol wo-btn-ghost" style="font-size:11px;" title="Add column">+ Col</button>' +
                    '<button type="button" class="__ct_del wo-btn-ghost wo-kebab-item-danger" aria-label="Delete table">' + TRASH_SVG + '</button>' +
                    '</div>' +
                    '</div>';

                var tableHtml = '<div class="wo-ct-grid-wrap"><table class="wo-ct-grid"><thead><tr>';
                t.columns.forEach(function(col, ci) {
                    var isFormulaCol = !!(t.columnFormulas && t.columnFormulas[col]);
                    tableHtml += '<th data-ct-col="' + ci + '">' +
                        (isFormulaCol ? '<span class="wo-mono" style="font-size:9px;color:var(--wo-accent);" title="Formula column - value computed below, not typed here">ƒx</span> ' : '') +
                        '<input type="text" value="' + String(col).replace(/"/g, '&quot;') + '"></th>';
                });
                tableHtml += '</tr></thead><tbody>';
                t.rows.forEach(function(row, ri) {
                    tableHtml += '<tr>';
                    t.columns.forEach(function(col, ci) {
                        var isFormulaCol = !!(t.columnFormulas && t.columnFormulas[col]);
                        if (isFormulaCol) {
                            tableHtml += '<td data-ct-cell data-row="' + ri + '" data-col-idx="' + ci + '" style="color:var(--wo-muted);font-style:italic;text-align:center;" title="Computed by this column\'s formula">ƒx</td>';
                        } else {
                            tableHtml += '<td data-ct-cell data-row="' + ri + '" data-col-idx="' + ci + '"><input type="text" value="' + String(row[col] || '').replace(/"/g, '&quot;') + '"></td>';
                        }
                    });
                    tableHtml += '</tr>';
                });
                tableHtml = '<div data-coll-body style="margin-top:7px;">' + tableHtml + '</tbody></table></div>' +
                    '<div style="color:var(--wo-muted);font-size:10px;margin-top:5px;">Right-click a cell to add/delete rows, columns, or a cell — or right-click a column header to make/unmake it a formula column.</div>';

                var formulaColKeys = Object.keys(t.columnFormulas || {}).filter(function(c) {
                    return t.columns.indexOf(c) >= 0;
                });
                var formulaSectionHtml = '';
                if (formulaColKeys.length) {
                    formulaSectionHtml = '<div style="margin-top:10px;border-top:1px solid var(--wo-border);padding-top:8px;">' +
                        '<div style="color:var(--wo-muted);font-size:11px;margin-bottom:4px;">Formula columns (ƒx) — this formula is evaluated for every row. Use <code class="wo-mono">R(\'Column Name\')</code> to read another column from that same row.</div>' +
                        formulaColKeys.map(function(colName) {
                            return '<div data-ct-formula-wrap="' + String(colName).replace(/"/g, '&quot;') + '" style="margin-top:8px;">' +
                                '<label style="color:var(--wo-muted);font-size:11px;">' + String(colName).replace(/</g, '&lt;') + '</label>' +
                                formulaBox(t.columnFormulas, colName) +
                                '</div>';
                        }).join('') +
                        '</div>';
                }

                box.innerHTML = head + tableHtml + formulaSectionHtml + '</div>';
                content.appendChild(box);
                makeCollapsible(box, id, !customTableExpandState[id], function(expandedNow) {
                    customTableExpandState[id] = expandedNow;
                });

                box.querySelector('.__ct_del').onclick = function() {
                    woConfirm('Delete custom table "' + id + '"? Any formula referencing it will start returning empty results.').then(function(ok) {
                        if (!ok) return;
                        delete cfg.customTables[id];
                        tablesTab();
                    });
                };
                box.querySelector('.__ct_addrow').onclick = function() {
                    ctAddRow(t);
                    tablesTab();
                };
                box.querySelector('.__ct_addcol').onclick = function() {
                    ctAddCol(t);
                    tablesTab();
                };
                box.querySelectorAll('[data-ct-formula-wrap]').forEach(function(wrap) {
                    var colName = wrap.getAttribute('data-ct-formula-wrap');
                    var ta = wrap.querySelector('textarea[data-f]');
                    attachFormulaAssist(ta);
                    ta.oninput = function(e) {
                        t.columnFormulas[colName] = e.target.value;
                    };
                });
                box.querySelectorAll('th[data-ct-col] input').forEach(function(input) {
                    input.oninput = function(e) {
                        var ci = +input.closest('th').getAttribute('data-ct-col');
                        var oldName = t.columns[ci];
                        var newName = e.target.value;
                        t.columns[ci] = newName;
                        // Rows are keyed by column name, not index - carry each
                        // row's existing value across the rename so retyping
                        // the header doesn't silently blank every cell in it.
                        // columnFormulas is keyed by column name too - without
                        // this, renaming a formula column would silently
                        // strand its formula under the old name (invisible,
                        // since the formula-columns section below only lists
                        // names still present in t.columns) and the column
                        // would revert to looking like an empty plain column.
                        if (oldName !== newName) {
                            t.rows.forEach(function(row) {
                                if (row.hasOwnProperty(oldName)) {
                                    row[newName] = row[oldName];
                                    delete row[oldName];
                                }
                            });
                            if (t.columnFormulas && t.columnFormulas.hasOwnProperty(oldName)) {
                                t.columnFormulas[newName] = t.columnFormulas[oldName];
                                delete t.columnFormulas[oldName];
                            }
                        }
                    };
                });
                box.querySelectorAll('td[data-ct-cell] input').forEach(function(input) {
                    input.oninput = function(e) {
                        var td = input.closest('td');
                        var ri = +td.getAttribute('data-row');
                        // Resolved by column INDEX, not a name baked into the
                        // markup at render time - a column rename mutates
                        // t.columns in place without a full re-render (so
                        // typing isn't interrupted), so a name captured at
                        // render time would go stale the moment the header
                        // was renamed and this cell was edited afterward.
                        var ci = +td.getAttribute('data-col-idx');
                        var col = t.columns[ci];
                        t.rows[ri][col] = e.target.value;
                    };
                });
                box.querySelector('.wo-ct-grid').addEventListener('contextmenu', function(e) {
                    var th = e.target.closest('th[data-ct-col]');
                    if (th) {
                        ctGridContextMenu(e, t, { ci: +th.getAttribute('data-ct-col') });
                        return;
                    }
                    var td = e.target.closest('td[data-ct-cell]');
                    if (td) {
                        ctGridContextMenu(e, t, { ci: +td.getAttribute('data-col-idx'), ri: +td.getAttribute('data-row') });
                    }
                });
            });

            customHeader.querySelector('#__ct_add').onclick = function() {
                woPrompt('Table ID (used in formulas via T()/lookup() — letters, numbers, underscores only):').then(function(id) {
                    if (!id) return;
                    id = id.trim();
                    if (!id) return;
                    if (!/^[A-Za-z0-9_]+$/.test(id)) {
                        woAlert('Table ID can only contain letters, numbers, and underscores.');
                        return;
                    }
                    if (cfg.customTables[id] || (cfg.apiTables && cfg.apiTables[id]) || usage[id]) {
                        woAlert('A table with that ID already exists.');
                        return;
                    }
                    cfg.customTables[id] = {
                        columns: ['Column 1'],
                        rows: [{}]
                    };
                    tablesTab();
                });
            };

            // ── API tables — beta_2 (experimental). A named table backed by
            // a live REST fetch instead of the DOM or hand-typed data;
            // resolveApiTable() (buildCtx's T() fallback) is what actually
            // runs the fetch. Config UI is always visible/editable (so it
            // can be set up before ever turning beta_2 on), but only
            // resolves real data once that beta feature is enabled — same
            // "inert, not hidden" convention as domain()/assetWOHistory().
            if (!cfg.apiTables) cfg.apiTables = {};
            var apiHeader = document.createElement('div');
            apiHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px;';
            apiHeader.innerHTML = '<span class="wo-rule-title">API Tables</span> <span class="wo-beta-pill" data-beta-pill-tip="Beta feature — Setup > Beta">BETA</span>' +
                '<button type="button" id="__at_add" class="wo-btn wo-btn-primary" style="font-size:11px;margin-left:auto;">+ Add API Table</button>';
            content.appendChild(apiHeader);
            apiHeader.querySelectorAll('[data-beta-pill-tip]').forEach(function(el) {
                attachTooltip(el, el.getAttribute('data-beta-pill-tip'));
            });

            var apiIntro = document.createElement('div');
            apiIntro.style.cssText = 'color:var(--wo-muted);font-size:11px;margin-bottom:8px;';
            apiIntro.textContent = 'Experimental — resolves data from Maximo\'s REST API (Asset Work Order/Downtime History, live) or a domain list already cached in this browser (Domain List) instead of a scan. Only works when the beta_2 "Maximo REST Data" feature is enabled (Setup > Beta).';
            content.appendChild(apiIntro);

            var apiIds = Object.keys(cfg.apiTables).sort();
            if (!apiIds.length) {
                var emptyApi = document.createElement('div');
                emptyApi.style.cssText = 'color:var(--wo-muted);font-size:11px;';
                emptyApi.textContent = 'None yet.';
                content.appendChild(emptyApi);
            }

            apiIds.forEach(function(id) {
                var t = cfg.apiTables[id];
                if (!t.source) t.source = 'assetWO';
                var box = document.createElement('div');
                box.className = 'wo-card';
                box.innerHTML =
                    '<div data-coll-header class="wo-card-head">' +
                    '<code class="wo-mono" style="font-size:11px;">' + String(id).replace(/</g, '&lt;') + '</code>' +
                    '<button type="button" class="__at_del wo-btn-ghost wo-kebab-item-danger" style="margin-left:auto;" aria-label="Delete table" onclick="event.stopPropagation()">' + TRASH_SVG + '</button>' +
                    '</div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<div>' +
                    '<label style="color:var(--wo-muted);font-size:11px;">Source</label><br>' +
                    '<select data-at-source style="margin-top:2px;">' +
                    '<option value="assetWO"' + (t.source === 'assetWO' ? ' selected' : '') + '>Asset Work Order History</option>' +
                    '<option value="assetDowntime"' + (t.source === 'assetDowntime' ? ' selected' : '') + '>Asset Downtime History</option>' +
                    '<option value="domain"' + (t.source === 'domain' ? ' selected' : '') + '>Domain List</option>' +
                    '</select>' +
                    '</div>' +
                    (t.source === 'domain' ?
                        '<div style="margin-top:6px;">' +
                        '<label style="color:var(--wo-muted);font-size:11px;">Domain name (e.g. ABBWPRIORITY) — exact key, matched against what Maximo has already cached in this browser</label><br>' +
                        '<input type="text" data-at-domainkey value="' + String(t.domainKey || '').replace(/"/g, '&quot;') + '" style="width:100%;margin-top:2px;">' +
                        '</div>'
                        :
                        '<div style="margin-top:6px;">' +
                        '<label style="color:var(--wo-muted);font-size:11px;">Asset # formula</label><br>' +
                        formulaBox(t, 'assetFormula') +
                        '</div>' +
                        '<div style="margin-top:6px;">' +
                        '<label style="color:var(--wo-muted);font-size:11px;">Site ID formula</label><br>' +
                        formulaBox(t, 'siteFormula') +
                        '</div>' +
                        (t.source === 'assetWO' ? '<div style="margin-top:6px;">' +
                            '<label style="color:var(--wo-muted);font-size:11px;">Limit</label><br>' +
                            '<input type="number" data-at-limit min="1" value="' + (t.limit || 10) + '" style="width:80px;margin-top:2px;">' +
                            '</div>' : '')) +
                    '</div>';
                content.appendChild(box);
                makeCollapsible(box, id, !apiTableExpandState[id], function(expandedNow) {
                    apiTableExpandState[id] = expandedNow;
                });

                box.querySelector('.__at_del').onclick = function() {
                    woConfirm('Delete API table "' + id + '"? Any formula referencing it will start returning empty results.').then(function(ok) {
                        if (!ok) return;
                        delete cfg.apiTables[id];
                        tablesTab();
                    });
                };
                box.querySelector('[data-at-source]').onchange = function(e) {
                    t.source = e.target.value;
                    tablesTab();
                };
                box.querySelectorAll('[data-f]').forEach(function(ta) {
                    attachFormulaAssist(ta);
                });
                var formulaTextareas = box.querySelectorAll('[data-f]');
                if (formulaTextareas[0]) formulaTextareas[0].oninput = function(e) {
                    t.assetFormula = e.target.value;
                };
                if (formulaTextareas[1]) formulaTextareas[1].oninput = function(e) {
                    t.siteFormula = e.target.value;
                };
                var limitInput = box.querySelector('[data-at-limit]');
                if (limitInput) limitInput.oninput = function(e) {
                    t.limit = (+e.target.value) || 10;
                };
                var domainKeyInput = box.querySelector('[data-at-domainkey]');
                if (domainKeyInput) domainKeyInput.oninput = function(e) {
                    t.domainKey = e.target.value.trim();
                };
            });

            apiHeader.querySelector('#__at_add').onclick = function() {
                woPrompt('Table ID (used in formulas via T()/lookup() — letters, numbers, underscores only):').then(function(id) {
                    if (!id) return;
                    id = id.trim();
                    if (!id) return;
                    if (!/^[A-Za-z0-9_]+$/.test(id)) {
                        woAlert('Table ID can only contain letters, numbers, and underscores.');
                        return;
                    }
                    if (cfg.apiTables[id] || cfg.customTables[id] || usage[id]) {
                        woAlert('A table with that ID already exists.');
                        return;
                    }
                    cfg.apiTables[id] = {
                        source: 'assetWO',
                        assetFormula: '',
                        siteFormula: '',
                        limit: 10
                    };
                    tablesTab();
                });
            };
        }


        // ── SETTINGS TAB ──
        // ── BETA TAB ── Enable/disable registry only — no feature's actual
        // settings live here. Only lists features this user currently
        // holds the grant for; the tab itself is only ever rendered at all
        // when hasAnyBetaGrant() is true (see the tab-bar markup above).
        function betaTab() {
            content.innerHTML = '';
            // Deliberately NOT a fresh localStorage read — `st` here is the
            // SAME object hoisted once at openSetup() scope that
            // settingsTab() reads/writes (see the comment on its
            // declaration). A local re-read would shadow it, and a toggle
            // made here would then get silently reverted the moment Save &
            // Apply persists the outer (stale) object on modal close.
            if (!st.betaEnabled) st.betaEnabled = {};

            var grants = getGrants();
            var intro = document.createElement('div');
            intro.style.cssText = 'color:var(--wo-muted);font-size:11px;margin-bottom:10px;';
            intro.textContent = 'Your access: ' + (grants.join(', ') || 'user') + '.';
            content.appendChild(intro);

            BETA_FEATURES.filter(function(f) {
                return hasGrant(f.id);
            }).forEach(function(f) {
                var div = document.createElement('div');
                div.className = 'wo-card';
                var on = !!st.betaEnabled[f.id];
                div.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">' + f.label + '</span> <span class="wo-beta-pill">' + f.id.toUpperCase() + '</span></div>' +
                    '<div data-coll-body style="margin-top:7px;">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" data-beta-toggle ' + (on ? 'checked' : '') + '>' +
                    '<span style="color:var(--wo-text);font-size:11px;">Enable this feature</span>' +
                    '</label>' +
                    '<div style="color:var(--wo-muted);font-size:10px;margin-top:6px;">' + f.description + '</div>' +
                    '</div>';
                content.appendChild(div);
                makeCollapsible(div, f.label, false);
                div.querySelector('[data-beta-toggle]').onchange = function(e) {
                    st.betaEnabled[f.id] = e.target.checked;
                    saveSettingsCfg(st);
                    applyHotkeys();
                    render();
                };
            });
        }

        function settingsTab() {
            // `st` is declared once at openSetup() scope (not here) so a
            // staged channel/version change survives switching tabs and
            // back — see the comment there.
            content.innerHTML = '';

            // Quick Return / Copy Message — prefix/suffix/delimiter are global;
            // per-rule return-message config now lives inline in the Rules tab
            // (see msgSection()'s "Include in return message" control).
            var qrDiv = document.createElement('div');
            qrDiv.className = 'wo-card';
            qrDiv.innerHTML =
                '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Return Message</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<div style="margin-bottom:6px;"><label style="color:var(--wo-muted);font-size:11px;">Prefix (e.g. Hi {name},)</label><br>' +
                '<input id="__st_prefix" type="text" value="' + (st.msgPrefix || '').replace(/"/g, '&quot;') + '" style="width:100%;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-bottom:6px;"><label style="color:var(--wo-muted);font-size:11px;">Suffix / Signature (e.g. - wz)</label><br>' +
                '<input id="__st_suffix" type="text" value="' + (st.msgSuffix || '').replace(/"/g, '&quot;') + '" style="width:100%;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-bottom:6px;"><label style="color:var(--wo-muted);font-size:11px;">Delimiter (default: ". ")</label><br>' +
                '<input id="__st_delim" type="text" value="' + (st.msgDelim !== undefined ? st.msgDelim : '. ').replace(/"/g, '&quot;') + '" style="width:80px;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-top:8px;color:var(--wo-muted);font-size:10px;">Per-rule inclusion is set in each rule\'s Fail/Warn section.</div>' +
                '</div>';
            content.appendChild(qrDiv);
            makeCollapsible(qrDiv, 'Return Message');

            // Hotkeys (Scan / Return / Approve / ...) — all registered
            // actions live under ONE collapsible card now (not one card
            // each), sharing the same duplicate-combo check so the same
            // keystroke can never be assigned to two actions at once.
            var activeHotkeyActions = HOTKEY_ACTIONS.filter(hotkeyActionActive);
            if (activeHotkeyActions.length) {
                var hkCard = document.createElement('div');
                hkCard.className = 'wo-card';
                hkCard.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Hotkeys</span></div>' +
                    '<div data-coll-body style="margin-top:7px;"></div>';
                content.appendChild(hkCard);
                makeCollapsible(hkCard, 'Hotkeys', false);
                var hkBody = hkCard.querySelector('[data-coll-body]');

                activeHotkeyActions.forEach(function(action, ai) {
                    var hkDiv = document.createElement('div');
                    hkDiv.style.cssText = ai > 0 ? 'margin-top:12px;padding-top:12px;border-top:1px solid var(--wo-border);' : '';
                    var hkCurrent = hotkeyFor(action, st);
                    hkDiv.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><b style="font-size:11px;">' + action.label + '</b>' + (action.betaFeature ? ' <span class="wo-beta-pill">BETA</span>' : '') + '</div>' +
                        '<div style="color:var(--wo-muted);font-size:11px;margin-top:4px;">Current: <b class="__st_hk_display" style="color:var(--wo-accent);">' + (hkCurrent || 'not set') + '</b></div>' +
                        '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;"><input class="__st_hk_input" type="text" readonly placeholder="Click here, then press your key combo..." style="flex:1;font-size:11px;cursor:pointer;">' +
                        '<button type="button" class="wo-btn-ghost __st_hk_clear">Clear</button></div>' +
                        '<div class="__st_hk_error" style="margin-top:4px;color:var(--wo-fail);font-size:10px;display:none;"></div>';
                    hkBody.appendChild(hkDiv);

                    var hkInput = hkDiv.querySelector('.__st_hk_input');
                    var hkDisplay = hkDiv.querySelector('.__st_hk_display');
                    var hkError = hkDiv.querySelector('.__st_hk_error');
                    hkInput.addEventListener('keydown', function(e) {
                        e.preventDefault();
                        var parts = [];
                        if (e.ctrlKey) parts.push('Ctrl');
                        if (e.altKey) parts.push('Alt');
                        if (e.shiftKey) parts.push('Shift');
                        if (e.metaKey) parts.push('Meta');
                        var k = e.key;
                        if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) parts.push(k.length === 1 ? k.toUpperCase() : k);
                        var combo = parts.join('+');
                        if (!combo) return;
                        var conflict = HOTKEY_ACTIONS.filter(function(other) {
                            return other !== action && hotkeyActionActive(other) && hotkeyFor(other, st) === combo;
                        })[0];
                        if (conflict) {
                            hkError.textContent = combo + ' is already assigned to ' + conflict.label + ' — pick a different combo.';
                            hkError.style.display = '';
                            return;
                        }
                        hkError.style.display = 'none';
                        st[action.settingsKey] = combo;
                        hkInput.value = combo;
                        hkDisplay.textContent = combo;
                        saveSettings();
                    });

                    hkDiv.querySelector('.__st_hk_clear').onclick = function() {
                        st[action.settingsKey] = '';
                        hkInput.value = '';
                        hkDisplay.textContent = 'not set';
                        hkError.style.display = 'none';
                        saveSettings();
                    };
                });
            }

            // ── Auto-Scan on New WO ──
            var autoScanDiv = document.createElement('div');
            autoScanDiv.className = 'wo-card';
            autoScanDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Auto-Scan</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_autoscan" ' + (st.autoScan ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Scan automatically when a new WO opens</span>' +
                '</label>' +
                '<div style="color:var(--wo-muted);font-size:10px;margin-top:4px;">Detects a WO number change from the last scan and starts a new one.</div>' +
                '</div>';
            content.appendChild(autoScanDiv);
            makeCollapsible(autoScanDiv, 'Auto-Scan', false);

            autoScanDiv.querySelector('#__st_autoscan').onchange = function(e) {
                st.autoScan = e.target.checked;
                saveSettingsCfg(st);
            };

            // ── Display ──
            var displayDiv = document.createElement('div');
            displayDiv.className = 'wo-card';
            displayDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Display</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_hide_summary" ' + (st.hideSummaryBar ? '' : 'checked') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Show status summary bar</span>' +
                '</label>' +
                '<div style="color:var(--wo-muted);font-size:10px;margin-top:4px;">Pass/fail/warn/error counts under the status line.</div>' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:10px;">' +
                '<input type="checkbox" id="__st_whoami_formulas" ' + (st.whoamiInFormulas ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Allow whoami() in formulas</span>' +
                '</label>' +
                '<div style="color:var(--wo-muted);font-size:10px;margin-top:4px;">Allows rules/messages using your name, username, or email via whoami().</div>' +
                '</div>';
            content.appendChild(displayDiv);
            makeCollapsible(displayDiv, 'Display', false);

            displayDiv.querySelector('#__st_hide_summary').onchange = function(e) {
                st.hideSummaryBar = !e.target.checked;
                saveSettingsCfg(st);
                render();
            };
            displayDiv.querySelector('#__st_whoami_formulas').onchange = function(e) {
                st.whoamiInFormulas = e.target.checked;
                saveSettingsCfg(st);
                refreshWhoamiIfEnabled();
            };

            var devTier = getDevTier();

            // Debug button (dev tier only — moved from panel)
            if (devTier === 'dev') {
                var dbgDiv = document.createElement('div');
                dbgDiv.className = 'wo-card';
                dbgDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Debug</span></div>' +
                    '<div data-coll-body style="margin-top:7px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;">' +
                    '<button id="__st_debug" type="button" class="wo-btn">Run Debug Dump (check DevTools console)</button>' +
                    '<button id="__st_beta2diag" type="button" class="wo-btn">Run beta_2 Diagnostics (copies report to clipboard)</button>' +
                    '</div>';
                content.appendChild(dbgDiv);
                makeCollapsible(dbgDiv, 'Debug', false);
                dbgDiv.querySelector('#__st_debug').onclick = function() {
                    window.__woDebugTables();
                    window.__woDebugCache();
                    woAlert('Check DevTools console for debug dump.');
                };
                // One click: prompts once for asset/site (only needed for the
                // REST 406 half of the report — Cancel/blank still runs the
                // domain-shape half), then copies the whole report to the
                // clipboard so it can be pasted straight back, no manual
                // fetch()/JSON.parse() console typing required.
                dbgDiv.querySelector('#__st_beta2diag').onclick = function() {
                    woPrompt('Asset # to test REST calls against (blank to skip that part):', lastDiagAssetnum).then(function(assetnum) {
                        if (assetnum === null) return;
                        lastDiagAssetnum = assetnum.trim();
                        var sitePromise = lastDiagAssetnum ?
                            woPrompt('Site ID for that asset:', lastDiagSiteid) :
                            Promise.resolve('');
                        sitePromise.then(function(siteid) {
                            if (siteid === null) return;
                            lastDiagSiteid = siteid.trim();
                            buildBeta2DiagnosticReport(lastDiagAssetnum, lastDiagSiteid).then(function(report) {
                                console.log(report);
                                copyTextToClipboard(report);
                                woAlert('Diagnostics copied to clipboard — paste it back.');
                            });
                        });
                    });
                };
            }

            // Save settings on any change
            function saveSettings() {
                // Read current persisted state first so we never lose keys not in the DOM
                var currentSaved = {};
                try {
                    currentSaved = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                } catch (e) {}

                st.msgPrefix = content.querySelector('#__st_prefix').value;
                st.msgSuffix = content.querySelector('#__st_suffix').value;
                st.msgDelim = content.querySelector('#__st_delim').value;

                // Always prefer the in-memory hotkey (set by keydown) for
                // each registered action, falling back to whatever was
                // previously saved — same reasoning as before, just applied
                // to every hotkey action instead of only Scan's.
                HOTKEY_ACTIONS.forEach(function(action) {
                    if (!st[action.settingsKey] && currentSaved[action.settingsKey]) {
                        st[action.settingsKey] = currentSaved[action.settingsKey];
                    }
                });

                saveSettingsCfg(st);
                applyHotkeys();
            }

            // ── Auto-Backup section ──
            var backupSettDiv = document.createElement('div');
            backupSettDiv.className = 'wo-card';
            var fsaSupported = typeof window.showSaveFilePicker !== 'undefined';
            backupSettDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Backups</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<div style="color:var(--wo-muted);font-size:10px;">' +
                (fsaSupported ? 'Supported (Chrome/Edge)' : '⚠ Not supported here — use Export/Import instead') +
                '</div>' +
                '<div style="margin-top:8px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_autobackup" ' + (st.autoBackup ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Auto-save backup on changes</span>' +
                '</label></div>' +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__st_set_new_backup" type="button" class="wo-btn" style="font-size:11px;">New Location</button>' +
                '<button id="__st_link_backup" type="button" class="wo-btn" style="font-size:11px;">Link Existing</button>' +
                '</div>' +
                '<div style="margin-top:8px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_backup_prompt_reset" ' + (!st.backupPromptDismissed ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Prompt if backup isn\'t set up</span>' +
                '</label></div>' +
                '</div>';
            content.appendChild(backupSettDiv);
            makeCollapsible(backupSettDiv, 'Backups', false);

            backupSettDiv.querySelector('#__st_autobackup').onchange = function(e) {
                st.autoBackup = e.target.checked;
                saveSettingsCfg(st);
            };
            backupSettDiv.querySelector('#__st_backup_prompt_reset').onchange = function(e) {
                st.backupPromptDismissed = !e.target.checked;
                saveSettingsCfg(st);
            };
            if (fsaSupported) {
                backupSettDiv.querySelector('#__st_set_new_backup').onclick = function() {
                    pickBackupFile();
                };
                backupSettDiv.querySelector('#__st_link_backup').onclick = function() {
                    linkExistingBackupFile();
                };
            } else {
                backupSettDiv.querySelector('#__st_set_new_backup').disabled = true;
                backupSettDiv.querySelector('#__st_link_backup').disabled = true;
            }

            // ── Updates section — channel + version pin available to everyone;
            // beta/dev channel options and beta/dev-tagged pins need the console unlock. ──
            var updSettDiv = document.createElement('div');
            updSettDiv.className = 'wo-card';
            var chOptions = ['stable'];
            if (devTier === 'beta' || devTier === 'dev') chOptions.push('beta');
            if (devTier === 'dev') chOptions.push('dev');
            var curChannel = st.channel || 'stable';
            if (chOptions.indexOf(curChannel) === -1) curChannel = 'stable';
            updSettDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Updates' +
                (devTier ? ' <span style="color:var(--wo-accent);font-weight:400;font-size:10px;">(' + devTier + ' mode unlocked)</span>' : '') +
                '</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<div>' +
                '<label style="color:var(--wo-muted);font-size:11px;">Channel:</label><br>' +
                '<select id="__st_channel" style="margin-top:2px;">' +
                chOptions.map(function(c) {
                    return '<option value="' + c + '"' + (c === curChannel ? ' selected' : '') + '>' + c + '</option>';
                }).join('') +
                '</select>' +
                '</div>' +
                (devTier === 'dev' ?
                    '<div style="margin-top:6px;color:var(--wo-muted);font-size:10px;">Build: <code class="wo-mono">' + BUILD_ID + '</code></div>' :
                    '') +
                '<div style="margin-top:8px;">' +
                '<label style="color:var(--wo-muted);font-size:11px;">Version:</label><br>' +
                '<select id="__st_pin" style="width:100%;margin-top:2px;"><option value="">Latest (current version)</option></select>' +
                '<div id="__st_pin_note" style="display:none;margin-top:4px;color:var(--wo-muted);font-size:10px;">Pinning has no effect on the dev channel — it always tracks the tip of main directly.</div>' +
                '</div>' +
                '<div style="margin-top:10px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_upd_disable" ' + (st.updateDisabled ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Disable update check</span>' +
                '</label></div>' +
                '<div style="margin-top:6px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_upd_auto_patch" ' + (st.autoUpdatePatch !== false ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Auto-install patches (same line, on by default)</span>' +
                '</label></div>' +
                '<div style="margin-top:6px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_upd_auto" ' + (st.autoUpdate ? 'checked' : '') + '>' +
                '<span style="color:var(--wo-text);font-size:11px;">Also auto-install new features (off by default)</span>' +
                '</label></div>' +
                '<div style="margin-top:8px;">' +
                '<button id="__st_check_now" type="button" class="wo-btn">Check Now</button>' +
                '</div>' +
                (devTier ?
                    '<div style="margin-top:8px;color:var(--wo-muted);font-size:10px;">window.__woLockDev() in the console re-hides beta/dev options and resets to stable.</div>' :
                    '') +
                '</div>';
            content.appendChild(updSettDiv);
            makeCollapsible(updSettDiv, 'Updates', false);

            updSettDiv.querySelector('#__st_channel').onchange = function(e) {
                // Stage only — e.stopPropagation() keeps this from also
                // reaching the generic content 'input' listener below
                // (saveSettings()), which would otherwise persist this
                // immediately anyway. Actually applying a channel/version
                // change used to trigger an instant install/reload the
                // moment you touched the dropdown; now it waits for
                // Save & Apply, same as every other Setup tab.
                // stopPropagation() also blocks the Save button's OWN dirty
                // tracker (content's bubbling 'change' listener), which isn't
                // the thing it was meant to guard against — call it directly
                // so the button ungreys and its hover tooltip picks this up.
                e.stopPropagation();
                st.channel = e.target.value;
                setStatus('Channel set to ' + st.channel + ' — click Save to check for updates.');
                updateSaveButtonState();
                refreshVersionPicker();
            };

            var pinSel = updSettDiv.querySelector('#__st_pin');
            // Pinning is meaningless on the dev channel (it always tracks
            // main directly, ignoring version.json entirely — see
            // resolveUpdateTarget()'s early return for channel==='dev') —
            // grey the control out and say so the instant Channel changes,
            // instead of leaving a now-irrelevant dropdown looking live.
            var lastRemoteV = null;
            // What the "Latest" option means depends on the CHANNEL you're
            // currently set to (that's what unpinned actually follows — see
            // resolveUpdateTarget()), not on your dev/beta GRANT. A dev-grant
            // holder sitting on the stable channel should see "Latest stable
            // (X)" pointing at channels.stable, same as a plain user would —
            // not the highest dev-gated build they merely have permission to
            // pin to. Mirrors resolveUpdateTarget()'s own channel fallback
            // (channels[channel] || channels.stable || remote.latest) rather
            // than re-deriving it from the raw versions[] list, so this label
            // can never disagree with what an actual unpinned update-check
            // would resolve to.
            function updateLatestLabel() {
                if (!lastRemoteV) return;
                var defaultOpt = pinSel.querySelector('option[value=""]');
                if (!defaultOpt) return;
                var effChannel = st.channel || 'stable';
                if (effChannel === 'dev' && devTier !== 'dev') effChannel = 'stable';
                if (effChannel === 'beta' && devTier !== 'beta' && devTier !== 'dev') effChannel = 'stable';
                // The dev channel has no version.json pointer at all — it
                // always installs whatever's live on main (see
                // resolveUpdateTarget()'s early return for channel==='dev'),
                // not a specific tagged version — so falling back to
                // channels.stable here would show a stale/wrong number
                // instead of just saying what dev actually does.
                if (effChannel === 'dev') {
                    defaultOpt.textContent = 'Latest (dev — always tracks main)';
                    return;
                }
                var channels = lastRemoteV.channels || {};
                var target = channels[effChannel] || channels.stable || lastRemoteV.latest;
                if (target) {
                    defaultOpt.textContent = (effChannel === 'beta') ?
                        ('Latest (' + target + ')') :
                        ('Latest stable (' + target + ')');
                }
            }
            function refreshVersionPicker() {
                var isDev = st.channel === 'dev';
                pinSel.disabled = isDev;
                pinSel.style.opacity = isDev ? '0.5' : '';
                var note = updSettDiv.querySelector('#__st_pin_note');
                if (note) note.style.display = isDev ? '' : 'none';
                updateLatestLabel();
            }
            refreshVersionPicker();
            var xhrV = new XMLHttpRequest();
            xhrV.open('GET', WORKER_BASE_URL + '/version.json', true);
            xhrV.onload = function() {
                if (xhrV.status !== 200) return;
                try {
                    var remoteV = JSON.parse(xhrV.responseText);
                    lastRemoteV = remoteV;
                    // The default option is a placeholder until this fetch
                    // resolves — once it does, say which version "Latest"
                    // actually means instead of leaving that unstated.
                    updateLatestLabel();
                    // Group by major.minor, preserving remoteV.versions' existing
                    // newest-first order. Each line gets a floating "X.Y"
                    // option — always tracks that line's newest patch — plus
                    // every exact patch underneath for the "the newest patch
                    // broke something, freeze at the previous one" rollback case.
                    var lines = [],
                        byLine = {},
                        nameByVersion = {},
                        grantByVersion = {};
                    (remoteV.versions || []).forEach(function(v) {
                        if (!isVersionEntryAllowed(v, devTier)) return; // gated version, not visible to this tier
                        var key = minorKey(v.version);
                        if (!byLine[key]) {
                            byLine[key] = [];
                            lines.push(key);
                        }
                        byLine[key].push(v.version);
                        if (v.name) nameByVersion[v.version] = v.name;
                        if (v.grant) grantByVersion[v.version] = v.grant;
                    });
                    // Flat list, not <optgroup> — an optgroup's own label
                    // isn't selectable, which fought the "auto-patch is the
                    // thing you pick" model. Instead the auto-patch option
                    // itself acts as the header, with each exact patch
                    // listed right under it, indented, as its own selectable
                    // option (for the "newest patch broke something, freeze
                    // on the previous one" rollback case).
                    lines.forEach(function(key) {
                        var floatOpt = document.createElement('option');
                        floatOpt.value = key;
                        floatOpt.textContent = key;
                        if (st.pinnedVersion === key) floatOpt.selected = true;
                        pinSel.appendChild(floatOpt);
                        byLine[key].forEach(function(vstr) {
                            var opt = document.createElement('option');
                            opt.value = vstr;
                            opt.textContent = '    ' + vstr +
                                (nameByVersion[vstr] ? ' — ' + nameByVersion[vstr] : '') +
                                (grantByVersion[vstr] ? ' (' + grantByVersion[vstr] + ')' : '');
                            if (st.pinnedVersion === vstr) opt.selected = true;
                            pinSel.appendChild(opt);
                        });
                    });
                } catch (e) {}
            };
            xhrV.send();

            pinSel.onchange = function(e) {
                e.stopPropagation(); // stage only — see the channel handler's comment above
                st.pinnedVersion = e.target.value;
                setStatus(st.pinnedVersion ?
                    'Version set to ' + st.pinnedVersion + ' — click Save to check for updates.' :
                    'Unpinned — click Save to follow the channel.');
                updateSaveButtonState();
            };

            updSettDiv.querySelector('#__st_upd_disable').onchange = function(e) {
                st.updateDisabled = e.target.checked;
                saveSettingsCfg(st);
            };
            updSettDiv.querySelector('#__st_upd_auto_patch').onchange = function(e) {
                st.autoUpdatePatch = e.target.checked;
                saveSettingsCfg(st);
            };
            updSettDiv.querySelector('#__st_upd_auto').onchange = function(e) {
                st.autoUpdate = e.target.checked;
                saveSettingsCfg(st);
            };
            updSettDiv.querySelector('#__st_check_now').onclick = function() {
                st.updateDisabled = false;
                st.skippedVersion = '';
                updSettDiv.querySelector('#__st_upd_disable').checked = false;
                saveSettingsCfg(st);
                checkForUpdate();
            };


            content.addEventListener('input', saveSettings);

            // ── Danger Zone: reset / uninstall ──
            // Neither button is a true "uninstall" — the bookmarklet always
            // reinstalls the tool on the next click, so there's no way to
            // remove it permanently from a page you don't control. Both are
            // framed honestly as resets, not removal, to avoid promising
            // something that isn't possible.
            var dangerDiv = document.createElement('div');
            dangerDiv.className = 'wo-card';
            dangerDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Reset / Uninstall</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<div style="color:var(--wo-muted);font-size:11px;margin-bottom:10px;">Neither is permanent — the bookmarklet always reinstalls the tool.</div>' +
                '<div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;">' +
                '<div><button id="__st_reset_tool" type="button" class="wo-btn">Reset Tool</button>' +
                '<div style="color:var(--wo-muted);font-size:10px;margin-top:4px;max-width:420px;">Clears cached code and session data. Your config is kept and restored automatically next launch.</div></div>' +
                '<div><button id="__st_reset_all" type="button" class="wo-btn wo-btn-danger">Full Reset</button>' +
                '<div style="color:var(--wo-muted);font-size:10px;margin-top:4px;max-width:420px;">Erases everything, with no backup. Starts completely fresh.</div></div>' +
                '</div>' +
                '</div>';
            content.appendChild(dangerDiv);
            makeCollapsible(dangerDiv, 'Reset / Uninstall', true);

            dangerDiv.querySelector('#__st_reset_tool').onclick = function() {
                woConfirm('Reset the tool but keep your config?\n\nClears cached code and session data. Your config is restored automatically next launch.').then(function(ok) {
                    if (!ok) return;
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
                    woAlert('Tool reset. Click the bookmarklet again — your config comes back automatically.').then(function() {
                        modal._woCleanup();
                        modal.remove();
                        teardown();
                    });
                });
            };
            dangerDiv.querySelector('#__st_reset_all').onclick = function() {
                woConfirm('Erase everything — rules, groups, scans, settings, and the tool itself?\n\nCannot be undone. No backup.').then(function(ok1) {
                    if (!ok1) return;
                    woConfirm('Really sure? This can\'t be undone.').then(function(ok2) {
                        if (!ok2) return;
                        Object.keys(localStorage).filter(function(k) {
                            return k.indexOf('__wo_') === 0;
                        }).forEach(function(k) {
                            localStorage.removeItem(k);
                        });
                        if (window.indexedDB) indexedDB.deleteDatabase('__wo_tool_db');
                        woAlert('Everything erased. Click the bookmarklet again for a fresh install.').then(function() {
                            modal._woCleanup();
                            modal.remove();
                            teardown();
                        });
                    });
                });
            };
        }

        // ── UPDATE TAB ──
        function updateTab() {
            content.innerHTML = '';
            var div = document.createElement('div');
            div.className = 'wo-card';
            div.style.cssText = 'display:flex;flex-direction:column;height:100%;gap:8px;padding:10px;';
            div.innerHTML = '<div style="color:var(--wo-muted);font-size:11px;">Paste or load the tool script, then Install. A manual, offline path — separate from automatic updates.</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__upd_load" type="button" class="wo-btn wo-btn-primary">Load Saved</button>' +
                '<label class="wo-btn" style="cursor:pointer;">Open File… <input type="file" id="__upd_file" accept=".js,.txt,text/javascript,text/plain" style="display:none;"></label>' +
                '<button id="__upd_save_file" type="button" class="wo-btn">Save File…</button>' +
                '</div>' +
                '<textarea id="__upd_ta" class="wo-code" style="flex:1;width:100%;min-height:300px;" placeholder="Paste or open a .js file..."></textarea>' +
                '<div><button id="__upd_go" type="button" class="wo-btn wo-btn-pass">Install</button> <span id="__upd_status" style="color:var(--wo-text);margin-left:10px;font-size:12px;"></span></div>';
            content.appendChild(div);

            var ta = content.querySelector('#__upd_ta');
            var updStatusEl = content.querySelector('#__upd_status');


            // Load saved
            content.querySelector('#__upd_load').onclick = function() {
                var saved = localStorage.getItem('__wo_tool_src') || '';
                if (!saved) {
                    updStatusEl.textContent = 'No saved code found.'
                    return;
                }
                ta.value = saved;
                updStatusEl.textContent = 'Loaded  ' + saved.length + ' chars.';
            };

            // Open file (works in Notepad++ "open in browser", Chrome, Edge etc.)
            content.querySelector('#__upd_file').onchange = function(e) {
                var file = e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function(ev) {
                    ta.value = ev.target.result;
                    updStatusEl.textContent = 'Opened: ' + file.name + ' (' + ev.target.result.length + ' chars)';
                };
                reader.readAsText(file);
            };

            // Save to file (downloads as .js — open result in Notepad++)
            content.querySelector('#__upd_save_file').onclick = function() {
                var code = ta.value;
                if (!code.trim()) {
                    updStatusEl.textContent = 'Nothing to save.';
                    return;
                }
                var blob = new Blob([code], {
                    type: 'text/javascript'
                });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'wo_tool.js';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                updStatusEl.textContent = 'Downloaded wo_tool.js — edit in Notepad++, then open file to re-load.';
            };

            // Install
            content.querySelector('#__upd_go').onclick = function() {
                var code = ta.value.trim();
                if (!code) {
                    updStatusEl.textContent = 'Nothing to install.';
                    return;
                }
                try {
                    new Function(code);
                } catch (e) {
                    updStatusEl.style.color = 'var(--wo-fail)';
                    updStatusEl.textContent = 'SYNTAX ERROR: ' + e.message;
                    return;
                }
                try {
                    // A manual paste isn't any specific tagged version — if a pin was
                    // active, clear it rather than leave it pointing at a tag that
                    // would silently overwrite this paste on the next update check.
                    var pinSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                    if (pinSt.pinnedVersion) {
                        pinSt.pinnedVersion = '';
                        localStorage.setItem('__wo_settings', JSON.stringify(pinSt));
                    }
                    localStorage.setItem('__wo_tool_src', code);
                    updStatusEl.style.color = 'var(--wo-pass)';
                    updStatusEl.textContent = 'Saved. Reloading...';
                    setTimeout(function() {
                        modal.remove();
                        teardown();
                        eval(code);
                    }, 1500);


                } catch (e) {
                    updStatusEl.style.color = 'var(--wo-fail)';
                    updStatusEl.textContent = 'Save failed: ' + e.message;
                }
            };
        }

        function guideTab() {
            window.open('https://williamzitzmann.github.io/WO-Review-Tool/', '_blank');
        }

        // ── ADMIN TAB ── Only rendered when the server granted 'admin' (see
        // loadAdminAccountEmails/handleCheckAccess in worker.js — cross-
        // references the logged-in whoami email against every admin
        // account). Just links out to the Worker-hosted admin page; no
        // admin data is ever fetched or held inside this tool.
        function adminTab() {
            window.open(WORKER_BASE_URL + '/admin', '_blank');
        }

        // ── FEEDBACK TAB ── Files a GitHub Issue in the private repo via
        // the Worker's /feedback endpoint (needs a fresh access token, same
        // as fetching the tool itself — that's what keeps this from being
        // an open, unauthenticated write path onto the issue tracker).
        // Falls back to a mailto: draft if the Worker call fails for any
        // reason, so a report is never just silently lost.
        function feedbackTab() {
            content.innerHTML = '';
            var div = document.createElement('div');
            div.className = 'wo-card';
            div.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Bug / Suggestion</span></div>' +
                '<div data-coll-body style="margin-top:7px;">' +
                '<div style="margin-bottom:6px;">Type: <select id="__fb_type">' +
                '<option value="Bug">Bug</option>' +
                '<option value="Suggestion">Suggestion</option>' +
                '<option value="Admin">Question for my admin</option>' +
                '</select></div>' +
                '<textarea id="__fb_body" placeholder="What happened, or what would help?" style="width:100%;height:140px;"></textarea>' +
                '<label style="display:block;margin-top:6px;font-size:11px;color:var(--wo-muted);"><input type="checkbox" id="__fb_pii"> Include name and personal identifying details</label>' +
                '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">' +
                '<button id="__fb_send" type="button" class="wo-btn wo-btn-primary">Send</button>' +
                '<span id="__fb_status" style="color:var(--wo-muted);font-size:10px;"></span>' +
                '</div>' +
                '</div>';
            content.appendChild(div);
            makeCollapsible(div, 'Bug / Suggestion', false);

            div.querySelector('#__fb_send').onclick = function() {
                var type = div.querySelector('#__fb_type').value;
                var body = div.querySelector('#__fb_body').value.trim();
                var includePii = div.querySelector('#__fb_pii').checked;
                var statusSpan = div.querySelector('#__fb_status');
                var sendBtn = div.querySelector('#__fb_send');
                if (!body) {
                    woAlert('Describe the bug, suggestion, or question first.');
                    return;
                }
                var stCtx = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                var context = 'Tool version: v' + TOOL_VERSION +
                    '\nGrants: ' + (getGrants().join(', ') || 'user') +
                    '\nChannel: ' + (stCtx.channel || 'stable') + (stCtx.pinnedVersion ? ' (pinned: ' + stCtx.pinnedVersion + ')' : '') +
                    '\nLast status: ' + (statusEl ? statusEl.textContent : '') +
                    '\nBrowser: ' + navigator.userAgent +
                    '\nURL: ' + location.href;

                function openEmailDraft(recipient, subject, fullContext) {
                    var mailBody = body + '\n\n---\n' + fullContext;
                    window.location.href = 'mailto:' + recipient +
                        '?subject=' + encodeURIComponent(subject) +
                        '&body=' + encodeURIComponent(mailBody);
                }

                sendBtn.disabled = true;
                statusSpan.textContent = 'Sending...';
                // Whoami (name/username/email) is opt-in only, per the
                // checkbox — never fetched or attached unless the user
                // explicitly asked for it on this specific report.
                var whoamiPromise = includePii ? readWhoamiCanonical().catch(function() {
                    return null;
                }) : Promise.resolve(null);
                whoamiPromise.then(function(who) {
                    var fullContext = context;
                    if (who) {
                        fullContext += '\nReporter: ' + (who.displayName || who.username || '') +
                            (who.username ? ' (' + who.username + ')' : '') +
                            (who.email ? ' <' + who.email + '>' : '') +
                            (who.insertSite ? ' — site ' + who.insertSite : '') +
                            (who.country ? ', ' + who.country : '');
                    }

                    if (type === 'Admin') {
                        // Routes to the bucket-resolved admin contact
                        // (getSupportEmail() — nearest-ancestor-wins
                        // contactEmail, the same one an access-denied
                        // banner shows) instead of Bug/Suggestion's
                        // /feedback -> GitHub issue path, which always
                        // lands in the TOOL MAINTAINER's repo — the wrong
                        // destination for a question about this specific
                        // site's setup. No server round trip needed here;
                        // it's a plain mailto draft the user reviews
                        // before sending.
                        sendBtn.disabled = false;
                        statusSpan.textContent = 'Opening email draft to ' + getSupportEmail() + '...';
                        openEmailDraft(getSupportEmail(), 'WO Review Tool — question from a user', fullContext);
                        div.querySelector('#__fb_body').value = '';
                        return;
                    }

                    getWorkerAccessToken().then(function(token) {
                        return xhrPostJSON(WORKER_BASE_URL + '/feedback', {
                            token: token,
                            type: type,
                            body: body,
                            context: fullContext
                        });
                    }).then(function(res) {
                        sendBtn.disabled = false;
                        if (res && res.ok) {
                            statusSpan.textContent = 'Sent — thank you.';
                            div.querySelector('#__fb_body').value = '';
                        } else {
                            statusSpan.textContent = 'Could not file report — opening an email draft instead.';
                            openEmailDraft(getSupportEmail(), 'WO Review Tool ' + type + ' report', fullContext);
                        }
                    }).catch(function() {
                        sendBtn.disabled = false;
                        statusSpan.textContent = 'Could not reach the report system — opening an email draft instead.';
                        openEmailDraft(getSupportEmail(), 'WO Review Tool ' + type + ' report', fullContext);
                    });
                });
            };
        }

        // ── PROFILES TAB ──
        function profilesTab() {
            content.innerHTML = '';

            var activeId = getActiveProfileId();
            var profiles = getProfiles();

            // ── Local profiles ──
            var localDiv = document.createElement('div');
            localDiv.className = 'wo-card';
            var localHtml = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Local Profiles</span></div>' +
                '<div data-coll-body style="margin-top:7px;">';
            var ids = Object.keys(profiles);
            if (!ids.length) {
                localHtml += '<div style="color:var(--wo-muted);font-size:11px;">No saved profiles yet — save one below, or import a preset.</div>';
            } else {
                var onlyOne = ids.length === 1;
                ids.forEach(function(id) {
                    var p = profiles[id];
                    var isActive = id === activeId;
                    // Can't switch to the profile you're already on, and if
                    // it's your only saved profile that's also true by
                    // definition — check both explicitly rather than
                    // relying on isActive alone matching correctly.
                    var switchBlocked = isActive || onlyOne;
                    // Can't delete the active profile, and can't delete your last
                    // remaining one either way — disable clearly, don't just rely on
                    // the disabled attribute's default (subtle) look.
                    var deleteBlocked = isActive || onlyOne;
                    var deleteReason = isActive ?
                        'Switch to another profile first' :
                        'This is your only saved profile';
                    localHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border:1px solid ' + (isActive ? 'var(--wo-pass)' : 'var(--wo-border)') + ';border-radius:var(--wo-r-ctl);margin-bottom:6px;background:var(--wo-field);">' +
                        '<div style="font-size:11px;"><b>' + (p.name || id) + '</b>' + (isActive ? ' <span style="color:var(--wo-pass);font-size:10px;">(active)</span>' : '') +
                        '<br><span style="color:var(--wo-muted);font-size:10px;">' + (p.description || '') + '</span></div>' +
                        '<span class="wo-kebab-wrap" onclick="event.stopPropagation()">' +
                        '<button data-pf-kebab type="button" class="wo-kebab-btn" data-id="' + id + '" aria-label="Profile actions" aria-haspopup="true">' +
                        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="3" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.7" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="13" r="0.7" stroke="currentColor" stroke-width="1.4"/></svg>' +
                        '</button>' +
                        '</span>' +
                        '</div>';
                });
            }
            localHtml += '</div>' +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__pf_save_new" type="button" class="wo-btn wo-btn-primary" style="font-size:11px;">Save As New</button>' +
                '<button id="__pf_blank" type="button" class="wo-btn" style="font-size:11px;">Start Blank</button>' +
                '</div>' +
                '</div>';
            localDiv.innerHTML = localHtml;
            content.appendChild(localDiv);
            makeCollapsible(localDiv, 'Local Profiles', false);

            // Switch/Duplicate/Delete consolidated into one "..." menu per
            // row (same wo-kebab-menu convention as the Variables/Rules
            // tabs — see closeRuleMenu()/openRuleMenu above) instead of
            // separate always-visible buttons.
            localDiv.querySelectorAll('[data-pf-kebab]').forEach(function(kebabBtn) {
                kebabBtn.onclick = function(ev) {
                    ev.stopPropagation();
                    var wasOpen = !!openRuleMenu;
                    closeRuleMenu();
                    if (wasOpen) return;
                    var id = kebabBtn.getAttribute('data-id');
                    var isActive = id === activeId;
                    var switchDisabled = isActive || onlyOne;
                    var deleteDisabled = isActive || onlyOne;
                    var deleteReason = isActive ? 'Switch to another profile first' : 'This is your only saved profile';
                    var menu = document.createElement('div');
                    menu.className = 'wo-kebab-menu';
                    menu.innerHTML =
                        '<button data-switch type="button" class="wo-kebab-item"' + (switchDisabled ? ' disabled title="' + (isActive ? 'Already active' : deleteReason) + '"' : '') + '>' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                        '<span>Switch</span>' +
                        '</button>' +
                        '<button data-dup type="button" class="wo-kebab-item">' +
                        '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 10.2V3.8C3.5 3.1 4.1 2.5 4.8 2.5H10.2" stroke="currentColor" stroke-width="1.3"/></svg>' +
                        '<span>Duplicate</span>' +
                        '</button>' +
                        '<button data-del type="button" class="wo-kebab-item wo-kebab-item-danger"' + (deleteDisabled ? ' disabled title="' + deleteReason + '"' : '') + '>' +
                        TRASH_SVG +
                        '<span>Delete</span>' +
                        '</button>';
                    menu.style.position = 'fixed';
                    var btnRect = kebabBtn.getBoundingClientRect();
                    menu.style.top = (btnRect.bottom + 4) + 'px';
                    menu.style.right = (window.innerWidth - btnRect.right) + 'px';
                    modal.appendChild(menu);
                    var mr = menu.getBoundingClientRect();
                    if (mr.bottom > window.innerHeight) menu.style.top = Math.max(4, btnRect.top - mr.height - 4) + 'px';

                    var switchBtn = menu.querySelector('[data-switch]');
                    if (!switchDisabled) switchBtn.onclick = function(e) {
                        e.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Switch to "' + (profiles[id].name || id) + '"? Your current config is saved first.').then(function(ok) {
                            if (!ok) return;
                            flushLiveConfigToStorage();
                            try {
                                switchProfile(id);
                            } catch (err) {
                                // migrateProfile() throws if this profile's configVersion is
                                // newer than what this tool build understands - never leave
                                // it half-applied or silently claim success.
                                woAlert(err.message);
                                return;
                            }
                            woAlert('Switched to "' + (profiles[id].name || id) + '".').then(function() {
                                modal.remove();
                                render();
                            });
                        });
                    };
                    menu.querySelector('[data-dup]').onclick = function(e) {
                        e.stopPropagation();
                        closeRuleMenu();
                        flushLiveConfigToStorage();
                        var p2 = getProfiles();
                        // The ACTIVE profile's stored blob can lag behind live
                        // in-memory edits until Save is clicked - re-snapshot
                        // from current state for that one case (same source
                        // "Save As New" uses), otherwise the stored blob is
                        // already the authoritative copy.
                        var src = isActive ? snapshotProfile(p2[id]) : p2[id];
                        var newId = id + '-copy-' + Date.now();
                        var copy = JSON.parse(JSON.stringify(src));
                        copy.id = newId;
                        copy.name = (src.name || id) + ' (copy)';
                        copy.savedAt = new Date().toISOString();
                        p2[newId] = copy;
                        saveProfiles(p2);
                        woAlert('Duplicated as "' + copy.name + '".').then(function() {
                            profilesTab();
                        });
                    };
                    var delBtn = menu.querySelector('[data-del]');
                    if (!deleteDisabled) delBtn.onclick = function(e) {
                        e.stopPropagation();
                        closeRuleMenu();
                        woConfirm('Delete profile "' + (profiles[id].name || id) + '"? This cannot be undone.').then(function(ok) {
                            if (!ok) return;
                            var p3 = getProfiles();
                            delete p3[id];
                            saveProfiles(p3);
                            profilesTab();
                        });
                    };
                    openRuleMenu = menu;
                };
            });
            localDiv.querySelector('#__pf_save_new').onclick = function() {
                woPrompt('Name for this profile:').then(function(name) {
                    if (!name) return;
                    var id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('profile-' + new Date().toISOString());
                    woPrompt('Short description (optional):').then(function(desc) {
                        desc = desc || '';
                        flushLiveConfigToStorage();
                        var snap = snapshotProfile({
                            id: id,
                            name: name.trim(),
                            description: desc
                        });
                        // Set active BEFORE registerProfile's own auto-save fires, so a
                        // linked PC backup file reflects the new active profile right away.
                        localStorage.setItem(ACTIVE_PROFILE_KEY, id);
                        registerProfile(snap);
                        woAlert('Saved as "' + name.trim() + '".').then(function() {
                            profilesTab();
                        });
                    });
                });
            };

            localDiv.querySelector('#__pf_blank').onclick = function() {
                woPrompt('Name for the new blank profile:').then(function(name) {
                    if (!name) return;
                    var id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('profile-' + new Date().toISOString());
                    woPrompt('Short description (optional):').then(function(desc) {
                        desc = desc || '';
                        var blank = {
                            id: id,
                            name: name.trim(),
                            description: desc,
                            configVersion: 1,
                            rules: {
                                groups: [],
                                rules: []
                            },
                            scan: {
                                woTabId: DEFAULT_SCAN.woTabId,
                                scans: []
                            },
                            fields: {},
                            state: {},
                            vars: [],
                            settings: {},
                            savedAt: new Date().toISOString()
                        };
                        woConfirm('Switch to blank profile "' + name.trim() + '"? Your current config is saved first.').then(function(ok) {
                            if (!ok) return;
                            flushLiveConfigToStorage();
                            registerProfile(blank);
                            switchProfile(id); // preserves the outgoing profile's live edits, same as any switch
                            woAlert('Started blank profile "' + name.trim() + '". Build it out in Rules/Groups/Scan/Variables.').then(function() {
                                modal.remove();
                                render();
                            });
                        });
                    });
                });
            };

            // ── Organization configs (admin-managed, /admin/configs) ──
            // The list itself is a pure localStorage read (getOrgConfigs(),
            // metadata only) — cached by loader.js on the tool's last real
            // check-access call (piggybacked on the existing 15-min grant
            // cache, no new network trigger from opening this tab). Content
            // is only ever fetched live, at the exact moment "Import &
            // Switch" is clicked (installOrgConfig() -> fetchOrgConfigsLive())
            // — same re-import-with-backup UX as the GitHub presets card
            // below, but nothing is ever applied without that explicit
            // click + confirm.
            var orgCardDiv = document.createElement('div');
            orgCardDiv.className = 'wo-card';
            orgCardDiv.innerHTML = '<div data-coll-header class="wo-card-head"><span class="wo-rule-title">Organization Configs</span></div>' +
                '<div data-coll-body style="margin-top:7px;"><div id="__pf_org_list" style="color:var(--wo-muted);font-size:11px;"></div></div>';
            content.appendChild(orgCardDiv);
            makeCollapsible(orgCardDiv, 'Organization Configs', false);

            (function renderOrgConfigsCard() {
                var list = getOrgConfigs();
                var listDiv = orgCardDiv.querySelector('#__pf_org_list');
                if (!list || !list.length) {
                    listDiv.innerHTML = '<div style="color:var(--wo-muted);font-size:11px;">No organization configs are currently available to you.</div>';
                    return;
                }
                var byId = {};
                list.forEach(function(c) { byId[c.id] = c; });
                listDiv.innerHTML = list.map(function(c) {
                    var already = !!profiles['org_' + c.id];
                    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border:1px solid var(--wo-border);border-radius:var(--wo-r-ctl);margin-bottom:6px;background:var(--wo-field);">' +
                        '<div style="font-size:11px;"><b>' + orgConfigDisplayName(c) + '</b><br><span style="color:var(--wo-muted);font-size:10px;">' + (c.description || '') + '</span></div>' +
                        '<button type="button" class="__pf_org_import wo-btn" data-id="' + c.id + '" style="font-size:11px;padding:4px 9px;">' + (already ? 'Re-import &amp; Switch' : 'Import &amp; Switch') + '</button>' +
                        '</div>';
                }).join('');
                listDiv.querySelectorAll('.__pf_org_import').forEach(function(btn) {
                    btn.onclick = function() {
                        var id = btn.getAttribute('data-id');
                        var name = (byId[id] && orgConfigDisplayName(byId[id])) || id;
                        var profileId = 'org_' + id;
                        var already = !!profiles[profileId];
                        function proceed() {
                            btn.disabled = true;
                            btn.textContent = 'Importing...';
                            installOrgConfig(id).then(function(result) {
                                var ok = !!(result && result.ok);
                                if (ok) {
                                    woAlert('Imported and switched.' + (result.backupId ? ' Your previous version was saved as a backup profile — see Local Profiles.' : '')).then(function() {
                                        modal.remove();
                                        render();
                                    });
                                } else {
                                    btn.disabled = false;
                                    btn.textContent = 'Failed — retry';
                                }
                            }).catch(function(e) {
                                btn.disabled = false;
                                btn.textContent = 'Failed — retry';
                                if (e && /configVersion|newer version/.test(e.message)) woAlert(e.message);
                            });
                        }
                        if (already) {
                            var isActive = getActiveProfileId() === profileId;
                            var msg = 'Re-import "' + name + '"?\n\n' +
                                (isActive ?
                                    'This is your currently active config — it will be overwritten with the latest organization version.' :
                                    'Your locally saved "' + name + '" profile will be overwritten with the latest organization version.') +
                                '\n\nWhatever it currently holds will be saved as a backup profile first, so nothing is lost — but any local edits you made under this profile stop being the "' + name + '" profile once this runs.';
                            woConfirm(msg).then(function(ok) {
                                if (ok) proceed();
                            });
                        } else {
                            proceed();
                        }
                    };
                });
            })();

            // ── GitHub presets ──
        }

        var tabFns = {};
        function bindTab(id, fn, onReclick) {
            var btn = modal.querySelector('#' + id);
            if (!btn) return; // tab not rendered (e.g. Install, dev-only)
            tabFns[id] = fn;
            btn.onclick = function() {
                // Clicking a tab header that's already active is the one
                // explicit "reset" gesture for state a tab preserves across
                // ordinary tab switches (e.g. Rules' expand/collapse) —
                // everything else (switching away and back) must leave it
                // alone, so this only fires on a genuine re-click.
                if (onReclick && this.classList.contains('is-active')) onReclick();
                tabScrollPos[currentTabId] = content.scrollTop;
                activateTab(id);
                fn();
                currentTabId = id;
                content.scrollTop = tabScrollPos[id] || 0;
            };
        }
        bindTab('__s_admin', adminTab);
        bindTab('__s_guide', guideTab);
        bindTab('__s_feedback', feedbackTab);
        bindTab('__s_rules', rulesTab, function() {
            ruleExpandState = {};
        });
        bindTab('__s_vars', varsTab, function() {
            varExpandState = {};
        });
        bindTab('__s_groups', groupsTab, function() {
            groupExpandState = {};
        });
        bindTab('__s_scan', scanTab, function() {
            scanExpandState = {};
        });
        bindTab('__s_tables', tablesTab);
        bindTab('__s_profiles', profilesTab);
        bindTab('__s_settings', settingsTab);
        bindTab('__s_beta', betaTab);
        bindTab('__s_update', updateTab);
        activateTab('__s_rules');
        rulesTab();
    }

    function startWOWatcher() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (!st.autoScan) return;
        if (window.__wo_watcher_interval) return; // already running

        window.__wo_watcher_interval = setInterval(function() {
            if (scanning) return; // don't trigger during an active scan
            var st2 = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            if (!st2.autoScan) return;

            var storedCfg = {};
            try {
                storedCfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
            } catch (e) {}
            var woEntry = null;
            Object.keys(storedCfg).forEach(function(k) {
                var e = storedCfg[k];
                if (e.type !== 'table-column' && (k === 'Work Order :: Work Order' || e.label === 'Work Order')) {
                    woEntry = e;
                }
            });

            var currentWO = woEntry ? resolveField(woEntry) : '';
            var lastWO = localStorage.getItem('__wo_last_scanned_wo') || '';

            if (currentWO && currentWO !== lastWO) {
                setStatus('New WO detected — auto-scanning...');
                runScan(render);
            }
        }, 500); // checks every .5 seconds
    }


    function checkAutoScan() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (!st.autoScan) return;

        // Read the current WO number visible on the page right now
        var storedCfg = {};
        try {
            storedCfg = JSON.parse(localStorage.getItem(FKEY) || '{}');
        } catch (e) {}

        // Find the field config entry for the WO number field
        var woEntry = null;
        Object.keys(storedCfg).forEach(function(k) {
            var e = storedCfg[k];
            if (e.type !== 'table-column' && (k === 'Work Order :: Work Order' || e.label === 'Work Order')) {
                woEntry = e;
            }
        });

        var currentWO = woEntry ? resolveField(woEntry) : '';
        var lastWO = localStorage.getItem('__wo_last_scanned_wo') || '';

        if (currentWO && currentWO !== lastWO) {
            setStatus('New WO detected — auto-scanning...');
            runScan(render);
        }
    }

    function applyHotkeys() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        if (window.__wo_hk_listener) document.removeEventListener('keydown', window.__wo_hk_listener);
        // No need to touch the Scan button's tooltip here — attachTooltip()
        // was bound with scanBtnTooltipText itself (not a frozen string), so
        // it re-reads __wo_settings fresh on every hover and can't go stale.
        var byCombo = {};
        HOTKEY_ACTIONS.forEach(function(action) {
            if (!hotkeyActionActive(action)) return; // beta feature off (or never granted) — this action doesn't exist right now
            var hk = hotkeyFor(action, st);
            if (hk) byCombo[hk] = action; // the Settings UI is what actually prevents two actions colliding on one combo
        });
        if (!Object.keys(byCombo).length) return;

        window.__wo_hk_listener = function(e) {
            // Never fire while the user is typing somewhere editable in
            // THIS tool's own UI (Setup's formula boxes, the Feedback
            // textarea, quick-return inputs, etc. — everything the tool
            // renders lives in the same top-level document as this
            // listener, unlike Maximo's own fields which are isolated
            // inside iframes and never reach a top-document keydown
            // listener at all). This matters more now than when only Scan
            // (read-only) had a hotkey: Fix silently overwrites field
            // values with no confirm dialog, so an accidental trigger
            // mid-typing would be a real, silent data change.
            var activeEl = document.activeElement;
            if (activeEl) {
                var tag = activeEl.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl.isContentEditable) return;
            }
            var parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
            var action = byCombo[parts.join('+')];
            if (action) {
                e.preventDefault();
                action.run();
            }
        };
        document.addEventListener('keydown', window.__wo_hk_listener);
    }
    applyHotkeys();

    buildPanel();
    // mergeSnapshot(extractSnapshotFull());

    startupRestore().then(function() {
        // A fresh install (nothing restored from a linked backup file) gets an
        // interactive installer instead of a silent default. Anything already
        // restored (RKEY present) skips straight through.
        if (!localStorage.getItem(RKEY)) {
            return showInstaller().then(function() {
                applyHotkeys(); // config just arrived — (re)attach hotkey listener from it
                // Backup-setup nag was suppressed in startupRestore() for fresh
                // installs specifically so it wouldn't race the installer — surface
                // it now that setup is done, if still relevant.
                var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
                if (!st.autoBackup && !st.backupPromptDismissed) {
                    setTimeout(function() {
                        showBackupSetupPrompt('No backup protection yet — set up a backup file to protect your new config.');
                    }, 500);
                }
            });
        }
    }).then(function() {
        // One-time write-back: if storage still has old-shape rules (an old
        // profile, a restored backup, a stale pin), persist the normalized
        // form now so later getCfg() calls hit the fast already-migrated path
        // instead of re-normalizing every time. Purely a perf optimization —
        // getCfg() normalizes on every read regardless, so correctness never
        // depends on this running.
        try {
            var rawCfgCheck = JSON.parse(localStorage.getItem(RKEY) || 'null');
            if (rawCfgCheck && rawCfgCheck.rules && rawCfgCheck.rules.some(function(r) {
                    return !isNewRuleShape(r);
                })) {
                saveCfg(getCfg());
            }
        } catch (e) {}
        // Same write-back, but for STORED (not-currently-active) profiles —
        // switching to one later must not fold in whatever ruleReturnCfg the
        // active profile happens to have left in live settings, so each
        // profile's own settings.ruleReturnCfg is passed in explicitly.
        try {
            var profiles = getProfiles();
            var profilesChanged = false;
            Object.keys(profiles).forEach(function(pid) {
                var p = profiles[pid];
                if (!p || !p.rules || !p.rules.rules) return;
                var needsMigration = p.rules.rules.some(function(r) {
                    return !isNewRuleShape(r);
                });
                if (!needsMigration) return;
                var legacyAll = (p.settings && p.settings.ruleReturnCfg) || {};
                p.rules = normalizeCfg(p.rules, legacyAll);
                if (p.settings) {
                    delete p.settings.ruleReturnCfg;
                    delete p.settings.ruleMessages;
                }
                profilesChanged = true;
            });
            if (profilesChanged) saveProfiles(profiles);
        } catch (e) {}
        // Must run before this first render() — see its own comment for
        // why (a freshly-applied update should show the SAME scan results
        // the old instance had, not a blank "press Scan" slate).
        restoreUpdateSnapshotIfAny();
        render();
        if (window.__wo_pending_scroll_restore) {
            // bodyEl only exists after render()'s own buildPanel() call -
            // this is the other half of restoreUpdateSnapshotIfAny()'s
            // handoff, see its comment.
            if (bodyEl) bodyEl.scrollTop = window.__wo_pending_scroll_restore;
            delete window.__wo_pending_scroll_restore;
        }
        checkAutoScan();
        startWOWatcher();
        checkForUpdate();
        // Fire-and-forget: a no-op unless the opt-in Settings toggle is on;
        // re-renders once loaded so a whoami()-using rule that evaluated
        // empty on the very first paint picks up the real value without
        // needing a manual rescan.
        refreshWhoamiIfEnabled();
    });

})();
