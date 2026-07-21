// Black-box test of the REAL wo_tool.js update-install path (not a
// reimplementation): verifies that applying a self-update
// (rawInstall -> applyUpdateWhenIdle -> applyUpdateNow) defers the actual
// teardown()+eval() while a scan is in progress, applies once it clears,
// and that whatever was on screen (scan results/log/return message)
// survives the reload via the sessionStorage snapshot/restore round trip -
// the same real choke point installUpdate()/checkDevUpdate() both use.
//
// Drives this through window.__woTestHooks (a small, explicitly-labeled
// dev/test affordance in wo_tool.js itself — see its own comment) rather
// than reaching into module-private state, since `scanning`/`cache` aren't
// otherwise reachable from outside the tool's own closure.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TOOL_PATH = path.join(__dirname, '..', 'wo_tool.js');
const toolSrc = fs.readFileSync(TOOL_PATH, 'utf8');

function makeDom() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const w = dom.window;
    w.fetch = function() { return Promise.reject(new Error('network disabled in test')); };
    w.XMLHttpRequest = function() {
        var self = this;
        self.open = function() {};
        self.setRequestHeader = function() {};
        self.send = function() { setTimeout(function() { if (self.onerror) self.onerror(new Error('network disabled')); }, 0); };
    };
    w.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };
    // RKEY present with .rules skips the first-run installer.
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
    // Suppresses startupRestore()'s unrelated backup-setup nag prompt, which
    // this test's minimal DOM fixture doesn't have the elements for — not
    // something this file is testing.
    w.localStorage.setItem('__wo_settings', JSON.stringify({ backupPromptDismissed: true }));
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

async function testDeferredUntilScanFinishes() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50); // let the async boot chain (startupRestore etc.) settle

    const hooksBefore = w.__woTestHooks;
    check('tool booted, test hooks present', !!hooksBefore);

    hooksBefore.setScanning(true);
    check('scanning forced true via test hook', hooksBefore.isScanning() === true);

    hooksBefore.rawInstall(toolSrc, 'v-test-1');
    await tick(50);

    check('code is cached (downloaded) immediately regardless of scanning',
        w.localStorage.getItem('__wo_tool_src') === toolSrc);
    check('apply is DEFERRED while scanning - same instance still running (hooks object unchanged)',
        w.__woTestHooks === hooksBefore);

    // Still deferred well past the poll interval, as long as scanning stays true.
    await tick(1200);
    check('still deferred after 1.2s of continued scanning', w.__woTestHooks === hooksBefore);

    hooksBefore.setScanning(false);
    // Poll interval (500ms) + applyUpdateNow's own 800ms setTimeout + margin.
    await tick(1800);

    check('apply proceeded once scanning cleared - a NEW instance booted (hooks object replaced)',
        w.__woTestHooks !== hooksBefore);
}

async function testSnapshotSurvivesReload() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    const fakeCache = { fields: { 'Tab :: Field': 'hello' }, tables: {}, tableErrors: {} };
    const fakeLog = ['Scan started', 'Tab read OK'];
    const fakeReturnMsg = 'Everything checks out.';
    w.__woTestHooks.setScanState(fakeCache, true, fakeLog, fakeReturnMsg);

    check('scan state seeded via test hook',
        JSON.stringify(w.__woTestHooks.getScanState().cache) === JSON.stringify(fakeCache));

    // Not scanning this time - apply happens on the next tick without a defer wait.
    w.__woTestHooks.rawInstall(toolSrc, 'v-test-2');
    await tick(1200); // applyUpdateNow's own 800ms setTimeout + margin

    const restored = w.__woTestHooks.getScanState();
    check('cache survived the teardown()+eval() round trip via sessionStorage snapshot/restore',
        JSON.stringify(restored.cache) === JSON.stringify(fakeCache), restored.cache);
    check('hasScanned survived (true, not reset to pre-scan blank state)', restored.hasScanned === true);
    check('scanLog survived', JSON.stringify(restored.scanLog) === JSON.stringify(fakeLog), restored.scanLog);
    check('currentReturnMsg survived', restored.currentReturnMsg === fakeReturnMsg, restored.currentReturnMsg);

    check('the snapshot key is cleaned up after being consumed (no leftover state)',
        w.sessionStorage.getItem('__wo_update_scan_snapshot') === null);
}

async function testNoSnapshotWhenNothingWasScanned() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    // hasScanned is false by default (fresh boot, never scanned) - an
    // update applied here should NOT bother writing a snapshot at all.
    check('hasScanned is false on a fresh boot', w.__woTestHooks.getScanState().hasScanned === false);

    w.__woTestHooks.rawInstall(toolSrc, 'v-test-3');
    await tick(400); // mid-flight, before the 800ms apply delay fires

    check('no snapshot was written for a pre-scan (nothing real to preserve) update',
        w.sessionStorage.getItem('__wo_update_scan_snapshot') === null);
}

// ── The update BANNER's visibility must not depend on the defer-until-
// idle mechanism above at all — it's a completely separate decision
// (checkForUpdate()'s own branching, untouched by this change) about
// whether to auto-install silently vs. show a manual-install prompt. A
// minor-version bump with autoUpdate explicitly off must still show
// showUpdatePrompt()'s banner. ──
async function testBannerShowsWhenAutoUpdateOff() {
    const dom = makeDom();
    const w = dom.window;
    w.localStorage.setItem('__wo_settings', JSON.stringify({
        backupPromptDismissed: true,
        autoUpdate: false,
        autoUpdatePatch: false // patch auto-update defaults ON otherwise - this test uses a MINOR bump anyway, but belt-and-suspenders
    }));

    var versionJson = JSON.stringify({
        latest: '0.28.0',
        channels: { stable: '0.28.0', beta: '0.28.0' },
        versions: [{ version: '0.28.0', name: 'Test Bump', changes: ['A change.'] }]
    });
    w.XMLHttpRequest = function() {
        var self = this;
        self.open = function(method, url) { self._url = url; };
        self.setRequestHeader = function() {};
        self.send = function() {
            setTimeout(function() {
                if (String(self._url || '').indexOf('version.json') !== -1) {
                    self.status = 200;
                    self.responseText = versionJson;
                    if (self.onload) self.onload();
                } else if (self.onerror) {
                    self.onerror(new Error('network disabled'));
                }
            }, 0);
        };
    };

    w.eval(toolSrc);
    await tick(150); // boot's own checkForUpdate() call + the mocked XHR round trip

    var banner = w.document.getElementById('__wo_update_banner');
    check('update banner appears for a minor bump with auto-update off (not silently auto-installed)',
        !!banner, banner && banner.textContent.slice(0, 80));
    check('banner mentions the available version', !!banner && banner.textContent.indexOf('0.28.0') !== -1);
}

(async function main() {
    await testDeferredUntilScanFinishes();
    await testSnapshotSurvivesReload();
    await testNoSnapshotWhenNothingWasScanned();
    await testBannerShowsWhenAutoUpdateOff();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
