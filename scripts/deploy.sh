#!/bin/sh
# Deploy the committed HEAD to Vercel production.
# Vercel's Hobby plan blocks deployments whose commits list a co-author who isn't
# a project member (for example a Co-Authored-By trailer), so we deploy an export
# of HEAD without git metadata.
set -e
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first (this deploys HEAD)." >&2
  exit 1
fi
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
git archive HEAD | tar -x -C "$out"
cp -R .vercel "$out/"
cd "$out"
vercel deploy --prod --yes
