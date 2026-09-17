import { getDb, row, rows } from "../db/index.js";
import { parseJson } from "../db/sql.js";
import { briefId, updateId } from "../lib/ids.js";
import type { DecisionBrief, StakeholderUpdate } from "../domain/types.js";

interface BriefRow {
  id: string;
  cluster_id: string;
  problem: string;
  evidence: string;
  affected_segments: string;
  recommended_priority: string;
  suggested_next_step: string;
  risks_if_ignored: string;
  open_questions: string;
  status: "draft" | "approved";
  approved_by: string | null;
  model: string;
  created_at: string;
}

const briefToDomain = (r: BriefRow): DecisionBrief => ({
  id: r.id,
  clusterId: r.cluster_id,
  problem: r.problem,
  evidence: parseJson<string[]>(r.evidence, []),
  affectedSegments: parseJson<string[]>(r.affected_segments, []),
  recommendedPriority: r.recommended_priority,
  suggestedNextStep: r.suggested_next_step,
  risksIfIgnored: r.risks_if_ignored,
  openQuestions: parseJson<string[]>(r.open_questions, []),
  status: r.status,
  approvedBy: r.approved_by,
  model: r.model,
  createdAt: r.created_at,
});

export function insertBrief(
  input: Omit<DecisionBrief, "id" | "createdAt" | "status" | "approvedBy">,
): DecisionBrief {
  const id = briefId();
  getDb()
    .prepare(
      `INSERT INTO decision_briefs (
         id, cluster_id, problem, evidence, affected_segments, recommended_priority,
         suggested_next_step, risks_if_ignored, open_questions, model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.clusterId,
      input.problem,
      JSON.stringify(input.evidence),
      JSON.stringify(input.affectedSegments),
      input.recommendedPriority,
      input.suggestedNextStep,
      input.risksIfIgnored,
      JSON.stringify(input.openQuestions),
      input.model,
    );
  return findBrief(id)!;
}

export function findBrief(id: string): DecisionBrief | null {
  const r = row<BriefRow>(getDb().prepare("SELECT * FROM decision_briefs WHERE id = ?").get(id));
  return r ? briefToDomain(r) : null;
}

export function latestBrief(clusterId: string): DecisionBrief | null {
  const r = row<BriefRow>(
    getDb()
      .prepare(
        "SELECT * FROM decision_briefs WHERE cluster_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(clusterId),
  );
  return r ? briefToDomain(r) : null;
}

/**
 * Editing a brief writes a new row rather than mutating the old one, so the
 * record of "what the AI proposed" survives the human rewrite.
 */
export function reviseBrief(
  source: DecisionBrief,
  patch: Partial<Omit<DecisionBrief, "id" | "clusterId" | "createdAt">>,
  approvedBy: string | null,
): DecisionBrief {
  const id = briefId();
  const merged = { ...source, ...patch };
  getDb()
    .prepare(
      `INSERT INTO decision_briefs (
         id, cluster_id, problem, evidence, affected_segments, recommended_priority,
         suggested_next_step, risks_if_ignored, open_questions, status, approved_by, model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      source.clusterId,
      merged.problem,
      JSON.stringify(merged.evidence),
      JSON.stringify(merged.affectedSegments),
      merged.recommendedPriority,
      merged.suggestedNextStep,
      merged.risksIfIgnored,
      JSON.stringify(merged.openQuestions),
      approvedBy ? "approved" : "draft",
      approvedBy,
      merged.model,
    );
  return findBrief(id)!;
}

// --- stakeholder updates ---------------------------------------------------

interface UpdateRow {
  id: string;
  cluster_id: string;
  audience: string;
  subject: string;
  body: string;
  status: "draft" | "sent";
  model: string;
  created_at: string;
}

const updateToDomain = (r: UpdateRow): StakeholderUpdate => ({
  id: r.id,
  clusterId: r.cluster_id,
  audience: r.audience,
  subject: r.subject,
  body: r.body,
  status: r.status,
  model: r.model,
  createdAt: r.created_at,
});

export function insertUpdate(
  input: Omit<StakeholderUpdate, "id" | "createdAt" | "status">,
): StakeholderUpdate {
  const id = updateId();
  getDb()
    .prepare(
      `INSERT INTO stakeholder_updates (id, cluster_id, audience, subject, body, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.clusterId, input.audience, input.subject, input.body, input.model);
  return findUpdate(id)!;
}

export function findUpdate(id: string): StakeholderUpdate | null {
  const r = row<UpdateRow>(
    getDb().prepare("SELECT * FROM stakeholder_updates WHERE id = ?").get(id),
  );
  return r ? updateToDomain(r) : null;
}

export function listUpdates(clusterId: string): StakeholderUpdate[] {
  return rows<UpdateRow>(
    getDb()
      .prepare("SELECT * FROM stakeholder_updates WHERE cluster_id = ? ORDER BY created_at DESC")
      .all(clusterId),
  ).map(updateToDomain);
}

export function markUpdateSent(id: string): StakeholderUpdate | null {
  getDb().prepare("UPDATE stakeholder_updates SET status = 'sent' WHERE id = ?").run(id);
  return findUpdate(id);
}
