import { getDb, rows, row } from "../db/index.js";
import * as scoresRepo from "../repositories/scores.repo.js";
import * as aiCacheRepo from "../repositories/aiCache.repo.js";
import * as suggestionsRepo from "../repositories/mergeSuggestions.repo.js";
import * as jobsRepo from "../repositories/jobs.repo.js";
import type { ClusterStatus, SubmitterType } from "../domain/types.js";

/**
 * Read models for the stakeholder dashboard.
 *
 * These are SQL aggregates rather than per-cluster loops: the dashboard is the
 * one view that touches every cluster at once, so an N+1 here is the difference
 * between a page that loads and one that does not.
 */

export interface RankedCluster {
  clusterId: string;
  title: string;
  canonicalNeed: string;
  status: ClusterStatus;
  themeId: string | null;
  themeName: string | null;
  productArea: string | null;
  owningTeam: string | null;
  score: number;
  components: {
    submitterWeight: number;
    reach: number;
    severity: number;
    strategicAlignment: number;
    urgency: number;
  };
  rationale: string;
  requestCount: number;
  supporterCount: number;
  distinctAccounts: number;
  totalArrUsd: number;
  topSegment: string | null;
  updatedAt: string;
}

interface RankedRow {
  cluster_id: string;
  title: string;
  canonical_need: string;
  status: ClusterStatus;
  theme_id: string | null;
  theme_name: string | null;
  product_area: string | null;
  owning_team: string | null;
  total: number;
  c_submitter_weight: number;
  c_reach: number;
  c_severity: number;
  c_strategic: number;
  c_urgency: number;
  rationale: string;
  request_count: number;
  supporter_count: number;
  distinct_accounts: number;
  total_arr: number;
  top_segment: string | null;
  updated_at: string;
}

const RANKED_SQL = `
  -- rowid breaks ties: a rescore can land in the same millisecond as the score
  -- it replaces, and MAX(created_at) alone would pick either one.
  WITH latest_scores AS (
    SELECT * FROM (
      SELECT s.*,
             ROW_NUMBER() OVER (
               PARTITION BY s.cluster_id ORDER BY s.created_at DESC, s.rowid DESC
             ) AS rn
        FROM priority_scores s
    ) WHERE rn = 1
  ),
  -- ARR is per account. Collapsing to distinct accounts first stops two people
  -- from the same company counting their company's revenue twice.
  cluster_accounts AS (
    SELECT cluster_id, account_name, MAX(arr_usd) AS arr_usd
      FROM (
        SELECT r.cluster_id, sub.account_name, sub.arr_usd
          FROM requests r JOIN submitters sub ON sub.id = r.submitter_id
         WHERE r.cluster_id IS NOT NULL AND sub.account_name IS NOT NULL
        UNION ALL
        SELECT g.cluster_id, sub.account_name, sub.arr_usd
          FROM support_signals g JOIN submitters sub ON sub.id = g.submitter_id
         WHERE sub.account_name IS NOT NULL
      )
     GROUP BY cluster_id, account_name
  )
  SELECT c.id                AS cluster_id,
         c.title,
         c.canonical_need,
         c.status,
         c.theme_id,
         t.name              AS theme_name,
         t.product_area,
         c.owning_team,
         c.updated_at,
         COALESCE(ls.total, 0)              AS total,
         COALESCE(ls.c_submitter_weight, 0) AS c_submitter_weight,
         COALESCE(ls.c_reach, 0)            AS c_reach,
         COALESCE(ls.c_severity, 0)         AS c_severity,
         COALESCE(ls.c_strategic, 0)        AS c_strategic,
         COALESCE(ls.c_urgency, 0)          AS c_urgency,
         COALESCE(ls.rationale, '')         AS rationale,
         (SELECT COUNT(*) FROM requests r WHERE r.cluster_id = c.id)       AS request_count,
         (SELECT COUNT(*) FROM support_signals g WHERE g.cluster_id = c.id) AS supporter_count,
         (SELECT COUNT(*) FROM cluster_accounts ca WHERE ca.cluster_id = c.id) AS distinct_accounts,
         (SELECT COALESCE(SUM(ca.arr_usd), 0) FROM cluster_accounts ca WHERE ca.cluster_id = c.id) AS total_arr,
         (SELECT sub.type FROM requests r
             JOIN submitters sub ON sub.id = r.submitter_id
            WHERE r.cluster_id = c.id
            GROUP BY sub.type ORDER BY COUNT(*) DESC LIMIT 1)              AS top_segment
    FROM clusters c
    LEFT JOIN themes t ON t.id = c.theme_id
    LEFT JOIN latest_scores ls ON ls.cluster_id = c.id
`;

const toRanked = (r: RankedRow): RankedCluster => ({
  clusterId: r.cluster_id,
  title: r.title,
  canonicalNeed: r.canonical_need,
  status: r.status,
  themeId: r.theme_id,
  themeName: r.theme_name,
  productArea: r.product_area,
  owningTeam: r.owning_team,
  score: r.total,
  components: {
    submitterWeight: r.c_submitter_weight,
    reach: r.c_reach,
    severity: r.c_severity,
    strategicAlignment: r.c_strategic,
    urgency: r.c_urgency,
  },
  rationale: r.rationale,
  requestCount: r.request_count,
  supporterCount: r.supporter_count,
  distinctAccounts: r.distinct_accounts,
  totalArrUsd: Math.round(r.total_arr),
  topSegment: r.top_segment,
  updatedAt: r.updated_at,
});

export interface RankedQuery {
  limit?: number;
  themeId?: string;
  status?: ClusterStatus;
}

export function topClusters(query: RankedQuery = {}): RankedCluster[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.themeId) {
    where.push("c.theme_id = ?");
    params.push(query.themeId);
  }
  if (query.status) {
    where.push("c.status = ?");
    params.push(query.status);
  }

  const sql = `${RANKED_SQL}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY total DESC, request_count DESC
    LIMIT ?`;

  return rows<RankedRow>(
    getDb()
      .prepare(sql)
      .all(...params, query.limit ?? 20),
  ).map(toRanked);
}

export interface ThemeBreakdown {
  themeId: string | null;
  themeName: string;
  productArea: string;
  clusterCount: number;
  requestCount: number;
  averageScore: number;
  topScore: number;
  topClusters: Array<{ clusterId: string; title: string; score: number }>;
}

/** Ranked features grouped by theme - the "by area" half of the dashboard. */
export function byTheme(topN = 3): ThemeBreakdown[] {
  const all = rows<RankedRow>(getDb().prepare(`${RANKED_SQL} ORDER BY total DESC`).all()).map(
    toRanked,
  );

  const grouped = new Map<string, RankedCluster[]>();
  for (const c of all) {
    const key = c.themeId ?? "__unassigned__";
    const bucket = grouped.get(key);
    if (bucket) bucket.push(c);
    else grouped.set(key, [c]);
  }

  return [...grouped.entries()]
    .map(([key, clusters]) => {
      const scores = clusters.map((c) => c.score);
      return {
        themeId: key === "__unassigned__" ? null : key,
        themeName: clusters[0]?.themeName ?? "Unassigned",
        productArea: clusters[0]?.productArea ?? "unassigned",
        clusterCount: clusters.length,
        requestCount: clusters.reduce((a, c) => a + c.requestCount, 0),
        averageScore:
          scores.length === 0
            ? 0
            : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
        topScore: scores.length === 0 ? 0 : Math.max(...scores),
        topClusters: clusters
          .slice(0, topN)
          .map((c) => ({ clusterId: c.clusterId, title: c.title, score: c.score })),
      };
    })
    .sort((a, b) => b.topScore - a.topScore);
}

export interface TrendPoint {
  period: string;
  total: number;
  bySubmitterType: Record<SubmitterType, number>;
}

/** Request volume over time, split by submitter type. */
export function volumeTrend(days = 90): TrendPoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const result = rows<{ period: string; type: SubmitterType; n: number }>(
    getDb()
      .prepare(
        `SELECT substr(r.created_at, 1, 10) AS period, s.type AS type, COUNT(*) AS n
           FROM requests r
           JOIN submitters s ON s.id = r.submitter_id
          WHERE r.created_at >= ?
          GROUP BY period, type
          ORDER BY period ASC`,
      )
      .all(since),
  );

  const byPeriod = new Map<string, TrendPoint>();
  for (const r of result) {
    let point = byPeriod.get(r.period);
    if (!point) {
      point = {
        period: r.period,
        total: 0,
        bySubmitterType: { customer: 0, prospect: 0, support: 0, internal: 0 },
      };
      byPeriod.set(r.period, point);
    }
    point.total += r.n;
    point.bySubmitterType[r.type] = r.n;
  }

  return [...byPeriod.values()];
}

export interface SubmitterMix {
  type: SubmitterType;
  requests: number;
  supporters: number;
}

export function submitterMix(): SubmitterMix[] {
  const requests = rows<{ type: SubmitterType; n: number }>(
    getDb()
      .prepare(
        `SELECT s.type, COUNT(*) AS n FROM requests r
           JOIN submitters s ON s.id = r.submitter_id GROUP BY s.type`,
      )
      .all(),
  );
  const supporters = rows<{ type: SubmitterType; n: number }>(
    getDb()
      .prepare(
        `SELECT s.type, COUNT(*) AS n FROM support_signals g
           JOIN submitters s ON s.id = g.submitter_id GROUP BY s.type`,
      )
      .all(),
  );

  const types: SubmitterType[] = ["customer", "prospect", "support", "internal"];
  return types.map((type) => ({
    type,
    requests: requests.find((r) => r.type === type)?.n ?? 0,
    supporters: supporters.find((r) => r.type === type)?.n ?? 0,
  }));
}

export interface OperationalMetrics {
  totalRequests: number;
  totalClusters: number;
  consolidationRate: number;
  duplicatesAbsorbed: number;
  analysedRequests: number;
  pendingAnalysis: number;
  pendingMergeReviews: number;
  medianTimeToPrioritisationSeconds: number | null;
  rationaleCompleteness: {
    scoredClusters: number;
    withRationale: number;
    withEvidence: number;
    withBrief: number;
    percent: number;
  };
  aiUsageByStage: ReturnType<typeof aiCacheRepo.usageByStage>;
  jobs: ReturnType<typeof jobsRepo.stats>;
}

/**
 * The success metrics from the README, computed from the audit trail rather
 * than self-reported. `medianTimeToPrioritisation` is the gap between a request
 * being submitted and its cluster carrying a score - the manual-triage latency
 * this system exists to remove.
 */
export function operationalMetrics(): OperationalMetrics {
  const db = getDb();

  const totalRequests =
    (row<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM requests").get()) ?? { n: 0 }).n;
  const totalClusters =
    (row<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM clusters").get()) ?? { n: 0 }).n;
  const analysed =
    (
      row<{ n: number }>(
        db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'analyzed'").get(),
      ) ?? { n: 0 }
    ).n;
  const pending =
    (
      row<{ n: number }>(
        db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status IN ('received','analyzing')").get(),
      ) ?? { n: 0 }
    ).n;

  // Every request beyond the first in a cluster is one a human did not have to
  // recognise as a duplicate.
  const duplicatesAbsorbed = Math.max(0, totalRequests - totalClusters);

  const latencies = rows<{ seconds: number }>(
    db
      .prepare(
        `SELECT (julianday(first_score.created_at) - julianday(r.created_at)) * 86400 AS seconds
           FROM requests r
           JOIN (
             SELECT cluster_id, MIN(created_at) AS created_at
               FROM priority_scores GROUP BY cluster_id
           ) first_score ON first_score.cluster_id = r.cluster_id
          WHERE r.cluster_id IS NOT NULL
            AND first_score.created_at >= r.created_at
          ORDER BY seconds ASC`,
      )
      .all(),
  ).map((r) => r.seconds);

  const median =
    latencies.length === 0
      ? null
      : Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0);

  return {
    totalRequests,
    totalClusters,
    consolidationRate: totalRequests === 0 ? 0 : Math.round((duplicatesAbsorbed / totalRequests) * 1000) / 10,
    duplicatesAbsorbed,
    analysedRequests: analysed,
    pendingAnalysis: pending,
    pendingMergeReviews: suggestionsRepo.pendingCount(),
    medianTimeToPrioritisationSeconds: median,
    rationaleCompleteness: rationaleCompleteness(),
    aiUsageByStage: aiCacheRepo.usageByStage(),
    jobs: jobsRepo.stats(),
  };
}

/**
 * The quality metric behind the other two.
 *
 * Consolidation rate and time-to-prioritisation can both be gamed by merging
 * more aggressively and scoring more eagerly. This one cannot: it asks what
 * share of ranked needs carry reasoning a human could actually audit. A
 * prioritisation call nobody can reconstruct in three months is a memory, not
 * a decision.
 */
function rationaleCompleteness(): OperationalMetrics["rationaleCompleteness"] {
  const r = row<{
    scored: number;
    with_rationale: number;
    with_evidence: number;
    with_brief: number;
  }>(
    getDb()
      .prepare(
        `WITH latest AS (
           SELECT * FROM (
             SELECT s.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY s.cluster_id ORDER BY s.created_at DESC, s.rowid DESC
                    ) AS rn
               FROM priority_scores s
           ) WHERE rn = 1
         )
         SELECT COUNT(*) AS scored,
                SUM(CASE WHEN TRIM(rationale) != '' THEN 1 ELSE 0 END) AS with_rationale,
                SUM(CASE WHEN evidence NOT IN ('[]','') THEN 1 ELSE 0 END) AS with_evidence,
                SUM(CASE WHEN EXISTS (
                      SELECT 1 FROM decision_briefs b WHERE b.cluster_id = latest.cluster_id
                    ) THEN 1 ELSE 0 END) AS with_brief
           FROM latest`,
      )
      .get(),
  ) ?? { scored: 0, with_rationale: 0, with_evidence: 0, with_brief: 0 };

  const scored = r.scored ?? 0;
  const complete = Math.min(r.with_rationale ?? 0, r.with_evidence ?? 0);

  return {
    scoredClusters: scored,
    withRationale: r.with_rationale ?? 0,
    withEvidence: r.with_evidence ?? 0,
    withBrief: r.with_brief ?? 0,
    percent: scored === 0 ? 0 : Math.round((complete / scored) * 1000) / 10,
  };
}

export function scoreDistribution() {
  const latest = scoresRepo.latestForAllClusters();
  const buckets = [
    { label: "0-19", min: 0, max: 20, count: 0 },
    { label: "20-39", min: 20, max: 40, count: 0 },
    { label: "40-59", min: 40, max: 60, count: 0 },
    { label: "60-79", min: 60, max: 80, count: 0 },
    { label: "80-100", min: 80, max: 101, count: 0 },
  ];
  for (const score of latest.values()) {
    const bucket = buckets.find((b) => score.total >= b.min && score.total < b.max);
    if (bucket) bucket.count++;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}
