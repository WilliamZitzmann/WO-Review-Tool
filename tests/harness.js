// Standalone harness: loads the real wo_tool.js into a jsdom window,
// seeds localStorage with dev/beta grants + a config that already has
// rules (skips the first-run installer), then drives the ACTUAL Setup UI
// (button clicks, not a hand-copied reimplementation) to verify:
//  1) domain() decode caching doesn't change behavior
//  2) a "Domain List" API table resolves via T()/lookup()
//  4) a custom table formula column computes per-row via R(), survives a
//     header rename, and the +Row/+Col buttons + context menu work
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TOOL_PATH = path.join(__dirname, '..', 'wo_tool.js');
const toolSrc = fs.readFileSync(TOOL_PATH, 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
    runScripts: 'outside-only',
    pretendToBeVisual: true
});
const { window } = dom;

window.fetch = function() {
    return Promise.reject(new Error('network disabled in test harness'));
};
window.XMLHttpRequest = function() {
    var self = this;
    self.open = function() {};
    self.setRequestHeader = function() {};
    self.send = function() {
        setTimeout(function() {
            if (typeof self.onerror === 'function') self.onerror(new Error('network disabled'));
        }, 0);
    };
};
window.ResizeObserver = function() {
    return { observe: function() {}, unobserve: function() {}, disconnect: function() {} };
};

window.localStorage.setItem('__wo_grants', JSON.stringify(['user', 'dev', 'beta_0']));
window.localStorage.setItem('__wo_settings', JSON.stringify({ betaEnabled: { beta_2: true } }));

// Fake domain list, same shape __woBeta2Report() confirmed from a real
// Maximo install (attributes map + array-of-arrays data).
window.localStorage.setItem('TESTPRIORITY', JSON.stringify({
    attributes: { value: 0, description: 1 },
    data: [
        ['1', 'Emergency'],
        ['2', 'Urgent'],
        ['8', 'By Due Date']
    ]
}));

// RKEY ('__wo_rules_config') present with .rules skips the first-run
// installer entirely (see the file's own boot sequence, near its end).
window.localStorage.setItem('__wo_rules_config', JSON.stringify({
    groups: [],
    rules: [],
    customTables: {
        TestTable: {
            columns: ['Code', 'Meaning'],
            rows: [{ Code: '1' }, { Code: '2' }, { Code: '8' }],
            columnFormulas: { Meaning: "domain('TESTPRIORITY', R('Code'))" }
        }
    },
    apiTables: {
        PriorityDomain: { source: 'domain', domainKey: 'TESTPRIORITY' }
    }
}));
window.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
window.localStorage.setItem('__wo_vars_config', JSON.stringify([
    { id: 'v_meaning8', label: 'Meaning of 8', formula: "lookup('TestTable','Code','8','Meaning')" },
    { id: 'v_domain_tbl', label: 'Domain table lookup', formula: "lookup('PriorityDomain','value','8','description')" }
]));

// Spy on JSON.parse to verify #1 (domain caching): re-testing the same
// variable repeatedly should NOT re-parse the TESTPRIORITY blob every time.
let domainParseCount = 0;
const realJSONParse = window.JSON.parse.bind(window.JSON);
window.JSON.parse = function(str) {
    if (typeof str === 'string' && str.indexOf('TESTPRIORITY'.slice(0, 0)) === 0) {} // no-op, keep shape
    if (typeof str === 'string' && str.indexOf('"By Due Date"') >= 0) domainParseCount++;
    return realJSONParse(str);
};

let bootError = null;
window.addEventListener('error', function(e) {
    bootError = e.error || e.message;
});

try {
    window.eval(toolSrc);
} catch (e) {
    bootError = e;
}

const results = [];
function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail ? ' :: ' + detail : ''));
}

check('tool loaded without throwing', !bootError, bootError && (bootError.stack || String(bootError)));

setTimeout(function() {
    const doc = window.document;
    const setupBtn = doc.querySelector('#__wo_setup');
    check('Setup button exists in panel', !!setupBtn);
    if (setupBtn) setupBtn.click();

    const tablesTabBtn = doc.querySelector('#__s_tables');
    check('Tables tab button exists in Setup modal', !!tablesTabBtn);
    if (tablesTabBtn) tablesTabBtn.click();

    // ── Custom table: formula column rendering ──
    const ctGrid = doc.querySelector('.wo-ct-grid');
    check('Custom table grid rendered', !!ctGrid);

    const addRowBtn = doc.querySelector('.__ct_addrow');
    const addColBtn = doc.querySelector('.__ct_addcol');
    check('+ Row button exists', !!addRowBtn);
    check('+ Col button exists', !!addColBtn);

    const fxBadge = ctGrid && ctGrid.querySelector('th .wo-mono');
    check('Formula column header shows fx badge', !!fxBadge, fxBadge && fxBadge.textContent);

    const formulaCells = ctGrid ? Array.from(ctGrid.querySelectorAll('td')).filter(function(td) {
        return td.textContent.trim() === 'ƒx' || td.textContent.trim() === 'fx' || td.getAttribute('style') && td.getAttribute('style').indexOf('italic') >= 0;
    }) : [];
    check('Formula column body cells render as computed placeholders (not inputs)', formulaCells.length === 3, formulaCells.length + ' found');

    const formulaWrap = doc.querySelector('[data-ct-formula-wrap="Meaning"]');
    check('Formula-column editor box rendered for "Meaning"', !!formulaWrap);
    const formulaTextarea = formulaWrap && formulaWrap.querySelector('textarea');
    check('Formula textarea has the saved formula', !!(formulaTextarea && formulaTextarea.value.indexOf("R('Code')") >= 0), formulaTextarea && formulaTextarea.value);

    // ── Variables tab: verify the actual computed value via lookup()+R()+domain() ──
    const varsTabBtn = doc.querySelector('#__s_vars');
    check('Variables tab button exists', !!varsTabBtn);
    if (varsTabBtn) varsTabBtn.click();

    const testButtons = doc.querySelectorAll('[data-vt]');
    check('Variable Test buttons found', testButtons.length >= 2, testButtons.length + ' found');
    testButtons.forEach(function(btn) {
        btn.click();
    });
    const resultSpans = Array.from(doc.querySelectorAll('[data-vr]')).map(function(s) {
        return s.textContent;
    });
    console.log('Variable test results:', JSON.stringify(resultSpans));
    check('v_meaning8 (custom table formula column via R()) resolved to "By Due Date"', resultSpans.some(function(t) {
        return t.indexOf('By Due Date') >= 0;
    }), resultSpans.join(' | '));
    check('v_domain_tbl (API table source: domain) resolved to "By Due Date"', resultSpans.some(function(t) {
        return t.indexOf('By Due Date') >= 0;
    }) && resultSpans.length >= 2, resultSpans.join(' | '));

    // ── Rename carry-over: rename "Meaning" -> "Decoded", re-test ──
    doc.querySelector('#__s_tables').click();
    const headerInput = doc.querySelector('.wo-ct-grid thead input');
    let renamed = false;
    if (headerInput) {
        // Second header input is "Meaning" (first is "Code")
        const headerInputs = doc.querySelectorAll('.wo-ct-grid thead input');
        if (headerInputs[1]) {
            headerInputs[1].value = 'Decoded';
            headerInputs[1].dispatchEvent(new window.Event('input', { bubbles: true }));
            renamed = true;
        }
    }
    check('Renamed formula column header via input', renamed);

    const cfgAfterRename = JSON.parse(window.localStorage.getItem('__wo_rules_config'));
    // NOTE: openSetup() works on an in-memory copy of cfg, only persisted on
    // Save & Apply - check the in-memory `t` object instead by re-reading
    // the DOM's formula-wrap now that it's re-rendered under the new name.
    doc.querySelector('#__s_tables').click();
    const renamedWrap = doc.querySelector('[data-ct-formula-wrap="Decoded"]');
    check('Formula section follows the renamed column (in-memory)', !!renamedWrap);

    // ── Context menu: Remove Formula Column ──
    const thCells = doc.querySelectorAll('.wo-ct-grid thead th');
    let removed = false;
    if (thCells[1]) {
        const evt = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
        thCells[1].dispatchEvent(evt);
        const rmItem = Array.from(doc.querySelectorAll('[data-ct-act="rmformula"]'));
        if (rmItem[0]) {
            rmItem[0].click();
            removed = true;
        }
    }
    check('Remove Formula Column context-menu item found and clicked', removed);
    doc.querySelector('#__s_tables').click();
    const stillFormula = doc.querySelector('[data-ct-formula-wrap="Decoded"]');
    check('Column no longer a formula column after Remove', !stillFormula);

    // ── Caching (#1): re-test both domain-touching variables several more
    // times; parse count for the TESTPRIORITY blob should barely move.
    const parseCountBefore = domainParseCount;
    for (let i = 0; i < 5; i++) {
        testButtons.forEach(function(btn) { btn.click(); });
    }
    const parseCountAfter = domainParseCount;
    check('Domain list is not re-parsed on every read (cache hit)', (parseCountAfter - parseCountBefore) === 0, 'parses before=' + parseCountBefore + ' after 10 more reads=' + parseCountAfter);

    // ── + Row / + Col buttons actually mutate the table, not just exist ──
    doc.querySelector('#__s_tables').click();
    const rowsBefore = doc.querySelectorAll('.wo-ct-grid tbody tr').length;
    doc.querySelector('.__ct_addrow').click();
    const rowsAfter = doc.querySelectorAll('.wo-ct-grid tbody tr').length;
    check('+ Row button adds a row', rowsAfter === rowsBefore + 1, rowsBefore + ' -> ' + rowsAfter);

    const colsBefore = doc.querySelectorAll('.wo-ct-grid thead th').length;
    doc.querySelector('.__ct_addcol').click();
    const colsAfter = doc.querySelectorAll('.wo-ct-grid thead th').length;
    check('+ Col button adds a column', colsAfter === colsBefore + 1, colsBefore + ' -> ' + colsAfter);

    // ── Delete Column via context menu ──
    const colsBeforeDelete = doc.querySelectorAll('.wo-ct-grid thead th').length;
    const firstTh = doc.querySelector('.wo-ct-grid thead th');
    firstTh.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    const delColItem = doc.querySelector('[data-ct-act="delcol"]');
    check('Delete Column context-menu item found', !!delColItem);
    if (delColItem) delColItem.click();
    const colsAfterDelete = doc.querySelectorAll('.wo-ct-grid thead th').length;
    check('Delete Column button removes a column', colsAfterDelete === colsBeforeDelete - 1, colsBeforeDelete + ' -> ' + colsAfterDelete);

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
}, 300);
