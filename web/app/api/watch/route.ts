import { NextResponse } from 'next/server';
import { ensureSchema, getWatchState, hasDb, setMeta, WATCH_DEFAULTS } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The Pi reads this at the top of every run; the dashboard reads it to show the state. */
export async function GET() {
  if (!hasDb()) return NextResponse.json(WATCH_DEFAULTS, { status: 200 });
  try {
    await ensureSchema();
    return NextResponse.json(await getWatchState(), { status: 200 });
  } catch (err) {
    return NextResponse.json({ ...WATCH_DEFAULTS, error: String(err).slice(0, 200) }, { status: 200 });
  }
}

interface Body {
  enabled?: boolean;
  intervalMin?: number;
  /** Ask for one scan now, regardless of the interval. */
  requestScan?: boolean;
  /** The Pi calls this once it has honoured a request. */
  clearRequest?: boolean;
}

export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'no database' }, { status: 503 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  await ensureSchema();
  try {
    if (typeof body.enabled === 'boolean') {
      await setMeta('watch_enabled', body.enabled ? '1' : '0');
    }
    if (typeof body.intervalMin === 'number' && Number.isFinite(body.intervalMin)) {
      // Clamp: below 15 minutes the Pi scrapes employer boards faster than they change.
      const mins = Math.max(15, Math.min(1440, Math.round(body.intervalMin)));
      await setMeta('scan_interval_min', String(mins));
    }
    if (body.requestScan) {
      await setMeta('scan_requested', new Date().toISOString());
    }
    if (body.clearRequest) {
      await setMeta('scan_requested', '');
    }
    return NextResponse.json(await getWatchState(), { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}
