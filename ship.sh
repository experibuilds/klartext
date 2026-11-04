#!/usr/bin/env bash
# Each iteration: commit + tag a version + push → Vercel auto-deploys.
set -euo pipefail
MSG="${1:?usage: ./ship.sh \"feat: what changed\" [patch|minor|major]}"
BUMP="${2:-patch}"
git add -A
git commit -m "$MSG"
VER=$(npm version "$BUMP" --no-git-tag-version)
git add package.json && git commit -m "release: $VER"
git tag "$VER"
git push origin main --tags
echo "🚀 $VER pushed — deploying. Rollback anytime: Vercel → Deployments → Promote."
