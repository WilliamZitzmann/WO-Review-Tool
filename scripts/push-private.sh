#!/bin/sh
# Pushes the current wo_tool.js to the private repo's main (dev channel),
# collapsing clone -> install hook -> copy -> commit -> push -> cleanup into
# one command. Deliberately still does a FRESH clone every time (no
# persistent checkout) rather than caching one - see the memory note
# "project-private-repo-deploy" for why: avoids private repo content and
# git credentials sitting at rest between sessions, and avoids a stale
# local clone silently drifting from origin.
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

# Same pre-commit hook as the public repo, so BUILD_ID gets auto-refreshed
# here too (hooks are local-only, not part of `git clone`).
cp "$REPO_ROOT/.git/hooks/pre-commit" ./.git/hooks/pre-commit
chmod +x ./.git/hooks/pre-commit

cp "$REPO_ROOT/wo_tool.js" ./wo_tool.js
git add wo_tool.js
git commit -m "$1"
git push origin main
