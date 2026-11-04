# Job Board

Vercel app fed by the `job_watch.py` cron on `vez`. Shows population-health roles in the
Downingtown/Wilmington and York corridors, lets you mark each one **Applied** or
**Not for me**, and keeps everything in an archive instead of deleting it.

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
| `GET` | `/api/jobs` | public | `{ active, archive, meta }` |
| `PATCH` | `/api/jobs/:id` | public | body `{ "status": "new" \| "applied" \| "ignored" }` |
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

- The table is created automatically on first request (`CREATE TABLE IF NOT EXISTS`).
- The UI polls `/api/jobs` every 5 minutes and has a manual Refresh button.
- A job whose `last_seen` is older than 7 days gets a **may be closed** badge rather than
  being removed — the posting may still be live even if it scrolled off the board.
- Nothing is ever deleted. `Applied` / `Not for me` just set `status`, which moves the row
  to the archive; **Restore** puts it back in the main list.
