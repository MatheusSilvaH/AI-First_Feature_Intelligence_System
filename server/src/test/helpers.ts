import { getDb } from "../db/index.js";

/**
 * Tests share one in-memory database for the whole process (see
 * vitest.config.ts). Clearing rows between tests is faster than rebuilding the
 * schema and keeps each test's setup explicit.
 */
const TABLES = [
  "ai_call_log",
  "ai_cache",
  "idempotency_keys",
  "events",
  "insights",
  "jobs",
  "stakeholder_updates",
  "decision_briefs",
  "priority_scores",
  "support_signals",
  "merge_suggestions",
  "cluster_decisions",
  "request_analysis",
  "requests_fts",
  "requests",
  "clusters",
  "themes",
  "submitters",
  "settings",
];

export function resetDb(): void {
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  for (const table of TABLES) db.exec(`DELETE FROM ${table}`);
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * Number of times a stage actually reached the AI layer. Every call is logged
 * to `ai_call_log`, including cache hits - the carried-forward rationale path
 * does not call `structuredCall` at all, so it logs nothing.
 */
export function aiCallCount(stage = "explain_score"): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE stage = ?")
    .get(stage) as { n: number };
  return r.n;
}

export const customer = (overrides: Record<string, unknown> = {}) => ({
  name: "Test Customer",
  email: `c${Math.random().toString(36).slice(2, 10)}@acme.example`,
  type: "customer" as const,
  tier: "enterprise" as const,
  accountName: "Acme Corp",
  arrUsd: 200_000,
  ...overrides,
});
