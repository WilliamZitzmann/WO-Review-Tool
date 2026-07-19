#!/bin/sh
# Pushes the current wo_tool.js/loader.js/version.json to the private
# repo's main (dev channel), collapsing clone -> install hook -> copy ->
# commit -> push -> cleanup into one command. Deliberately still does a
# FRESH clone every time (no persistent checkout) rather than caching one -
# see the memory note "project-private-repo-deploy" for why: avoids private
# repo content and git credentials sitting at rest between sessions, and
# avoids a stale local clone silently drifting from origin.
#
# The public repo is the dev-edit source for all three files; the private
# repo is what the Worker actually serves (GET /tool, /loader.js,
# /version.json) - the public repo is not a runtime dependency for any of
# them anymore. wo_tool.js also gets minified to wo_tool.min.js here (the
# file GET /tool actually serves) - see scripts/minify-tool.js.
#
# Usage: scripts/push-private.sh "commit message"
# Run from the public repo's root (same directory as this script's parent).

set -e

if [ -z "$1" ]; then
    echo "Usage: scripts/push-private.sh \"commit message\"" >&2
    exit 1
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

gh repo clone WilliamZitzmann/WO-Review-Tool-Private "$SCRATCH"
cd "$SCRATCH"
git config user.name "WilliamZitzmann"
git config user.email "williamzitzmann@gmail.com"

cp "$REPO_ROOT/wo_tool.js" ./wo_tool.js
cp "$REPO_ROOT/loader.js" ./loader.js
cp "$REPO_ROOT/version.json" ./version.json

# Refreshed here explicitly (not via the public repo's pre-commit hook -
# this repo intentionally has no copy of it) so BUILD_ID reflects THIS
# commit's time even if the public repo's own commit happened earlier in
# the session, and so it's stamped before minification below reads it -
# doing this via a copied hook instead would restamp a second time at
# `git commit`, after the minified file had already been built from the
# first stamp, leaving wo_tool.min.js showing a stale BUILD_ID.
stamp=$(date -u +"%y%j.%H%M")z
sed -i "s/var BUILD_ID = '[^']*';/var BUILD_ID = '${stamp}';/" wo_tool.js

# wo_tool.min.js is what GET /tool actually serves - see
# scripts/minify-tool.js for why this is identifier-mangling only.
node "$REPO_ROOT/scripts/minify-tool.js" wo_tool.js wo_tool.min.js

git add wo_tool.js wo_tool.min.js loader.js version.json
git commit -m "$1"
git push origin main
