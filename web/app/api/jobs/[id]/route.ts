import { NextResponse } from 'next/server';
import { ensureSchema, MAX_REASON, pool, type Status } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID: Status[] = ['new', 'applied', 'ignored'];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const status = body.status as Status;
  if (!VALID.includes(status)) {
    return NextResponse.json({ error: `status must be one of ${VALID.join(', ')}` }, { status: 400 });
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : '';

  await ensureSchema();
  const { rowCount } = await pool().query(
    `UPDATE jobs
        SET status = $2,
            status_reason = CASE WHEN $2 = 'ignored' THEN NULLIF($3, '') ELSE NULL END,
            status_changed_at = CASE WHEN $2 = 'new' THEN NULL ELSE now() END
      WHERE id = $1`,
    [id, status, reason],
  );
  if (rowCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, id, status, reason: reason || null });
}
