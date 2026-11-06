#!/usr/bin/env bash
# Five-minute gate for the job watcher.
#
# The dashboard owns whether a scan is due (on/off, check-every, "scan now"), and job_watch.py
# answers that question with one HTTP GET before opening any browser page. So a tick is cheap:
# it exits in well under a second when nothing is due, and prints nothing at all when it does
# nothing. When a scan is due, job_watch.py's stdout is the alert, exactly as in the daily job.
#
# The 08:00 scheduled run stays as the backstop for "the board is unreachable" - a gate tick
# returns silently in that case, a scheduled run does not.
#
# Concurrency is handled inside job_watch.py (an flock around the scan), so a tick that lands
# mid-scan exits immediately instead of starting a second browser on the Pi.
set -uo pipefail

PY="${JOB_WATCH_PY:-$HOME/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3}"
SCRIPT="${JOB_WATCH_SCRIPT:-$HOME/.hermes/scripts/job_watch.py}"
ENVFILE="$HOME/.hermes/.env"

if [ ! -x "$PY" ]; then
  echo "job-watch gate: python not found at $PY"
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "job-watch gate: $SCRIPT is missing - run deploy-job-watch.sh"
  exit 1
fi

if [ -f "$ENVFILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENVFILE"
  set +a
fi

exec "$PY" "$SCRIPT" --gate
