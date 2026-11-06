#!/usr/bin/env bash
# Employer hunt: keep finding job boards that are NOT watched yet.
#
# The dashboard owns exactly one switch, "looking for new employers". When it is on and the
# cooldown has passed, this asks a Hermes agent to propose employers, probe each board with
# `job_watch.py --probe-source` (a real page load, so a hallucinated URL dies there) and install
# the ones on an applicant tracking system we can already read. Installed sources land in
# ~/.hermes/job-watches/sources.d/ and are picked up by the daily 8:00 scan - there is no second
# schedule for employers we already watch.
#
# Silent by default: no output means no message. Output is the agent's summary, delivered as-is.
set -uo pipefail

ENVFILE="$HOME/.hermes/.env"
if [ -f "$ENVFILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENVFILE"
  set +a
fi

BOARD="${JOB_BOARD_URL:-}"
TOKEN="${JOB_BOARD_TOKEN:-}"
PY="${JOB_WATCH_PY:-$HOME/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3}"
WATCH="${JOB_WATCH_SCRIPT:-$HOME/.hermes/scripts/job_watch.py}"
HERMES="${HERMES_BIN:-$HOME/.local/bin/hermes}"
SOURCES_D="$HOME/.hermes/job-watches/sources.d"
COOLDOWN_MIN="${JOB_HUNT_COOLDOWN_MIN:-360}"
MAX_ADD="${JOB_HUNT_MAX_ADD:-3}"
MAX_PROBE="${JOB_HUNT_MAX_PROBE:-3}"
HUNT_TIMEOUT="${JOB_HUNT_TIMEOUT:-1200}"

[ -x "$PY" ] || { echo "employer hunt: python missing at $PY"; exit 1; }
[ -f "$WATCH" ] || { echo "employer hunt: $WATCH is missing - run deploy-job-watch.sh"; exit 1; }
[ -x "$HERMES" ] || { echo "employer hunt: hermes not found at $HERMES"; exit 1; }
[ -n "$BOARD" ] || exit 0          # no board: nothing owns the switch, stay quiet

STATE=$(curl -s --max-time 20 "$BOARD/api/discover" || echo '{}')
read -r ENABLED LAST_AT <<<"$("$PY" -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print("1" if d.get("enabled") else "0", d.get("lastHuntAt") or "-")' <<<"$STATE")"

# Off, or nothing said: do nothing at all (no LLM run, no tokens).
[ "$ENABLED" = "1" ] || exit 0

if [ "$LAST_AT" != "-" ] && [ "$LAST_AT" != "null" ] && [ -n "$LAST_AT" ]; then
  DUE=$("$PY" -c 'import sys
from datetime import datetime, timezone
try:
    last = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
except Exception:
    print("1"); raise SystemExit
age = (datetime.now(timezone.utc) - last).total_seconds() / 60
print("1" if age >= float(sys.argv[2]) else "0")' "$LAST_AT" "$COOLDOWN_MIN")
  [ "$DUE" = "1" ] || exit 0
fi

# One browser at a time: a probe runs page loads through the same Camofox the scan uses.
if pgrep -f "scripts/job_watch.py" >/dev/null 2>&1; then
  exit 0
fi

BEFORE=$(ls -1 "$SOURCES_D"/*.json 2>/dev/null | wc -l)

PROMPT=$(cat <<EOF
You are the employer scout for a personal job watch. Your job: find job boards the watch does NOT have yet and install the ones it can already read.

Step 1. Run this and read the output:
  $PY $WATCH --list-sources
That prints every employer already scanned. Never propose any of them again, and never propose their other domains.

Step 2. Think of employers in south-central and south-eastern Pennsylvania and northern Delaware that plausibly post roles like: population health coordinator, community health worker, care coordinator, care manager, patient navigator, health educator, community outreach, social services coordinator, referral coordinator, care connector. They must be within about 50 minutes' drive of York PA or of Marshallton PA (West Chester). Good hunting grounds: health systems, FQHCs and community health centres, county agencies (children and youth, area agency on aging, behavioural health), home health and hospice, Medicaid managed care plans, and community nonprofits in those counties. Do not propose staffing or travel-nurse agencies, or national aggregators (Indeed, LinkedIn, Glassdoor, ZipRecruiter).

Step 3. Do NOT invent or guess careers URLs. For each employer, run exactly this and it will find the board, probe it and install it if it passes:
  $PY $WATCH --find-board "<Employer name>" --add --allow-fail
Read the JSON it prints. "found": true means a real board was found, at least 5 postings were seen, and the source was installed (the command also prints "added: <path>"). "found": false means no board passed - drop that employer for this run.

Step 4. Try at most $MAX_PROBE employers, and stop early once $MAX_ADD have been added. If none pass, that is a normal result.

Rules
- Never claim a source was added unless the command printed "added:".
- Never invent candidates to have something to report.
- Do not edit any file, do not modify job_watch.py, do not touch the sources already watched.

Reply with at most 6 short lines, nothing else:
FOUND: <n> added
one line per added source: <Employer> - <url>
optionally up to 2 lines: MISS: <employer> - <short reason>
EOF
)

OUT=$(timeout "$HUNT_TIMEOUT" "$HERMES" -z "$PROMPT" --yolo 2>/dev/null)
RC=$?
AFTER=$(ls -1 "$SOURCES_D"/*.json 2>/dev/null | wc -l)
ADDED=$((AFTER - BEFORE))

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [ -n "$TOKEN" ]; then
  curl -s --max-time 20 -X POST "$BOARD/api/discover" \
    -H 'content-type: application/json' -H "x-ingest-token: $TOKEN" \
    -d "{\"hunt\":{\"at\":\"$NOW\",\"added\":$ADDED}}" >/dev/null || true
  if [ "$ADDED" -gt 0 ]; then
    # Show the new boards on the next scan push too, without waiting for the 8:00 run.
    "$PY" - <<'PYEOF' 2>/dev/null || true
import importlib.util, json, os, urllib.request
spec = importlib.util.spec_from_file_location("jw", os.path.expanduser("~/.hermes/scripts/job_watch.py"))
jw = importlib.util.module_from_spec(spec); spec.loader.exec_module(jw)
rows = jw.extra_source_rows()
if rows and jw.WEB_URL and jw.WEB_TOKEN:
    jw._http_json("POST", jw.WEB_URL + "/api/sources/discover", {"extra": rows},
                  {"x-ingest-token": jw.WEB_TOKEN}, timeout=30)
PYEOF
  fi
fi

# Nothing added and nothing to say: stay silent, unless the agent itself failed.
if [ -z "${OUT// /}" ]; then
  if [ "$RC" -ne 0 ]; then
    printf 'employer hunt: agent exited %s with nothing to report%s\n' "$RC" \
      "$([ "$RC" -eq 124 ] && printf ' (timed out after %ss)' "$HUNT_TIMEOUT")"
  fi
  exit 0
fi
printf '%s\n' "$OUT"
