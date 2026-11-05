import { NextResponse } from 'next/server';
import { ensureSchema, jobId, MAX_MAP_BYTES, pool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IncomingJob {
  employer: string;
  job_id: string;
  title: string;
  location?: string | null;
  url?: string | null;
  posted?: string | null;
}

/** A route card: the rendered map plus the drive time it was rendered for. */
interface IncomingMap {
  employer: string;
  job_id: string;
  drive_min?: number | null;
  drive_mi?: number | null;
  origin_label?: string | null;
  png: string; // base64
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'INGEST_TOKEN is not configured on the server' }, { status: 500 });
  }
  const got = req.headers.get('x-ingest-token');
  if (got !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { jobs?: IncomingJob[]; maps?: IncomingMap[]; run_at?: string; scanner?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const maps = Array.isArray(body.maps) ? body.maps : [];
  if (jobs.length === 0 && maps.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, updated: 0, total: 0, note: 'empty snapshot' });
  }

  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    let updated = 0;
    let mapsStored = 0;
    let mapsSkipped = 0;

    for (const j of jobs) {
      if (!j || !j.employer || !j.job_id || !j.title) continue;
      const id = jobId(j.employer, String(j.job_id));
      const posted = typeof j.posted === 'string' && DATE_ONLY.test(j.posted) ? j.posted : null;
      const res = await client.query(
        `INSERT INTO jobs (id, job_key, employer, title, location, url, posted, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (id) DO UPDATE
           SET title     = EXCLUDED.title,
               job_key   = EXCLUDED.job_key,
               location  = COALESCE(EXCLUDED.location, jobs.location),
               url       = COALESCE(EXCLUDED.url, jobs.url),
               posted    = COALESCE(EXCLUDED.posted, jobs.posted),
               last_seen = now()
         RETURNING (xmax = 0) AS was_inserted`,
        [id, String(j.job_id), j.employer, j.title, j.location ?? null, j.url ?? null, posted],
      );
      if (res.rows[0]?.was_inserted) inserted += 1;
      else updated += 1;
    }

    for (const m of maps) {
      if (!m || !m.employer || !m.job_id || typeof m.png !== 'string') continue;
      const id = jobId(m.employer, String(m.job_id));
      let png: Buffer;
      try {
        png = Buffer.from(m.png, 'base64');
      } catch {
        mapsSkipped += 1;
        continue;
      }
      // A route card is an enhancement: never let a bad one fail the whole ingest.
      if (png.length === 0 || png.length > MAX_MAP_BYTES) {
        mapsSkipped += 1;
        continue;
      }
      const { rowCount } = await client.query(
        // Only for a job that still exists: the board purges addressed rows, and a map for a
        // gone job must be skipped rather than violating the foreign key and failing the batch.
        `INSERT INTO job_maps (id, png, drive_min, drive_mi, origin_label, generated_at)
         SELECT $1, $2, $3, $4, $5, now()
          WHERE EXISTS (SELECT 1 FROM jobs WHERE id = $1)
         ON CONFLICT (id) DO UPDATE
           SET png          = EXCLUDED.png,
               drive_min    = EXCLUDED.drive_min,
               drive_mi     = EXCLUDED.drive_mi,
               origin_label = EXCLUDED.origin_label,
               generated_at = now()`,
        [
          id,
          png,
          Number.isFinite(Number(m.drive_min)) ? Math.round(Number(m.drive_min)) : null,
          Number.isFinite(Number(m.drive_mi)) ? Number(m.drive_mi) : null,
          typeof m.origin_label === 'string' ? m.origin_label.slice(0, 80) : null,
        ],
      );
      if (rowCount) mapsStored += 1;
      else mapsSkipped += 1;
    }

    await client.query(
      `INSERT INTO meta (key, value) VALUES ('last_ingest', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [body.run_at || new Date().toISOString()],
    );
    if (typeof body.scanner === 'string' && body.scanner.trim()) {
      // Proof of which scanner build fed the board, so Pi/repo drift is visible.
      await client.query(
        `INSERT INTO meta (key, value) VALUES ('scanner_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [body.scanner.trim().slice(0, 40)],
      );
    }

    await client.query('COMMIT');
    return NextResponse.json({
      ok: true,
      inserted,
      updated,
      total: inserted + updated,
      maps: mapsStored,
      mapsSkipped,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  } finally {
    client.release();
  }
}
