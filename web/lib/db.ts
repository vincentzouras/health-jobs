import { Pool } from 'pg';
import crypto from 'node:crypto';

export type Status = 'new' | 'applied' | 'ignored';

export interface Job {
  id: string;
  employer: string;
  title: string;
  location: string | null;
  url: string;
  status: Status;
  posted: string | null;
  firstSeen: string;
  lastSeen: string;
  statusChangedAt: string | null;
}

const CONN = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

declare global {
  // eslint-disable-next-line no-var
  var __jobPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __jobSchema: Promise<void> | undefined;
}

export function hasDb(): boolean {
  return Boolean(CONN);
}

export function pool(): Pool {
  if (!CONN) throw new Error('POSTGRES_URL is not configured');
  if (!global.__jobPool) {
    global.__jobPool = new Pool({ connectionString: CONN, max: 3, idleTimeoutMillis: 10_000 });
  }
  return global.__jobPool;
}

export async function ensureSchema(): Promise<void> {
  if (!global.__jobSchema) {
    global.__jobSchema = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id                TEXT PRIMARY KEY,
          job_key           TEXT,
          employer          TEXT NOT NULL,
          title             TEXT NOT NULL,
          location          TEXT,
          url               TEXT,
          status            TEXT NOT NULL DEFAULT 'new',
          posted            DATE,
          first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
          status_changed_at TIMESTAMPTZ
        );
      `);
      await pool().query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_key TEXT;`);
      await pool().query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS posted DATE;`);
      await pool().query(`CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);`);
      await pool().query(`CREATE INDEX IF NOT EXISTS jobs_last_seen_idx ON jobs (last_seen DESC);`);
      await pool().query(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    })();
  }
  return global.__jobSchema;
}

/** Stable id derived from the Pi's employer + requisition id. */
export function jobId(employer: string, jobKey: string): string {
  return crypto.createHash('sha1').update(`${employer}|${jobKey}`).digest('hex').slice(0, 16);
}
