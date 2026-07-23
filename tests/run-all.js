// Runs every test file in this directory as its own process, then reports
// a combined pass/fail summary.
//
// Only worker_test.mjs lives here now — it tests access-control/worker.js,
// which stays in this (public) repo. Every other test file (harness.js,
// loader_test.mjs, admin_html_test.mjs, etc.) moved to the private repo
// alongside wo_tool.js/loader.js/admin.html, the files they actually test.
// See README.md.
const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
    'worker_test.mjs',
];

const fs = require('fs');
let anyFailed = false;
let anyRan = false;

FILES.forEach(function(file) {
    var full = path.join(__dirname, file);
    if (!fs.existsSync(full)) {
        console.log('SKIP - ' + file + ' (not present in this checkout)');
        return;
    }
    anyRan = true;
    console.log('\n=== ' + file + ' ===');
    var result = spawnSync(process.execPath, [full], { stdio: 'inherit', cwd: __dirname });
    if (result.status !== 0) anyFailed = true;
});

if (!anyRan) {
    console.log('\nNo test files found.');
    process.exit(1);
}

console.log('\n' + (anyFailed ? 'SOME TEST FILES FAILED' : 'ALL TEST FILES PASSED'));
process.exit(anyFailed ? 1 : 0);
