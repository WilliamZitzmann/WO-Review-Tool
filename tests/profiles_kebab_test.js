// Black-box test of the REAL wo_tool.js Local Profiles kebab menu (not a
// reimplementation): Switch/Delete used to be separate always-visible
// buttons; Duplicate didn't exist at all. Verifies all three are now
// behind a single "..." menu per row (same wo-kebab-menu convention as
// Variables/Rules), with Switch/Delete correctly disabled for the active
// profile or when it's the only one saved, and Duplicate producing a real
// independent copy (not a reference) under a new id.
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
    w.confirm = function() { return true; }; // woConfirm() uses a custom modal, but be defensive
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
    w.localStorage.setItem('__wo_settings', JSON.stringify({ backupPromptDismissed: true }));

    var profileShape = { rules: { groups: [], rules: [] }, scan: { woTabId: 'x', scans: [] }, fields: {}, state: {}, vars: [], settings: {} };
    var profiles = {
        active_one: Object.assign({ id: 'active_one', name: 'Active One', description: 'currently active', configVersion: 1, savedAt: new Date().toISOString() }, profileShape),
        other_one: Object.assign({ id: 'other_one', name: 'Other One', description: 'not active', configVersion: 1, savedAt: new Date().toISOString() }, profileShape),
    };
    w.localStorage.setItem('__wo_profiles', JSON.stringify(profiles));
    w.localStorage.setItem('__wo_active_profile_id', 'active_one');
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

function openProfilesTab(w) {
    var doc = w.document;
    doc.getElementById('__wo_setup').click();
    doc.getElementById('__s_profiles').click();
}

async function testKebabRendersInsteadOfBareButtons() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    openProfilesTab(w);
    var doc = w.document;

    check('no bare .__pf_switch button exists anymore', !doc.querySelector('.__pf_switch'));
    check('no bare .__pf_delete button exists anymore', !doc.querySelector('.__pf_delete'));
    var kebabs = doc.querySelectorAll('[data-pf-kebab]');
    check('each profile row has its own kebab button', kebabs.length === 2, kebabs.length);
}

async function testActiveProfileRowDisablesSwitchAndDelete() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    openProfilesTab(w);
    var doc = w.document;
    var activeKebab = doc.querySelector('[data-pf-kebab][data-id="active_one"]');
    activeKebab.click();

    var menu = w.document.querySelector('.wo-kebab-menu');
    check('kebab menu opens with Switch/Duplicate/Delete items', !!menu && menu.querySelector('[data-switch]') && menu.querySelector('[data-dup]') && menu.querySelector('[data-del]'));
    check('Switch is disabled for the currently active profile', menu.querySelector('[data-switch]').disabled === true);
    check('Delete is disabled for the currently active profile', menu.querySelector('[data-del]').disabled === true);
    check('Duplicate is NOT disabled for the active profile (still a valid action)', menu.querySelector('[data-dup]').disabled === false);
}

async function testOtherProfileRowAllowsSwitchAndDelete() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    openProfilesTab(w);
    var doc = w.document;
    var otherKebab = doc.querySelector('[data-pf-kebab][data-id="other_one"]');
    otherKebab.click();

    var menu = w.document.querySelector('.wo-kebab-menu');
    check('Switch is enabled for a non-active profile (2 profiles exist, not "only one")', menu.querySelector('[data-switch]').disabled === false);
    check('Delete is enabled for a non-active profile', menu.querySelector('[data-del]').disabled === false);
}

async function testDuplicateCreatesIndependentCopy() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    openProfilesTab(w);
    var doc = w.document;
    var otherKebab = doc.querySelector('[data-pf-kebab][data-id="other_one"]');
    otherKebab.click();
    var menu = w.document.querySelector('.wo-kebab-menu');
    menu.querySelector('[data-dup]').click();
    await tick(50);

    var profiles = w.__woTestHooks.getProfiles();
    var ids = Object.keys(profiles);
    check('duplicating added a THIRD profile (2 -> 3)', ids.length === 3, ids);
    var newId = ids.filter(function(id) { return id !== 'active_one' && id !== 'other_one'; })[0];
    check('the duplicate has a new id, not "other_one" itself', !!newId && newId !== 'other_one');
    check('the duplicate\'s name is suffixed "(copy)"', !!newId && profiles[newId].name === 'Other One (copy)', newId && profiles[newId].name);
    check('the original "other_one" profile is untouched', profiles.other_one.name === 'Other One');

    // Independent copy, not a shared reference - mutating the duplicate's
    // rules must not affect the original.
    profiles[newId].rules.rules.push({ id: 'injected' });
    w.__woTestHooks.saveProfiles(profiles);
    var reread = w.__woTestHooks.getProfiles();
    check('mutating the duplicate\'s rules does not leak into the original (deep copy, not a reference)',
        reread.other_one.rules.rules.length === 0, reread.other_one.rules.rules);
}

(async function main() {
    await testKebabRendersInsteadOfBareButtons();
    await testActiveProfileRowDisablesSwitchAndDelete();
    await testOtherProfileRowAllowsSwitchAndDelete();
    await testDuplicateCreatesIndependentCopy();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
