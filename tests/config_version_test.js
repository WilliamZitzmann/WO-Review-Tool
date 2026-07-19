// Black-box test of the REAL wo_tool.js config-version gate and
// backup/import shape validation (not a reimplementation): covers
// migrateProfile()/switchProfile() throwing on a too-new configVersion,
// and applyBackup()/validateBackupShape() rejecting malformed or
// too-new backup blobs before writing anything to localStorage.
//
// Drives this through window.__woTestHooks (see its own comment in
// wo_tool.js) rather than reaching into module-private state.
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
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
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

async function testMigrateProfileRejectsNewerVersion() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    const hooks = w.__woTestHooks;
    check('test hooks present', !!hooks);
    check('CURRENT_CONFIG_VERSION exposed and is 1', hooks.CURRENT_CONFIG_VERSION === 1, hooks.CURRENT_CONFIG_VERSION);

    var futureProfile = { id: 'p1', name: 'Future', configVersion: 99, rules: { groups: [], rules: [] } };
    var threw = null;
    try {
        hooks.migrateProfile(futureProfile);
    } catch (e) {
        threw = e;
    }
    check('migrateProfile throws on configVersion newer than this build understands', !!threw, threw && threw.message);
    check('error message names both the config version and the cap',
        !!threw && /v99/.test(threw.message) && /v1/.test(threw.message));

    var currentProfile = { id: 'p2', name: 'Current', configVersion: 1, rules: { groups: [], rules: [] } };
    var ok = null;
    try {
        ok = hooks.migrateProfile(currentProfile);
    } catch (e) {}
    check('migrateProfile does not throw on a profile at the current version', ok && ok.configVersion === 1);
}

async function testSwitchProfileLeavesPointerConsistentOnRejectedMigration() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    const hooks = w.__woTestHooks;
    var profiles = {
        good: { id: 'good', name: 'Good', configVersion: 1, rules: { groups: [], rules: [] }, scan: { woTabId: 'x', scans: [] }, fields: {}, state: {}, vars: [], settings: {} },
        future: { id: 'future', name: 'Future', configVersion: 99, rules: { groups: [], rules: [] }, scan: { woTabId: 'x', scans: [] }, fields: {}, state: {}, vars: [], settings: {} }
    };
    hooks.saveProfiles(profiles);
    w.localStorage.setItem('__wo_active_profile_id', 'good');

    var threw = null;
    try {
        hooks.switchProfile('future');
    } catch (e) {
        threw = e;
    }
    check('switchProfile throws (via migrateProfile) on a too-new target profile', !!threw, threw && threw.message);
    check('active-profile pointer was NOT moved to the rejected target - stays consistent with actually-applied data',
        w.localStorage.getItem('__wo_active_profile_id') === 'good');
}

async function testApplyBackupRejectsTooNewConfigVersion() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    const hooks = w.__woTestHooks;
    var before = w.localStorage.getItem('__wo_rules_config');
    var b = { configVersion: 99, rules: { groups: [], rules: [{ id: 'r_new' }] } };

    var threw = null;
    try {
        hooks.applyBackup(b);
    } catch (e) {
        threw = e;
    }
    check('applyBackup throws on a too-new configVersion', !!threw, threw && threw.message);
    check('nothing was written - RKEY unchanged after a rejected backup', w.localStorage.getItem('__wo_rules_config') === before);
}

async function testApplyBackupRejectsMalformedShape() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);
    const hooks = w.__woTestHooks;

    var cases = [
        ['not an object at all', 'just a string'],
        ['a bare array', ['a', 'b']],
        ['rules is a string instead of an object', { rules: 'oops' }],
        ['rules.rules is not an array', { rules: { groups: [], rules: 'oops' } }],
        ['scan is an array instead of an object', { scan: ['oops'] }],
        ['src is not a string', { src: 12345 }],
        ['src is syntactically invalid JS', { src: 'function( { this is not valid js' }]
    ];

    cases.forEach(function(c) {
        var label = c[0], blob = c[1];
        var threw = null;
        try {
            hooks.applyBackup(blob);
        } catch (e) {
            threw = e;
        }
        check('applyBackup rejects: ' + label, !!threw, threw && threw.message);
    });
}

async function testApplyBackupAcceptsWellFormedBlob() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);
    const hooks = w.__woTestHooks;

    var blob = JSON.parse(hooks.buildBackupBlob());
    check('buildBackupBlob() stamps configVersion', blob.configVersion === hooks.CURRENT_CONFIG_VERSION, blob.configVersion);

    var threw = null;
    try {
        hooks.applyBackup(blob);
    } catch (e) {
        threw = e;
    }
    check('applyBackup accepts a well-formed, current-version blob produced by buildBackupBlob() itself', !threw, threw && threw.message);
}

(async function main() {
    await testMigrateProfileRejectsNewerVersion();
    await testSwitchProfileLeavesPointerConsistentOnRejectedMigration();
    await testApplyBackupRejectsTooNewConfigVersion();
    await testApplyBackupRejectsMalformedShape();
    await testApplyBackupAcceptsWellFormedBlob();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
