// Black-box test of the REAL wo_tool.js scan-log minimize toggle (not a
// reimplementation): a "-" button in the top-right of the status area
// hides just #__wo_scanlog (the step-by-step "Reading WO tab...",
// "Scanning: X..." lines) to reclaim space, while #__wo_status (e.g.
// "Scan Complete 11:02") and #__wo_summary (the rule output) stay
// visible either way. Persisted via __wo_settings.scanLogMinimized, same
// convention as panelCollapsed.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TOOL_PATH = path.join(__dirname, '..', 'wo_tool.js');
const toolSrc = fs.readFileSync(TOOL_PATH, 'utf8');

function makeDom(settingsOverride) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const w = dom.window;
    w.fetch = function() { return Promise.reject(new Error('network disabled')); };
    w.XMLHttpRequest = function() {
        var self = this;
        self.open = function() {};
        self.setRequestHeader = function() {};
        self.send = function() { setTimeout(function() { if (self.onerror) self.onerror(new Error('network disabled')); }, 0); };
    };
    w.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
    w.localStorage.setItem('__wo_settings', JSON.stringify(Object.assign({ backupPromptDismissed: true }, settingsOverride || {})));
    return dom;
}

function tick(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

async function testToggleHidesOnlyScanLog() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);
    var doc = w.document;

    var toggleBtn = doc.getElementById('__wo_scanlog_toggle');
    check('minimize toggle button exists in the status area', !!toggleBtn);
    check('scan log starts visible by default', doc.getElementById('__wo_scanlog').style.display !== 'none');

    toggleBtn.click();
    check('clicking the toggle hides #__wo_scanlog', doc.getElementById('__wo_scanlog').style.display === 'none');
    check('#__wo_status is untouched (still present, no display:none)', doc.getElementById('__wo_status').style.display !== 'none');
    check('#__wo_summary is untouched (still present, no display:none)', doc.getElementById('__wo_summary').style.display !== 'none');
    check('toggle button now shows "+" (expand affordance)', toggleBtn.textContent === '+');

    toggleBtn.click();
    check('clicking again shows #__wo_scanlog again', doc.getElementById('__wo_scanlog').style.display !== 'none');
    check('toggle button shows "−" again', toggleBtn.textContent === '−');
}

async function testPersistedAcrossReload() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);
    var doc = w.document;

    doc.getElementById('__wo_scanlog_toggle').click();
    var settingsAfterToggle = JSON.parse(w.localStorage.getItem('__wo_settings'));
    check('scanLogMinimized persisted to __wo_settings after toggling', settingsAfterToggle.scanLogMinimized === true);

    // Simulate a fresh boot (new tool instance, same localStorage) - the
    // minimized state should be respected from the start, not reset.
    const dom2 = makeDom({ scanLogMinimized: true });
    const w2 = dom2.window;
    w2.eval(toolSrc);
    await tick(50);
    check('a fresh boot with scanLogMinimized:true starts with the scan log already hidden',
        w2.document.getElementById('__wo_scanlog').style.display === 'none');
    check('...and the toggle button shows "+" on that fresh boot too',
        w2.document.getElementById('__wo_scanlog_toggle').textContent === '+');
}

(async function main() {
    await testToggleHidesOnlyScanLog();
    await testPersistedAcrossReload();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
