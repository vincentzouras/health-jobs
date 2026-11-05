import { NextResponse } from 'next/server';
import { ensureSchema, hasDb, pool } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve a job's stored route card.
 *
 * The image is rendered once on the Pi and never changes for a given job, so this is
 * `immutable` and cached at the edge: the dashboard costs one origin hit per map, ever.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return new NextResponse('no database', { status: 503 });

  await ensureSchema();
  const { rows } = await pool().query(`SELECT png FROM job_maps WHERE id = $1`, [id]);
  const png = rows[0]?.png as Buffer | undefined;
  if (!png) return new NextResponse('not found', { status: 404 });

  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
