import { NextResponse } from 'next/server';
import {
  ensureSchema,
  getSourceCandidates,
  hasDb,
  setCandidateStatus,
  type CandidateStatus,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS: Record<string, CandidateStatus> = {
  watch: 'wanted',
  dismiss: 'ignored',
  reset: 'seen',
};

/** The discovery queue: job sites the Pi has seen but nobody has written a parser for. */
export async function GET() {
  if (!hasDb()) return NextResponse.json({ candidates: [] }, { status: 200 });
  try {
    await ensureSchema();
    return NextResponse.json({ candidates: await getSourceCandidates() }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { candidates: [], error: String(err).slice(0, 200) },
      { status: 200 },
    );
  }
}

/**
 * What the human decides about a candidate. Nothing starts being scraped because of this:
 * "watch" records the intent, and a parser is written against the site afterwards.
 */
export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'no database' }, { status: 503 });
  let body: { host?: string; action?: string };
  try {
    body = (await req.json()) as { host?: string; action?: string };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const status = ACTIONS[String(body.action)];
  if (!body.host || !status) {
    return NextResponse.json(
      { error: 'expected { host, action: watch|dismiss|reset }' },
      { status: 400 },
    );
  }
  await ensureSchema();
  try {
    const ok = await setCandidateStatus(body.host, status);
    if (!ok) return NextResponse.json({ error: 'unknown host' }, { status: 404 });
    return NextResponse.json({ ok: true, candidates: await getSourceCandidates() }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}
