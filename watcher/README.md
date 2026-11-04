# watcher

`job_watch.py` — one file, Python standard library only. Scrapes 11 employer job boards through
a local [Camofox](https://github.com/jo-inc/camofox-browser) browser, filters results down to roles
the graduate can actually apply for, pushes them to the dashboard, and sends a Telegram alert for
anything new.

## Why a browser

Four of the boards can't be scraped with plain HTTP:

- **Penn Medicine** sits behind Cloudflare (403 to `curl`)
- **ChristianaCare / Main Line / WellSpan** serve Next.js shells whose `/_next/data/*.json`
  routes 404 — only the rendered DOM has the jobs
- **Jefferson** and **Tower** render results client-side

Camofox (`127.0.0.1:9377`) handles all of them. It's already running as `camofox.service` for
other Hermes work.

## Install on the Pi

```bash
scp job_watch.py vincent@vez:~/.hermes/scripts/job_watch.py
ssh vincent@vez '~/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3 \
  ~/.hermes/scripts/job_watch.py --selftest'
```

Register the daily run (already done, job id `8e7a83cfdc37`):

```bash
cd ~/.hermes/hermes-agent
./hermes cron create "0 8 * * *" \
  --name "Job alerts: population health (PA/DE)" \
  --script job_watch.py --no-agent --deliver telegram
```

`--no-agent` means the script's stdout *is* the message and empty stdout sends nothing. No LLM in
the alert path: no per-run cost, no chance of an invented posting.

## Commands

```bash
PY=~/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3

$PY job_watch.py             # normal run — silent unless something is new
$PY job_watch.py --dump      # show relevant / new / rejected
$PY job_watch.py --dump --dump-all
$PY job_watch.py --selftest  # 89 filter + parser tests; run after ANY rule change
$PY job_watch.py --baseline  # mark everything currently live as already-known
```

## What counts as a match

Four gates, in order:

1. **Title matches one of ~50 target role families** — care coordinator, patient navigator, community
   health worker, health educator, outreach coordinator, quality improvement, referral/intake
   coordinator, practice manager, case manager, plus the adjacent doors into the same employers
   (patient services rep, medical staff coordinator, unit coordinator/secretary, health information,
   disease intervention, emergency preparedness, process improvement).
2. **Title isn't excluded** — ~95 clinical and administrative terms (RN, LPN, therapist, tech,
   coder, director, intern, and the CNA-equivalent titles: nursing assistant, patient care
   assistant) plus social-program terms (treatment court, life skills, re-entry, housing, shelter,
   justice) that were flooding in from PHMC.
3. **URL doesn't encode a license the title hides** — `rn-care-coordinator-per-diem` was slipping
   through as "Care Coordinator, Per Diem".
4. **Location is in one of the two corridors** — city allow-list with word-boundary matching (so
   "District Of **Columbia**" doesn't match "Columbia, PA"), plus a ~45-state blocklist. Unknown
   location is dropped, never guessed.

For *new* matches only, it then opens the posting and rejects on hard requirements: "must have RN
license", "master's required", "LCSW", "position filled". This exists because Melmark's $89,440
"Health Care Coordinator" looked perfect and required a PA RN.

## Posted dates

Each list page is scanned for the posting date (`Posted 3 days ago`, `11/02/2026`,
`Nov 2, 2026`, `2026-11-02`, …) and normalised to `YYYY-MM-DD` in `parse_posted()`. Sources that
don't publish a date on the results page send `null` — the board then falls back to "found
<when the Pi first saw it>" rather than inventing a date. The dashboard stores it in
`jobs.posted` and only overwrites a known date with a newer known date, so a partial page load
can't erase it.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Camofox wedged / down | Self-heals — `/start` → `/health` → `systemctl restart camofox` |
| Tab reaped mid-run (404) | Self-heals — fresh tab, retry |
| A page returns an empty shell (WellSpan throttles) | Self-heals — backs off, retries twice |
| A source's markup changes | Alerts — `returned 0 postings (usually ~N)` |
| A source partially breaks | Alerts — `< 40% of peak` |
| Every source unreachable | Alerts — `⚠️ Job watch FAILED`, exit 1 |
| Nothing new | Silent — 0 bytes |

Per-source counts are persisted in `source_health` (`last` / `peak` / `zero_streak`), so a broken
parser is loud instead of looking like "no new jobs".

## Adding a source

Append to `SOURCES` in `job_watch.py`:

```python
{
    "name": "Employer Name",
    "base": "https://careers.example.org",
    "parse": parse_example,          # (href, card_text, base) -> (job_id, title, location, url)
    "default_location": "...",       # only if the cards never show a city
    "urls": ["https://careers.example.org/jobs?q=coordinator"],
},
```

Then `--baseline` so existing postings don't all alert at once, and add a parser case to
`selftest()`.

Sources that were investigated and rejected (with reasons) are listed in
[../docs/job-alerts-setup.md](../docs/job-alerts-setup.md).
