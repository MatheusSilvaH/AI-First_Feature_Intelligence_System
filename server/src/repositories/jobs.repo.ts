import { getDb, row, rows, transaction } from "../db/index.js";
import { nullable, parseJson } from "../db/sql.js";
import { jobId } from "../lib/ids.js";
import { env } from "../config/env.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

const toDomain = (r: JobRow): Job => ({
  id: r.id,
  type: r.type,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAfter: r.run_after,
  lastError: r.last_error,
  dedupeKey: r.dedupe_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Enqueues work. When `dedupeKey` collides with an existing pending/running job
 * the enqueue is a no-op - a partial unique index enforces this, so it holds
 * even with several workers racing.
 */
export function enqueue(input: {
  type: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  runAfter?: string;
  maxAttempts?: number;
}): Job | null {
  const id = jobId();
  const result = getDb()
    .prepare(
      `INSERT INTO jobs (id, type, payload, dedupe_key, run_after, max_attempts)
       VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?)
       ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
         DO NOTHING`,
    )
    .run(
      id,
      input.type,
      JSON.stringify(input.payload ?? {}),
      nullable(input.dedupeKey),
      nullable(input.runAfter),
      input.maxAttempts ?? env.AI_JOB_MAX_ATTEMPTS,
    );

  if (result.changes === 0) return null;
  return findById(id);
}

export function findById(id: string): Job | null {
  const r = row<JobRow>(getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id));
  return r ? toDomain(r) : null;
}

/**
 * Atomically claims the next due job. The SELECT and UPDATE share a transaction
 * so two workers cannot claim the same row.
 */
export function claimNext(): Job | null {
  return transaction((conn) => {
    const candidate = row<JobRow>(
      conn
        .prepare(
          `SELECT * FROM jobs
            WHERE status = 'pending'
              AND run_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
            ORDER BY run_after ASC
            LIMIT 1`,
        )
        .get(),
    );
    if (!candidate) return null;

    conn
      .prepare(
        `UPDATE jobs
            SET status = 'running',
                attempts = attempts + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'pending'`,
      )
      .run(candidate.id);

    return toDomain({ ...candidate, status: "running", attempts: candidate.attempts + 1 });
  });
}

export function markSucceeded(id: string): void {
  getDb()
    .prepare(
      `UPDATE jobs SET status = 'succeeded', last_error = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(id);
}

/**
 * Retries with exponential backoff until `max_attempts`, then parks the job as
 * `dead` so it stops consuming worker cycles but stays visible for triage.
 */
export function markFailed(job: Job, error: string): void {
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffSeconds = Math.min(300, 2 ** job.attempts * 5);
  const runAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  getDb()
    .prepare(
      `UPDATE jobs
          SET status = ?, last_error = ?, run_after = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(exhausted ? "dead" : "pending", error.slice(0, 2000), runAfter, job.id);
}

/** Requeues jobs left `running` by a crashed process. Called once at boot. */
export function recoverStuck(): number {
  const result = getDb()
    .prepare(
      `UPDATE jobs SET status = 'pending',
              last_error = COALESCE(last_error, 'recovered after restart'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE status = 'running'`,
    )
    .run();
  return Number(result.changes);
}

export function stats(): Record<JobStatus, number> {
  const base: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
  };
  for (const r of rows<{ status: JobStatus; n: number }>(
    getDb().prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all(),
  )) {
    base[r.status] = r.n;
  }
  return base;
}

export function pendingCount(): number {
  return (
    row<{ n: number }>(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')")
        .get(),
    ) ?? { n: 0 }
  ).n;
}
