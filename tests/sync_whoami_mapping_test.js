// Black-box test of the REAL scripts/sync-whoami-mapping.js: deliberately
// drifts wo_tool.js's synced blocks, runs the actual sync script (not a
// reimplementation of its logic), and verifies it detects and fixes both
// mechanisms it's responsible for (the WHOAMI_FIELDS block and the
// EPHEMERAL_KEYS line). Restores wo_tool.js to its original content
// afterward regardless of pass/fail, so running this test never leaves the
// repo in a modified state.
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const TOOL_PATH = path.join(REPO_ROOT, 'wo_tool.js');
const SYNC_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'sync-whoami-mapping.js');

const results = [];
function check(label, cond, detail) {
    results.push({ label, ok: !!cond });
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
}

const { main: runSync } = require(SYNC_SCRIPT_PATH);
const originalToolSrc = fs.readFileSync(TOOL_PATH, 'utf8');

function restore() {
    fs.writeFileSync(TOOL_PATH, originalToolSrc);
}

try {
    check('wo_tool.js starts already in sync (no leftover drift from a previous run)', runSync() === false);

    // ── Drift the WHOAMI_FIELDS block ──
    var drifted = originalToolSrc.replace("city: d.city || '',", "city: 'DELIBERATE_DRIFT_FOR_TEST',");
    check('drift actually applied to the in-memory copy (sanity check on the test itself)', drifted !== originalToolSrc);
    fs.writeFileSync(TOOL_PATH, drifted);

    var changed1 = runSync();
    check('sync script reports it changed something', changed1 === true);
    var afterFieldSync = fs.readFileSync(TOOL_PATH, 'utf8');
    check('WHOAMI_FIELDS drift was fixed', afterFieldSync.indexOf("city: d.city || '',") !== -1 && afterFieldSync.indexOf('DELIBERATE_DRIFT_FOR_TEST') === -1);
    check('re-running the sync script is a no-op once back in sync (idempotent)', runSync() === false);

    // ── Drift the EPHEMERAL_KEYS line ──
    var driftedKeys = originalToolSrc.replace(
        /var EPHEMERAL_KEYS = \[[^\]]*\]; \/\/ === SYNC:EPHEMERAL_KEYS ===/,
        "var EPHEMERAL_KEYS = ['__wo_tool_src']; // === SYNC:EPHEMERAL_KEYS ==="
    );
    check('EPHEMERAL_KEYS drift actually applied to the in-memory copy', driftedKeys !== originalToolSrc);
    fs.writeFileSync(TOOL_PATH, driftedKeys);

    var changed2 = runSync();
    check('sync script reports it changed something (EPHEMERAL_KEYS case)', changed2 === true);
    var afterKeysSync = fs.readFileSync(TOOL_PATH, 'utf8');
    check('EPHEMERAL_KEYS drift was fixed', afterKeysSync.indexOf("'__wo_org_configs', '__wo_contact_email'") !== -1);

    // ── The two files must now actually be functionally in sync — not
    // just "the script said so" ──
    var loaderSrc = fs.readFileSync(path.join(REPO_ROOT, 'loader.js'), 'utf8');
    function extract(text, startMarker, endMarker) {
        var s = text.indexOf(startMarker), e = text.indexOf(endMarker);
        return text.slice(s, e + endMarker.length);
    }
    check('the WHOAMI_FIELDS block is now byte-identical between loader.js and wo_tool.js',
        extract(loaderSrc, '// === WHOAMI_FIELDS:START ===', '// === WHOAMI_FIELDS:END ===') ===
        extract(afterKeysSync, '// === WHOAMI_FIELDS:START ===', '// === WHOAMI_FIELDS:END ==='));

    var loaderKeysLine = loaderSrc.split('\n').find(function(l) { return l.indexOf('// === SYNC:EPHEMERAL_KEYS ===') !== -1; });
    var toolKeysLine = afterKeysSync.split('\n').find(function(l) { return l.indexOf('// === SYNC:EPHEMERAL_KEYS ===') !== -1; });
    check('the EPHEMERAL_KEYS line is now byte-identical between loader.js and wo_tool.js', loaderKeysLine === toolKeysLine);
} finally {
    restore();
    var afterRestore = fs.readFileSync(TOOL_PATH, 'utf8');
    check('wo_tool.js restored to its exact original content — this test leaves no trace', afterRestore === originalToolSrc);
}

const failed = results.filter(function(r) { return !r.ok; });
console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' PASSED'));
process.exitCode = failed.length ? 1 : 0;
