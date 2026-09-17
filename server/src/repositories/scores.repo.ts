import { getDb, row, rows } from "../db/index.js";
import { parseJson } from "../db/sql.js";
import { scoreId } from "../lib/ids.js";
import type { PriorityScore } from "../domain/types.js";

interface ScoreRow {
  id: string;
  cluster_id: string;
  total: number;
  c_submitter_weight: number;
  c_reach: number;
  c_severity: number;
  c_strategic: number;
  c_urgency: number;
  rationale: string;
  evidence: string;
  weights_version: string;
  inputs_fingerprint: string;
  evidence_fingerprint: string;
  rationale_stale: number;
  model: string;
  created_at: string;
}

const toDomain = (r: ScoreRow): PriorityScore => ({
  id: r.id,
  clusterId: r.cluster_id,
  total: r.total,
  components: {
    submitterWeight: r.c_submitter_weight,
    reach: r.c_reach,
    severity: r.c_severity,
    strategicAlignment: r.c_strategic,
    urgency: r.c_urgency,
  },
  rationale: r.rationale,
  evidence: parseJson<string[]>(r.evidence, []),
  weightsVersion: r.weights_version,
  inputsFingerprint: r.inputs_fingerprint,
  evidenceFingerprint: r.evidence_fingerprint,
  rationaleStale: r.rationale_stale === 1,
  model: r.model,
  createdAt: r.created_at,
});

export function insert(input: Omit<PriorityScore, "id" | "createdAt">): PriorityScore {
  const id = scoreId();
  getDb()
    .prepare(
      `INSERT INTO priority_scores (
         id, cluster_id, total, c_submitter_weight, c_reach, c_severity,
         c_strategic, c_urgency, rationale, evidence, weights_version,
         inputs_fingerprint, evidence_fingerprint, rationale_stale, model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.clusterId,
      input.total,
      input.components.submitterWeight,
      input.components.reach,
      input.components.severity,
      input.components.strategicAlignment,
      input.components.urgency,
      input.rationale,
      JSON.stringify(input.evidence),
      input.weightsVersion,
      input.inputsFingerprint,
      input.evidenceFingerprint,
      input.rationaleStale ? 1 : 0,
      input.model,
    );
  return toDomain(
    row<ScoreRow>(getDb().prepare("SELECT * FROM priority_scores WHERE id = ?").get(id))!,
  );
}

/**
 * Timestamps have millisecond precision, and a rescore can follow the score it
 * replaces inside the same millisecond. `rowid` breaks the tie by insertion
 * order, so "latest" is never ambiguous.
 */
export function latestForCluster(clusterId: string): PriorityScore | null {
  const r = row<ScoreRow>(
    getDb()
      .prepare(
        `SELECT * FROM priority_scores WHERE cluster_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(clusterId),
  );
  return r ? toDomain(r) : null;
}

export function historyForCluster(clusterId: string, limit = 20): PriorityScore[] {
  return rows<ScoreRow>(
    getDb()
      .prepare(
        `SELECT * FROM priority_scores WHERE cluster_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(clusterId, limit),
  ).map(toDomain);
}

/**
 * Latest score per cluster, in one query. Used by the ranked dashboard views -
 * doing this per cluster in a loop is the classic N+1 that makes the leaderboard
 * slow once the corpus grows.
 */
export function latestForAllClusters(): Map<string, PriorityScore> {
  const result = rows<ScoreRow>(
    getDb()
      .prepare(
        `SELECT * FROM (
           SELECT s.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.cluster_id ORDER BY s.created_at DESC, s.rowid DESC
                  ) AS rn
             FROM priority_scores s
         ) WHERE rn = 1`,
      )
      .all(),
  ).map(toDomain);

  return new Map(result.map((s) => [s.clusterId, s]));
}
