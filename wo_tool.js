(function __WO_TOOL__() {
    var FKEY = '__wo_field_config',
        RKEY = '__wo_rules_config',
        GSTATE = '__wo_group_state',
        SKEY = '__wo_scan_config',
        VKEY = '__wo_vars_config';

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
    var TOOL_VERSION = '0.17.0';
    // Built-in fallback hotkey — used whenever __wo_settings has never set
    // rescanHotkey (undefined), regardless of which config/profile is loaded.
    // An explicit '' (user hit "Clear" in Setup) is a deliberate choice and
    // is left alone, not overridden.
    var DEFAULT_HOTKEY = 'Ctrl+Shift+S';
    var DEFAULT_CFG = {
        groups: [{
            id: 'g_core',
            title: 'Work Order Summary',
            layout: 'vertical',
            fields: ['Work Order :: Work Order', 'Work Order :: Description', 'Work Order :: Asset', 'Work Order :: Location', 'Work Order :: Work Type', 'Work Order :: Status'],
            table: null,
            ruleRefs: [],
            defaultCollapsed: false
        }, {
            id: 'g_time',
            title: 'Time Check',
            layout: 'horizontal',
            fields: ['Work Order :: Actual Start', 'Work Order :: Actual Finish', 'Work Order :: Duration'],
            table: null,
            ruleRefs: ['r_duration'],
            defaultCollapsed: false
        }, {
            id: 'g_lot',
            title: 'Lot Number',
            layout: 'vertical',
            fields: ['Work Order :: Production Run Lot #'],
            table: null,
            ruleRefs: ['r_lot'],
            defaultCollapsed: false
        }, {
            id: 'g_downtime',
            title: 'Downtime History',
            layout: 'vertical',
            fields: [],
            table: 'm69f3c12d',
            ruleRefs: ['r_downtime'],
            defaultCollapsed: true
        }, {
            id: 'g_related',
            title: 'Related Work Orders',
            layout: 'vertical',
            fields: [],
            table: 'Related Work Orders',
            ruleRefs: ['r_related'],
            defaultCollapsed: true
        }, {
            id: 'g_approvers',
            title: 'Approvers',
            layout: 'vertical',
            fields: ['Approvers :: Approval Group 1', 'Approvers :: Approval Group 2', 'Approvers :: Approval Group 3'],
            table: null,
            ruleRefs: ['r_approver'],
            defaultCollapsed: true
        }, {
            id: 'g_labor',
            title: 'Labor',
            layout: 'vertical',
            fields: [],
            table: 'Labor',
            ruleRefs: [],
            defaultCollapsed: false
        }],
        rules: [{
            id: 'r_lot',
            label: 'Lot Number Provided',
            formula: "var lot=(F('Work Order :: Production Run Lot #')||'').trim();\nif(/^n\\/?a$/i.test(lot)) return 'na';\nreturn lot.length>3;",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_duration',
            label: 'Time Validated',
            formula: "var d=hours(F('Work Order :: Duration'));\nvar a=hoursBetween(F('Work Order :: Actual Start'),F('Work Order :: Actual Finish'));\nif(d==null) return 'na';\nif(a==null) return 'na';\nreturn d<=a;",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }, {
            id: 'r_downtime',
            label: 'Downtime Logged',
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
            label: 'Production Approver',
            formula: "var lot=(F('Work Order :: Production Run Lot #')||'').trim();\nif(/^n\\/?a$/i.test(lot)||lot.length<=3) return 'na';\nvar loc=F('Work Order :: Location')||'';\nvar field='Approvers :: Approval Group 3';\nif(loc.indexOf('AVWP-B1')===0) field='Approvers :: Approval Group 1';\nelse if(loc.indexOf('AVWP-B2')===0) field='Approvers :: Approval Group 2';\nreturn notEmpty(F(field));",
            pass: { short: '', long: [] },
            fail: { short: '', long: [], returnMode: 'none', returnCustom: '' },
            warn: { short: '', long: [], returnMode: 'none', returnCustom: '' }
        }]
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
            if (g.table && !tableGroups[g.table]) tableGroups[g.table] = [];
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

    function buildCtx(data) {
        function F(key) {
            if (data.fields.hasOwnProperty(key)) return data.fields[key];
            var suf = ' :: ' + key;
            var fk = Object.keys(data.fields).filter(function(k) {
                return k.slice(-suf.length) === suf;
            })[0];
            return fk ? data.fields[fk] : '';
        }

        function T(t) {
            return data.tables[t] || [];
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
            isEmpty: isEmptyFn,
            notEmpty: notEmptyFn,
            hours: hoursFn,
            hoursBetween: hoursBetweenFn,
            oneOf: oneOfFn,
            contains: containsFn,
            matches: matchesFn,
            maxLaborHours: function(tableTitle, nameCol, hoursCol) {
                return maxLaborHoursFn(T(tableTitle), nameCol, hoursCol);
            },
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

    var ARGN = ['F', 'T', 'rowCount', 'col', 'has', 'isEmpty', 'notEmpty', 'hours', 'hoursBetween', 'oneOf', 'contains', 'matches', 'maxLaborHours', 'V'];

    function runVariable(formula, data) {
        var c = buildCtx(data);
        var av = [c.F, c.T, c.rowCount, c.col, c.has, c.isEmpty, c.notEmpty, c.hours, c.hoursBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.V];
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
        var c = buildCtx(data);
        var av = [c.F, c.T, c.rowCount, c.col, c.has, c.isEmpty, c.notEmpty, c.hours, c.hoursBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.V];
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
    function applyBackup(b) {
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
        profiles[p.id] = p;
        saveProfiles(profiles);
    }

    // ── GitHub-hosted preset fetch (configs/index.json + configs/<id>.json) ──
    function fetchProfileIndex() {
        return new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', REPO_RAW_BASE + '/main/configs/index.json', true);
            xhr.onload = function() {
                if (xhr.status !== 200) {
                    resolve([]);
                    return;
                }
                try {
                    resolve(JSON.parse(xhr.responseText) || []);
                } catch (e) {
                    resolve([]);
                }
            };
            xhr.onerror = function() {
                resolve([]);
            };
            xhr.send();
        });
    }

    function fetchProfile(id) {
        return new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', REPO_RAW_BASE + '/main/configs/' + id + '.json', true);
            xhr.onload = function() {
                if (xhr.status !== 200) {
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    resolve(null);
                }
            };
            xhr.onerror = function() {
                resolve(null);
            };
            xhr.send();
        });
    }

    // Download a GitHub preset, register it locally, and switch to it.
    function installProfileFromGitHub(id) {
        return fetchProfile(id).then(function(p) {
            if (!p) return false;
            registerProfile(p);
            localStorage.setItem(ACTIVE_PROFILE_KEY, p.id); // before applyProfile's auto-save fires
            applyProfile(p);
            return true;
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
        banner.style.cssText = 'background:#1a2e3a;border:1px solid #2980b9;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;';
        banner.innerHTML =
            '<div style="color:#7ec8e3;font-weight:bold;margin-bottom:4px;">⚠ Config was reset — backup file found</div>' +
            '<div style="color:#aaa;margin-bottom:6px;">Click below to restore your settings from <b>' + (handle.name || 'backup') + '</b></div>' +
            '<button id="__wo_restore_btn" style="background:#2980b9;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">Restore Config</button>' +
            ' <button id="__wo_restore_skip" style="background:none;border:none;color:#666;cursor:pointer;font-size:11px;">Start Fresh</button>';
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
                            setStatus('✅ Config restored from ' + handle.name);
                        } catch (e) {
                            banner.remove();
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
        banner.style.cssText = 'background:#1a2a1a;border:1px solid #2ecc71;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;';
        banner.innerHTML =
            '<div style="color:#2ecc71;font-weight:bold;margin-bottom:4px;">📂 Newer config found in backup file</div>' +
            '<div style="color:#aaa;margin-bottom:6px;">' +
            'Backup file: <b>' + fileSavedAt.slice(0, 16).replace('T', ' ') + '</b><br>' +
            'Current config: <b>' + localSavedAt.slice(0, 16).replace('T', ' ') + '</b><br>' +
            'This may be from another browser session. Load the backup?</div>' +
            '<div style="display:flex;gap:6px;">' +
            '<button id="__wo_load_bak_btn" style="background:#2ecc71;color:#000;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">Load Backup</button>' +
            '<button id="__wo_keep_local_btn" style="background:none;border:none;color:#666;cursor:pointer;font-size:11px;">Keep Current</button>' +
            '</div>';
        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_load_bak_btn').onclick = function() {
            applyBackup(b);
            banner.remove();
            render();
            setStatus('✅ Config loaded from backup file');
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
        banner.style.cssText = 'background:#2a1a1a;border:1px solid #e74c3c;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;';
        banner.innerHTML =
            '<div style="color:#e74c3c;font-weight:bold;margin-bottom:4px;">⚠ No backup protection</div>' +
            '<div style="color:#aaa;margin-bottom:6px;">' + message + '</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button id="__wo_set_new_backup" style="background:#e74c3c;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">Set New Backup Location</button>' +
            '<button id="__wo_link_backup" style="background:#555;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Link Existing Backup File</button>' +
            '<button id="__wo_backup_dismiss" style="background:none;border:none;color:#666;cursor:pointer;font-size:11px;">Don\'t ask again</button>' +
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
            alert('Your browser does not support file system access. Use Chrome or Edge for auto-backup.');
            return Promise.resolve();
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
                        setStatus('✅ Backup saved to ' + handle.name + ' — auto-save enabled');
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
            alert('Your browser does not support file system access. Use Chrome or Edge.');
            return Promise.resolve();
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
                                setStatus('✅ Config loaded and backup linked to ' + handle.name);
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
                                setStatus('✅ Config restored from backup file (' + fileSavedAt.slice(0, 10) + ')');
                            } else if (fileSavedAt > localSavedAt) {
                                setStatus('📂 Backup file is newer — see prompt above');
                                showNewerBackupPrompt(b, fileSavedAt, localSavedAt);
                            } else {
                                setStatus('✅ Backup OK — ' + handle.name + ' (up to date)');
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

    // ── Dev/beta unlock (console-only, deliberately not in Setup UI) ──
    // Stored outside __wo_settings so it never rides along in a shared/exported backup.
    var DEV_UNLOCK_KEY = '__wo_dev_unlock';
    var REPO_RAW_BASE = 'https://raw.githubusercontent.com/WilliamZitzmann/WO-Review-Tool';

    function getDevTier() {
        var t = '';
        try {
            t = localStorage.getItem(DEV_UNLOCK_KEY) || '';
        } catch (e) {}
        return (t === 'beta' || t === 'dev') ? t : '';
    }

    window.__woEnableBeta = function() {
        if (getDevTier() === 'dev') {
            console.log('[WO Tool] Developer mode already unlocked (includes beta). Use window.__woLockDev() to reset.');
            return 'dev';
        }
        localStorage.setItem(DEV_UNLOCK_KEY, 'beta');
        console.log('[WO Tool] Beta features unlocked. Reopen Setup > Settings to see Update Channel.');
        return 'beta';
    };

    window.__woEnableDev = function() {
        localStorage.setItem(DEV_UNLOCK_KEY, 'dev');
        console.log('[WO Tool] Developer mode unlocked. Reopen Setup > Settings to see Update Channel.');
        return 'dev';
    };

    window.__woLockDev = function() {
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
                codeUrl: REPO_RAW_BASE + '/main/wo_tool.js',
                pinned: false
            };
        }

        var pin = st.pinnedVersion || '';
        if (pin && isPrerelease(pin) && tier !== 'beta' && tier !== 'dev') pin = '';

        var channels = remote.channels || {};
        var version = pin || channels[channel] || channels.stable || remote.latest;
        return {
            channel: channel,
            version: version,
            codeUrl: REPO_RAW_BASE + '/v' + version + '/wo_tool.js',
            pinned: !!pin
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
        var GITHUB_VERSION_URL = REPO_RAW_BASE + '/main/version.json';
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
                    checkDevUpdate(target.codeUrl);
                    return;
                }

                if (target.version === TOOL_VERSION) {
                    dismissUpdateBanner();
                    setStatus(target.pinned ?
                        '📌 Pinned to v' + TOOL_VERSION :
                        'Running the latest ' + target.channel + ' version (v' + TOOL_VERSION + ')');
                    return;
                }

                if (target.pinned) {
                    // Explicit user pin/rollback — install immediately, no prompt.
                    // No banner ever shows while pinned; a stale one from before the
                    // pin was set must not linger and offer a conflicting install.
                    dismissUpdateBanner();
                    setStatus('🔄 Installing pinned v' + target.version + '...');
                    installUpdate(target.version, target.codeUrl);
                    return;
                }

                if (st.autoUpdate) {
                    setStatus('🔄 Auto-installing update v' + target.version + '...');
                    installUpdate(target.version, target.codeUrl);
                } else {
                    var skipped = st.skippedVersion || '';
                    if (skipped === target.version) {
                        setStatus('Update v' + target.version + ' available (skipped — see Settings to re-enable)');
                        return;
                    }
                    setStatus('Update available - current version: v' + TOOL_VERSION);
                    showUpdatePrompt(remote, target);
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

    // ── Dev channel: tracks tip of main directly, no version numbers to compare ──
    function checkDevUpdate(codeUrl) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', codeUrl, true);
        xhr.onload = function() {
            if (xhr.status !== 200) {
                setStatus('Dev channel check failed (HTTP ' + xhr.status + ') — running v' + TOOL_VERSION);
                return;
            }
            var code = xhr.responseText;
            var cached = localStorage.getItem('__wo_tool_src') || '';
            if (code === cached) {
                setStatus('Running latest dev build (main) — v' + TOOL_VERSION);
                return;
            }
            setStatus('🔄 Installing latest dev build...');
            rawInstall(code, 'dev (main)');
        };
        xhr.onerror = function() {
            setStatus('Dev channel check: no connection — running v' + TOOL_VERSION);
        };
        xhr.send();
    }

    // ── Show update prompt with cumulative changelog ──
    function showUpdatePrompt(remote, target) {
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
                '<span style="color:#2ecc71;font-weight:bold;">v' + v.version + '</span>' +
                '<ul style=\"margin:2px 0 0 16px;padding:0 0 0 16px;color:#aaa;list-style:disc;\">' +
                (v.changes || []).map(function(c) {
                    return '<li>' + c + '</li>';
                }).join('') +
                '</ul></div>';
        }).join('');
        var banner = document.createElement('div');
        banner.id = '__wo_update_banner';
        banner.style.cssText = 'background:#1a2e1a;border:1px solid #2ecc71;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;';
        banner.innerHTML =
            '<div style="color:#2ecc71;font-weight:bold;margin-bottom:6px;"> Latest ' + target.channel + ' version: v' + target.version + '<br>' +
            '<div style="max-height:120px;overflow-y:auto;margin-bottom:8px;">' + changelogHtml + '</div>' +
            '<div style="display:flex;gap:6px;">' +
            '<button id="__wo_update_btn" style="background:#2ecc71;color:#000;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">Install Update</button>' +
            '<button id="__wo_update_skip" style="background:none;border:none;color:#666;cursor:pointer;font-size:11px;">Skip</button>' +
            '<button id="__wo_update_disable" style="background:none;border:none;color:#555;cursor:pointer;font-size:11px;">Disable Updates</button>' +
            '</div>';

        if (bodyEl) bodyEl.insertBefore(banner, bodyEl.firstChild);
        document.getElementById('__wo_update_btn').onclick = function() {
            installUpdate(target.version, target.codeUrl);
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
    function rawInstall(code, label) {
        try {
            new Function(code);
        } catch (e) {
            setStatus('Update (' + label + ') has syntax error — aborted, still running v' + TOOL_VERSION);
            return;
        }
        localStorage.setItem('__wo_tool_src', code);
        setStatus('Update installed (' + label + ')! Reloading...');
        setTimeout(function() {
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

    // ── Install update from GitHub ──
    function installUpdate(newVersion, codeUrl) {
        setStatus('Downloading v' + newVersion + '...');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', codeUrl, true);
        xhr.onload = function() {
            if (xhr.status !== 200) {
                setStatus('Update download failed (HTTP ' + xhr.status + ') — still running v' + TOOL_VERSION);
                return;
            }
            // Reconcile an active pin to whatever's actually being installed. This
            // is the single choke point every install path (banner, pinned auto-
            // install, future affordances) goes through — without it, a pinned
            // user who explicitly installs a different version gets silently
            // reverted back to the old pin on the very next automatic check.
            // Only touches the pin if one was already active; unpinned users stay
            // unpinned.
            var pinSt = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            if (pinSt.pinnedVersion && pinSt.pinnedVersion !== newVersion) {
                pinSt.pinnedVersion = newVersion;
                localStorage.setItem('__wo_settings', JSON.stringify(pinSt));
            }
            rawInstall(xhr.responseText, 'v' + newVersion);
        };
        xhr.onerror = function() {
            setStatus('Network error during update — still running v' + TOOL_VERSION);
        };
        xhr.send();
    }

    function statusColor(s) {
        return s === 'pass' ? '#2ecc71' :
            s === 'fail' ? '#e74c3c' :
            s === 'warn' ? '#FF9800' :
            s === 'error' ? '#9b59b6' :
            '#9E9E9E';
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
    var scanLog = [];
    window.__wo_laborTypeCache = [];

    function runActions(step) {
        var actions = (step && step.actions) || [];
        if (!actions.length) return;
        actions.forEach(function(action) {
            try {
                if (action.condition) {
                    if (!formulaBool(action.condition, cache)) return;
                }
                var val = '';
                try {
                    var c = buildCtx(cache);
                    var av = [c.F, c.T, c.rowCount, c.col, c.has, c.isEmpty, c.notEmpty, c.hours, c.hoursBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.V];
                    var fn = Function.apply(null, ARGN.concat(['return (' + action.value + ');']));
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
                var av = [c.F, c.T, c.rowCount, c.col, c.has, c.isEmpty, c.notEmpty, c.hours, c.hoursBetween, c.oneOf, c.contains, c.matches, c.maxLaborHours, c.V];

                var fn = Function.apply(null, ARGN.concat(['return (' + expr.trim() + ');']));
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
            if (g.table && !(g.table in tableGroups)) tableGroups[g.table] = [];
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
    function runScan(done) {
        if (scanning) return;
        scanning = true;
        scanLog = [];
        cache = {
            fields: {},
            tables: {},
            tableErrors: {}
        };
        var sew = findSendEventWin();
        var scan = getScan();
        setStatus('Reading WO tab...');
        // mergeSnapshot(extractSnapshotFull());
        var targets = scan.scans.filter(function(s) {
            return formulaBool(s.condition, cache);
        });
        scan.scans.forEach(function(s) {
            if (targets.indexOf(s) < 0) scanLog.push({
                title: s.title,
                result: 'skipped (condition false)'
            });
        });
        var i = 0;

        function next() {
            if (i >= targets.length) return finish();
            var t = targets[i++];
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
                                runActions(t);
                                next();
                            });
                        } else {
                            runActions(t);
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
                setStatus('Scan complete ' + new Date().toLocaleTimeString());
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
                setStatus('Scan complete ' + new Date().toLocaleTimeString());
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

    function getGroupHiddenCols(gid) {
        var gs = getGS();
        return (gs[gid] && gs[gid].hiddenCols) || [];
    }

    function saveGroupHiddenCols(gid, cols) {
        var gs = getGS();
        if (!gs[gid]) gs[gid] = {};
        gs[gid].hiddenCols = cols;
        saveGS(gs);
    }
    var panel, bodyEl, statusEl;

    function setStatus(t) {
        if (statusEl) statusEl.textContent = t;
    }

    function pushLayout(on) {
        document.body.style.marginRight = on ? PANEL_W + 'px' : '';
        window.dispatchEvent(new Event('resize'));
        // Poll until the panel has actually taken its width, then fire one more
        // resize so any content that laid out before the panel was inserted reflows.
        if (on) {
            poll(function() {
                var dock = document.getElementById('__wo_dock');
                return dock && dock.offsetWidth > 0;
            }, 1000, function() {
                window.dispatchEvent(new Event('resize'));
            });
        }
    }

    function teardown() {
        var p = document.getElementById('__wo_dock');
        if (p) p.remove();
        pushLayout(false);
        panel = null;
        localStorage.removeItem('__wo_last_scanned_wo');
        if (window.__wo_watcher_interval) {
            clearInterval(window.__wo_watcher_interval);
            window.__wo_watcher_interval = null;
        }
    }




    function routeWorkflow(action) {
        var retMsg = action === 'return' ? buildReturnMessage() : '';

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
                        return;
                    }

                    poll(function() {
                        return !!(findElById('m71741679-rb') || findElById('m67326ef-rb'));
                    }, 8000, function(page2Ready) {
                        if (!page2Ready) {
                            setStatus('Action page did not appear. Select action manually.');
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
                                return;
                            }

                            if (action === 'return') {

                                function clickReturnRadio(attempt) {
                                    var p2r = findPage2Frame();
                                    if (!p2r) {
                                        setStatus('Lost page 2 frame.');
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
                                            return;
                                        }
                                        var p2c = findPage2Frame();
                                        if (!p2c) {
                                            setStatus('Lost page 2 frame. Fill memo manually.');
                                            return;
                                        }
                                        try {
                                            p2c.win.__wo_pending_memo = retMsg;
                                        } catch (e) {
                                            setStatus('Cannot write to dialog frame. Fill memo manually.');
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
                        return;
                    }
                    submitPage1();
                });
            }
        });
    }


    function buildPanel() {
        var old = document.getElementById('__wo_dock');
        if (old) old.remove();
        panel = document.createElement('div');
        panel.id = '__wo_dock';
        panel.style.cssText = 'position:fixed;top:0;right:0;width:' + PANEL_W + 'px;height:100vh;z-index:999999;background:#141414;color:#eee;font-family:Segoe UI,Arial,sans-serif;font-size:12px;display:flex;flex-direction:column;box-shadow:-4px 0 14px rgba(0,0,0,.5);';
        panel.innerHTML = '<div style="background:#2c2c2c;padding:8px;display:flex;justify-content:space-between;align-items:center;"><span style="display:flex;flex-direction:column;line-height:1.2;"><b style="font-size:12px;">Will\'s WO</b><b style="font-size:11px;color:#c2c2c2;font-weight:normal;">Review Tool</b></span><span style="color:#c2c2c2;font-size:9px;font-weight:normal;">v' + TOOL_VERSION + '</span><span><button id="__wo_rescan">Scan</button> <button id="__wo_setup">Setup</button> <button id="__wo_exit" style="color:#e74c3c;">Exit</button></span></div><div id="__wo_status" style="padding:2px 8px;color:#ff8;font-size:10px;min-height:14px;"></div><div id="__wo_scanlog" style="padding:0 8px 4px;font-size:10px;color:#999;max-height:80px;overflow:auto;"></div><div id="__wo_body" style="flex:1;overflow:auto;padding:6px;"></div>';
        document.body.appendChild(panel);
        bodyEl = panel.querySelector('#__wo_body');
        statusEl = panel.querySelector('#__wo_status');
        panel.querySelector('#__wo_rescan').onclick = function() {
            runScan(render);
        };
        panel.querySelector('#__wo_setup').onclick = openSetup;
        panel.querySelector('#__wo_exit').onclick = function() {
            if (confirm('Close WO Validation tool?')) teardown();
        };
        pushLayout(true);
        // Set rescan button title to show hotkey
        (function() {
            var st = {};
            try {
                st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            } catch (e) {}
            var hk = st.rescanHotkey || '';
            var btn = panel.querySelector('#__wo_rescan');
            if (btn) btn.title = hk ? 'Scan (' + hk + ')' : 'Scan';
        })();

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
        var full = (prefix ? prefix + (body ? delim : '') : '') + body + (suffix ? (body || prefix ? ' ' : '') + suffix : '');
        return full.trim();
    }

    function render() {
        if (!panel) buildPanel();
        renderScanLog();
        var cfg = getCfg(),
            gs = getGS();
        var results = {};
        cfg.rules.forEach(function(r) {
            var res = runFormula(r.formula, cache);
            res.label = r.label;
            results[r.id] = res;
        });
        bodyEl.innerHTML = '';

        // ── Pre-scan state ──
        var preScan = !hasScanned; // ← all Latin characters
        if (preScan) {
            var banner = document.createElement('div');
            banner.style.cssText = 'background:#1a1a2e;border:1px solid #2980b9;border-radius:6px;' +
                'padding:6px 10px;margin-bottom:8px;font-size:11px;color:#7ec8e3;text-align:center;';
            banner.innerHTML = '⟳ Press <b>Scan</b> to populate values';
            bodyEl.appendChild(banner);
        }

        var varCache = {};
        getVars().forEach(function(v) {
            var res = runVariable(v.formula, cache);
            varCache[v.id] = res.error ?
                ('⚠ ' + res.error) :
                (res.value !== null ? String(res.value) : ''); // stringify for display only
        });

        orderedGroups(cfg).forEach(function(group) {
            var varById = {};
            var st = gs[group.id] || {};
            if (st.visible === false) return;
            var collapsed = st.hasOwnProperty('collapsed') ? st.collapsed : !!group.defaultCollapsed;
            var tile = document.createElement('div');
            tile.setAttribute('data-gid', group.id);
            tile.style.cssText = 'margin-bottom:6px;border:1px solid #333;border-radius:6px;overflow:hidden;background:#181818;';
            var refs = group.ruleRefs || [];
            var dots = '';
            if (!preScan) {
                refs.forEach(function(id) {
                    var r = results[id];
                    if (r) dots += '<span title="' + r.label + '" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + statusColor(r.status) + ';margin-right:4px;"></span>';
                });
            }
            var tipHtml = '';
            if (group.tooltip) {
                tipHtml = '<span class="__wo_tip_icon" data-tip="' + group.tooltip.replace(/"/g, '&quot;') + '" style="color:#aaa;font-size:11px;cursor:default;margin-left:4px;">ⓘ</span>';
            }

            var bannerHtml = '';
            if (group.expandedMsg) {
                bannerHtml = '<div class="__wo_banner" style="padding:4px 10px;font-size:11px;color:#aad4f5;background:#1a2a36;border-bottom:1px solid #2a3a46;' + (collapsed ? 'display:none;' : '') + '">' + String(group.expandedMsg).replace(/</g, '&lt;') + '</div>';
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
                    if (s === 'pass') {
                        var passLong = resolveMsgList(rule.pass && rule.pass.long, cache);
                        if (passLong.length) {
                            subMsgs = passLong;
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">✓ Passed</span>';
                        } else {
                            var passShort = (rule.pass && rule.pass.short) ? resolveMsg(rule.pass.short, cache) : '';
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">' + (passShort ? '✓ ' + String(passShort).replace(/</g, '&lt;') : '✓ OK') + '</span>';
                        }
                    } else if (s === 'fail') {
                        var failLong = resolveMsgList(rule.fail && rule.fail.long, cache);
                        if (failLong.length) {
                            subMsgs = failLong;
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">✗ Failed</span>';
                        } else {
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">✗ ' + String(res.detail).replace(/</g, '&lt;') + '</span>';
                        }
                    } else if (s === 'warn') {
                        var warnLong = resolveMsgList(rule.warn && rule.warn.long, cache);
                        if (warnLong.length) {
                            subMsgs = warnLong;
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">⚠ Warning</span>';
                        } else {
                            statusLabel = '<span style="font-weight:bold;color:' + color + ';">⚠ ' + String(res.detail).replace(/</g, '&lt;') + '</span>';
                        }
                        // override subHtml color for warn
                    } else if (s === 'na') {
                        statusLabel = '<span style="font-weight:bold;color:' + color + ';">— N/A</span>';
                    } else {
                        statusLabel = '<span style="font-weight:bold;color:' + color + ';">⚠ ' + String(res.detail).replace(/</g, '&lt;') + '</span>';
                    }

                    var subColor = (s === 'warn') ? '#e67e22' : (s === 'pass' ? '#2ecc71' : '#e74c3c');
                    var subHtml = subMsgs.map(function(m) {
                        return '<div style="margin-left:20px;color:' + subColor + ';font-size:10px;padding:1px 0;">• ' + String(m).replace(/</g, '&lt;') + '</div>';
                    }).join('');

                    rulesHtml += '<div style="margin-top:5px;padding:4px 6px;border-radius:4px;background:#202020;border-left:3px solid ' + color + ';">' + '<div style="display:flex;align-items:center;gap:6px;">' + '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';display:inline-block;flex-shrink:0;"></span>' + '<span style="flex:1;color:#ccc;">' + String(res.label).replace(/</g, '&lt;') + '</span>' + statusLabel + '</div>' + subHtml + '</div>';
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

                bodyHtml += '<div style="display:flex;flex-direction:column;gap:6px;">';
                fieldRows.forEach(function(row, ri) {
                    bodyHtml += '<div style="display:flex;flex-direction:row;flex-wrap:nowrap;gap:6px;">';
                    row.forEach(function(fk, fi) {
                        var key = ri + '_' + fi;
                        var w = widthStore[key];
                        var style = w ? 'flex:0 0 ' + w + '%;min-width:0;' : 'flex:1 1 0;min-width:0;';
                        // Check if this is a variable reference
                        var vDef = varById[fk];
                        if (vDef) {
                            var val = varCache[fk];
                            bodyHtml += '<div style="' + style + '">' +
                                '<div style="color:#7ec8e3;font-size:10px;">' + String(vDef.label).replace(/</g, '&lt;') + ' <span style="color:#555;font-size:9px;">(var)</span></div>' +
                                '<div>' + (!preScan && val ? String(val).replace(/</g, '&lt;') : '<span style="color:#444">—</span>') + '</div></div>';
                        } else {
                            var v = cache.fields[fk],
                                lbl = fk.split(' :: ').pop();
                            bodyHtml += '<div style="' + style + '">' +
                                '<div style="color:#999;font-size:10px;">' + lbl + '</div>' +
                                '<div>' + (!preScan && v ? String(v).replace(/</g, '&lt;') : '<span style="color:#444">—</span>') + '</div></div>';
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
                bodyHtml += '<div style="display:flex;flex-direction:column;gap:6px;margin-top:' + (group.fields && group.fields.length ? '6' : '0') + 'px;">';
                group.varFields.forEach(function(vid) {
                    var vDef = varById[vid];
                    if (!vDef) return;
                    var val = varCache[vid];
                    bodyHtml += '<div><div style="color:#7ec8e3;font-size:10px;">' + String(vDef.label).replace(/</g, '&lt;') + ' <span style="color:#555;font-size:9px;">(var)</span></div>' +
                        '<div>' + (!preScan && val ? String(val).replace(/</g, '&lt;') : '<span style="color:#444">—</span>') + '</div></div>';
                });
                bodyHtml += '</div>';
            }

            if (group.table) {
                var rows = cache.tables[group.table] || [];
                var err = cache.tableErrors[group.table];
                if (err && !rows.length) {
                    bodyHtml += '<div style="color:#e74c3c;margin-top:4px;">' + err + '</div>';
                } else if (rows.length === 0) {
                    bodyHtml += '<div style="color:#666;margin-top:4px;">No rows</div>';
                } else {
                    var allCols = Object.keys(rows[0]);
                    var hiddenCols = getGroupHiddenCols(group.id);
                    var visCols = allCols.filter(function(c) {
                        return hiddenCols.indexOf(c) < 0;
                    });
                    bodyHtml += '<div style="display:flex;align-items:center;margin-top:4px;margin-bottom:2px;">' + '<span style="color:#999;font-size:10px;flex:1;">' + rows.length + ' row' + (rows.length !== 1 ? 's' : '') + '</span>' + '<button class="__wo_col_toggle_btn" style="font-size:10px;padding:1px 6px;cursor:pointer;" title="Toggle visible columns">⚙ Cols</button>' + '</div>';
                    bodyHtml += '<div class="__wo_col_panel" style="display:none;background:#202020;border-radius:4px;padding:5px;margin-bottom:4px;font-size:11px;line-height:1.8;">';
                    allCols.forEach(function(c) {
                        var checked = hiddenCols.indexOf(c) < 0;
                        bodyHtml += '<label style="display:inline-block;margin-right:10px;cursor:pointer;"><input type="checkbox" class="__wo_colcb" data-col="' + c.replace(/"/g, '&quot;') + '" ' + (checked ? 'checked' : '') + '>' + c + '</label>';
                    });
                    bodyHtml += '</div>';
                    bodyHtml += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;"><tr>' + visCols.map(function(c) {
                        return '<th style="text-align:left;border-bottom:1px solid #444;padding:3px;white-space:nowrap;">' + c + '</th>';
                    }).join('') + '</tr>';
                    rows.forEach(function(r) {
                        bodyHtml += '<tr>' + visCols.map(function(c) {
                            return '<td style="padding:3px;border-bottom:1px solid #2a2a2a;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + String(r[c] || '').replace(/"/g, '&quot;') + '">' + String(r[c] || '').replace(/</g, '&lt;') + '</td>';
                        }).join('') + '</tr>';
                    });
                    bodyHtml += '</table></div>';
                }
            }
            // ── header inline message ──
            var headerMsgHtml = '';
            if (!preScan && group.headerMsg && group.headerMsg.enabled) {
                var hmRaw = group.headerMsg.value || '';
                var hmText = '';
                if (group.headerMsg.type === 'field') {
                    hmText = cache.fields[hmRaw] || '';
                } else if (group.headerMsg.type === 'variable') {
                    hmText = varCache[hmRaw] || '';
                    // no status color for variables — use neutral
                } else {
                    // type === 'rule' — use shortened pass/fail message
                    var hmRule = cfg.rules.filter(function(r) {
                        return r.id === hmRaw;
                    })[0];
                    if (hmRule) {
                        var hmRes = results[hmRaw];
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
                    var hmColor = (group.headerMsg.type === 'rule' && results[hmRaw]) ?
                        statusColor(results[hmRaw].status) :
                        (group.headerMsg.type === 'variable' ? '#7ec8e3' : '#aaa');

                    headerMsgHtml = '<span style="margin-left:6px;font-size:10px;color:' + hmColor + ';font-weight:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;display:inline-block;vertical-align:middle;" title="' + String(hmText).replace(/"/g, '&quot;') + '">' + String(hmText).replace(/</g, '&lt;') + '</span>';
                }
            }
            tile.innerHTML = '<div class="__wo_th" draggable="true" style="background:#252525;padding:5px 8px;display:flex;justify-content:space-between;align-items:center;cursor:grab;">' +
                '<span style="display:flex;align-items:center;min-width:0;overflow:hidden;">' + dots + '<b>' + String(group.title).replace(/</g, '&lt;') + '</b>' + headerMsgHtml + '</span>' +
                '<span style="display:flex;align-items:center;gap:4px;">' + tipHtml + '<button class="__wo_tc">' + (collapsed ? '\u25B6' : '\u25BC') + '</button><button class="__wo_tx">x</button></span>' +
                '</div>' + bannerHtml +
                '<div class="__wo_tb" style="padding:8px;' + (collapsed ? 'display:none;' : '') + '">' + rulesHtml + bodyHtml + '</div>';

            bodyEl.appendChild(tile);

            var tipIcon = tile.querySelector('.__wo_tip_icon');
            if (tipIcon) {
                tipIcon.addEventListener('mouseenter', function() {
                    var tt = document.createElement('div');
                    tt.id = '__wo_tip_float';
                    tt.style.cssText = 'position:fixed;z-index:9999999;background:#333;color:#eee;font-size:11px;font-family:Segoe UI,Arial,sans-serif;padding:5px 8px;border-radius:4px;max-width:240px;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.6);pointer-events:none;';
                    tt.textContent = tipIcon.getAttribute('data-tip');
                    document.body.appendChild(tt);
                    var r = tipIcon.getBoundingClientRect();
                    tt.style.top = (r.bottom + 4) + 'px';
                    tt.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
                });
                tipIcon.addEventListener('mouseleave', function() {
                    var old = document.getElementById('__wo_tip_float');
                    if (old) old.remove();
                });
            }
            var colBtn = tile.querySelector('.__wo_col_toggle_btn');
            var colPanel = tile.querySelector('.__wo_col_panel');
            if (colBtn && colPanel) {
                colBtn.onclick = function(e) {
                    e.stopPropagation();
                    colPanel.style.display = colPanel.style.display === 'none' ? 'block' : 'none';
                };
                colPanel.querySelectorAll('.__wo_colcb').forEach(function(cb) {
                    cb.onchange = function() {
                        var hidden = getGroupHiddenCols(group.id);
                        var col = cb.getAttribute('data-col');
                        if (!cb.checked && hidden.indexOf(col) < 0) hidden.push(col);
                        if (cb.checked) {
                            hidden = hidden.filter(function(c) {
                                return c !== col;
                            });
                        }
                        saveGroupHiddenCols(group.id, hidden);
                        render();
                    };
                });
            }
            tile.querySelector('.__wo_tc').onclick = function() {
                var b = tile.querySelector('.__wo_tb'),
                    h = b.style.display === 'none';
                b.style.display = h ? 'block' : 'none';
                this.textContent = h ? '\u25BC' : '\u25B6';
                var banner = tile.querySelector('.__wo_banner');
                if (banner) banner.style.display = h ? 'block' : 'none';
                var g2 = getGS();
                if (!g2[group.id]) g2[group.id] = {};
                g2[group.id].collapsed = !h;
                saveGS(g2);
            };
            tile.querySelector('.__wo_tx').onclick = function() {
                var g2 = getGS();
                if (!g2[group.id]) g2[group.id] = {};
                g2[group.id].visible = false;
                saveGS(g2);
                render();
            };
            var head = tile.querySelector('.__wo_th');
            head.addEventListener('dragstart', function(e) {
                e.dataTransfer.setData('text/plain', group.id);
            });
            tile.addEventListener('dragover', function(e) {
                e.preventDefault();
                tile.style.borderColor = '#2ecc71';
            });
            tile.addEventListener('dragleave', function() {
                tile.style.borderColor = '#333';
            });
            tile.addEventListener('drop', function(e) {
                e.preventDefault();
                tile.style.borderColor = '#333';
                var dragged = e.dataTransfer.getData('text/plain');
                if (!dragged || dragged === group.id) return;
                var cfg2 = getCfg(),
                    ids = orderedGroups(cfg2).map(function(g) {
                        return g.id;
                    });
                var from = ids.indexOf(dragged),
                    to = ids.indexOf(group.id);
                ids.splice(from, 1);
                ids.splice(to, 0, dragged);
                var g2 = getGS();
                g2.__order = ids;
                saveGS(g2);
                render();
            });
        });
        // ── Quick Return preview box ──
        var qrWrap = document.createElement('div');
        qrWrap.style.cssText = 'margin-bottom:4px;';

        var retMsg = preScan ? '' : buildReturnMessage();
        qrWrap.innerHTML = '<div style="position:relative;background:#222;border:1px solid #444;border-radius:6px;padding:8px 36px 8px 10px;min-height:38px;font-size:11px;color:' + (retMsg ? '#ddd' : '#666') + ';font-family:Segoe UI,Arial,sans-serif;word-break:break-word;">' +
            (preScan ?
                '<i>Scan first to generate return message</i>' :
                (retMsg ? retMsg.replace(/</g, '&lt;') : '<i>No failed rules — return message will appear here</i>')) +
            '<button class="__wo_qr_copy" title="Copy to clipboard" style="position:absolute;bottom:6px;right:6px;background:none;border:none;cursor:pointer;color:#aaa;font-size:14px;padding:2px 4px;">📋</button>' +
            '</div>';

        bodyEl.appendChild(qrWrap);
        // ── Return and Approve buttons ──
        var actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;';

        var returnBtn = document.createElement('button');
        returnBtn.textContent = '↩ Return';
        returnBtn.style.cssText = 'flex:1;padding:6px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
        returnBtn.onclick = function() {
            if (!confirm('Return this Work Order?\n\nThe return message will be filled into the Memo field.')) return;
            routeWorkflow('return');
        };

        var approveBtn = document.createElement('button');
        approveBtn.textContent = '✓ Approve';
        approveBtn.style.cssText = 'flex:1;padding:6px;background:#2ecc71;color:#000;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
        approveBtn.onclick = function() {
            if (!confirm('Approve this Work Order?\n\nThis will route with Complete Review selected.')) return;
            routeWorkflow('approve');
        };

        actionRow.appendChild(returnBtn);
        actionRow.appendChild(approveBtn);
        bodyEl.appendChild(actionRow);

        qrWrap.querySelector('.__wo_qr_copy').onclick = function() {
            var msg = buildReturnMessage();
            if (!msg) {
                alert('No failed rules to copy.');
                return;
            }
            var ta = document.createElement('textarea');
            ta.value = msg;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            var btn = qrWrap.querySelector('.__wo_qr_copy');
            btn.textContent = '✓';
            setTimeout(function() {
                btn.textContent = '📋';
            }, 1500);
        };


        var showAll = document.createElement('button');
        showAll.textContent = 'Show hidden tiles';
        showAll.style.cssText = 'width:100%;margin-top:4px;';
        showAll.onclick = function() {
            var g2 = getGS();
            getCfg().groups.forEach(function(g) {
                if (!g2[g.id]) g2[g.id] = {};
                g2[g.id].visible = true;
            });
            saveGS(g2);
            render();
        };
        bodyEl.appendChild(showAll);
        // ── Footer ──
        var footer = document.createElement('div');
        footer.style.cssText = 'text-align:center;color:#444;font-size:10px;padding:6px 0 2px;font-style:italic;letter-spacing:0.02em;';
        footer.textContent = 'Created by William Zitzmann, william.zitzmann@abbvie.com';
        bodyEl.appendChild(footer);

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
        return {
            fields: f.sort(),
            tables: Object.keys(t).sort()
        };
    }

    function openFieldBrowser(cfg, opts, onSave) {
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
        bModal.style.cssText = 'position:fixed;top:4%;left:8%;width:78%;height:88%;background:#111;color:#eee;z-index:10000000;border-radius:8px;box-shadow:0 6px 30px rgba(0,0,0,.8);display:flex;flex-direction:column;font-family:Segoe UI,Arial,sans-serif;font-size:12px;padding:10px;';

        // Group selector for target
        var grpOptions = '<option value="">-- no group --</option>' +
            cfg.groups.map(function(g, gi) {
                return '<option value="' + gi + '">' + g.title + '</option>';
            }).join('');

        bModal.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<b style="font-size:13px;">Browse Page Fields</b>' +
            '<button id="__fb_close" style="background:#333;color:#eee;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;">✕ Close</button>' +
            '</div>' +
            '<div style="margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<input id="__fb_search" type="text" placeholder="Filter fields..." style="flex:1;min-width:150px;background:#222;color:#eee;border:1px solid #444;padding:4px 8px;border-radius:4px;font-size:12px;">' +
            '<span style="color:#aaa;font-size:11px;">Add checked fields to group:</span>' +
            '<select id="__fb_grp" style="background:#222;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:4px;">' + grpOptions + '</select>' +
            '</div>' +
            '<div style="color:#777;font-size:10px;margin-bottom:4px;">' +
            '<span style="color:#2ecc71;">■</span> Already registered &nbsp;' +
            '<span style="color:#eee;">■</span> New field &nbsp;' +
            'Tick fields to add, then click Save.</div>' +
            '<div id="__fb_list" style="flex:1;overflow:auto;border:1px solid #333;border-radius:4px;padding:4px;"></div>' +
            '<div style="margin-top:8px;display:flex;justify-content:flex-end;gap:8px;">' +
            '<button id="__fb_selall" style="background:#444;color:#eee;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;">Select All Visible</button>' +
            '<button id="__fb_selnone" style="background:#444;color:#eee;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;">Deselect All</button>' +
            '<button id="__fb_save" style="background:#2ecc71;color:#000;font-weight:bold;border:none;padding:6px 18px;cursor:pointer;border-radius:4px;">Save Selected</button>' +
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
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:3px;cursor:pointer;' +
                    (isReg ? 'background:#1a2e1a;' : 'background:#1a1a1a;') + 'margin-bottom:2px;';
                row.innerHTML =
                    '<input type="checkbox" data-fkey="' + f.key.replace(/"/g, '&quot;') + '" ' + (isReg ? 'checked disabled style="opacity:0.5;"' : '') + '>' +
                    '<span style="color:' + (isReg ? '#2ecc71' : '#eee') + ';flex:1;font-size:11px;">' +
                    f.tab.replace(/</g, '&lt;') + ' :: ' + f.label.replace(/</g, '&lt;') +
                    '</span>' +
                    '<span style="color:#888;font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + String(f.value).replace(/"/g, '&quot;') + '">' +
                    (f.value ? String(f.value).replace(/</g, '&lt;') : '<i style="color:#555;">empty</i>') +
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
                '<div id="__inst_profiles" style="margin-top:8px;color:#888;">Loading available presets…</div>' +
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

            var selectedProfileId = '';
            var profilesDiv = modal.querySelector('#__inst_profiles');
            var goBtn = modal.querySelector('#__inst_go');

            fetchProfileIndex().then(function(list) {
                if (!list || !list.length) {
                    profilesDiv.innerHTML = '<div style="color:#e74c3c;">Could not load presets (offline?). You can skip and start from basic defaults, or load one later in Setup &gt; Profiles.</div>';
                    return;
                }
                profilesDiv.innerHTML = list.map(function(p, i) {
                    return '<label style="display:block;padding:6px;border:1px solid #333;border-radius:4px;margin-bottom:6px;cursor:pointer;">' +
                        '<input type="radio" name="__inst_profile" value="' + p.id + '" ' + (i === 0 ? 'checked' : '') + '> ' +
                        '<b>' + p.name + '</b><br>' +
                        '<span style="color:#888;margin-left:20px;">' + (p.description || '') + '</span>' +
                        '</label>';
                }).join('');
                selectedProfileId = list[0].id;
                profilesDiv.querySelectorAll('input[name="__inst_profile"]').forEach(function(r) {
                    r.onchange = function(e) {
                        selectedProfileId = e.target.value;
                    };
                });
                goBtn.disabled = false;
            });

            function finish() {
                modal.remove();
                resolve();
            }

            goBtn.onclick = function() {
                if (!selectedProfileId) return;
                var statusEl = modal.querySelector('#__inst_status');
                statusEl.textContent = 'Installing...';
                goBtn.disabled = true;
                installProfileFromGitHub(selectedProfileId).then(function(ok) {
                    statusEl.textContent = ok ? 'Done!' : 'Could not install — starting with basic defaults.';
                    setTimeout(finish, ok ? 300 : 1200);
                });
            };

            modal.querySelector('#__inst_skip').onclick = finish;
        });
    }

    function openSetup() {
        var old = document.getElementById('__wo_setup_modal');
        if (old) old.remove();
        var opts = fieldKeyOptions();
        var cfg = JSON.parse(JSON.stringify(getCfg()));
        var scan = JSON.parse(JSON.stringify(getScan()));

        // --- make modal draggable ---
        var modal = document.createElement('div');
        modal.id = '__wo_setup_modal';
        modal.style.cssText = 'position:fixed;top:3%;left:10%;width:75%;height:92%;background:#111;color:#eee;z-index:9999999;padding:10px;border-radius:8px;box-shadow:0 6px 30px rgba(0,0,0,.7);display:flex;flex-direction:column;font-family:Segoe UI,Arial,sans-serif;font-size:12px;';
        modal.innerHTML = '<div id="__s_titlebar" style="display:flex;justify-content:space-between;cursor:move;user-select:none;margin-bottom:4px;"><b>Setup</b><button id="__s_close">Close</button></div><div style="margin:6px 0;"> <button id="__s_rules">Rules</button> <button id="__s_groups">Groups &amp; Display</button> <button id="__s_vars">Variables</button> <button id="__s_scan">Scan</button> <button id="__s_profiles">Profiles</button> <button id="__s_settings">Settings</button> <button id="__s_update">Update</button> <button id="__s_guide" style="background:#2a4a6a;color:#7ec8e3;">Guide</button> <button id="__s_exp">Export</button> <button id="__s_imp">Import</button> <button id="__s_save" style="float:right;background:#2ecc71;color:#000;">Save &amp; Apply</button></div><div id="__s_content" style="flex:1;overflow:auto;border-top:1px solid #333;padding-top:8px;"></div>';
        document.body.appendChild(modal);

        // drag logic
        (function() {
            var tb = modal.querySelector('#__s_titlebar');
            var ox = 0,
                oy = 0,
                mx = 0,
                my = 0;
            tb.addEventListener('mousedown', function(e) {
                e.preventDefault();
                ox = modal.offsetLeft;
                oy = modal.offsetTop;
                mx = e.clientX;
                my = e.clientY;
                document.addEventListener('mousemove', drag);
                document.addEventListener('mouseup', stopdrag);
            });

            function drag(e) {
                modal.style.left = (ox + e.clientX - mx) + 'px';
                modal.style.top = (oy + e.clientY - my) + 'px';
            }

            function stopdrag() {
                document.removeEventListener('mousemove', drag);
                document.removeEventListener('mouseup', stopdrag);
            }
        })();

        var content = modal.querySelector('#__s_content');

        function makeCollapsible(box, headerText, startCollapsed) {
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
                var hidden = body.style.display === 'none';
                body.style.display = hidden ? '' : 'none';
                if (arrow) arrow.textContent = hidden ? '▼' : '▶';
            });
        }

        modal.querySelector('#__s_close').onclick = function() {
            modal.remove();
        };
        modal.querySelector('#__s_save').onclick = function() {
            saveCfg(cfg);
            saveScan(scan);
            applyHotkey();
            modal.remove();
            render();
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
            alert('Full config copied to clipboard - save it in a text file.');
        };
        modal.querySelector('#__s_imp').onclick = function() {
            var raw = prompt('Paste exported config JSON:');
            if (!raw) return;
            try {
                var b = JSON.parse(raw);
                if (b.rules) saveCfg(b.rules);
                if (b.scan) saveScan(b.scan);
                if (b.fields) saveFieldCfg(b.fields);
                if (b.state) saveGS(b.state);
                if (b.vars) saveVars(b.vars);

                alert('Imported. Reopen Setup.');
                modal.remove();
                render();
            } catch (e) {
                alert('Invalid JSON: ' + e.message);
            }
        };

        function formulaBox(obj, prop) {
            return '<textarea data-f style="width:100%;height:80px;font-family:monospace;font-size:11px;background:#000;color:#0f0;margin-top:4px;">' + String(obj[prop]).replace(/</g, '&lt;') + '</textarea>';
        }
        // ── VARIABLES TAB ──
        function varsTab() {
            content.innerHTML = '';
            var vars = getVars();

            vars.forEach(function(v, idx) {
                var box = document.createElement('div');
                box.style.cssText = 'border:1px solid #2a4a6a;border-radius:6px;padding:8px;margin-bottom:8px;background:#0d1a26;';
                var fo = opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('');
                box.innerHTML =
                    '<div data-coll-header style="display:flex;align-items:center;gap:6px;padding:4px 0;">' +
                    '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                    '<span style="color:#7ec8e3;font-size:10px;">ID: <code>' + v.id + '</code></span>' +
                    '<input type="text" data-vl value="' + v.label.replace(/"/g, '&quot;') + '" style="flex:1;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;" placeholder="Variable label" onclick="event.stopPropagation()">' +
                    '<button data-vd style="color:#e74c3c;background:none;border:1px solid #e74c3c;border-radius:3px;padding:2px 6px;cursor:pointer;" onclick="event.stopPropagation()">Delete</button>' +
                    '</div>' +
                    '<div data-coll-body>' +
                    '<div style="margin-bottom:4px;">Insert field: <select data-vi style="background:#222;color:#eee;border:1px solid #444;font-size:11px;"><option value="">--</option>' + fo + '</select></div>' +
                    '<textarea data-vf style="width:100%;height:80px;font-family:monospace;font-size:11px;background:#000;color:#7ec8e3;border:1px solid #2a4a6a;padding:4px;">' + String(v.formula).replace(/</g, '&lt;') + '</textarea>' +
                    '<div style="margin-top:4px;display:flex;gap:6px;align-items:center;">' +
                    '<button data-vt style="font-size:11px;">Test</button>' +
                    '<span data-vr style="font-size:11px;color:#aaa;"></span>' +
                    '</div>' +
                    '<div style="margin-top:4px;color:#555;font-size:10px;">Formula must return a value (string, number, etc.). Use the same helpers as rules: F(), T(), rowCount(), etc.</div>' +
                    '</div>';

                content.appendChild(box);
                makeCollapsible(box, v.label);

                var fa = box.querySelector('[data-vf]');
                box.querySelector('[data-vl]').oninput = function(e) {
                    v.label = e.target.value;
                };
                fa.oninput = function() {
                    v.formula = fa.value;
                };
                box.querySelector('[data-vi]').onchange = function(e) {
                    if (!e.target.value) return;
                    var sn = "F('" + e.target.value.replace(/'/g, "\\'") + "')";
                    var p = fa.selectionStart || fa.value.length;
                    fa.value = fa.value.slice(0, p) + sn + fa.value.slice(p);
                    v.formula = fa.value;
                    e.target.value = '';
                };
                box.querySelector('[data-vd]').onclick = function() {
                    vars.splice(idx, 1);
                    saveVars(vars);
                    varsTab();
                };
                box.querySelector('[data-vt]').onclick = function() {
                    var res = runVariable(fa.value, cache);
                    var sp = box.querySelector('[data-vr]');
                    if (res.error) {
                        sp.style.color = '#e74c3c';
                        sp.textContent = '⚠ ' + res.error;
                    } else {
                        sp.style.color = '#7ec8e3';
                        sp.textContent = '→ ' + (res.value !== null ? JSON.stringify(res.value) : '(null)');
                    }
                };
            });

            var addBtn = document.createElement('button');
            addBtn.textContent = '+ Add Variable';
            addBtn.style.cssText = 'padding:5px 12px;background:#2980b9;color:#fff;border:none;border-radius:4px;cursor:pointer;';
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

            // Save vars on every formula/label change (real-time)
            content.addEventListener('input', function() {
                saveVars(vars);
            });
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
        function msgSection(rule, key, label, color, includeReturn) {
            var side = rule[key];
            var sec = document.createElement('div');
            sec.style.cssText = 'border:1px solid ' + color + ';border-radius:5px;padding:6px;margin-top:6px;';
            sec.innerHTML =
                '<div data-coll-header style="display:flex;align-items:center;gap:6px;cursor:pointer;">' +
                '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                '<b style="color:' + color + ';font-size:11px;">' + label + '</b>' +
                '</div>' +
                '<div data-coll-body style="margin-top:6px;">' +
                '<label style="color:#aaa;font-size:10px;">Short (one line, shown in the group header):</label><br>' +
                '<input type="text" data-short value="' + String(side.short || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#333;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;">' +
                '<div style="margin-top:6px;color:#aaa;font-size:10px;">Long — one or more messages, each with its own optional condition. Every matching entry is shown as a bullet list.</div>' +
                '<div data-long-list style="margin-top:4px;"></div>' +
                '<button data-add-long type="button" style="font-size:10px;margin-top:2px;">+ Add message</button>' +
                (includeReturn ?
                    ('<div style="margin-top:8px;border-top:1px solid #333;padding-top:6px;">' +
                        '<label style="color:#aaa;font-size:10px;">Include in return message:</label><br>' +
                        RETURN_MODES.map(function(m) {
                            return '<label style="margin-right:8px;font-size:10px;color:#ccc;"><input type="radio" name="__ret_' + rule.id + '_' + key + '" data-ret-mode value="' + m[0] + '" ' + ((side.returnMode || 'none') === m[0] ? 'checked' : '') + '> ' + m[1] + '</label>';
                        }).join('') +
                        '<div style="margin-top:4px;"><input type="text" data-ret-custom placeholder="Custom text (supports {{expr}})" value="' + String(side.returnCustom || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;"></div>' +
                        '</div>') : '') +
                '</div>';

            makeCollapsible(sec, label);

            sec.querySelector('[data-short]').oninput = function(e) {
                side.short = e.target.value;
            };

            function renderLongList() {
                var wrap = sec.querySelector('[data-long-list]');
                wrap.innerHTML = '';
                (side.long || []).forEach(function(entry, i) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-bottom:4px;';
                    row.innerHTML =
                        '<input type="text" placeholder="Condition (optional)" data-cond value="' + String(entry.condition || '').replace(/"/g, '&quot;') + '" style="flex:1;min-width:0;background:#000;color:#7ec8e3;font-family:monospace;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:10px;">' +
                        '<input type="text" placeholder="Message (supports {{expr}})" data-msg value="' + String(entry.msg || '').replace(/"/g, '&quot;') + '" style="flex:2;min-width:0;background:#333;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;">' +
                        '<button data-rm-entry type="button" style="color:#e74c3c;flex-shrink:0;">✕</button>';
                    row.querySelector('[data-cond]').oninput = function(e) {
                        entry.condition = e.target.value;
                    };
                    row.querySelector('[data-msg]').oninput = function(e) {
                        entry.msg = e.target.value;
                    };
                    row.querySelector('[data-rm-entry]').onclick = function() {
                        side.long.splice(i, 1);
                        renderLongList();
                    };
                    wrap.appendChild(row);
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
            }
            return sec;
        }

        function rulesTab() {
            content.innerHTML = '';
            cfg.rules.forEach(function(rule, idx) {
                var box = document.createElement('div');
                box.style.cssText = 'border:1px solid #333;border-radius:6px;padding:8px;margin-bottom:8px;';
                var fo = opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('');
                box.innerHTML =
                    '<div data-coll-header style="display:flex;align-items:center;gap:6px;padding:4px 0;">' +
                    '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                    '<input type="text" value="' + rule.label.replace(/"/g, '&quot;') + '" data-l style="width:65%;background:#222;color:#eee;border:1px solid #333;padding:2px 5px;border-radius:3px;" onclick="event.stopPropagation()"> ' +
                    '<button data-d style="margin-left:auto;color:#e74c3c;" onclick="event.stopPropagation()">Delete</button>' +
                    '</div>' +
                    '<div data-coll-body>' +
                    '<div style="margin-top:4px;">Insert field: <select data-i><option value="">--</option>' + fo + '</select></div>' +
                    formulaBox(rule, 'formula') +
                    '<div data-msg-sections style="margin-top:6px;"></div>' +
                    '<div style="margin-top:6px;"><button data-t type="button">Test</button> <span data-r style="margin-left:6px;"></span></div>' +
                    '<div style="margin-top:4px;color:#777;font-size:10px;">Available: F(field) T(table) rowCount(t) col(t,n) has(t,c,v) hours(str) hoursBetween(a,b) oneOf(v,arr) contains(t,p) matches(t,p) isEmpty(v) notEmpty(v) <b>maxLaborHours(tableTitle,nameCol,hoursCol)</b></div>' +
                    '</div>';


                content.appendChild(box);
                makeCollapsible(box, rule.label);

                var msgWrap = box.querySelector('[data-msg-sections]');
                msgWrap.appendChild(msgSection(rule, 'pass', '✓ Pass', '#2ecc71', false));
                msgWrap.appendChild(msgSection(rule, 'fail', '✗ Fail — must be fixed', '#e74c3c', true));
                msgWrap.appendChild(msgSection(rule, 'warn', '⚠ Warn — needs reviewer confirmation', '#FF9800', true));

                var fa = box.querySelector('[data-f]');
                box.querySelector('[data-l]').oninput = function(e) {
                    rule.label = e.target.value;
                };
                fa.oninput = function() {
                    rule.formula = fa.value;
                };

                box.querySelector('[data-i]').onchange = function(e) {
                    if (!e.target.value) return;
                    var sn = "F('" + e.target.value.replace(/'/g, "\\'") + "')";
                    var p = fa.selectionStart || fa.value.length;
                    fa.value = fa.value.slice(0, p) + sn + fa.value.slice(p);
                    rule.formula = fa.value;
                    e.target.value = '';
                };
                box.querySelector('[data-d]').onclick = function() {
                    cfg.rules.splice(idx, 1);
                    rulesTab();
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
            cfg.groups.forEach(function(group, idx) {
                var vis = gs[group.id] ? gs[group.id].visible !== false : true;
                var box = document.createElement('div');
                box.style.cssText = 'border:1px solid #333;border-radius:6px;padding:8px;margin-bottom:8px;';
                var fc = opts.fields.map(function(f) {
                    return '<label style="display:block;"><input type="checkbox" data-fd="' + f.replace(/"/g, '&quot;') + '" ' + (group.fields.indexOf(f) >= 0 ? 'checked' : '') + '>' + f + '</label>';
                }).join('');
                var to = '<option value="">-- none --</option>' + opts.tables.map(function(t) {
                    return '<option value="' + t.replace(/"/g, '&quot;') + '" ' + (group.table === t ? 'selected' : '') + '>' + t + '</option>';
                }).join('');
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

                box.innerHTML =
                    '<div data-coll-header style="display:flex;align-items:center;gap:6px;padding:4px 0;">' +
                    '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                    '<input type="text" value="' + group.title.replace(/"/g, '&quot;') + '" data-ti style="width:50%;background:#222;color:#eee;border:1px solid #333;padding:2px 5px;border-radius:3px;" onclick="event.stopPropagation()"> ' +
                    '<label onclick="event.stopPropagation()"><input type="checkbox" data-v ' + (vis ? 'checked' : '') + '>Visible</label> ' +
                    '<button data-d style="margin-left:auto;color:#e74c3c;" onclick="event.stopPropagation()">Delete</button>' +
                    '</div>' +
                    '<div data-coll-body>' +
                    '<div style="margin-top:4px;">Layout: <select data-la><option value="vertical" ' + (group.layout === 'vertical' ? 'selected' : '') + '>Vertical</option><option value="horizontal" ' + (group.layout === 'horizontal' ? 'selected' : '') + '>Horizontal</option></select> <label><input type="checkbox" data-c ' + (group.defaultCollapsed ? 'checked' : '') + '>Collapsed by default</label></div>' +
                    '<div style="margin-top:4px;"><label style="color:#aaa;">Tooltip:</label><br><input type="text" data-tt value="' + (group.tooltip || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#333;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;"></div>' +
                    '<div style="margin-top:4px;"><label style="color:#aaa;">Expanded Message:</label><br><textarea data-em style="width:100%;height:44px;background:#333;color:#aad4f5;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;">' + (group.expandedMsg || '').replace(/</g, '&lt;') + '</textarea></div>' +
                    '<div style="margin-top:6px;"><b>Table:</b> <select data-tb>' + to + '</select></div>' +
                    '<div style="margin-top:6px;" id="__roweditor_' + idx + '"><b>Field Rows</b> <button data-addrow style="font-size:10px;margin-left:6px;">+ Add Row</button><div data-rowlist style="margin-top:4px;"></div></div>' +
                    '<div style="margin-top:6px;max-height:90px;overflow:auto;border:1px solid #333;padding:4px;"><b>Rules:</b>' + rc + '</div>' +
                    '<div style="margin-top:8px;border:1px solid #444;border-radius:4px;padding:6px;" id="__hm_block_' + idx + '">' +
                    '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#aaa;"><input type="checkbox" id="__hm_en_' + idx + '" ' + (group.headerMsg && group.headerMsg.enabled ? 'checked' : '') + '><b>Show inline header message</b></label>' +
                    '<div style="margin-top:6px;border:1px solid #2a4a6a;border-radius:4px;padding:6px;">' +
                    '<b style="color:#7ec8e3;font-size:11px;">Variable Fields</b> <span style="color:#555;font-size:10px;">(shown in expanded group body)</span><br>' +
                    '<div id="__vf_list_' + idx + '" style="margin-top:4px;">' +
                    (getVars().map(function(v) {
                        var checked = (group.varFields || []).indexOf(v.id) >= 0;
                        return '<label style="display:block;font-size:11px;"><input type="checkbox" data-vref="' + v.id + '" ' + (checked ? 'checked' : '') + '> ' + v.label + ' <code style="color:#555;font-size:9px;">' + v.id + '</code></label>';
                    }).join('') || '<span style="color:#555;font-size:10px;">No variables defined — create them in the Variables tab.</span>') +
                    '</div>' +
                    '</div>' +
                    '<div id="__hm_opts_' + idx + '" style="margin-top:6px;' + (group.headerMsg && group.headerMsg.enabled ? '' : 'display:none;') + '">' +
                    '<div style="margin-bottom:4px;">Type: ' +
                    '<select id="__hm_type_' + idx + '" style="background:#222;color:#eee;border:1px solid #444;font-size:11px;">' +
                    '<option value="field"' + (group.headerMsg && group.headerMsg.type === 'field' ? ' selected' : '') + '>Field value</option>' +
                    '<option value="rule"' + (group.headerMsg && group.headerMsg.type === 'rule' ? ' selected' : '') + '>Rule pass/fail message</option>' +
                    '<option value="variable"' + (group.headerMsg && group.headerMsg.type === 'variable' ? ' selected' : '') + '>Variable value</option>' +
                    '</select></div>' +
                    '<div id="__hm_field_wrap_' + idx + '" style="' + (group.headerMsg && (group.headerMsg.type === 'rule' || group.headerMsg.type === 'variable') ? 'display:none;' : '') + '">' +
                    'Field: <select id="__hm_field_' + idx + '" style="background:#222;color:#eee;border:1px solid #444;font-size:11px;max-width:100%;">' +
                    '<option value="">-- pick field --</option>' +
                    opts.fields.map(function(f) {
                        return '<option value="' + f.replace(/"/g, '&quot;') + '"' + (group.headerMsg && group.headerMsg.value === f ? ' selected' : '') + '>' + f + '</option>';
                    }).join('') +
                    '</select></div>' +
                    '<div id="__hm_rule_wrap_' + idx + '" style="' + (group.headerMsg && group.headerMsg.type === 'rule' ? '' : 'display:none;') + '">' +
                    'Rule: <select id="__hm_rule_' + idx + '" style="background:#222;color:#eee;border:1px solid #444;font-size:11px;max-width:100%;">' +
                    '<option value="">-- pick rule --</option>' +
                    cfg.rules.map(function(r) {
                        return '<option value="' + r.id + '"' + (group.headerMsg && group.headerMsg.value === r.id ? ' selected' : '') + '>' + r.label + '</option>';
                    }).join('') +
                    '</select>' +
                    '<div style="margin-top:4px;"><label style="font-size:10px;color:#aaa;">Short pass message (leave blank to use rule\'s Pass Message):</label><br>' +
                    '<input type="text" id="__hm_short_pass_' + idx + '" value="' + ((group.headerMsg && group.headerMsg.shortPassMsg) ? group.headerMsg.shortPassMsg.replace(/"/g, '&quot;') : '') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;margin-top:2px;"></div>' +
                    '<div style="margin-top:4px;"><label style="font-size:10px;color:#aaa;">Short fail message (leave blank to use rule\'s Fail Messages):</label><br>' +
                    '<input type="text" id="__hm_short_fail_' + idx + '" value="' + ((group.headerMsg && group.headerMsg.shortFailMsg) ? group.headerMsg.shortFailMsg.replace(/"/g, '&quot;') : '') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;margin-top:2px;"></div>' +
                    '</div>' +
                    '<div id="__hm_var_wrap_' + idx + '" style="' + (group.headerMsg && group.headerMsg.type === 'variable' ? '' : 'display:none;') + '">' +
                    'Variable: <select id="__hm_var_' + idx + '" style="background:#222;color:#7ec8e3;border:1px solid #444;font-size:11px;max-width:100%;">' +
                    '<option value="">-- pick variable --</option>' +
                    getVars().map(function(v) {
                        return '<option value="' + v.id + '"' + (group.headerMsg && group.headerMsg.value === v.id ? ' selected' : '') + '>' + v.label + '</option>';
                    }).join('') +
                    '</select></div>' +
                    '</div>' +
                    '</div>' +
                    '</div>';



                content.appendChild(box);
                makeCollapsible(box, group.title);

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
                        rd.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;flex-wrap:nowrap;border:1px solid #2a2a2a;border-radius:4px;padding:4px;';
                        // each field cell
                        row.forEach(function(fk, fi) {
                            var cell = document.createElement('div');
                            cell.style.cssText = 'display:flex;align-items:center;gap:2px;flex:1 1 0;min-width:0;';
                            var sel = document.createElement('select');
                            sel.style.cssText = 'flex:1;min-width:0;background:#222;color:#eee;border:1px solid #444;font-size:11px;';
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
                            wInp.style.cssText = 'width:42px;background:#222;color:#eee;border:1px solid #444;font-size:10px;padding:1px 3px;';
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
                        addBtn.textContent = '+field';
                        addBtn.style.cssText = 'font-size:10px;flex-shrink:0;';
                        addBtn.onclick = function() {
                            row.push(opts.fields[0] || '');
                            group.fields = [].concat.apply([], group.fieldRows);
                            renderRows();
                        };
                        var delBtn = document.createElement('button');
                        delBtn.textContent = '✕row';
                        delBtn.style.cssText = 'font-size:10px;color:#e74c3c;flex-shrink:0;';
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

                box.querySelector('[data-ti]').oninput = function(e) {
                    group.title = e.target.value;
                };
                box.querySelector('[data-la]').onchange = function(e) {
                    group.layout = e.target.value;
                };
                box.querySelector('[data-c]').onchange = function(e) {
                    group.defaultCollapsed = e.target.checked;
                };
                box.querySelector('[data-tb]').onchange = function(e) {
                    group.table = e.target.value || null;
                };
                box.querySelector('[data-v]').onchange = function(e) {
                    var g2 = getGS();
                    if (!g2[group.id]) g2[group.id] = {};
                    g2[group.id].visible = e.target.checked;
                    saveGS(g2);
                };
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
                box.querySelectorAll('[data-vref]').forEach(function(cb) {
                    cb.onchange = function() {
                        if (!group.varFields) group.varFields = [];
                        var vid = cb.getAttribute('data-vref');
                        var i = group.varFields.indexOf(vid);
                        if (cb.checked && i < 0) group.varFields.push(vid);
                        if (!cb.checked && i >= 0) group.varFields.splice(i, 1);
                    };
                });

                box.querySelector('[data-d]').onclick = function() {
                    cfg.groups.splice(idx, 1);
                    groupsTab();
                };
            });
            var b = document.createElement('button');
            b.textContent = '+ Add Group';
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
            addFieldDiv.style.cssText = 'margin-top:12px;padding:8px;border:1px solid #444;border-radius:6px;';
            addFieldDiv.innerHTML = '<b style="color:#aaa;">Add a field not yet in any group:</b><br>' +
                '<select id="__new_field_pick" style="background:#222;color:#eee;border:1px solid #444;margin-top:4px;width:70%;">' +
                '<option value="">-- pick field --</option>' +
                opts.fields.map(function(f) {
                    return '<option value="' + f.replace(/"/g, '&quot;') + '">' + f + '</option>';
                }).join('') +
                '</select> into group: <select id="__new_field_grp" style="background:#222;color:#eee;border:1px solid #444;">' +
                '<option value="">--</option>' +
                cfg.groups.map(function(g, gi) {
                    return '<option value="' + gi + '">' + g.title + '</option>';
                }).join('') +
                '</select> <button id="__new_field_add">Add</button>';
            content.appendChild(addFieldDiv);
            // Pick from page button
            var pickBtn = document.createElement('button');
            pickBtn.textContent = '🔍 Browse Page Fields';
            pickBtn.style.cssText = 'margin-top:8px;padding:5px 12px;background:#8e44ad;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
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
            content.innerHTML = '<div style="margin-bottom:8px;">WO Tab ID: <input type="text" data-wt value="' + scan.woTabId + '"> <span style="color:#999;">(tab returned to after scan)</span></div>';
            content.querySelector('[data-wt]').oninput = function(e) {
                scan.woTabId = e.target.value;
            };
            scan.scans.forEach(function(s, idx) {
                var box = document.createElement('div');
                box.style.cssText = 'border:1px solid #333;border-radius:6px;padding:8px;margin-bottom:8px;';
                box.innerHTML =
                    '<div data-coll-header style="display:flex;align-items:center;gap:6px;padding:4px 0;">' +
                    '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                    '<input type="text" value="' + s.title.replace(/"/g, '&quot;') + '" data-ti style="width:35%;background:#222;color:#eee;border:1px solid #333;padding:2px 5px;border-radius:3px;" onclick="event.stopPropagation()"> ' +
                    'Type: <select data-ty onclick="event.stopPropagation()"><option value="tab" ' + (s.type === 'tab' ? 'selected' : '') + '>Tab</option><option value="dialog" ' + (s.type === 'dialog' ? 'selected' : '') + '>Dialog</option></select> ' +
                    '<button data-d style="margin-left:auto;color:#e74c3c;" onclick="event.stopPropagation()">Delete</button>' +
                    '</div>' +
                    '<div data-coll-body>' +
                    '<div style="margin-top:4px;">Tab ID / Event: <input type="text" data-id value="' + (s.tabId || s.eventType || '') + '"> Wait for text: <input type="text" data-w value="' + s.waitFor + '"> Wait for table: <input type="text" data-wtb value="' + (s.waitTable || '') + '"></div>' +
                    '<div style="margin-top:4px;color:#999;">Condition (formula, true = scan this):</div>' +
                    '<textarea data-f style="width:100%;height:60px;font-family:monospace;font-size:11px;background:#000;color:#0f0;">' + String(s.condition).replace(/</g, '&lt;') + '</textarea>' +
                    '</div>';

                // ── Row Detail Fields editor ──
                var rdfWrap = document.createElement('div');
                rdfWrap.style.cssText = 'margin-top:8px;border:1px solid #2a4a6a;border-radius:4px;padding:6px;';
                rdfWrap.innerHTML = '<b style="color:#7ec8e3;font-size:11px;">Row Detail Fields</b> ' +
                    '<span style="color:#555;font-size:10px;">(fields inside expanded row panels)</span>' +
                    '<button id="__rdf_add_' + idx + '" style="font-size:10px;margin-left:8px;">+ Add Field</button>' +
                    '<div id="__rdf_list_' + idx + '" style="margin-top:4px;"></div>';
                box.querySelector('[data-coll-body]').appendChild(rdfWrap);
                // ── Actions editor ──
                var actWrap = document.createElement('div');
                actWrap.style.cssText = 'margin-top:8px;border:1px solid #2a6a2a;border-radius:4px;padding:6px;';
                actWrap.innerHTML = '<b style="color:#2ecc71;font-size:11px;">Post-Scan Actions</b> ' +
                    '<span style="color:#555;font-size:10px;">(fill fields after this tab is scanned)</span>' +
                    '<button id="__act_add_' + idx + '" style="font-size:10px;margin-left:8px;">+ Add Action</button>' +
                    '<div id="__act_list_' + idx + '" style="margin-top:4px;"></div>';
                box.querySelector('[data-coll-body]').appendChild(actWrap);


                function renderActList() {
                    var actList = actWrap.querySelector('#__act_list_' + idx);
                    actList.innerHTML = '';
                    (s.actions || []).forEach(function(act, ai) {
                        var row = document.createElement('div');
                        row.style.cssText = 'display:flex;gap:4px;align-items:flex-start;margin-bottom:6px;flex-wrap:wrap;border:1px solid #333;border-radius:3px;padding:4px;';
                        row.innerHTML =
                            '<div style="flex:1;min-width:140px;"><div style="color:#999;font-size:10px;">Field Element ID</div>' +
                            '<input type="text" data-act-id value="' + (act.fieldId || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;" placeholder="e.g. m12345678-tb"></div>' +
                            '<div style="flex:2;min-width:160px;"><div style="color:#999;font-size:10px;">Value Expression (e.g. V(\'v_core\') or F(\'...\'))</div>' +
                            '<input type="text" data-act-val value="' + (act.value || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="flex:2;min-width:160px;"><div style="color:#999;font-size:10px;">Condition (optional — blank = always run)</div>' +
                            '<input type="text" data-act-cond value="' + (act.condition || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="display:flex;flex-direction:column;justify-content:center;gap:4px;">' +
                            '<button data-act-del style="color:#e74c3c;background:none;border:1px solid #e74c3c;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10px;">✕</button>' +
                            '</div>';
                        actList.appendChild(row);
                        row.querySelector('[data-act-id]').oninput = function(e) {
                            act.fieldId = e.target.value;
                        };
                        row.querySelector('[data-act-val]').oninput = function(e) {
                            act.value = e.target.value;
                        };
                        row.querySelector('[data-act-cond]').oninput = function(e) {
                            act.condition = e.target.value || undefined;
                        };
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

                function renderRdfList() {
                    var rdfList = rdfWrap.querySelector('#__rdf_list_' + idx);
                    rdfList.innerHTML = '';
                    (s.rowDetailFields || []).forEach(function(rdf, ri) {
                        var row = document.createElement('div');
                        row.style.cssText = 'display:flex;gap:4px;align-items:flex-start;margin-bottom:6px;flex-wrap:wrap;border:1px solid #333;border-radius:3px;padding:4px;';
                        row.innerHTML =
                            '<div style="flex:1;min-width:120px;"><div style="color:#999;font-size:10px;">Column Name</div>' +
                            '<input type="text" data-rdf-col value="' + (rdf.columnName || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="flex:1;min-width:120px;"><div style="color:#999;font-size:10px;">Element ID</div>' +
                            '<input type="text" data-rdf-id value="' + (rdf.elementId || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="flex:1;min-width:120px;"><div style="color:#999;font-size:10px;">Table Prefix</div>' +
                            '<input type="text" data-rdf-prefix value="' + (rdf.tablePrefix || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="width:50px;"><div style="color:#999;font-size:10px;">Expand Col</div>' +
                            '<input type="number" data-rdf-expcol value="' + (rdf.expandColIndex || 0) + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:2px 4px;font-size:11px;"></div>' +
                            '<div style="flex:2;min-width:180px;"><div style="color:#999;font-size:10px;">Collect Condition (formula, blank = always)</div>' +
                            '<textarea data-rdf-cond style="width:100%;height:48px;background:#000;color:#7ec8e3;font-family:monospace;font-size:10px;border:1px solid #2a4a6a;padding:2px;">' + (rdf.collectCondition || '') + '</textarea></div>' +
                            '<div style="display:flex;flex-direction:column;justify-content:center;gap:4px;">' +
                            '<button data-rdf-del style="color:#e74c3c;background:none;border:1px solid #e74c3c;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10px;">✕</button>' +
                            '</div>';
                        rdfList.appendChild(row);

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
                makeCollapsible(box, s.title);

                box.querySelector('[data-ti]').oninput = function(e) {
                    s.title = e.target.value;
                };
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
                box.querySelector('[data-d]').onclick = function() {
                    scan.scans.splice(idx, 1);
                    scanTab();
                };
            });
            var b = document.createElement('button');
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


        // ── SETTINGS TAB ──
        function settingsTab() {
            var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
            content.innerHTML = '';

            // Quick Return / Copy Message — prefix/suffix/delimiter are global;
            // per-rule return-message config now lives inline in the Rules tab
            // (see msgSection()'s "Include in return message" control).
            var qrDiv = document.createElement('div');
            qrDiv.style.cssText = 'border:1px solid #333;border-radius:6px;margin-bottom:10px;';
            qrDiv.innerHTML =
                '<div data-coll-header style="display:flex;align-items:center;gap:6px;padding:8px 10px;">' +
                '<span data-coll-arrow style="font-size:10px;color:#aaa;min-width:10px;">▶</span>' +
                '<b>Quick Return Message</b>' +
                '</div>' +
                '<div data-coll-body style="padding:0 10px 10px;">' +
                '<div style="margin-top:6px;"><label style="color:#aaa;font-size:11px;">Prefix (e.g. Hi {name},)</label><br>' +
                '<input id="__st_prefix" type="text" value="' + (st.msgPrefix || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-top:6px;"><label style="color:#aaa;font-size:11px;">Suffix / Signature (e.g. - wz)</label><br>' +
                '<input id="__st_suffix" type="text" value="' + (st.msgSuffix || '').replace(/"/g, '&quot;') + '" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-top:6px;"><label style="color:#aaa;font-size:11px;">Delimiter between messages (default: space + period)</label><br>' +
                '<input id="__st_delim" type="text" value="' + (st.msgDelim !== undefined ? st.msgDelim : '. ').replace(/"/g, '&quot;') + '" style="width:80px;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;margin-top:2px;"></div>' +
                '<div style="margin-top:8px;color:#666;font-size:10px;">Per-rule "include in return message" settings have moved to each rule\'s Fail/Warn section in the Rules tab.</div>' +
                '</div>';
            content.appendChild(qrDiv);
            makeCollapsible(qrDiv, 'Quick Return Message');

            // Scan hotkey
            var hkDiv = document.createElement('div');
            hkDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            var hkCurrent = (st.rescanHotkey !== undefined) ? st.rescanHotkey : DEFAULT_HOTKEY;
            hkDiv.innerHTML = '<b>Scan Hotkey</b><br>' +
                '<div style="margin-top:6px;color:#aaa;font-size:11px;">Current: <b id="__st_hk_display" style="color:#ff8;">' + (hkCurrent || 'not set') + '</b></div>' +
                '<div style="margin-top:4px;"><input id="__st_hk_input" type="text" readonly placeholder="Click here, then press your key combo..." style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:3px 5px;border-radius:3px;font-size:11px;cursor:pointer;">' +
                ' <button id="__st_hk_clear">Clear</button></div>';
            content.appendChild(hkDiv);

            var hkInput = hkDiv.querySelector('#__st_hk_input');
            var hkDisplay = hkDiv.querySelector('#__st_hk_display');
            hkInput.addEventListener('keydown', function(e) {
                e.preventDefault();
                var parts = [];
                if (e.ctrlKey) parts.push('Ctrl');
                if (e.altKey) parts.push('Alt');
                if (e.shiftKey) parts.push('Shift');
                if (e.metaKey) parts.push('Meta');
                var k = e.key;
                if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) parts.push(k.length === 1 ? k.toUpperCase() : k);
                st.rescanHotkey = parts.join('+');
                hkInput.value = st.rescanHotkey;
                hkDisplay.textContent = st.rescanHotkey;
                saveSettings();
            });

            hkDiv.querySelector('#__st_hk_clear').onclick = function() {
                st.rescanHotkey = '';
                hkInput.value = '';
                hkDisplay.textContent = 'not set';
                saveSettings();
            };

            // ── Auto-Scan on New WO ──
            var autoScanDiv = document.createElement('div');
            autoScanDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            autoScanDiv.innerHTML = '<b>Auto-Scan</b>' +
                '<div style="margin-top:8px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_autoscan" ' + (st.autoScan ? 'checked' : '') + '>' +
                '<span style="color:#aaa;font-size:11px;">Auto-scan when a new Work Order is opened</span>' +
                '</label>' +
                '<div style="color:#555;font-size:10px;margin-top:4px;">Compares the current WO number on the page to the last scanned WO. If different, a scan starts automatically.</div>' +
                '</div>';
            content.appendChild(autoScanDiv);

            autoScanDiv.querySelector('#__st_autoscan').onchange = function(e) {
                st.autoScan = e.target.checked;
                saveSettingsCfg(st);
            };

            var devTier = getDevTier();

            // Debug button (dev tier only — moved from panel)
            if (devTier === 'dev') {
                var dbgDiv = document.createElement('div');
                dbgDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
                dbgDiv.innerHTML = '<b>Debug</b><br><button id="__st_debug" style="margin-top:6px;">Run Debug Dump (check DevTools console)</button>';
                content.appendChild(dbgDiv);
                dbgDiv.querySelector('#__st_debug').onclick = function() {
                    window.__woDebugTables();
                    window.__woDebugCache();
                    alert('Check DevTools console for debug dump.');
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

                // Always prefer the in-memory st.rescanHotkey (set by keydown),
                // fall back to whatever was previously saved
                if (!st.rescanHotkey && currentSaved.rescanHotkey) {
                    st.rescanHotkey = currentSaved.rescanHotkey;
                }

                saveSettingsCfg(st);
                applyHotkey();
            }

            // ── Auto-Backup section ──
            var backupSettDiv = document.createElement('div');
            backupSettDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            var fsaSupported = typeof window.showSaveFilePicker !== 'undefined';
            backupSettDiv.innerHTML = '<b>Auto-Backup</b>' +
                '<div style="margin-top:4px;color:#555;font-size:10px;">' +
                (fsaSupported ? '✅ File System Access supported (Chrome/Edge)' : '⚠ Not supported in this browser — use manual Export/Import instead') +
                '</div>' +
                '<div style="margin-top:8px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_autobackup" ' + (st.autoBackup ? 'checked' : '') + '>' +
                '<span style="color:#aaa;font-size:11px;">Auto-save config backup on changes</span>' +
                '</label></div>' +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__st_set_new_backup" style="background:#2980b9;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;">Set New Backup Location</button>' +
                '<button id="__st_link_backup" style="background:#555;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;">Link Existing Backup</button>' +
                '</div>' +
                '<div style="margin-top:8px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_backup_prompt_reset" ' + (!st.backupPromptDismissed ? 'checked' : '') + '>' +
                '<span style="color:#aaa;font-size:11px;">Show backup setup prompt if not configured</span>' +
                '</label></div>';
            content.appendChild(backupSettDiv);

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
            updSettDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            var chOptions = ['stable'];
            if (devTier === 'beta' || devTier === 'dev') chOptions.push('beta');
            if (devTier === 'dev') chOptions.push('dev');
            var curChannel = st.channel || 'stable';
            if (chOptions.indexOf(curChannel) === -1) curChannel = 'stable';
            updSettDiv.innerHTML = '<b>Updates</b>' +
                (devTier ? ' <span style="color:#7ec8e3;font-size:10px;">(' + devTier + ' mode unlocked)</span>' : '') +
                '<div style="margin-top:8px;">' +
                '<label style="color:#aaa;font-size:11px;">Channel:</label><br>' +
                '<select id="__st_channel" style="background:#222;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;font-size:11px;margin-top:2px;">' +
                chOptions.map(function(c) {
                    return '<option value="' + c + '"' + (c === curChannel ? ' selected' : '') + '>' + c + '</option>';
                }).join('') +
                '</select>' +
                '</div>' +
                '<div style="margin-top:8px;">' +
                '<label style="color:#aaa;font-size:11px;">Version:</label><br>' +
                '<select id="__st_pin" style="width:100%;background:#222;color:#eee;border:1px solid #444;padding:3px 6px;border-radius:3px;font-size:11px;margin-top:2px;"><option value="">— latest on channel —</option></select>' +
                '</div>' +
                '<div style="margin-top:10px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_upd_disable" ' + (st.updateDisabled ? 'checked' : '') + '>' +
                '<span style="color:#aaa;font-size:11px;">Disable update check on launch</span>' +
                '</label></div>' +
                '<div style="margin-top:6px;">' +
                '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<input type="checkbox" id="__st_upd_auto" ' + (st.autoUpdate ? 'checked' : '') + '>' +
                '<span style="color:#aaa;font-size:11px;">Auto-install updates silently (no prompt)</span>' +
                '</label></div>' +
                '<div style="margin-top:8px;">' +
                '<button id="__st_check_now" style="background:#2c2c2c;color:#eee;border:1px solid #444;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;">Check for Updates Now</button>' +
                '</div>' +
                (devTier ?
                    '<div style="margin-top:8px;color:#555;font-size:10px;">window.__woLockDev() in the console re-hides beta/dev options and resets to stable.</div>' :
                    '');
            content.appendChild(updSettDiv);

            updSettDiv.querySelector('#__st_channel').onchange = function(e) {
                st.channel = e.target.value;
                saveSettingsCfg(st);
                dismissUpdateBanner();
                setStatus('Channel set to ' + st.channel + ' — checking for update...');
                checkForUpdate();
            };

            var pinSel = updSettDiv.querySelector('#__st_pin');
            var xhrV = new XMLHttpRequest();
            xhrV.open('GET', REPO_RAW_BASE + '/main/version.json', true);
            xhrV.onload = function() {
                if (xhrV.status !== 200) return;
                try {
                    var remoteV = JSON.parse(xhrV.responseText);
                    (remoteV.versions || []).forEach(function(v) {
                        var isPre = isPrerelease(v.version);
                        if (isPre && devTier !== 'beta' && devTier !== 'dev') return; // beta/dev builds stay hidden
                        var opt = document.createElement('option');
                        opt.value = v.version;
                        opt.textContent = v.version;
                        if (st.pinnedVersion === v.version) opt.selected = true;
                        pinSel.appendChild(opt);
                    });
                } catch (e) {}
            };
            xhrV.send();

            pinSel.onchange = function(e) {
                st.pinnedVersion = e.target.value;
                saveSettingsCfg(st);
                dismissUpdateBanner();
                setStatus(st.pinnedVersion ? 'Pinned to v' + st.pinnedVersion + ' — checking...' : 'Unpinned — following channel');
                checkForUpdate();
            };

            updSettDiv.querySelector('#__st_upd_disable').onchange = function(e) {
                st.updateDisabled = e.target.checked;
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
        }

        // ── UPDATE TAB ──
        function updateTab() {
            content.innerHTML = '';
            var div = document.createElement('div');
            div.style.cssText = 'display:flex;flex-direction:column;height:100%;gap:6px;';
            div.innerHTML = '<div style="color:#aaa;font-size:11px;">Paste or load the full tool script, then click Install.</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__upd_load" style="background:#2980b9;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;">Load Saved Code</button>' +
                '<label style="background:#555;color:#fff;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:12px;">Open File… <input type="file" id="__upd_file" accept=".js,.txt,text/javascript,text/plain" style="display:none;"></label>' +
                '<button id="__upd_save_file" style="background:#555;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;">Save to File…</button>' +
                '</div>' +
                '<textarea id="__upd_ta" style="flex:1;width:100%;min-height:300px;background:#000;color:#0f0;font-family:monospace;font-size:12px;border:1px solid #333;padding:6px;box-sizing:border-box;" placeholder="Paste or open a .js file..."></textarea>' +
                '<div><button id="__upd_go" style="padding:6px 16px;background:#2ecc71;color:#000;font-weight:bold;border:none;cursor:pointer;border-radius:4px;">Install</button> <span id="__upd_status" style="color:#fff;margin-left:10px;font-size:12px;"></span></div>';
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
                    updStatusEl.style.color = '#f55';
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
                    updStatusEl.style.color = '#2ecc71';
                    updStatusEl.textContent = 'Saved. Reloading...';
                    setTimeout(function() {
                        modal.remove();
                        teardown();
                        eval(code);
                    }, 1500);


                } catch (e) {
                    updStatusEl.style.color = '#f55';
                    updStatusEl.textContent = 'Save failed: ' + e.message;
                }
            };
        }

        function guideTab() {
            window.open('https://wo-review-tool-guide.netlify.app/', '_blank');
        }

        // ── PROFILES TAB ──
        function profilesTab() {
            content.innerHTML = '';

            var activeId = getActiveProfileId();
            var profiles = getProfiles();

            // ── Local profiles ──
            var localDiv = document.createElement('div');
            localDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            var localHtml = '<b>Local Profiles</b><div style="margin-top:8px;">';
            var ids = Object.keys(profiles);
            if (!ids.length) {
                localHtml += '<div style="color:#888;">No saved profiles yet — save the current config as one below, or import a preset.</div>';
            } else {
                var onlyOne = ids.length === 1;
                ids.forEach(function(id) {
                    var p = profiles[id];
                    var isActive = id === activeId;
                    // Can't delete the active profile, and can't delete your last
                    // remaining one either way — disable clearly, don't just rely on
                    // the disabled attribute's default (subtle) look.
                    var deleteBlocked = isActive || onlyOne;
                    var deleteReason = isActive ?
                        'Switch to another profile first' :
                        'This is your only saved profile';
                    localHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border:1px solid ' + (isActive ? '#2ecc71' : '#333') + ';border-radius:4px;margin-bottom:6px;">' +
                        '<div><b>' + (p.name || id) + '</b>' + (isActive ? ' <span style="color:#2ecc71;font-size:10px;">(active)</span>' : '') +
                        '<br><span style="color:#888;font-size:10px;">' + (p.description || '') + '</span></div>' +
                        '<div style="display:flex;gap:4px;">' +
                        '<button class="__pf_switch" data-id="' + id + '" style="font-size:11px;" ' + (isActive ? 'disabled' : '') + '>Switch</button>' +
                        '<button class="__pf_delete" data-id="' + id + '" style="font-size:11px;background:#5a2020;color:#fff;' + (deleteBlocked ? 'opacity:0.35;cursor:not-allowed;' : '') + '" ' +
                        (deleteBlocked ? 'disabled title="Can\'t delete — ' + deleteReason + '"' : '') + '>Delete</button>' +
                        '</div></div>';
                });
            }
            localHtml += '</div>' +
                '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button id="__pf_save_new" style="background:#2980b9;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;">Save Current As New Profile</button>' +
                '<button id="__pf_blank" style="background:#555;color:#fff;border:none;padding:4px 10px;cursor:pointer;border-radius:4px;font-size:11px;">Start Blank Profile</button>' +
                '</div>';
            localDiv.innerHTML = localHtml;
            content.appendChild(localDiv);

            localDiv.querySelectorAll('.__pf_switch').forEach(function(btn) {
                btn.onclick = function() {
                    var id = btn.getAttribute('data-id');
                    if (!confirm('Switch to "' + (profiles[id].name || id) + '"? Your current config will be saved back to its own profile first.')) return;
                    switchProfile(id);
                    alert('Switched to "' + (profiles[id].name || id) + '".');
                    modal.remove();
                    render();
                };
            });
            localDiv.querySelectorAll('.__pf_delete').forEach(function(btn) {
                btn.onclick = function() {
                    var id = btn.getAttribute('data-id');
                    if (!confirm('Delete profile "' + (profiles[id].name || id) + '"? This cannot be undone.')) return;
                    var p2 = getProfiles();
                    delete p2[id];
                    saveProfiles(p2);
                    profilesTab();
                };
            });
            localDiv.querySelector('#__pf_save_new').onclick = function() {
                var name = prompt('Name for this profile:');
                if (!name) return;
                var id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('profile-' + new Date().toISOString());
                var desc = prompt('Short description (optional):') || '';
                var snap = snapshotProfile({
                    id: id,
                    name: name.trim(),
                    description: desc
                });
                // Set active BEFORE registerProfile's own auto-save fires, so a
                // linked PC backup file reflects the new active profile right away.
                localStorage.setItem(ACTIVE_PROFILE_KEY, id);
                registerProfile(snap);
                alert('Saved as "' + name.trim() + '".');
                profilesTab();
            };

            localDiv.querySelector('#__pf_blank').onclick = function() {
                var name = prompt('Name for the new blank profile:');
                if (!name) return;
                var id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('profile-' + new Date().toISOString());
                var desc = prompt('Short description (optional):') || '';
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
                if (!confirm('Switch to a blank "' + name.trim() + '" profile now? Your current live config will be saved back to its own profile first.')) return;
                registerProfile(blank);
                switchProfile(id); // preserves the outgoing profile's live edits, same as any switch
                alert('Started blank profile "' + name.trim() + '". Build it out in Rules/Groups/Scan/Variables.');
                modal.remove();
                render();
            };

            // ── GitHub presets ──
            var ghDiv = document.createElement('div');
            ghDiv.style.cssText = 'border:1px solid #333;border-radius:6px;padding:10px;margin-bottom:10px;';
            ghDiv.innerHTML = '<b>Import Preset from GitHub</b><div id="__pf_gh_list" style="margin-top:8px;color:#888;">Loading…</div>';
            content.appendChild(ghDiv);

            fetchProfileIndex().then(function(list) {
                var listDiv = ghDiv.querySelector('#__pf_gh_list');
                if (!list || !list.length) {
                    listDiv.innerHTML = '<div style="color:#e74c3c;">Could not load presets (offline?).</div>';
                    return;
                }
                listDiv.innerHTML = list.map(function(p) {
                    var already = !!profiles[p.id];
                    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px;border:1px solid #333;border-radius:4px;margin-bottom:6px;">' +
                        '<div><b>' + p.name + '</b><br><span style="color:#888;font-size:10px;">' + (p.description || '') + '</span></div>' +
                        '<button class="__pf_import" data-id="' + p.id + '" style="font-size:11px;">' + (already ? 'Re-import &amp; Switch' : 'Import &amp; Switch') + '</button>' +
                        '</div>';
                }).join('');
                listDiv.querySelectorAll('.__pf_import').forEach(function(btn) {
                    btn.onclick = function() {
                        var id = btn.getAttribute('data-id');
                        btn.disabled = true;
                        btn.textContent = 'Importing...';
                        installProfileFromGitHub(id).then(function(ok) {
                            if (ok) {
                                alert('Imported and switched.');
                                modal.remove();
                                render();
                            } else {
                                btn.disabled = false;
                                btn.textContent = 'Failed — retry';
                            }
                        });
                    };
                });
            });
        }

        modal.querySelector('#__s_guide').onclick = guideTab;
        modal.querySelector('#__s_rules').onclick = rulesTab;
        modal.querySelector('#__s_vars').onclick = varsTab;
        modal.querySelector('#__s_groups').onclick = groupsTab;
        modal.querySelector('#__s_scan').onclick = scanTab;
        modal.querySelector('#__s_profiles').onclick = profilesTab;
        modal.querySelector('#__s_settings').onclick = settingsTab;
        modal.querySelector('#__s_update').onclick = updateTab;
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

    function applyHotkey() {
        var st = JSON.parse(localStorage.getItem('__wo_settings') || '{}');
        var hk = (st.rescanHotkey !== undefined) ? st.rescanHotkey : DEFAULT_HOTKEY;
        if (window.__wo_hk_listener) document.removeEventListener('keydown', window.__wo_hk_listener);
        // Update rescan button tooltip
        var rescanBtn = panel && panel.querySelector('#__wo_rescan');
        if (rescanBtn) rescanBtn.title = hk ? 'Scan (' + hk + ')' : 'Scan';
        if (!hk) return;

        window.__wo_hk_listener = function(e) {
            var parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey) parts.push('Meta');
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
            if (parts.join('+') === hk) {
                e.preventDefault();
                runScan(render);
            }
        };
        document.addEventListener('keydown', window.__wo_hk_listener);
    }
    applyHotkey();

    buildPanel();
    // mergeSnapshot(extractSnapshotFull());

    startupRestore().then(function() {
        // A fresh install (nothing restored from a linked backup file) gets an
        // interactive installer instead of a silent default. Anything already
        // restored (RKEY present) skips straight through.
        if (!localStorage.getItem(RKEY)) {
            return showInstaller().then(function() {
                applyHotkey(); // config just arrived — (re)attach hotkey listener from it
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
        render();
        checkAutoScan();
        startWOWatcher();
        checkForUpdate();
    });

})();
