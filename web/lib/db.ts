import { Pool } from 'pg';
import crypto from 'node:crypto';
import type { Area } from './areas';

export type { Area } from './areas';
export { AREA_LABEL, AREAS } from './areas';

export type Status = 'new' | 'applied' | 'ignored' | 'retired';

export interface Job {
  id: string;
  employer: string;
  title: string;
  location: string | null;
  url: string;
  status: Status;
  /** Free-text note the human wrote when dismissing a job. */
  statusReason: string | null;
  posted: string | null;
  firstSeen: string;
  lastSeen: string;
  statusChangedAt: string | null;
  /** Present when the Pi resolved a route from one of the two cluster pins. */
  hasMap: boolean;
  driveMin: number | null;
  driveMi: number | null;
  /** Which cluster this posting belongs to: the nearer of the two pins. */
  area: Area | null;
  /** Encoded polyline (precision 5) of the drive; the browser decodes it to draw the map. */
  mapGeometry: string | null;
  mapOrigin: string | null;
}

/** Longest dismissal note we keep; anything past this is truncated. */
export const MAX_REASON = 400;

/** A job site we noticed but do not scrape yet: the queue behind "improves over time". */
export type CandidateStatus = 'seen' | 'wanted' | 'ignored';

export interface SourceCandidate {
  host: string;
  firstSeen: string;
  lastSeen: string;
  /** How many links pointed at this host, so the queue can be ordered by evidence. */
  seenCount: number;
  sampleUrl: string | null;
  sampleTitle: string | null;
  employer: string | null;
  status: CandidateStatus;
}

/** Rows kept in the queue, newest evidence first; 'ignored' never comes back. */
export async function getSourceCandidates(limit = 30): Promise<SourceCandidate[]> {
  const { rows } = await pool().query(
    `SELECT host, first_seen, last_seen, seen_count, sample_url, sample_title, employer, status
       FROM source_candidates
      WHERE status <> 'ignored'
      ORDER BY (status = 'wanted') DESC, seen_count DESC, last_seen DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    host: String(r.host),
    firstSeen: new Date(r.first_seen as string).toISOString(),
    lastSeen: new Date(r.last_seen as string).toISOString(),
    seenCount: Number(r.seen_count) || 0,
    sampleUrl: (r.sample_url as string | null) ?? null,
    sampleTitle: (r.sample_title as string | null) ?? null,
    employer: (r.employer as string | null) ?? null,
    status: r.status as CandidateStatus,
  }));
}

/** Merge the Pi's queue in, keeping the first sighting and the highest count. */
export async function upsertSourceCandidates(
  rows: { host?: unknown; first_seen?: unknown; last_seen?: unknown; seen_count?: unknown;
          sample_url?: unknown; sample_title?: unknown; employer?: unknown }[],
): Promise<number> {
  let stored = 0;
  for (const r of rows) {
    const host = typeof r.host === 'string' ? r.host.trim().toLowerCase().slice(0, 120) : '';
    if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    const stamp = (v: unknown) =>
      typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;
    const { rowCount } = await pool().query(
      `INSERT INTO source_candidates
         (host, first_seen, last_seen, seen_count, sample_url, sample_title, employer)
       VALUES ($1, COALESCE($2, now()), COALESCE($3, now()), $4, $5, $6, $7)
       ON CONFLICT (host) DO UPDATE
         SET last_seen    = GREATEST(source_candidates.last_seen, COALESCE(EXCLUDED.last_seen, now())),
             first_seen   = LEAST(source_candidates.first_seen, COALESCE(EXCLUDED.first_seen, now())),
             seen_count   = GREATEST(source_candidates.seen_count, EXCLUDED.seen_count),
             sample_url   = COALESCE(source_candidates.sample_url, EXCLUDED.sample_url),
             sample_title = COALESCE(source_candidates.sample_title, EXCLUDED.sample_title),
             employer     = COALESCE(source_candidates.employer, EXCLUDED.employer)`,
      [
        host,
        stamp(r.first_seen),
        stamp(r.last_seen),
        Math.max(1, Math.min(100_000, Math.round(Number(r.seen_count) || 1))),
        typeof r.sample_url === 'string' ? r.sample_url.slice(0, 300) : null,
        typeof r.sample_title === 'string' ? r.sample_title.slice(0, 200) : null,
        typeof r.employer === 'string' ? r.employer.slice(0, 120) : null,
      ],
    );
    if (rowCount) stored += 1;
  }
  return stored;
}

export async function setCandidateStatus(host: string, status: CandidateStatus): Promise<boolean> {
  const { rowCount } = await pool().query(
    `UPDATE source_candidates SET status = $2 WHERE host = $1`,
    [host.trim().toLowerCase().slice(0, 120), status],
  );
  return Boolean(rowCount);
}

/** A route is ~1–8 KB of polyline; anything this big is not a route. */
export const MAX_GEOMETRY = 20_000;

export function rowToJob(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    employer: String(r.employer),
    title: String(r.title),
    location: (r.location as string) ?? null,
    url: (r.url as string) ?? '',
    status: r.status as Status,
    statusReason: (r.status_reason as string | null) ?? null,
    posted: (r.posted as string) ?? null,
    firstSeen: new Date(r.first_seen as string).toISOString(),
    lastSeen: new Date(r.last_seen as string).toISOString(),
    statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at as string).toISOString() : null,
    hasMap: Boolean(r.map_geometry),
    driveMin: r.drive_min === null || r.drive_min === undefined ? null : Number(r.drive_min),
    driveMi: r.drive_mi === null || r.drive_mi === undefined ? null : Number(r.drive_mi),
    area: (r.map_cluster as Area | null) ?? null,
    mapGeometry: (r.map_geometry as string | null) ?? null,
    mapOrigin: (r.map_origin as string | null) ?? null,
  };
}

/**
 * Columns every caller selects; keeps the two read paths in sync. The route-card fields come
 * from scalar subqueries so both queries keep their plain `FROM jobs`.
 */
export const JOB_COLUMNS = `id, employer, title, location, url, status, status_reason,
              posted::text AS posted, first_seen, last_seen, status_changed_at,
              (SELECT m.drive_min  FROM job_maps m WHERE m.id = jobs.id) AS drive_min,
              (SELECT m.drive_mi   FROM job_maps m WHERE m.id = jobs.id) AS drive_mi,
              (SELECT m.cluster    FROM job_maps m WHERE m.id = jobs.id) AS map_cluster,
              (SELECT m.geometry   FROM job_maps m WHERE m.id = jobs.id) AS map_geometry,
              (SELECT m.origin_label FROM job_maps m WHERE m.id = jobs.id) AS map_origin`;

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
          status_reason     TEXT,
          posted            DATE,
          first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
          status_changed_at TIMESTAMPTZ
        );
      `);
      await pool().query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_key TEXT;`);
      await pool().query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS posted DATE;`);
      await pool().query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_reason TEXT;`);
      await pool().query(`CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);`);
      await pool().query(`CREATE INDEX IF NOT EXISTS jobs_last_seen_idx ON jobs (last_seen DESC);`);
      await pool().query(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      // Route cards: the drive from the pinned origin, as an encoded polyline the browser
      // draws over OpenStreetMap tiles. No image is stored, so a card costs ~2 KB not ~200 KB.
      await pool().query(`
        CREATE TABLE IF NOT EXISTS job_maps (
          id           TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
          geometry     TEXT,
          drive_min    INTEGER,
          drive_mi     NUMERIC(6,1),
          cluster      TEXT,
          origin_label TEXT,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Which of the two clusters the posting belongs to (added when the board split in two).
      await pool().query(`ALTER TABLE job_maps ADD COLUMN IF NOT EXISTS cluster TEXT;`);
      // Sites we ran into but do not scrape yet. Kept as a queue a human works through: adding a
      // source means writing and validating a parser, which is not something to do unattended.
      await pool().query(`
        CREATE TABLE IF NOT EXISTS source_candidates (
          host         TEXT PRIMARY KEY,
          first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
          seen_count   INTEGER NOT NULL DEFAULT 1,
          sample_url   TEXT,
          sample_title TEXT,
          employer     TEXT,
          status       TEXT NOT NULL DEFAULT 'seen'
        );
      `);
      // The first cut stored a rendered PNG instead; that shape is not compatible and the rows
      // carried nothing worth keeping, so swap the column out rather than leave a dead one.
      const legacy = await pool().query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'job_maps' AND column_name = 'png'`);
      if (legacy.rowCount) {
        await pool().query(`ALTER TABLE job_maps ADD COLUMN IF NOT EXISTS geometry TEXT;`);
        await pool().query(`ALTER TABLE job_maps DROP COLUMN IF EXISTS png;`);
      }
    })();
  }
  return global.__jobSchema;
}

/** Stable id derived from the Pi's employer + requisition id. */
export function jobId(employer: string, jobKey: string): string {
  return crypto.createHash('sha1').update(`${employer}|${jobKey}`).digest('hex').slice(0, 16);
}

/**
 * The one thing the dashboard still owns: keep hunting for new employers, or not.
 *
 * Scanning the employer list is a single fixed trigger (the daily cron) - the toggle here is
 * purely about spending effort finding boards that are not watched yet.
 */
export interface ExtraSource {
  /** File name under ~/.hermes/job-watches/sources.d/, which is also how it gets removed. */
  slug: string;
  name: string;
  url: string;
  /** Which parser reads it (workday, ukg, neogov, phenom, ...). */
  parse: string;
}

export interface DiscoveryState {
  enabled: boolean;
  lastHuntAt: string | null;
  lastHuntAdded: number | null;
  /** Sources added since the hand-written list: scanned by the same daily run. */
  extra: ExtraSource[];
  /** Slugs the human removed here; the Pi deletes the files on its next run. */
  sourceDrops: string[];
}

export const DISCOVERY_DEFAULTS: DiscoveryState = {
  enabled: false,
  lastHuntAt: null,
  lastHuntAdded: null,
  extra: [],
  sourceDrops: [],
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function getDiscoveryState(): Promise<DiscoveryState> {
  const { rows } = await pool().query(
    `SELECT key, value FROM meta
      WHERE key IN ('discovery_enabled','discovery_last','discovery_added',
                    'extra_sources','source_drops')`,
  );
  const m = Object.fromEntries(rows.map((r) => [String(r.key), r.value as string]));
  const added = Number(m.discovery_added);
  return {
    enabled: m.discovery_enabled === '1',
    lastHuntAt: m.discovery_last || null,
    lastHuntAdded: Number.isFinite(added) ? added : null,
    extra: parseJson<ExtraSource[]>(m.extra_sources, []),
    sourceDrops: parseJson<string[]>(m.source_drops, []),
  };
}

export async function setDiscoveryEnabled(on: boolean): Promise<void> {
  await setMeta('discovery_enabled', on ? '1' : '0');
}

export async function setExtraSources(rows: ExtraSource[]): Promise<void> {
  await setMeta('extra_sources', JSON.stringify(rows.slice(0, 40)));
}

export async function recordHunt(at: string, added: number): Promise<void> {
  await setMeta('discovery_last', at);
  await setMeta('discovery_added', String(added));
}

/** Queue a removal; the Pi polls for these at the top of its next run. */
export async function requestSourceDrop(slug: string): Promise<void> {
  const { sourceDrops } = await getDiscoveryState();
  const next = Array.from(new Set([...sourceDrops, slug])).slice(0, 40);
  await setMeta('source_drops', JSON.stringify(next));
}

export async function clearSourceDrops(slugs: string[]): Promise<void> {
  const { sourceDrops } = await getDiscoveryState();
  const done = new Set(slugs);
  await setMeta('source_drops', JSON.stringify(sourceDrops.filter((s) => !done.has(s))));
}

export async function setMeta(key: string, value: string): Promise<void> {
  await pool().query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}
