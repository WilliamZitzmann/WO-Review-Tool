// Runs every test file in this directory as its own process (mixing .mjs
// ESM and .js CommonJS harnesses in one process isn't straightforward, and
// each file is already a fully standalone script with its own exit code —
// see each file's own header comment for what it actually verifies), then
// reports a combined pass/fail summary.
const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
    'worker_test.mjs',
    'admin_html_test.mjs', // only present if this checkout also has admin.html copied in — see README.md
    'harness.js',
    'org_config_harness.js',
    'loader_test.mjs',
    'update_defer_test.js',
    'sync_whoami_mapping_test.js',
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
