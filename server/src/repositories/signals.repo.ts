import { getDb, row, rows } from "../db/index.js";
import { nullable } from "../db/sql.js";
import { signalId } from "../lib/ids.js";
import type { CustomerTier, SubmitterType, SupportSignal } from "../domain/types.js";

interface SignalRow {
  id: string;
  cluster_id: string;
  request_id: string;
  submitter_id: string;
  impact_text: string;
  current_workaround: string | null;
  created_at: string;
}

const toDomain = (r: SignalRow): SupportSignal => ({
  id: r.id,
  clusterId: r.cluster_id,
  requestId: r.request_id,
  submitterId: r.submitter_id,
  impactText: r.impact_text,
  currentWorkaround: r.current_workaround,
  createdAt: r.created_at,
});

/**
 * Idempotent per (cluster, submitter): supporting the same need twice updates
 * the description rather than inflating reach. That is what makes this a
 * "signal" and not a vote.
 */
export function upsert(input: {
  clusterId: string;
  requestId: string;
  submitterId: string;
  impactText: string;
  currentWorkaround?: string | null;
}): SupportSignal {
  const id = signalId();
  getDb()
    .prepare(
      `INSERT INTO support_signals
         (id, cluster_id, request_id, submitter_id, impact_text, current_workaround)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cluster_id, submitter_id) DO UPDATE SET
         impact_text        = excluded.impact_text,
         current_workaround = excluded.current_workaround,
         request_id         = excluded.request_id`,
    )
    .run(
      id,
      input.clusterId,
      input.requestId,
      input.submitterId,
      input.impactText,
      nullable(input.currentWorkaround),
    );

  return toDomain(
    row<SignalRow>(
      getDb()
        .prepare("SELECT * FROM support_signals WHERE cluster_id = ? AND submitter_id = ?")
        .get(input.clusterId, input.submitterId),
    )!,
  );
}

export interface SignalWithSubmitter extends SupportSignal {
  submitterName: string;
  submitterType: SubmitterType;
  submitterTier: CustomerTier | null;
  accountName: string | null;
  arrUsd: number | null;
}

export function listForCluster(clusterId: string): SignalWithSubmitter[] {
  return rows<
    SignalRow & {
      submitter_name: string;
      submitter_type: SubmitterType;
      submitter_tier: CustomerTier | null;
      account_name: string | null;
      arr_usd: number | null;
    }
  >(
    getDb()
      .prepare(
        `SELECT g.*, s.name AS submitter_name, s.type AS submitter_type,
                s.tier AS submitter_tier, s.account_name, s.arr_usd
           FROM support_signals g
           JOIN submitters s ON s.id = g.submitter_id
          WHERE g.cluster_id = ?
          ORDER BY g.created_at DESC`,
      )
      .all(clusterId),
  ).map((r) => ({
    ...toDomain(r),
    submitterName: r.submitter_name,
    submitterType: r.submitter_type,
    submitterTier: r.submitter_tier,
    accountName: r.account_name,
    arrUsd: r.arr_usd,
  }));
}

export function countsByCluster(): Map<string, number> {
  const result = rows<{ cluster_id: string; n: number }>(
    getDb()
      .prepare("SELECT cluster_id, COUNT(*) AS n FROM support_signals GROUP BY cluster_id")
      .all(),
  );
  return new Map(result.map((r) => [r.cluster_id, r.n]));
}
