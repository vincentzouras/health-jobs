'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, Status } from '@/lib/db';

interface ApiPayload {
  active: Job[];
  archive: Job[];
  meta: { lastIngest: string | null; db: boolean };
  error?: string;
}

const REFRESH_MS = 5 * 60 * 1000;

/** Deterministic UTC formatting so SSR and client produce identical markup. */
function fmtUTC(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function isStale(job: Job): boolean {
  const seen = new Date(job.lastSeen).getTime();
  return Date.now() - seen > 7 * 24 * 60 * 60 * 1000;
}

export default function JobBoard({ initial }: { initial: ApiPayload }) {
  const [data, setData] = useState<ApiPayload>(initial);
  const [query, setQuery] = useState('');
  const [employer, setEmployer] = useState('all');
  const [sort, setSort] = useState<'newest' | 'employer' | 'title'>('newest');
  const [showArchive, setShowArchive] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Relative times and local-time strings must not be rendered during SSR, or the
  // server and client markup disagree (React hydration error #418).
  useEffect(() => setMounted(true), []);
  const rel = (iso: string | null) => (mounted ? timeAgo(iso) : fmtUTC(iso));

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const res = await fetch('/api/jobs', { cache: 'no-store' });
      const json = (await res.json()) as ApiPayload;
      setData(json);
    } catch {
      /* keep previous data on transient failure */
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    timer.current = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  const setStatus = useCallback(
    async (id: string, status: Status) => {
      setBusy((b) => ({ ...b, [id]: true }));
      // optimistic
      setData((prev) => {
        const all = [...prev.active, ...prev.archive];
        const target = all.find((j) => j.id === id);
        if (!target) return prev;
        const moved: Job = {
          ...target,
          status,
          statusChangedAt: status === 'new' ? null : new Date().toISOString(),
        };
        const rest = all.filter((j) => j.id !== id);
        const active = status === 'new' ? [moved, ...rest.filter((j) => j.status === 'new')] : rest.filter((j) => j.status === 'new');
        const archive =
          status === 'new' ? rest.filter((j) => j.status !== 'new') : [moved, ...rest.filter((j) => j.status !== 'new')];
        return { ...prev, active, archive };
      });
      try {
        await fetch(`/api/jobs/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      } catch {
        /* fall through to reconcile */
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
        void refresh();
      }
    },
    [refresh],
  );

  const employers = useMemo(() => {
    const s = new Set<string>();
    for (const j of [...data.active, ...data.archive]) s.add(j.employer);
    return [...s].sort();
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = data.active.filter((j) => {
      if (employer !== 'all' && j.employer !== employer) return false;
      if (!q) return true;
      return (
        j.title.toLowerCase().includes(q) ||
        j.employer.toLowerCase().includes(q) ||
        (j.location ?? '').toLowerCase().includes(q)
      );
    });
    rows = [...rows].sort((a, b) => {
      if (sort === 'employer') return a.employer.localeCompare(b.employer) || a.title.localeCompare(b.title);
      if (sort === 'title') return a.title.localeCompare(b.title);
      return new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime();
    });
    return rows;
  }, [data.active, employer, query, sort]);

  const counts = {
    active: data.active.length,
    applied: data.archive.filter((j) => j.status === 'applied').length,
    ignored: data.archive.filter((j) => j.status === 'ignored').length,
  };

  return (
    <main className="wrap">
      <header className="header">
        <h1>Job Board</h1>
        <div className="sub">
          Population health roles · Downingtown / Wilmington and York corridors
          <br />
          Last checked by the Pi{' '}
          <strong>{rel(data.meta.lastIngest)}</strong>
          {data.meta.lastIngest && !mounted ? '' : ''}
        </div>
        {!data.meta.db && (
          <div className="banner err">
            No database connected yet. Add <code>POSTGRES_URL</code> in Vercel → Settings →
            Environment Variables, then redeploy.
          </div>
        )}
        {data.error && <div className="banner err">Database error: {data.error}</div>}
      </header>

      <section className="stats">
        <div className="stat new">
          <div className="n">{counts.active}</div>
          <div className="l">To review</div>
        </div>
        <div className="stat applied">
          <div className="n">{counts.applied}</div>
          <div className="l">Applied</div>
        </div>
        <div className="stat ignored">
          <div className="n">{counts.ignored}</div>
          <div className="l">Not applicable</div>
        </div>
      </section>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title, employer, or city…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search jobs"
        />
        <select value={employer} onChange={(e) => setEmployer(e.target.value)} aria-label="Filter by employer">
          <option value="all">All employers</option>
          {employers.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort by">
          <option value="newest">Newest first</option>
          <option value="employer">By employer</option>
          <option value="title">By title</option>
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => void refresh(true)} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <strong>{data.active.length === 0 ? 'No jobs waiting for review' : 'Nothing matches that filter'}</strong>
          {data.active.length === 0
            ? 'The Pi posts new matches after its 8:00 AM run. Anything you applied to or dismissed lives in the archive below.'
            : 'Try clearing the search box or switching the employer filter.'}
        </div>
      ) : (
        <div className="list">
          {filtered.map((job) => (
            <article className="card" key={job.id}>
              <div className="body">
                <h3 className="title">
                  {job.url ? (
                    <a href={job.url} target="_blank" rel="noopener noreferrer">
                      {job.title}
                    </a>
                  ) : (
                    job.title
                  )}
                </h3>
                <div className="meta">
                  <span className="pill employer">{job.employer}</span>
                  {job.location && <span>{job.location}</span>}
                  <span>· found {rel(job.firstSeen)}</span>
                  {mounted && isStale(job) && (
                    <span className="pill stale" title="Not returned by the last few scans">
                      may be closed
                    </span>
                  )}
                </div>
              </div>
              <div className="actions">
                <div className="row">
                  <a
                    className="btn primary"
                    href={job.url || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ textAlign: 'center', textDecoration: 'none' }}
                  >
                    Apply ↗
                  </a>
                </div>
                <div className="row">
                  <button
                    className="btn green"
                    disabled={!!busy[job.id]}
                    onClick={() => void setStatus(job.id, 'applied')}
                  >
                    Applied
                  </button>
                  <button
                    className="btn ghost"
                    disabled={!!busy[job.id]}
                    onClick={() => void setStatus(job.id, 'ignored')}
                  >
                    Not for me
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {data.archive.length > 0 && (
        <>
          <div className="archive-head">
            <h2>Archive</h2>
            <span className="count">
              {data.archive.length} job{data.archive.length === 1 ? '' : 's'}
            </span>
            <button className="btn ghost" onClick={() => setShowArchive((v) => !v)}>
              {showArchive ? 'Hide' : 'Show'}
            </button>
          </div>
          {showArchive && (
            <div className="list">
              {data.archive.map((job) => (
                <article className="card" key={job.id}>
                  <div className="body">
                    <h3 className="title">
                      {job.url ? (
                        <a href={job.url} target="_blank" rel="noopener noreferrer">
                          {job.title}
                        </a>
                      ) : (
                        job.title
                      )}
                    </h3>
                    <div className="meta">
                      <span className="pill employer">{job.employer}</span>
                      <span className={`pill ${job.status}`}>
                        {job.status === 'applied' ? 'Applied' : 'Not applicable'}
                      </span>
                      {job.location && <span>{job.location}</span>}
                      {job.statusChangedAt && <span>· {rel(job.statusChangedAt)}</span>}
                    </div>
                  </div>
                  <div className="actions">
                    <div className="row">
                      <button
                        className="btn"
                        disabled={!!busy[job.id]}
                        onClick={() => void setStatus(job.id, 'new')}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      <div className="foot">
        Built from the <code>job_watch.py</code> run on <code>vez</code>. Matches are filtered to
        population-health / care-coordination / community-health roles in the two corridors, and
        screened for licensure requirements. Your Applied / Not-for-me marks persist in Postgres —
        nothing is deleted, it just moves to the archive.
      </div>
    </main>
  );
}
