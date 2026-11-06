import { NextResponse } from 'next/server';
import {
  ensureSchema,
  getSourceCandidates,
  hasDb,
  setExtraSources,
  upsertSourceCandidates,
  type ExtraSource,
} from '@/lib/db';

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

  let body: { candidates?: Incoming[]; extra?: ExtraSource[]; run_at?: string };
  try {
    body = (await req.json()) as { candidates?: Incoming[]; extra?: ExtraSource[]; run_at?: string };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const rows = Array.isArray(body.candidates) ? body.candidates : [];
  const extra = Array.isArray(body.extra)
    ? body.extra.filter((e) => e && typeof e.slug === 'string' && typeof e.name === 'string')
    : null;
  if (rows.length === 0 && !extra) {
    return NextResponse.json({ ok: true, stored: 0, note: 'empty' });
  }

  await ensureSchema();
  try {
    const stored = rows.length ? await upsertSourceCandidates(rows) : 0;
    if (extra) await setExtraSources(extra);
    return NextResponse.json({
      ok: true,
      stored,
      total: rows.length,
      extra: extra ? extra.length : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
