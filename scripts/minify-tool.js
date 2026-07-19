#!/usr/bin/env node
// Minifies wo_tool.js for the private repo's served copy (see
// push-private.sh, which is the only caller). Identifier-mangling only —
// deliberately NOT `mangle.properties`. wo_tool.js's formula engine builds
// functions at runtime from literal parameter-name strings matched against
// plain property access (c.domain, c.F, ...); property mangling would
// desync that, and would also silently corrupt every user's saved
// localStorage config on the next version bump, since it's read back by a
// later, independently-mangled build. Terser's default `mangle: true`
// never touches property names unless `mangle.properties` is set, so this
// stays off by omission, not by an extra flag to remember.
//
// Usage: node minify-tool.js <input.js> <output.js>
'use strict';
const fs = require('fs');
const { minify } = require('terser');

async function main() {
    const [, , inputPath, outputPath] = process.argv;
    if (!inputPath || !outputPath) {
        console.error('Usage: node minify-tool.js <input.js> <output.js>');
        process.exit(1);
    }
    const src = fs.readFileSync(inputPath, 'utf8');
    const result = await minify(src, {
        compress: true,
        mangle: true,
        format: { comments: false },
    });
    if (result.error) {
        console.error('Minification failed:', result.error);
        process.exit(1);
    }
    fs.writeFileSync(outputPath, result.code, 'utf8');
    console.log('Wrote ' + outputPath + ' (' + result.code.length + ' bytes, from ' + src.length + ')');
}

main();
