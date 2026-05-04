#!/usr/bin/env bash
# Setup a fresh tmpdir for one e2e scenario.
# Usage: setup-tmpdir.sh <fixture_dir>
# Prints the absolute path of the prepared tmpdir to stdout (only line of output).
set -euo pipefail

FIXTURE="${1:?Usage: setup-tmpdir.sh <fixture_dir>}"

if [[ ! -d "$FIXTURE" ]]; then
  echo "ERROR: fixture directory does not exist: $FIXTURE" >&2
  exit 1
fi

# Create tmpdir
TMP="$(mktemp -d /tmp/yoke-e2e-XXXXXX)"

# Init git repo
git -C "$TMP" init -q -b main
git -C "$TMP" config user.email "e2e@yoke.test"
git -C "$TMP" config user.name "Yoke E2E"

# Bootstrap commit so the worktree manager has a HEAD to branch from
git -C "$TMP" commit -q --allow-empty -m "bootstrap"

# Copy named fixture subtrees explicitly (skips fixture-only meta dirs like seed/).
#   yoke/    → .yoke/    (the dot-hidden runtime config dir)
#   prompts/ → prompts/  (verbatim — referenced from template prompt_template:)
if [[ -d "$FIXTURE/yoke" ]]; then
  mkdir -p "$TMP/.yoke"
  cp -R "$FIXTURE/yoke/." "$TMP/.yoke/"
fi
if [[ -d "$FIXTURE/prompts" ]]; then
  mkdir -p "$TMP/prompts"
  cp -R "$FIXTURE/prompts/." "$TMP/prompts/"
fi

# If the fixture ships a `seed/` directory, its contents become the
# repo's pre-existing baseline (a working app the workflow extends).
# Files land at the project root, not inside seed/.
if [[ -d "$FIXTURE/seed" ]]; then
  cp -R "$FIXTURE/seed/." "$TMP/"
fi

# Commit everything as one initial state.
git -C "$TMP" add -A
git -C "$TMP" commit -q -m "scenario fixture"

# Print only the tmpdir path
echo "$TMP"
