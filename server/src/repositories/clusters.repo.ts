import { getDb, row, rows } from "../db/index.js";
import { nullable } from "../db/sql.js";
import { clusterId as newClusterId, decisionId } from "../lib/ids.js";
import type { Cluster, ClusterDecision, ClusterStatus, DecisionActor } from "../domain/types.js";

interface ClusterRow {
  id: string;
  title: string;
  canonical_need: string;
  theme_id: string | null;
  status: ClusterStatus;
  owning_team: string | null;
  created_at: string;
  updated_at: string;
}

const toDomain = (r: ClusterRow): Cluster => ({
  id: r.id,
  title: r.title,
  canonicalNeed: r.canonical_need,
  themeId: r.theme_id,
  status: r.status,
  owningTeam: r.owning_team,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const touch = (id: string) =>
  getDb()
    .prepare(
      `UPDATE clusters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .run(id);

export function create(input: {
  title: string;
  canonicalNeed?: string;
  themeId?: string | null;
  owningTeam?: string | null;
}): Cluster {
  const id = newClusterId();
  getDb()
    .prepare(
      `INSERT INTO clusters (id, title, canonical_need, theme_id, owning_team)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.canonicalNeed ?? "",
      nullable(input.themeId),
      nullable(input.owningTeam),
    );
  return findById(id)!;
}

export function findById(id: string): Cluster | null {
  const r = row<ClusterRow>(getDb().prepare("SELECT * FROM clusters WHERE id = ?").get(id));
  return r ? toDomain(r) : null;
}

export function listAll(): Cluster[] {
  return rows<ClusterRow>(
    getDb().prepare("SELECT * FROM clusters ORDER BY updated_at DESC").all(),
  ).map(toDomain);
}

export function update(
  id: string,
  patch: Partial<Pick<Cluster, "title" | "canonicalNeed" | "themeId" | "status" | "owningTeam">>,
): Cluster | null {
  const sets: string[] = [];
  const params: Array<string | null> = [];
  const column = {
    title: "title",
    canonicalNeed: "canonical_need",
    themeId: "theme_id",
    status: "status",
    owningTeam: "owning_team",
  } as const;

  for (const [key, col] of Object.entries(column)) {
    const value = patch[key as keyof typeof column];
    if (value === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(value as string | null);
  }
  if (sets.length === 0) return findById(id);

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  getDb()
    .prepare(`UPDATE clusters SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, id);
  return findById(id);
}

export function memberCount(id: string): number {
  return (
    row<{ n: number }>(
      getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE cluster_id = ?").get(id),
    ) ?? { n: 0 }
  ).n;
}

/** Deletes clusters that no request points at any more (after a human split). */
export function deleteIfEmpty(id: string): boolean {
  if (memberCount(id) > 0) return false;
  getDb().prepare("DELETE FROM clusters WHERE id = ?").run(id);
  return true;
}

// --- membership audit ------------------------------------------------------

interface DecisionRow {
  id: string;
  cluster_id: string;
  request_id: string;
  decided_by: DecisionActor;
  confidence: number;
  rationale: string;
  overridden_from_cluster_id: string | null;
  created_at: string;
}

export function recordDecision(input: {
  clusterId: string;
  requestId: string;
  decidedBy: DecisionActor;
  confidence: number;
  rationale: string;
  overriddenFromClusterId?: string | null;
}): ClusterDecision {
  const id = decisionId();
  getDb()
    .prepare(
      `INSERT INTO cluster_decisions
         (id, cluster_id, request_id, decided_by, confidence, rationale, overridden_from_cluster_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.clusterId,
      input.requestId,
      input.decidedBy,
      input.confidence,
      input.rationale,
      nullable(input.overriddenFromClusterId),
    );
  touch(input.clusterId);

  const r = row<DecisionRow>(
    getDb().prepare("SELECT * FROM cluster_decisions WHERE id = ?").get(id),
  )!;
  return {
    id: r.id,
    clusterId: r.cluster_id,
    requestId: r.request_id,
    decidedBy: r.decided_by,
    confidence: r.confidence,
    rationale: r.rationale,
    overriddenFromClusterId: r.overridden_from_cluster_id,
    createdAt: r.created_at,
  };
}

/** Latest membership decision per request in the cluster. */
export function decisionsForCluster(clusterId: string): ClusterDecision[] {
  return rows<DecisionRow>(
    getDb()
      .prepare(
        `SELECT d.* FROM cluster_decisions d
          WHERE d.cluster_id = ?
            AND d.created_at = (
              SELECT MAX(created_at) FROM cluster_decisions
               WHERE cluster_id = d.cluster_id AND request_id = d.request_id
            )
          ORDER BY d.created_at ASC`,
      )
      .all(clusterId),
  ).map((r) => ({
    id: r.id,
    clusterId: r.cluster_id,
    requestId: r.request_id,
    decidedBy: r.decided_by,
    confidence: r.confidence,
    rationale: r.rationale,
    overriddenFromClusterId: r.overridden_from_cluster_id,
    createdAt: r.created_at,
  }));
}
