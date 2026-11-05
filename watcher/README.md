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

## Deploy on the Pi

Never `scp` by hand — that is how the Pi and the repo drift. The Pi keeps a checkout of this
repo and installs from it:

```bash
ssh vincent@vez '~/.hermes/scripts/deploy-job-watch.sh'   # pull → selftest → install
```

The 07:45 cron (`dee89f6f4230`) runs that for you before the 08:00 scan. It is silent when there
is nothing to do, installs atomically only if `--selftest` passes, keeps five rollback copies, and
re-hashes the installed file against what it tested. Check everything with:

```bash
ssh vincent@vez '~/.hermes/bin/status-job-watch.sh'
```

Register the two jobs (already done):

```bash
cd ~/.hermes/hermes-agent
./hermes cron create "45 7 * * *" \
  --name "Job board: deploy watcher from git" \
  --script deploy-job-watch.sh --no-agent --deliver telegram
./hermes cron create "0 8 * * *" \
  --name "Job alerts: population health (PA/DE)" \
  --script job_watch.py --no-agent --deliver telegram
```

`--no-agent` means the script's stdout *is* the message and empty stdout sends nothing. No LLM in
the alert path: no per-run cost, no chance of an invented posting. Filtering is a fixed set of
regexes, and `--selftest` is what protects them.

## Commands

```bash
PY=~/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3

$PY job_watch.py             # normal run — silent unless something is new
$PY job_watch.py --dump      # show relevant / new / rejected
$PY job_watch.py --dump --dump-all
$PY job_watch.py --selftest  # 130 filter + parser tests; run after ANY rule change
$PY job_watch.py --baseline  # mark everything currently live as already-known
$PY job_watch.py --backfill-posted   # read posted dates off detail pages for jobs lacking one
$PY job_watch.py --backfill-location # replace a source's guessed city with the real one
$PY job_watch.py --backfill-maps     # render route cards for postings that lack one
$PY job_watch.py --check-origin      # re-geocode the pinned start point and report drift
$PY job_watch.py --check-maps        # prove ORS_KEY + GEOAPIFY_KEY work end to end
```

## Geography

Two live corridors, both active:

- **West Chester ⇄ Wilmington** — the home/work commute along US-202 and I-95, plus the
  Downingtown / Exton / Malvern / King of Prussia ring and the Philadelphia edge.
- **York** — plus Hanover, Lancaster, Harrisburg, Hershey, Camp Hill and Carlisle.

Kent/Sussex County DE (Dover, Smyrna, Milford) is rejected: it is another 60–90 min *past*
Wilmington, not on the way to it. `FAR_DE` keys off the state suffix so Dover, PA stays in.

## Location: a default is a guess, the posting wins

Seven sources publish no city on their result cards, so they carry a `default_location`
(WellSpan → "York, PA", Tower → "Southeastern PA", PHMC → "Philadelphia, PA", Main Line, and the
three county GovernmentJobs boards). Those defaults are only stand-ins. WellSpan's board spans
York, Gettysburg, Ephrata, Lancaster and Lebanon — and **Chambersburg**, which is Franklin
County, ~50 min past York. A "Social Service Coordinator" at Chambersburg Hospital was being
shown as York, PA.

So for any match whose city came from a default, the detail page is read and `classify()` is run
again on the real city. The verified city is stored in `state.locations` and applied before
`classify()` on every later run, and the check runs *before* the dashboard push, so a wrong city
never reaches the board. A real city that is out of corridor drops the posting and records
`location_rejected`.

`--backfill-location` re-reads the real city for postings recorded before this existed and lists
anything that turns out to be out of corridor.

A derived city is judged differently from a card's city: `classify(..., derived=True)` accepts any
PA/DE town that is not known to be out of area, because the curated city list can never cover every
township a health system posts in (Chester County posts in Westtown, York County in Dillsburg, and
both were being dropped as "not an allowed city"). The employer's footprint bounds the risk, the
real city is printed on the card, and anything wrong goes through the normal not-applicable path.

## Route cards (map + drive time)

Every match gets a small map with the drive from **Country Club of York, 1400 Country Club Rd,
York, PA 17403** (pinned at 39.9276, -76.7452). The image is rendered **once**, at ingest, and
stored by the dashboard — viewing the board makes no routing or map calls at all.

Two free keys, both in `~/.hermes/.env` and never in the browser:

| Var | Service | Free tier | Used for |
|---|---|---|---|
| `ORS_KEY` | openrouteservice | 2,000 directions + 1,000 geocodes/day | drive time, distance, route geometry |
| `GEOAPIFY_KEY` | Geoapify Static Maps | 3,000 credits/day | the PNG itself (ORS has no static map) |

Our volume is ~3 calls per *new* posting, so a few per week. Without the keys the feature is
simply absent: jobs still sync and show, they just have no map.

- Geocodes are cached in `state.geo`, renders in `state.maps_done`, so nothing is done twice.
- `_GEOCODABLE` skips synthetic locations (`Southeastern PA`) that cannot resolve.
- `--backfill-maps` renders for the whole board from state (no re-scrape needed).
- `--check-maps` proves both keys in one shot: geocode the origin, geocode a corridor city, route
  it, render the PNG and report the sizes. Run it right after adding the keys.
- `--check-origin` re-geocodes the address and fails if the pinned point has drifted >500 m.
- Times are free-flow, not live traffic.

Attribution is required by both services and appears under the map:
"© OpenStreetMap contributors · Geoapify · routes by openrouteservice".

## What counts as a match

Four gates, in order:

1. **Title matches one of 59 target-title patterns** — care coordinator, patient navigator, community
   health worker, health educator, outreach coordinator, quality improvement, referral/intake
   coordinator, practice manager, case manager, plus the adjacent doors into the same employers
   (patient services rep, medical staff coordinator, unit coordinator/secretary, health information,
   disease intervention, emergency preparedness, process improvement).
2. **Title isn't excluded** — 112 rejection patterns: clinical and administrative terms (RN, LPN,
   therapist, tech, coder, director, intern, and the CNA-equivalent titles: nursing assistant,
   patient care assistant), seniority words (lead, master, senior, sr., principal) that are not
   first-job titles, plus social-program terms (treatment court, life skills, re-entry, housing,
   shelter, justice) that were flooding in from PHMC.
3. **URL doesn't encode a license the title hides** — `rn-care-coordinator-per-diem` was slipping
   through as "Care Coordinator, Per Diem".
4. **Location is in one of the two corridors** — city allow-list with word-boundary matching (so
   "District Of **Columbia**" doesn't match "Columbia, PA"), plus a ~45-state blocklist. Unknown
   location is dropped, never guessed. Kent/Sussex DE is rejected separately (see Geography).

For *new* matches only, it then opens the posting and rejects on hard requirements: "must have RN
license", "master's required", "LCSW", "position filled". This exists because Melmark's $89,440
"Health Care Coordinator" looked perfect and required a PA RN.

## Posted dates

Two passes, because sources differ:

1. **Results page** — most cards carry nothing, but where a date is present (`Posted 3 days
   ago`, `11/02/2026`, `Nov 2, 2026`) it is normalised to `YYYY-MM-DD`.
2. **Detail page** — Workday ("posted on Posted 2 Days Ago"), UltiPro ("Posting Details Posted:
   October 14, 2026") and NEOGOV ("Opening Date 08/17/2026") only show it inside the posting.

Only 15 of the 55 live postings have a date, because Penn Medicine, Tower Health, ChristianaCare,
WellSpan, AmeriHealth and Main Line Health do not publish one anywhere on the page. Those send
`null` and the board shows "found <when the Pi first saw it>" instead of inventing a date.
`--backfill-posted` re-walks known postings that still have no date, one page load each, and can
be re-run after adding a source.

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
