// Black-box test of the REAL wo_tool.js "Name - Bucket" display (not a
// reimplementation): worker.js's /check-access and /org-config-content now
// include a resolved `bucket` label on each matched org config (see
// resolveConfigBucketLabels() in worker.js), so two configs sharing a name
// from different sites aren't indistinguishable. Verifies
// orgConfigDisplayName() directly, then drives the REAL first-run installer
// and the installed profile's stored name end-to-end against a mock that
// includes a bucket label — mirrors org_config_harness.js's mock shape,
// just with `bucket` added.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TOOL_PATH = path.join(__dirname, '..', 'wo_tool.js');
const toolSrc = fs.readFileSync(TOOL_PATH, 'utf8');
const WORKER_BASE_URL = 'https://wo-review-tool-access.williamzitzmann.workers.dev';

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

function tick(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function testDisplayNameHelper() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w = dom.window;
    w.fetch = function() { return Promise.reject(new Error('network disabled')); };
    w.XMLHttpRequest = function() {
        this.open = function() {}; this.setRequestHeader = function() {};
        this.send = function() { var self = this; setTimeout(function() { if (self.onerror) self.onerror(new Error('network disabled')); }, 0); };
    };
    w.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.eval(toolSrc);

    var fn = w.__woTestHooks.orgConfigDisplayName;
    check('orgConfigDisplayName() joins name + bucket with " - "', fn({ name: 'Default', bucket: 'Ireland' }) === 'Default - Ireland');
    check('orgConfigDisplayName() falls back to the bare name when bucket is null (root-owned config)', fn({ name: 'Universal Defaults', bucket: null }) === 'Universal Defaults');
    check('orgConfigDisplayName() falls back to the bare name when bucket is absent entirely (older cached metadata)', fn({ name: 'Legacy Config' }) === 'Legacy Config');
    check('orgConfigDisplayName() does not produce a stray " - " for an empty-string bucket', fn({ name: 'Default', bucket: '' }) === 'Default');
}

async function testInstallerAndInstalledProfileShowBucketLabel() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://fake-maximo.example.com/maximo/webclient/login/login.jsp',
        runScripts: 'outside-only', pretendToBeVisual: true
    });
    const w = dom.window;
    w.fetch = function() { return Promise.reject(new Error('fetch disabled')); };
    w.XMLHttpRequest = function() {
        var self = this;
        var url;
        self.open = function(m, u) { url = u; };
        self.setRequestHeader = function() {};
        self.send = function() {
            setTimeout(function() {
                var status = 200, responseText = '';
                if (/\/maximo\/oslc\/whoami$/.test(url)) {
                    responseText = JSON.stringify({ loginID: 'testuser', email: 'testuser@abbvie.com', country: 'IE', insertSite: 'AVWP' });
                } else if (url === WORKER_BASE_URL + '/bootstrap') {
                    responseText = JSON.stringify({ maximoHosts: [], requiredFields: ['username'] });
                } else if (url === WORKER_BASE_URL + '/check-access') {
                    responseText = JSON.stringify({
                        granted: true, grants: ['user'], token: 'fake-token',
                        configs: [{ id: 'cfg_avwp', name: 'Default', description: 'AVWP site defaults', bucket: 'Ireland' }]
                    });
                } else if (url.indexOf(WORKER_BASE_URL + '/org-config-content') === 0) {
                    responseText = JSON.stringify({
                        configs: [{ id: 'cfg_avwp', name: 'Default', description: 'AVWP site defaults', bucket: 'Ireland', content: { rules: { groups: [], rules: [] }, scan: {}, fields: {}, state: {}, vars: [] } }]
                    });
                } else { status = 404; }
                self.status = status; self.responseText = responseText;
                if (typeof self.onload === 'function') self.onload();
            }, 0);
        };
    };
    w.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };
    w.localStorage.setItem('__wo_grants', JSON.stringify(['user']));
    // Metadata shape loader.js's cacheOrgConfigsMetadata() writes, now
    // including the resolved bucket label.
    w.localStorage.setItem('__wo_org_configs', JSON.stringify([
        { id: 'cfg_avwp', name: 'Default', description: 'AVWP site defaults', bucket: 'Ireland' }
    ]));

    w.eval(toolSrc);
    w.__woShowInstaller();
    await tick(30);

    var modal = w.document.getElementById('__wo_installer_modal');
    check('installer modal rendered', !!modal);
    check('installer radio label shows "Name - Bucket" (Default - Ireland), not just the bare name',
        !!modal && modal.textContent.indexOf('Default - Ireland') !== -1, modal && modal.textContent);

    var goBtn = w.document.getElementById('__inst_go');
    goBtn.click();
    await tick(50);

    var profiles = w.__woTestHooks.getProfiles();
    var installed = profiles['org_cfg_avwp'];
    check('installed profile\'s stored name is "Default - Ireland", so it stays distinguishable in Local Profiles later',
        !!installed && installed.name === 'Default - Ireland', installed && installed.name);
}

(async function main() {
    testDisplayNameHelper();
    await testInstallerAndInstalledProfileShowBucketLabel();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
