import { NextResponse } from 'next/server';
import { ensureSchema, hasDb, pool, type Job } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rowToJob = (r: Record<string, unknown>): Job => ({
  id: String(r.id),
  employer: String(r.employer),
  title: String(r.title),
  location: (r.location as string) ?? null,
  url: (r.url as string) ?? '',
  status: r.status as Job['status'],
  posted: (r.posted as string) ?? null,
  firstSeen: new Date(r.first_seen as string).toISOString(),
  lastSeen: new Date(r.last_seen as string).toISOString(),
  statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at as string).toISOString() : null,
});

export async function GET() {
  if (!hasDb()) {
    return NextResponse.json(
      { active: [], archive: [], meta: { lastIngest: null, db: false } },
      { status: 200 },
    );
  }
  try {
    await ensureSchema();
    const { rows } = await pool().query(
      `SELECT id, employer, title, location, url, status, posted::text AS posted,
              first_seen, last_seen, status_changed_at
         FROM jobs
        ORDER BY posted DESC NULLS LAST, first_seen DESC`,
    );
    const jobs = rows.map(rowToJob);
    const active = jobs.filter((j) => j.status === 'new');
    const archive = jobs.filter((j) => j.status !== 'new');

    const meta = await pool().query(`SELECT value FROM meta WHERE key = 'last_ingest'`);
    return NextResponse.json({
      active,
      archive,
      meta: { lastIngest: meta.rows[0]?.value ?? null, db: true },
    });
  } catch (err) {
    return NextResponse.json(
      { active: [], archive: [], meta: { lastIngest: null, db: true }, error: String(err).slice(0, 300) },
      { status: 200 },
    );
  }
}
