// Black-box test of the REAL wo_tool.js Feedback tab (not a
// reimplementation): verifies the third "Question for my admin" category
// added alongside Bug/Suggestion routes to the bucket-resolved admin
// contact (getSupportEmail()) via a plain mailto draft, and — critically —
// never touches /feedback (which always files a GitHub issue in the tool
// maintainer's repo, the wrong destination for a site-specific question).
// Bug/Suggestion must still hit /feedback exactly as before (regression
// check for the refactor that introduced the shared openEmailDraft()).
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
    const calls = [];
    w.XMLHttpRequest = function() {
        var self = this;
        self.open = function(method, url) { self._method = method; self._url = url; };
        self.setRequestHeader = function() {};
        self.send = function() {
            calls.push({ method: self._method, url: self._url });
            setTimeout(function() {
                var u = String(self._url || '');
                if (u.indexOf('/bootstrap') !== -1) {
                    self.status = 200;
                    self.responseText = JSON.stringify({ requiredFields: ['username'] });
                    if (self.onload) self.onload();
                } else if (u.indexOf('/maximo/oslc/whoami') !== -1) {
                    self.status = 200;
                    self.responseText = JSON.stringify({ loginID: 'testuser' });
                    if (self.onload) self.onload();
                } else if (u.indexOf('/check-access') !== -1) {
                    self.status = 200;
                    self.responseText = JSON.stringify({ granted: true, grants: ['user'], token: 'tok123', contactEmail: 'site-lead@abbvie.com' });
                    if (self.onload) self.onload();
                } else if (u.indexOf('/feedback') !== -1) {
                    self.status = 200;
                    self.responseText = JSON.stringify({ ok: true });
                    if (self.onload) self.onload();
                } else if (self.onerror) {
                    self.onerror(new Error('network disabled'));
                }
            }, 0);
        };
    };
    w.fetch = function() { return Promise.reject(new Error('network disabled in test')); };
    w.ResizeObserver = function() { return { observe() {}, unobserve() {}, disconnect() {} }; };
    w.localStorage.setItem('__wo_rules_config', JSON.stringify({ groups: [], rules: [] }));
    w.localStorage.setItem('__wo_scan_config', JSON.stringify({ targets: [] }));
    w.localStorage.setItem('__wo_settings', JSON.stringify({ backupPromptDismissed: true }));
    // Normally populated by loader.js's boot-time access verification,
    // well before Setup > Feedback could ever be opened - seeded directly
    // here since the "Admin" category deliberately skips its OWN network
    // round trip (see its comment in wo_tool.js), so nothing in THIS test
    // would otherwise populate it.
    w.localStorage.setItem('__wo_contact_email', 'site-lead@abbvie.com');
    return { dom, calls };
}

function tick(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

function openFeedbackTab(w) {
    var doc = w.document;
    doc.getElementById('__wo_setup').click();
    doc.getElementById('__s_feedback').click();
}

async function testAdminCategoryRoutesToBucketContactNotFeedback() {
    const { dom, calls } = makeDom();
    const w = dom.window;
    // location.href assignment to a non-http(s) scheme is unimplemented
    // navigation in jsdom - it logs, doesn't throw, and doesn't affect
    // the rest of the handler, so no special stubbing is needed to keep
    // the test running; we only assert on network calls and status text.
    w.eval(toolSrc);
    await tick(50);

    openFeedbackTab(w);
    var doc = w.document;

    var typeSelect = doc.getElementById('__fb_type');
    var options = Array.prototype.map.call(typeSelect.options, function(o) { return o.value; });
    check('feedback type has all three categories: Bug, Suggestion, Admin', JSON.stringify(options) === JSON.stringify(['Bug', 'Suggestion', 'Admin']), options);

    typeSelect.value = 'Admin';
    doc.getElementById('__fb_body').value = 'Can you check my access level?';
    doc.getElementById('__fb_send').click();
    await tick(100);

    check('selecting "Admin" and sending does NOT call /feedback', !calls.some(function(c) { return c.url.indexOf('/feedback') !== -1; }), calls);
    check('status line shows the resolved admin contact, not a generic "Sent" message',
        doc.getElementById('__fb_status').textContent.indexOf('site-lead@abbvie.com') !== -1,
        doc.getElementById('__fb_status').textContent);
    check('textarea cleared after opening the draft', doc.getElementById('__fb_body').value === '');
    check('send button re-enabled', doc.getElementById('__fb_send').disabled === false);
}

async function testBugCategoryStillHitsFeedbackEndpoint() {
    const { dom, calls } = makeDom();
    const w = dom.window;
    w.eval(toolSrc);
    await tick(50);

    openFeedbackTab(w);
    var doc = w.document;

    doc.getElementById('__fb_type').value = 'Bug';
    doc.getElementById('__fb_body').value = 'Something broke.';
    doc.getElementById('__fb_send').click();
    await tick(150);

    check('selecting "Bug" and sending DOES call /feedback (regression check on the shared refactor)',
        calls.some(function(c) { return c.url.indexOf('/feedback') !== -1; }), calls);
    check('status line shows the success message', doc.getElementById('__fb_status').textContent.indexOf('Sent') !== -1,
        doc.getElementById('__fb_status').textContent);
}

(async function main() {
    await testAdminCategoryRoutesToBucketContactNotFeedback();
    await testBugCategoryStillHitsFeedbackEndpoint();

    const failed = results.filter(function(r) { return !r.ok; });
    console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
    process.exitCode = failed.length ? 1 : 0;
})();
