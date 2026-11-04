import { NextResponse } from 'next/server';
import { ensureSchema, hasDb, JOB_COLUMNS, pool, rowToJob } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
      `SELECT ${JOB_COLUMNS}
         FROM jobs
        ORDER BY posted DESC NULLS LAST, first_seen DESC`,
    );
    const jobs = rows.map(rowToJob);
    const active = jobs.filter((j) => j.status === 'new');
    const archive = jobs.filter((j) => j.status !== 'new');

    const meta = await pool().query(`SELECT key, value FROM meta WHERE key IN ('last_ingest','scanner_version')`);
    const metaMap = Object.fromEntries(meta.rows.map((r) => [String(r.key), r.value as string]));
    return NextResponse.json({
      active,
      archive,
      meta: {
        lastIngest: metaMap.last_ingest ?? null,
        scannerVersion: metaMap.scanner_version ?? null,
        db: true,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { active: [], archive: [], meta: { lastIngest: null, db: true }, error: String(err).slice(0, 300) },
      { status: 200 },
    );
  }
}
