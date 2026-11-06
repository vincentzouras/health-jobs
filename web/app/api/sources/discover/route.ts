import { NextResponse } from 'next/server';
import { ensureSchema, getSourceCandidates, pool, upsertSourceCandidates } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Incoming {
  host?: string;
  first_seen?: string | null;
  last_seen?: string | null;
  seen_count?: number | null;
  sample_url?: string | null;
  sample_title?: string | null;
  employer?: string | null;
}

/**
 * The Pi's half of source discovery. Write-only and token-gated like /api/ingest: the scanner
 * reports which job hosts it bumped into, the board keeps the union.
 */
export async function POST(req: Request) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'INGEST_TOKEN is not configured on the server' },
      { status: 500 },
    );
  }
  if (req.headers.get('x-ingest-token') !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { candidates?: Incoming[]; run_at?: string };
  try {
    body = (await req.json()) as { candidates?: Incoming[]; run_at?: string };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const rows = Array.isArray(body.candidates) ? body.candidates : [];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, stored: 0, note: 'empty' });
  }

  await ensureSchema();
  try {
    const stored = await upsertSourceCandidates(rows);
    await pool().query(
      `INSERT INTO meta (key, value) VALUES ('last_discovery', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [body.run_at || new Date().toISOString()],
    );
    return NextResponse.json({ ok: true, stored, total: rows.length, queue: (await getSourceCandidates(200)).length });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
