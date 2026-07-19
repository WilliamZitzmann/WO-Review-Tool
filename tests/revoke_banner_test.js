// Black-box test of the REAL wo_tool.js revoke banner (not a
// reimplementation): revokeAccessLocally() (exposed as
// window.__woForceRevoke, the same hook loader.js's background
// verification calls on a live-session deny) shows a fixed banner that
// nothing else in the tool ever removes — it needs its own dismiss
// control or it sits on the page forever, the same "message sticks" bug
// fixed in loader.js's showBanner() (see tests/loader_test.mjs's
// [denied] dismiss checks for the loader-side counterpart).
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

async function testRevokeBannerHasDismiss() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    check('__woForceRevoke is exposed', typeof w.__woForceRevoke === 'function');
    w.__woForceRevoke('help@example.com');

    const banner = w.document.getElementById('__wo_revoked_banner');
    check('revoke banner rendered', !!banner, banner && banner.textContent);
    check('revoke banner mentions the resolved contact email',
        !!banner && banner.textContent.indexOf('help@example.com') !== -1);

    const closeBtn = banner && banner.querySelector('span[title="Dismiss"]');
    check('revoke banner has a dismiss control', !!closeBtn);
    if (closeBtn) closeBtn.onclick();
    check('clicking dismiss removes the revoke banner',
        !w.document.getElementById('__wo_revoked_banner'));
}

async function testRepeatedRevokeDoesNotStackBanners() {
    const dom = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    w.__woForceRevoke('help@example.com');
    w.__woForceRevoke('help@example.com');

    const banners = w.document.querySelectorAll('#__wo_revoked_banner');
    check('a second revoke reuses the same banner element instead of stacking a duplicate',
        banners.length === 1, banners.length);
}

(async function main() {
    await testRevokeBannerHasDismiss();
    await testRepeatedRevokeDoesNotStackBanners();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
