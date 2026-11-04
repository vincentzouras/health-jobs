# pop-health-jobs

A job-hunting system for a population-health graduate (BS, Lehigh) covering two corridors —
**Downingtown / Wilmington** and **York / Lancaster / Harrisburg**.

Two parts that work together:

| | What it is | Where it runs |
|---|---|---|
| **[watcher/](watcher/)** | Scrapes 11 employer job boards daily, filters to roles she can actually apply for, alerts on Telegram | Raspberry Pi (`vez`) via Hermes cron |
| **[web/](web/)** | Dashboard showing every match, with one-click Apply and Applied / Not-for-me tracking | Vercel + Postgres |

**Live:** https://pop-health-jobs.vercel.app

---

## How the pieces fit

```
vez (Pi)                              Vercel                       Postgres (Neon)
────────                              ──────                       ───────────────
watcher/job_watch.py
  ├─ Camofox browser ──▶ 11 job boards
  ├─ relevance filter
  ├─ Telegram alert ──────────────▶ phone
  └─ POST /api/ingest ─────────────▶ /api/ingest ──upsert──▶ jobs
                                              ▲                 (status: new/
    8:00 daily                                │                  applied/ignored)
       │                           /api/jobs  │
       └── GET /api/suppressed ───────────────┘
           (skips jobs already applied to)
```

---

## Layout

```
watcher/
  job_watch.py          the whole scraper/filter notifier — single file, stdlib only
  README.md             how to install it and the filter rules

web/
  app/                  Next.js app router
    page.tsx            server component: loads jobs from Postgres
    JobBoard.tsx        client component: search, filters, status buttons, archive
    globals.css
    api/ingest/         POST snapshot from the Pi (token auth, idempotent upsert)
    api/jobs/           GET active + archive
    api/jobs/[id]/      PATCH status
    api/suppressed/     GET jobs already applied to (consumed by the Pi)
  lib/db.ts             Postgres pool, schema bootstrap, stable job ids
  README.md             app-level setup and endpoint reference

docs/
  job-alerts-setup.md            watcher runbook: sources, filters, failure modes, commands
  population-health-job-search.md  full role/track/pay research
  live-openings.md               hand-verified posting list from the initial sweep
  *-tracker.csv                  spreadsheets for tracking applications
```

---

## Environment

### Vercel (`web/`)

| Variable | Source | Notes |
|---|---|---|
| `POSTGRES_URL` | Neon integration | Auto-injected when the Postgres store is attached |
| `INGEST_TOKEN` | You generate it | Shared secret; must match the Pi's `JOB_BOARD_TOKEN` |

### Pi (`~/.hermes/.env`)

```
JOB_BOARD_URL=https://pop-health-jobs.vercel.app
JOB_BOARD_TOKEN=<same value as INGEST_TOKEN>
```

Both are optional — without them the watcher still scrapes and alerts, it just doesn't publish
to the dashboard.

---

## Local development

```bash
cd web
npm install
cp .env.example .env.local     # fill in POSTGRES_URL and INGEST_TOKEN
npm run dev                    # http://localhost:3000
```

Then in another shell, push a fake snapshot:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H 'content-type: application/json' \
  -H "x-ingest-token: $INGEST_TOKEN" \
  -d '{"jobs":[{"employer":"Test","job_id":"1","title":"Health Coach","location":"Wilmington, DE","url":"https://example.com"}]}'
```

The schema creates itself on first request.

---

## Deploying

Vercel deploys `web/` automatically on every push to `main` (Root Directory is set to `web`).

To update the watcher on the Pi:

```bash
scp watcher/job_watch.py vincent@vez:~/.hermes/scripts/job_watch.py
ssh vincent@vez '~/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3 \
  ~/.hermes/scripts/job_watch.py --selftest'
```

Run `--selftest` after **any** change to the filter rules — it has 58 cases covering title
matching, geography, licensure screens, and the parsers.
