import { getDb, row, rows } from "../db/index.js";
import { newId } from "../lib/ids.js";

export interface MergeSuggestion {
  id: string;
  requestId: string;
  targetClusterId: string;
  verdict: "duplicate" | "related";
  confidence: number;
  rationale: string;
  status: "pending" | "accepted" | "rejected";
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface SuggestionRow {
  id: string;
  request_id: string;
  target_cluster_id: string;
  verdict: "duplicate" | "related";
  confidence: number;
  rationale: string;
  status: "pending" | "accepted" | "rejected";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const toDomain = (r: SuggestionRow): MergeSuggestion => ({
  id: r.id,
  requestId: r.request_id,
  targetClusterId: r.target_cluster_id,
  verdict: r.verdict,
  confidence: r.confidence,
  rationale: r.rationale,
  status: r.status,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
});

export function create(input: {
  requestId: string;
  targetClusterId: string;
  verdict: "duplicate" | "related";
  confidence: number;
  rationale: string;
}): MergeSuggestion {
  const id = newId("mrg");
  getDb()
    .prepare(
      `INSERT INTO merge_suggestions
         (id, request_id, target_cluster_id, verdict, confidence, rationale)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id, target_cluster_id) DO UPDATE SET
         verdict    = excluded.verdict,
         confidence = excluded.confidence,
         rationale  = excluded.rationale`,
    )
    .run(
      id,
      input.requestId,
      input.targetClusterId,
      input.verdict,
      input.confidence,
      input.rationale,
    );

  return toDomain(
    row<SuggestionRow>(
      getDb()
        .prepare("SELECT * FROM merge_suggestions WHERE request_id = ? AND target_cluster_id = ?")
        .get(input.requestId, input.targetClusterId),
    )!,
  );
}

export function findById(id: string): MergeSuggestion | null {
  const r = row<SuggestionRow>(
    getDb().prepare("SELECT * FROM merge_suggestions WHERE id = ?").get(id),
  );
  return r ? toDomain(r) : null;
}

export interface SuggestionWithContext extends MergeSuggestion {
  requestTitle: string;
  targetClusterTitle: string;
}

export function listPending(limit = 50): SuggestionWithContext[] {
  return rows<SuggestionRow & { request_title: string; cluster_title: string }>(
    getDb()
      .prepare(
        `SELECT m.*, r.title AS request_title, c.title AS cluster_title
           FROM merge_suggestions m
           JOIN requests r ON r.id = m.request_id
           JOIN clusters c ON c.id = m.target_cluster_id
          WHERE m.status = 'pending'
          ORDER BY m.confidence DESC, m.created_at DESC
          LIMIT ?`,
      )
      .all(limit),
  ).map((r) => ({
    ...toDomain(r),
    requestTitle: r.request_title,
    targetClusterTitle: r.cluster_title,
  }));
}

export function resolve(
  id: string,
  status: "accepted" | "rejected",
  resolvedBy: string,
): MergeSuggestion | null {
  getDb()
    .prepare(
      `UPDATE merge_suggestions
          SET status = ?, resolved_by = ?,
              resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'pending'`,
    )
    .run(status, resolvedBy, id);
  return findById(id);
}

export function pendingCount(): number {
  return (
    row<{ n: number }>(
      getDb().prepare("SELECT COUNT(*) AS n FROM merge_suggestions WHERE status = 'pending'").get(),
    ) ?? { n: 0 }
  ).n;
}
