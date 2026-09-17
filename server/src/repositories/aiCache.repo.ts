import { getDb, row, rows } from "../db/index.js";
import { nullable, parseJson } from "../db/sql.js";
import { callId } from "../lib/ids.js";

export interface CachedOutput<T> {
  output: T;
  model: string;
  createdAt: string;
}

export function get<T>(cacheKey: string): CachedOutput<T> | null {
  const r = row<{ output: string; model: string; created_at: string }>(
    getDb().prepare("SELECT output, model, created_at FROM ai_cache WHERE cache_key = ?").get(
      cacheKey,
    ),
  );
  if (!r) return null;
  const parsed = parseJson<T | null>(r.output, null);
  if (parsed === null) return null;
  return { output: parsed, model: r.model, createdAt: r.created_at };
}

export function put(input: {
  cacheKey: string;
  stage: string;
  model: string;
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO ai_cache (cache_key, stage, model, output, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         output = excluded.output,
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens`,
    )
    .run(
      input.cacheKey,
      input.stage,
      input.model,
      JSON.stringify(input.output),
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
    );
}

// --- call telemetry --------------------------------------------------------

export function logCall(input: {
  stage: string;
  model: string;
  cacheHit: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  latencyMs: number;
  ok: boolean;
  error?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO ai_call_log
         (id, stage, model, cache_hit, input_tokens, output_tokens, cache_read_tokens,
          latency_ms, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      callId(),
      input.stage,
      input.model,
      input.cacheHit ? 1 : 0,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.cacheReadTokens ?? 0,
      Math.round(input.latencyMs),
      input.ok ? 1 : 0,
      nullable(input.error),
    );
}

export interface UsageByStage {
  stage: string;
  calls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  failures: number;
}

export function usageByStage(sinceIso?: string): UsageByStage[] {
  const since = sinceIso ?? "1970-01-01T00:00:00.000Z";
  return rows<{
    stage: string;
    calls: number;
    cache_hits: number;
    input_tokens: number;
    output_tokens: number;
    avg_latency: number;
    failures: number;
  }>(
    getDb()
      .prepare(
        `SELECT stage,
                COUNT(*)                     AS calls,
                SUM(cache_hit)               AS cache_hits,
                SUM(input_tokens)            AS input_tokens,
                SUM(output_tokens)           AS output_tokens,
                AVG(latency_ms)              AS avg_latency,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
           FROM ai_call_log
          WHERE created_at >= ?
          GROUP BY stage
          ORDER BY calls DESC`,
      )
      .all(since),
  ).map((r) => ({
    stage: r.stage,
    calls: r.calls,
    cacheHits: r.cache_hits ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    avgLatencyMs: Math.round(r.avg_latency ?? 0),
    failures: r.failures ?? 0,
  }));
}
