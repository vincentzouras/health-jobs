import { NextResponse } from 'next/server';
import {
  clearSourceDrops,
  ensureSchema,
  getDiscoveryState,
  hasDb,
  recordHunt,
  requestSourceDrop,
  setDiscoveryEnabled,
  DISCOVERY_DEFAULTS,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The employer hunt: on/off from the dashboard, plus the extra sources it has produced.
 *
 * The Pi reads this before it spends an LLM run, and polls it for sources the human removed.
 */
export async function GET() {
  if (!hasDb()) return NextResponse.json(DISCOVERY_DEFAULTS, { status: 200 });
  try {
    await ensureSchema();
    return NextResponse.json(await getDiscoveryState(), { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { ...DISCOVERY_DEFAULTS, error: String(err).slice(0, 200) },
      { status: 200 },
    );
  }
}

interface Body {
  /** Dashboard switch: keep hunting for employers we do not watch yet. */
  enabled?: boolean;
  /** Dashboard action: stop watching one of the sources the hunt added. */
  dropSource?: string;
  /** Pi acknowledgement, after it has deleted the files. Token-gated. */
  clearDrops?: string[];
  /** Pi report, after a hunt. Token-gated. */
  hunt?: { at?: string; added?: number };
}

export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'no database' }, { status: 503 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Anything that changes what the Pi does next needs the shared secret; the switch and the
  // "stop watching" action come from the dashboard and are open, like /api/jobs.
  const privileged = body.clearDrops !== undefined || body.hunt !== undefined;
  if (privileged) {
    const expected = process.env.INGEST_TOKEN;
    if (!expected) {
      return NextResponse.json({ error: 'INGEST_TOKEN is not configured' }, { status: 500 });
    }
    if (req.headers.get('x-ingest-token') !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  await ensureSchema();
  try {
    if (typeof body.enabled === 'boolean') await setDiscoveryEnabled(body.enabled);
    if (typeof body.dropSource === 'string' && body.dropSource.trim()) {
      await requestSourceDrop(body.dropSource.trim());
    }
    if (Array.isArray(body.clearDrops)) await clearSourceDrops(body.clearDrops.map(String));
    if (body.hunt && typeof body.hunt.at === 'string') {
      await recordHunt(body.hunt.at, Math.max(0, Math.round(Number(body.hunt.added) || 0)));
    }
    return NextResponse.json(await getDiscoveryState(), { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: String(err).slice(0, 200) }, { status: 500 });
  }
}
