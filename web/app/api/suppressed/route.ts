import { NextResponse } from 'next/server';
import { ensureSchema, hasDb, pool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Consumed by the Pi's job_watch.py before it alerts. Lets the 8am run skip anything
 * already marked applied / not-applicable, which matters if the baseline is ever reset.
 * Deliberately public and tiny - it contains no secrets.
 */
export async function GET() {
  if (!hasDb()) return NextResponse.json({ suppressed: [] });
  try {
    await ensureSchema();
    const { rows } = await pool().query(
      `SELECT employer, job_key FROM jobs WHERE status IN ('applied','ignored')`,
    );
    return NextResponse.json({ suppressed: rows.filter((r) => r.job_key) });
  } catch {
    return NextResponse.json({ suppressed: [] });
  }
}
