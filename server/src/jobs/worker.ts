import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import * as jobsRepo from "../repositories/jobs.repo.js";
import * as clustersRepo from "../repositories/clusters.repo.js";
import { JOB_TYPES } from "./types.js";
import { analyzeRequest, scoreCluster, generateBrief } from "../services/intelligence/pipeline.js";

/**
 * Background worker for AI pipeline jobs.
 *
 * AI analysis takes seconds to tens of seconds. Doing it inside the POST that
 * creates a request would make submission feel broken and would couple the
 * submitter's experience to Anthropic's latency and rate limits. Instead the
 * request is persisted immediately, a job is enqueued, and this worker drains
 * the queue with bounded concurrency.
 *
 * In-process is the right size for this system. The queue itself lives in
 * SQLite and jobs are claimed atomically, so moving to a separate worker
 * process later is a deployment change, not a rewrite.
 */

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`job payload missing required string '${key}'`);
  }
  return value;
}

const handlers: Record<string, Handler> = {
  [JOB_TYPES.ANALYZE_REQUEST]: (payload) => analyzeRequest(requireString(payload, "requestId")),

  [JOB_TYPES.SCORE_CLUSTER]: (payload) => scoreCluster(requireString(payload, "clusterId")),

  [JOB_TYPES.GENERATE_BRIEF]: (payload) => generateBrief(requireString(payload, "clusterId")),

  // Re-weighting the board changes every score but costs nothing to compute;
  // fanning out one job per cluster keeps each unit small and retryable.
  [JOB_TYPES.RESCORE_ALL]: async () => {
    const clusters = clustersRepo.listAll();
    for (const cluster of clusters) {
      jobsRepo.enqueue({
        type: JOB_TYPES.SCORE_CLUSTER,
        payload: { clusterId: cluster.id },
        dedupeKey: `score:${cluster.id}`,
      });
    }
    return { enqueued: clusters.length };
  },
};

async function execute(job: jobsRepo.Job): Promise<void> {
  const startedAt = Date.now();
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);

    const result = await handler(job.payload);
    jobsRepo.markSucceeded(job.id);
    logger.info({ jobId: job.id, type: job.type, ms: Date.now() - startedAt, result }, "job succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobsRepo.markFailed(job, message);
    logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, "job failed");
  }
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let inFlight = 0;

function tick(): void {
  while (running && inFlight < env.AI_WORKER_CONCURRENCY) {
    const job = jobsRepo.claimNext();
    if (!job) break;

    inFlight++;
    void execute(job).finally(() => {
      inFlight--;
    });
  }
}

export function startWorker(): void {
  if (running) return;
  running = true;

  const recovered = jobsRepo.recoverStuck();
  if (recovered > 0) logger.warn({ recovered }, "requeued jobs left running by a previous process");

  timer = setInterval(tick, env.AI_WORKER_POLL_MS);
  // Do not hold the event loop open on this timer alone.
  timer.unref?.();
  logger.info({ concurrency: env.AI_WORKER_CONCURRENCY }, "AI worker started");
}

export function stopWorker(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Drains the queue to completion, one job at a time. Used by tests and the seed
 * script, where waiting on a poll interval would be pointless latency.
 *
 * Jobs may enqueue follow-up jobs (analyse -> score), so this keeps going until
 * nothing is claimable rather than stopping at the initial queue depth.
 */
export async function drainQueue(maxJobs = 500): Promise<number> {
  let processed = 0;
  while (processed < maxJobs) {
    const job = jobsRepo.claimNext();
    if (!job) break;
    await execute(job);
    processed++;
  }
  return processed;
}
