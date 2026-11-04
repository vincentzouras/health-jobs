import JobBoard from './JobBoard';
import { ensureSchema, hasDb, JOB_COLUMNS, pool, rowToJob } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function load() {
  if (!hasDb()) {
    return { active: [], archive: [], meta: { lastIngest: null, db: false } };
  }
  try {
    await ensureSchema();
    const { rows } = await pool().query(
      `SELECT ${JOB_COLUMNS}
         FROM jobs
        ORDER BY posted DESC NULLS LAST, first_seen DESC`,
    );
    const jobs = rows.map(rowToJob);
    const meta = await pool().query(`SELECT value FROM meta WHERE key = 'last_ingest'`);
    return {
      active: jobs.filter((j) => j.status === 'new'),
      archive: jobs.filter((j) => j.status !== 'new'),
      meta: { lastIngest: meta.rows[0]?.value ?? null, db: true },
    };
  } catch (err) {
    return {
      active: [],
      archive: [],
      meta: { lastIngest: null, db: true },
      error: String(err).slice(0, 300),
    };
  }
}

export default async function Page() {
  const initial = await load();
  return <JobBoard initial={initial} />;
}
