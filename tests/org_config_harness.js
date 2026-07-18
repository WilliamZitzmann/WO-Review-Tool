// Focused jsdom test for Phase E (wo tool consuming admin-managed org
// configs), UPDATED for the redesigned flow where org config LISTING is a
// pure localStorage read (metadata loader.js cached from its last real
// check-access call) but INSTALLING always does a live re-fetch
// (fetchOrgConfigsLive() -> runCheckAccess() -> bootstrap/whoami/
// check-access -> /org-config-content) at the exact moment of the click.
// This mocks XMLHttpRequest with real fixture responses for every URL the
// real chain hits (whoami, bootstrap, check-access, org-config-content) so
// the ACTUAL live-fetch code path in wo_tool.js runs end-to-end, not a
// stand-in for it.
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

const WORKER_BASE_URL = 'https://wo-review-tool-access.williamzitzmann.workers.dev';

const orgConfigContent = {
    rules: { groups: [], rules: [{ id: 'org-rule-1', name: 'from org config' }] },
    scan: { woTabId: 'wotrackingtable', scans: [] },
    fields: { someField: true },
    state: {},
    vars: [{ id: 'v_org', label: 'Org var', formula: "'hello'" }]
};

let checkAccessCalls = 0;
let orgConfigContentCalls = 0;

window.fetch = function() { return Promise.reject(new Error('fetch disabled - this harness only exercises the XHR-based live-fetch chain')); };

window.XMLHttpRequest = function() {
    var self = this;
    var method, url, body;
    self.open = function(m, u) { method = m; url = u; };
    self.setRequestHeader = function() {};
    self.send = function(b) {
        body = b;
        setTimeout(function() {
            var status = 200, responseText = '';
            if (/\/maximo\/oslc\/whoami$/.test(url)) {
                responseText = JSON.stringify({ loginID: 'testuser', email: 'testuser@abbvie.com', country: 'IE', insertSite: 'AVWP' });
            } else if (url === WORKER_BASE_URL + '/bootstrap') {
                responseText = JSON.stringify({ maximoHosts: [], requiredFields: ['username', 'email', 'country', 'insertSite'] });
            } else if (url === WORKER_BASE_URL + '/check-access') {
                checkAccessCalls++;
                responseText = JSON.stringify({
                    granted: true, grants: ['user'], token: 'fake-token-' + checkAccessCalls,
                    configs: [{ id: 'cfg_avwp', name: 'AVWP Maintenance', description: 'AVWP site defaults' }]
                });
            } else if (url.indexOf(WORKER_BASE_URL + '/org-config-content') === 0) {
                orgConfigContentCalls++;
                responseText = JSON.stringify({
                    configs: [{ id: 'cfg_avwp', name: 'AVWP Maintenance', description: 'AVWP site defaults', content: orgConfigContent }]
                });
            } else {
                status = 404;
            }
            self.status = status;
            self.responseText = responseText;
            if (typeof self.onload === 'function') self.onload();
        }, 0);
    };
};
window.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };

window.localStorage.setItem('__wo_grants', JSON.stringify(['user']));

// Exactly the METADATA-ONLY shape loader.js's cacheOrgConfigsMetadata() now
// writes (no `.content` — that's only ever fetched live, at install time).
window.localStorage.setItem('__wo_org_configs', JSON.stringify([
    { id: 'cfg_avwp', name: 'AVWP Maintenance', description: 'AVWP site defaults' }
]));

let bootError = null;
window.addEventListener('error', function(e) { bootError = e.error || e.message; });
try {
    window.eval(toolSrc);
} catch (e) {
    bootError = e;
}

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

check('tool loaded without throwing', !bootError, bootError && (bootError.stack || String(bootError)));
check('__woShowInstaller is exposed', typeof window.__woShowInstaller === 'function');

window.__woShowInstaller();

setTimeout(function() {
    const doc = window.document;
    const modal = doc.getElementById('__wo_installer_modal');
    check('Installer modal rendered', !!modal);

    const profilesDiv = doc.getElementById('__inst_profiles');
    check('Installer renders from cached METADATA with zero network calls so far', checkAccessCalls === 0 && orgConfigContentCalls === 0,
        { checkAccessCalls, orgConfigContentCalls });

    const orgRadio = profilesDiv && profilesDiv.querySelector('input[name="__inst_profile"][value="cfg_avwp"]');
    check('Org config radio button rendered with expected value', !!orgRadio);
    check('Org config radio is checked by default', !!orgRadio && orgRadio.checked);

    const goBtn = doc.getElementById('__inst_go');
    check('Install button is enabled from the local metadata alone (no network wait needed to enable it)', !!goBtn && !goBtn.disabled);

    if (goBtn) goBtn.click();

    // installOrgConfig() now does a REAL multi-step XHR chain
    // (whoami -> bootstrap -> check-access -> org-config-content), so give
    // it more ticks than the old synchronous-from-localStorage version needed.
    setTimeout(function() {
        check('Clicking Install triggered exactly one live check-access call', checkAccessCalls === 1, checkAccessCalls);
        check('...and exactly one live org-config-content fetch', orgConfigContentCalls === 1, orgConfigContentCalls);

        const rules = JSON.parse(window.localStorage.getItem('__wo_rules_config') || 'null');
        check('Applied rules came from the LIVE-fetched org config content',
            !!rules && Array.isArray(rules.rules) && rules.rules.some(function(r) { return r.id === 'org-rule-1'; }),
            rules);

        const vars = JSON.parse(window.localStorage.getItem('__wo_vars_config') || 'null');
        check('Applied vars came from the org config content',
            Array.isArray(vars) && vars.some(function(v) { return v.id === 'v_org'; }),
            vars);

        const profiles = JSON.parse(window.localStorage.getItem('__wo_profiles') || '{}');
        check('installOrgConfig() registered a profile under "org_cfg_avwp"', !!profiles['org_cfg_avwp'], Object.keys(profiles));
        check('Registered profile carries the org config\'s name/description',
            profiles['org_cfg_avwp'] && profiles['org_cfg_avwp'].name === 'AVWP Maintenance' && profiles['org_cfg_avwp'].description === 'AVWP site defaults',
            profiles['org_cfg_avwp']);

        const activeId = window.localStorage.getItem('__wo_active_profile_id');
        check('Active profile pointer set to the installed org config', activeId === 'org_cfg_avwp', activeId);

        const modalGone = !doc.getElementById('__wo_installer_modal');
        check('Installer modal closed after install', modalGone);

        const failed = results.filter(function(r) { return !r.ok; });
        console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
        process.exitCode = failed.length ? 1 : 0;
    }, 800);
}, 300);
