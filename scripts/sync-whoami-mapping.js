#!/usr/bin/env node
// Keeps two things that MUST stay identical between loader.js and
// wo_tool.js — two independently-fetched files with no shared module
// system — in sync automatically, instead of relying on manual discipline.
// Both have already drifted for real: readWhoamiCanonical() silently
// missed 5 fields readWhoami() had for a while, and EPHEMERAL_KEYS missed
// two keys in both files after their own features shipped. loader.js is
// the source of truth for both; this script only ever writes wo_tool.js.
//
// 1) The WHOAMI_FIELDS block (the whoami() -> canonical-fields object
//    literal) — multi-line, delimited by
//    "// === WHOAMI_FIELDS:START ===" / "// === WHOAMI_FIELDS:END ===" in
//    both files.
// 2) The EPHEMERAL_KEYS array literal — single line, marked with a
//    trailing "// === SYNC:EPHEMERAL_KEYS ===" comment in both files.
//
// Run directly (`node scripts/sync-whoami-mapping.js`) or via the
// pre-commit hook, which runs it whenever a commit touches either file
// and re-stages wo_tool.js if this script changed it — same pattern as
// the existing BUILD_ID auto-bump.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const LOADER_PATH = path.join(REPO_ROOT, 'loader.js');
const TOOL_PATH = path.join(REPO_ROOT, 'wo_tool.js');

function extractBlock(text, startMarker, endMarker, fileLabel) {
    const startIdx = text.indexOf(startMarker);
    const endIdx = text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        throw new Error('Could not find ' + startMarker + ' / ' + endMarker + ' in ' + fileLabel);
    }
    // Include the markers themselves so the replacement is self-delimiting.
    return text.slice(startIdx, endIdx + endMarker.length);
}

function replaceBlock(text, startMarker, endMarker, replacement, fileLabel) {
    const startIdx = text.indexOf(startMarker);
    const endIdx = text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        throw new Error('Could not find ' + startMarker + ' / ' + endMarker + ' in ' + fileLabel);
    }
    return text.slice(0, startIdx) + replacement + text.slice(endIdx + endMarker.length);
}

function extractLine(text, marker, fileLabel) {
    const lines = text.split('\n');
    const line = lines.find(function(l) { return l.indexOf(marker) !== -1; });
    if (!line) throw new Error('Could not find a line containing ' + marker + ' in ' + fileLabel);
    return line;
}

function replaceLine(text, marker, replacementLine, fileLabel) {
    const lines = text.split('\n');
    const idx = lines.findIndex(function(l) { return l.indexOf(marker) !== -1; });
    if (idx === -1) throw new Error('Could not find a line containing ' + marker + ' in ' + fileLabel);
    lines[idx] = replacementLine;
    return lines.join('\n');
}

function main() {
    const loaderSrc = fs.readFileSync(LOADER_PATH, 'utf8');
    let toolSrc = fs.readFileSync(TOOL_PATH, 'utf8');
    const before = toolSrc;

    const whoamiBlock = extractBlock(loaderSrc, '// === WHOAMI_FIELDS:START ===', '// === WHOAMI_FIELDS:END ===', 'loader.js');
    toolSrc = replaceBlock(toolSrc, '// === WHOAMI_FIELDS:START ===', '// === WHOAMI_FIELDS:END ===', whoamiBlock, 'wo_tool.js');

    const ephemeralLine = extractLine(loaderSrc, '// === SYNC:EPHEMERAL_KEYS ===', 'loader.js');
    toolSrc = replaceLine(toolSrc, '// === SYNC:EPHEMERAL_KEYS ===', ephemeralLine, 'wo_tool.js');

    if (toolSrc !== before) {
        fs.writeFileSync(TOOL_PATH, toolSrc);
        console.log('[sync-whoami-mapping] wo_tool.js updated to match loader.js.');
        process.exitCode = 0; // still success - the hook re-stages the file
        return true;
    }
    console.log('[sync-whoami-mapping] already in sync, nothing to do.');
    return false;
}

if (require.main === module) {
    main();
}
module.exports = { main };
