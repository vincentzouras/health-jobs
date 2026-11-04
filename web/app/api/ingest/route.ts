import { NextResponse } from 'next/server';
import { ensureSchema, jobId, pool } from '@/lib/db';

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

  let body: { jobs?: IncomingJob[]; run_at?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (jobs.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0, updated: 0, total: 0, note: 'empty snapshot' });
  }

  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    let updated = 0;

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

    await client.query(
      `INSERT INTO meta (key, value) VALUES ('last_ingest', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [body.run_at || new Date().toISOString()],
    );

    await client.query('COMMIT');
    return NextResponse.json({ ok: true, inserted, updated, total: inserted + updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  } finally {
    client.release();
  }
}
