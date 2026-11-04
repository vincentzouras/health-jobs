# Population Health Jobs

Vercel app fed by the `job_watch.py` cron on `vez`. Shows population-health roles in the
Downingtown/Wilmington and York corridors, lets you mark each one **Applied** or
**Not for me** (with an optional note on why), and keeps everything in an archive instead of
deleting it.

## How it fits together

```
vez (Pi)                           Vercel                            Postgres
────────                           ──────                            ────────
job_watch.py   ──POST /api/ingest──▶  API (token auth)  ──upsert──▶    jobs
  (8:00 daily)                        /api/jobs         ◀──select──
                                      /api/jobs/[id]    ──update──▶   status
   ▲                                  /api/suppressed   ◀──select──
   └──────────GET /api/suppressed ──────────┘   (so applied jobs stop re-alerting)
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/jobs` | public | `{ active, archive, meta }` — each job carries `status` and `statusReason` |
| `PATCH` | `/api/jobs/:id` | public | body `{ "status": "new" \| "applied" \| "ignored", "reason"?: string }` |
| `DELETE` | `/api/jobs/:id` | public | purges an `ignored` row outright (409 for `applied`) |
| `POST` | `/api/ingest` | `x-ingest-token` header | body `{ "run_at": iso, "jobs": [{ employer, job_id, title, location, url }] }` |
| `GET` | `/api/suppressed` | public | `{ suppressed: [{ employer, id }] }` for the Pi |

Job ids are `sha1(employer + "|" + job_id).slice(0,16)`, computed server-side, so the Pi
never needs to know the scheme.

## Environment

| Var | Where | Notes |
|---|---|---|
| `POSTGRES_URL` | Vercel | Auto-injected when you attach Postgres from the Vercel dashboard |
| `INGEST_TOKEN` | Vercel **and** the Pi | Shared secret; generate with `openssl rand -hex 24` |

## Local development

```bash
npm install
cp .env.example .env.local   # fill in both vars
npm run dev
```

## Notes

- The UI is [Material UI](https://mui.com/material-ui/) v9 with the Next.js app-router cache
  provider (`app/Providers.tsx`, `app/theme.ts`). There is no hand-written stylesheet — layout
  comes from `Stack`/`Container` and spacing from `sx`.
- Each employer chip has its own colour. Employers are ranked by when the scan first saw them
  and stepped through the colour wheel by the golden angle, so a source keeps its colour as
  more are added, and neighbouring cards contrast hard (`app/employerColor.ts`).
- A **Not for me** row is a filter-fix request, not a record: the reason is optional (blank means
  an earlier dismissal covers it, and a **Reuse** button fills in the last one), and once the
  scanner has been corrected for that reason the row is deleted (`DELETE /api/jobs/:id`).
  Rejected postings that still pass `classify()` will reappear on the next scan, which is the
  signal that a filter did not actually cover them.
- The table is created automatically on first request (`CREATE TABLE IF NOT EXISTS`).
- The UI polls `/api/jobs` every 5 minutes and has a manual Refresh button.
- A job whose `last_seen` is older than 7 days gets a **may be closed** badge rather than
  being removed — the posting may still be live even if it scrolled off the board.
- Every card shows **found** (when the scan first saw the posting); when the source also
  publishes a date it leads with **posted**. Archived cards add **marked** (when you set the
  status), so the three times stay distinguishable.
- `Applied` / `Not for me` set `status`, which moves the row out of the main list; **Restore**
  puts it back. Applied rows are kept permanently. Not-applicable rows are a short-lived fix
  queue and are deleted once the scanner has been corrected (see below).

## Dismissal notes

`Not for me` takes an **optional** reason. The text is capped at 400 characters, stored in
`jobs.status_reason`, and shown on the archived card under **Why not**. Leaving it blank means
an earlier dismissal already covers it — there is no need to retype "RN license required" for ten
bad rows in a row. When a previous reason exists, the box offers a one-click
**Reuse “…”** so the row still gets tagged without any typing.

Archived dismissals keep an **Add note** / **Edit note** button. `Applied` and **Restore** clear
the note (the column is kept in step with `status = 'ignored'`).

A not-applicable row is a **fix request, not history**. The reason is what the scanner gets
corrected for; once it has been, the row is deleted outright via
`DELETE /api/jobs/:id` (only `ignored` rows can be purged — `applied` history is never
deletable). So the archive only ever holds applied jobs plus not-applicable rows that still
need attention, which is exactly the queue to hand over:

```bash
curl -s https://pop-health-jobs.vercel.app/api/jobs \
  | jq -r '.archive[] | select(.status=="ignored") | "\(.id)  \(.employer) — \(.title) — \(.statusReason)"'
```

Fix the scanner for the recurring reasons, then purge the rows that were addressed:

```bash
curl -sX DELETE https://pop-health-jobs.vercel.app/api/jobs/<id>
```

If a purged row reappears, the filter was not actually covering it — the posting is still live
and still passes `classify()`. The Pi will not re-alert on it (its `seen` state already recorded
the posting), so a reappearance is a signal rather than a nuisance.

The notes exist to feed the scraper: `job_watch.py`'s title/location/description screens are
tuned by hand, so reading back what was actually rejected is how the filter terms get a
correction instead of a guess. Add the recurring reasons to `POSITIVE` / `NEGATIVE` /
`URL_REJECT` / `DETAIL_REJECT`, run `--selftest`, then purge the rows they cover.
