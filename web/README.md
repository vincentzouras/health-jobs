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
- The table is created automatically on first request (`CREATE TABLE IF NOT EXISTS`).
- The UI polls `/api/jobs` every 5 minutes and has a manual Refresh button.
- A job whose `last_seen` is older than 7 days gets a **may be closed** badge rather than
  being removed — the posting may still be live even if it scrolled off the board.
- Every card shows **found** (when the scan first saw the posting); when the source also
  publishes a date it leads with **posted**. Archived cards add **marked** (when you set the
  status), so the three times stay distinguishable.
- Nothing is ever deleted. `Applied` / `Not for me` just set `status`, which moves the row
  to the archive; **Restore** puts it back in the main list.

## Dismissal notes

`Not for me` opens a small note box before it commits. The text is optional, capped at 400
characters, stored in `jobs.status_reason`, and shown on the archived card under **Why not**.
Archived dismissals keep an **Add note** / **Edit note** button, so older rows can be filled in
later. `Applied` and **Restore** clear it (the column is kept in step with `status = 'ignored'`).

The notes exist to feed the scraper: `job_watch.py`'s title/location/description screens are
tuned by hand, so reading back what was actually rejected is how the filter terms get a
correction instead of a guess. `GET /api/jobs` returns them, e.g.

```bash
curl -s https://pop-health-jobs.vercel.app/api/jobs \
  | jq -r '.archive[] | select(.statusReason) | "\(.employer) — \(.title) — \(.statusReason)"'
```
