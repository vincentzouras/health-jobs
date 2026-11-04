#!/usr/bin/env bash
# Install this as ~/.hermes/scripts/deploy-job-watch.sh
#
# Hermes cron only runs scripts that live under ~/.hermes/scripts/, and it cannot pass
# arguments. So this shim updates the repo checkout and then execs the real deploy script
# from it - meaning the deploy logic itself is never a stale copy on the Pi.
#
# Pair with:
#   ./hermes cron create "45 7 * * *" --name "Job board: deploy watcher from git" \
#     --script deploy-job-watch.sh --no-agent --deliver telegram
set -uo pipefail

REPO="${JOB_WATCH_REPO:-$HOME/.hermes/pop-health-jobs}"

if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --quiet origin main 2>/dev/null || true
  git -C "$REPO" merge --ff-only --quiet origin/main 2>/dev/null || true
fi

exec bash "$REPO/deploy/deploy-job-watch.sh" "$@"
