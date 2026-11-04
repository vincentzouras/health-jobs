# Job Alerts — Hermes setup on `vez`
_Deployed 2026-11-03, expanded 2026-11-04 · profile: default · owner: vincent@vez_

## What runs

| Piece | Location |
|---|---|
| **Source (this repo)** | [`watcher/job_watch.py`](../watcher/job_watch.py) |
| Script on the Pi | `~/.hermes/scripts/job_watch.py` — copy of the above |
| State | `~/.hermes/job-watches/job-alerts-state.json` |
| Last-run log | `~/.hermes/job-watches/job-alerts-last-run.json` |
| Cron job | `8e7a83cfdc37` — daily 08:00, `--no-agent`, delivers to Telegram |
| Browser | Camofox, `127.0.0.1:9377` (`camofox.service`) |

To update the Pi after editing the repo:

```bash
scp watcher/job_watch.py vincent@vez:~/.hermes/scripts/job_watch.py
```

Mode is **`--no-agent`**: the script's stdout *is* the message, and empty stdout sends
nothing. No LLM in the alert path, so no token cost per run and no invented postings.

## Sources — 11 employers, ~45 page loads, ~12 min per run

| Employer | Loads | Notes |
|---|---|---|
| Penn Medicine | 5 | Cloudflare-protected; needs Camofox. Covers Chester County Hospital, Exton, Parkesburg, West Chester, Lancaster General, **and Doylestown Health** (their careers page redirects here) |
| **WellSpan (York)** | 14–16 | `?keyword=` is ignored by their site, so it pages the **entire** board (165 postings) and filters client-side |
| **Tower Health** | 12 | Pages the board (122 postings); Reading / Pottstown / Phoenixville / Chestnut Hill |
| **Jefferson Health** ⭐ | 3 | Workday tenant `ThomasJeffersonExternal`. Location **and** title are encoded in the URL path, so both parse exactly |
| PHMC (Philadelphia) | 1 | UltiPro tenant — ~50 postings; region's largest public-health nonprofit |
| ChristianaCare | 4 | Publishes real pay bands |
| Main Line Health | 3 | Paoli, Bryn Mawr, Media, Wynnewood |
| AmeriHealth Caritas | 3 | National payer — most postings are out of region and get filtered |
| Chester County | 1 | GovernmentJobs |
| **Montgomery County** ⭐ | 2 | GovernmentJobs — Norristown |
| **Delaware County** ⭐ | 2 | GovernmentJobs — Media |

⭐ = added this round.

**Candidates tested and rejected, with reasons:**

| Employer | Why not |
|---|---|
| **Nemours** | Not on any reachable ATS. `nemours.wd1/wd3/wd5/wd12` all redirect to Workday's maintenance page; `nemours.icims.com` returns "Site Not Found"; their careers page exposes no job links at all. |
| **Independence Blue Cross** | SelectMinds board is reachable but listings carry **no location**, and many are posted as "PA/NJ/DE" — relevance can't be judged. |
| **UPMC** | `careers.upmc.com` returns only navigation; real results put the city in the slug, often just a county. |
| **PA Civil Service** | `governmentjobs.com/careers/pabureau` ignores `?keyword=` and always returns the same alphabetical page (liquor enforcement, state police cadet, PennDOT winter maintenance). Statewide board of thousands, unfilterable, zero yield. |
| **Doylestown Health** | Already covered — `doylestownhealth.org/careers` redirects to Penn Medicine. |
| **St. Luke's, Grand View, Westside, LCH** | Careers pages return HTTP 500 or expose no job anchors at the paths tried. |

## Relevance rules

`classify(title, location, url)` — deterministic, in order:

1. **Title must match** one of ~35 target titles (care coordinator, patient navigator,
   community health, health educator, outreach, quality, credentialing, referral/intake
   coordinator, practice manager, case manager…).
2. **Title must not match** ~90 clinical/administrative terms (RN, LPN, therapist, tech, coder,
   director, intern, cook, **treatment court, life skills, re-entry, housing, shelter, justice,
   residential**…). The social-program terms were added because PHMC's board is full of
   justice/housing case-management roles that aren't health work.
3. **URL must not encode a license** the title hides — `rn-care-coordinator-per-diem` was
   slipping through as "Care Coordinator, Per Diem".
4. **Location must be in one corridor.** City allow-list, word-boundary matched so
   "District Of **Columbia**" no longer matches "Columbia, PA" and "Dorchester" no longer
   matches "Chester, PA". A ~45-state blocklist rejects anything outside PA/DE.
   **Unknown location = dropped**, never guessed — except for five sources that publish no city
   at all, which carry an explicit `default_location`.
5. **Description screen** (`detail_reject`) runs on *new* matches only: rejects
   "must have RN license", "master's required", "LCSW", "position filled", etc. This exists
   because Melmark's $89,440 "Health Care Coordinator" looked perfect and required a PA RN.

Tuning these lists is a feedback loop: every **Not for me** on the dashboard can carry a short
note saying why, and those notes live in `jobs.status_reason`. Read them back with

```bash
curl -s https://pop-health-jobs.vercel.app/api/jobs \
  | jq -r '.archive[] | select(.statusReason) | "\(.employer) — \(.title) — \(.statusReason)"'
```

then add the recurring ones to `POSITIVE` / `NEGATIVE` / `URL_REJECT` / `DETAIL_REJECT` rather
than guessing at what to filter next.

## Live dashboard

**https://pop-health-jobs.vercel.app** — public, no login.

Every run pushes its relevant matches to Postgres on Vercel. On the page she can hit
**Apply ↗** (goes straight to the posting), **Applied**, or **Not for me** — which opens a
one-line note box ("RN license required", "not population health", …) before it commits.
Marked jobs leave the main list but stay in the **Archive** section with a **Restore** button —
nothing is ever deleted, and a dismissal note is shown back on the archived card.

```
vez (Pi)                            Vercel                         Postgres (Neon)
────────                            ──────                         ───────────────
job_watch.py ──POST /api/ingest──▶  /api/ingest  ──upsert──▶  jobs (status: new/applied/ignored)
  8:00 daily                        /api/jobs    ◀──select──
   ▲                                /api/jobs/:id ──update──▶  status
   └──── GET /api/suppressed ─────────────┘
        (skips jobs she already handled)
```

The suppression call is a safety net, not the primary dedupe — `seen` already prevents
re-alerting. It matters if a baseline is ever reset or a new source is added, so jobs she has
already applied to don't come back as new.

Project: `vincent-zouras-projects/pop-health-jobs`. Source lives in
[`web/`](../web/), deployed by Vercel on push to `main` with **Root Directory = `web`**.
Repo: `github.com/vincentzouras/pop-health-jobs`.
`INGEST_TOKEN` is set in Vercel (production + preview) and in `~/.hermes/.env` on the Pi.

## What self-heals vs. what alerts you

The honest split, as tested:

| Failure | Behaviour | Tested |
|---|---|---|
| Camofox wedged (`browser_rss_pressure`) | **Self-heals** — posts `/start`, polls `/health`, falls back to `systemctl restart camofox` | ✅ stopped the service entirely; watcher recovered and ran clean |
| Camofox process fully down | **Self-heals** — same path | ✅ `systemctl stop` → run completed, 0 bytes output |
| Tab reaped mid-run (404 on `/evaluate`) | **Self-heals** — opens a fresh tab, retries | ✅ observed live, now retried |
| One page returns an empty shell (WellSpan throttling) | **Self-heals** — backs off and retries up to 2× at +3 s | ✅ verified 16/16 pages then returned 12 each |
| A source's markup changes | **Alerts you** — `X: returned 0 postings (usually ~N)` | ✅ disabled Penn's parser; watcher reported it instead of going quiet |
| A source partially breaks | **Alerts you** — `X: only N postings (usually ~M)` when < 40 % of peak | ✅ |
| Page loads fail | **Alerts you** — `X: N page load(s) failed` | ✅ |
| Every source unreachable | **Alerts you** — `⚠️ Job watch FAILED`, exit 1 | ✅ pointed at a dead port; message printed, exit 1 |
| Script crashes | **Alerts you** — `⚠️ Job watch crashed: …`, exit 1 | ✅ wrapped in try/except |
| Nothing new | **Silent** — 0 bytes, no message | ✅ |

**Verified that exit-code-1 output still reaches Telegram**: a temporary job printing one line and
`sys.exit(1)` produced `Job '…': delivered to telegram:8949334764` in the scheduler log. So a
failure message is not swallowed.

**Source health is persisted** in `source_health` inside the state file: `last`, `peak`, `zero_streak`
per employer. `peak` is a high-water mark, so one bad day doesn't trigger a false alarm and a
genuinely broken parser does.

### The limit of self-repair

It can fix *infrastructure* (browser, tabs, throttling). It cannot fix **changed markup or a moved
URL** — when Penn or ChristianaCare redesigns their site, the watcher will tell you with
`returned 0 postings` rather than silently going dark, but repairing the parser is a code change
that needs me (or you). Same for a new employer being added.

If you stop getting alerts entirely and never got a warning, suspect the cron job itself — check
with `hermes cron list` / `hermes cron runs`.

Camofox kills its page when RSS crosses `BROWSER_RSS_RESTART_THRESHOLD_MB` (450 MB) and then
reports `ok:false, reason:browser_rss_pressure` until something relaunches it. `revive_browser()`
posts `/start`, waits for `/health`, then falls back to `systemctl --user restart camofox.service`.
A 503/502 on any page triggers it and retries.

## Validation status (2026-11-04)

| Check | Result |
|---|---|
| `--selftest` | **95/95 pass** (68 title/location, 11 description, 3 Jefferson URL, 2 Penn table-layout, 11 posted-date) |
| Baseline | **561 postings -> 55 relevant, 0 errors** |
| Board population | 55 active rows, **15 with a real posted date**, 40 on the "found" fallback |
| Per-source coverage | WellSpan 158, Tower 122, Penn 86, PHMC 50, Jefferson 46, ChristianaCare 32, Main Line 21, AmeriHealth 16, Chester 10, Delaware Co 10, Montgomery Co 10 |
| Silence when nothing new | `bytes=0` |
| Alert rendering | 9 clean matches with title / employer / location / link |
| **Scheduler → Telegram** | log: `Job '8e7a83cfdc37': delivered to telegram:8949334764` |
| Post-delivery recheck | `bytes=0` (state correctly re-seeded) |

Regression cases now locked in: DC / NH / SC / NY locations, "United States" alone, empty
location, Dorchester MA, and the RN-in-URL slug.

## Commands

```bash
PY=~/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3

$PY ~/.hermes/scripts/job_watch.py             # normal run (silent unless new)
$PY ~/.hermes/scripts/job_watch.py --dump      # relevant / new / rejected
$PY ~/.hermes/scripts/job_watch.py --dump --dump-all
$PY ~/.hermes/scripts/job_watch.py --selftest  # run filter tests after ANY rule change
$PY ~/.hermes/scripts/job_watch.py --baseline  # silence everything currently live
$PY ~/.hermes/scripts/job_watch.py --backfill-posted  # read posted dates for jobs lacking one

cd ~/.hermes/hermes-agent
./hermes cron list
./hermes cron run 8e7a83cfdc37
./hermes cron pause 8e7a83cfdc37
```

**`--baseline` silences everything currently posted.** Use it after adding a source or changing
filters, or the next run alerts on all ~22 existing matches.

## Alert bookkeeping

`seen` holds every posting ever observed, relevant or not. A posting only alerts once, and
only if it was never announced:

- brand-new posting that is relevant → **alerts**
- posting seen before but never announced, now relevant (e.g. employer edited the title) → **alerts**
- posting already announced → silent
- posting rejected by the description screen → silent, and not re-fetched each day

`--baseline` marks every currently-relevant posting as announced, which is what stops it
flooding you on the next run.

## Known limitations

- **Title filters can't read experience requirements.** A role wanting 5 years still surfaces.
  Treat alerts as "worth a look," not "definitely eligible."
- **Tower / Main Line / WellSpan cards omit the city**, so they use a `default_location`. A Tower
  posting at a far-flung facility would read as in-corridor. Their footprints are SE PA, so risk
  is small but real.
- **AmeriHealth needs an 11 s render wait** (Phenom renders the list late); at 5 s the cards are
  still empty and everything drops as "unknown location".
- **~12 minutes per run** — full-board pagination plus a description fetch per new match. Verified the scheduler tolerates it (real run: 711s, Ran now: succeeded).
