import { getDb, row, rows } from "../db/index.js";
import { nullable, parseJson, toFtsQuery } from "../db/sql.js";
import { requestId } from "../lib/ids.js";
import type {
  FeatureRequest,
  RequestAnalysis,
  RequestStatus,
  SeverityLevel,
  Sentiment,
  SubmitterType,
} from "../domain/types.js";

interface RequestRow {
  id: string;
  title: string;
  description: string;
  submitter_id: string;
  cluster_id: string | null;
  status: RequestStatus;
  source: string;
  created_at: string;
  updated_at: string;
}

const toDomain = (r: RequestRow): FeatureRequest => ({
  id: r.id,
  title: r.title,
  description: r.description,
  submitterId: r.submitter_id,
  clusterId: r.cluster_id,
  status: r.status,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// --- writes ----------------------------------------------------------------

export interface CreateRequestInput {
  title: string;
  description: string;
  submitterId: string;
  source?: string;
}

export function create(input: CreateRequestInput): FeatureRequest {
  const id = requestId();
  const db = getDb();
  db.prepare(
    `INSERT INTO requests (id, title, description, submitter_id, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.description, input.submitterId, input.source ?? "web");

  syncFts(id, input.title, input.description, "");
  return findById(id)!;
}

/** Rebuilds the FTS row for a request. Delete-then-insert; see 001_init.sql. */
export function syncFts(
  id: string,
  title: string,
  description: string,
  underlyingNeed: string,
): void {
  const db = getDb();
  db.prepare("DELETE FROM requests_fts WHERE request_id = ?").run(id);
  db.prepare(
    `INSERT INTO requests_fts (request_id, title, description, underlying_need)
     VALUES (?, ?, ?, ?)`,
  ).run(id, title, description, underlyingNeed);
}

export function setStatus(id: string, status: RequestStatus): void {
  getDb()
    .prepare(
      `UPDATE requests SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .run(status, id);
}

export function setCluster(id: string, clusterId: string | null): void {
  getDb()
    .prepare(
      `UPDATE requests SET cluster_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .run(nullable(clusterId), id);
}

// --- reads -----------------------------------------------------------------

export function findById(id: string): FeatureRequest | null {
  const r = row<RequestRow>(getDb().prepare("SELECT * FROM requests WHERE id = ?").get(id));
  return r ? toDomain(r) : null;
}

export function findByCluster(clusterId: string): FeatureRequest[] {
  return rows<RequestRow>(
    getDb()
      .prepare("SELECT * FROM requests WHERE cluster_id = ? ORDER BY created_at ASC")
      .all(clusterId),
  ).map(toDomain);
}

export interface ListFilters {
  search?: string;
  status?: RequestStatus;
  submitterType?: SubmitterType;
  themeId?: string;
  clusterId?: string;
  limit: number;
  offset: number;
}

export interface ListResult {
  items: Array<FeatureRequest & { submitterName: string; submitterType: SubmitterType }>;
  total: number;
}

export function list(filters: ListFilters): ListResult {
  const db = getDb();
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.search) {
    const fts = toFtsQuery(filters.search);
    if (fts) {
      where.push("r.id IN (SELECT request_id FROM requests_fts WHERE requests_fts MATCH ?)");
      params.push(fts);
    } else {
      // Query was all punctuation/stopwords - fall back to a literal substring
      // match rather than silently returning the unfiltered list.
      where.push("(r.title LIKE ? OR r.description LIKE ?)");
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }
  }
  if (filters.status) {
    where.push("r.status = ?");
    params.push(filters.status);
  }
  if (filters.submitterType) {
    where.push("s.type = ?");
    params.push(filters.submitterType);
  }
  if (filters.clusterId) {
    where.push("r.cluster_id = ?");
    params.push(filters.clusterId);
  }
  if (filters.themeId) {
    where.push("r.cluster_id IN (SELECT id FROM clusters WHERE theme_id = ?)");
    params.push(filters.themeId);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    row<{ n: number }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM requests r JOIN submitters s ON s.id = r.submitter_id ${whereSql}`,
        )
        .get(...params),
    ) ?? { n: 0 }
  ).n;

  const items = rows<RequestRow & { submitter_name: string; submitter_type: SubmitterType }>(
    db
      .prepare(
        `SELECT r.*, s.name AS submitter_name, s.type AS submitter_type
           FROM requests r
           JOIN submitters s ON s.id = r.submitter_id
           ${whereSql}
          ORDER BY r.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit, filters.offset),
  ).map((r) => ({
    ...toDomain(r),
    submitterName: r.submitter_name,
    submitterType: r.submitter_type,
  }));

  return { items, total };
}

// --- analysis (cached AI output) -------------------------------------------

interface AnalysisRow {
  request_id: string;
  underlying_need: string;
  job_to_be_done: string;
  problem_summary: string;
  severity: SeverityLevel;
  urgency: number;
  sentiment: Sentiment;
  strategic_alignment: number;
  suggested_team: string;
  suggested_product_area: string;
  tags: string;
  confidence: number;
  reasoning: string;
  model: string;
  prompt_version: string;
  created_at: string;
}

const analysisToDomain = (r: AnalysisRow): RequestAnalysis => ({
  requestId: r.request_id,
  underlyingNeed: r.underlying_need,
  jobToBeDone: r.job_to_be_done,
  problemSummary: r.problem_summary,
  severity: r.severity,
  urgency: r.urgency,
  sentiment: r.sentiment,
  strategicAlignment: r.strategic_alignment,
  suggestedTeam: r.suggested_team,
  suggestedProductArea: r.suggested_product_area,
  tags: parseJson<string[]>(r.tags, []),
  confidence: r.confidence,
  reasoning: r.reasoning,
  model: r.model,
  promptVersion: r.prompt_version,
  createdAt: r.created_at,
});

export function saveAnalysis(a: Omit<RequestAnalysis, "createdAt">): void {
  getDb()
    .prepare(
      `INSERT INTO request_analysis (
         request_id, underlying_need, job_to_be_done, problem_summary, severity,
         urgency, sentiment, strategic_alignment, suggested_team,
         suggested_product_area, tags, confidence, reasoning, model, prompt_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         underlying_need = excluded.underlying_need,
         job_to_be_done = excluded.job_to_be_done,
         problem_summary = excluded.problem_summary,
         severity = excluded.severity,
         urgency = excluded.urgency,
         sentiment = excluded.sentiment,
         strategic_alignment = excluded.strategic_alignment,
         suggested_team = excluded.suggested_team,
         suggested_product_area = excluded.suggested_product_area,
         tags = excluded.tags,
         confidence = excluded.confidence,
         reasoning = excluded.reasoning,
         model = excluded.model,
         prompt_version = excluded.prompt_version`,
    )
    .run(
      a.requestId,
      a.underlyingNeed,
      a.jobToBeDone,
      a.problemSummary,
      a.severity,
      a.urgency,
      a.sentiment,
      a.strategicAlignment,
      a.suggestedTeam,
      a.suggestedProductArea,
      JSON.stringify(a.tags),
      a.confidence,
      a.reasoning,
      a.model,
      a.promptVersion,
    );

  const req = findById(a.requestId);
  if (req) syncFts(req.id, req.title, req.description, a.underlyingNeed);
}

export function findAnalysis(requestId: string): RequestAnalysis | null {
  const r = row<AnalysisRow>(
    getDb().prepare("SELECT * FROM request_analysis WHERE request_id = ?").get(requestId),
  );
  return r ? analysisToDomain(r) : null;
}

export function findAnalysesByCluster(clusterId: string): RequestAnalysis[] {
  return rows<AnalysisRow>(
    getDb()
      .prepare(
        `SELECT a.* FROM request_analysis a
           JOIN requests r ON r.id = a.request_id
          WHERE r.cluster_id = ?
          ORDER BY a.created_at ASC`,
      )
      .all(clusterId),
  ).map(analysisToDomain);
}

// --- duplicate-candidate retrieval -----------------------------------------

export interface Candidate {
  requestId: string;
  clusterId: string | null;
  title: string;
  description: string;
  underlyingNeed: string;
  bm25: number;
}

/**
 * The retrieval half of duplicate detection. Returns the lexically closest
 * prior requests so the LLM only has to adjudicate a shortlist. Excludes the
 * request itself; `limit` caps how much text reaches the model.
 */
export function findDuplicateCandidates(
  excludeRequestId: string,
  text: string,
  limit = 8,
): Candidate[] {
  const ftsQuery = toFtsQuery(text);
  if (!ftsQuery) return [];

  return rows<{
    request_id: string;
    cluster_id: string | null;
    title: string;
    description: string;
    underlying_need: string;
    bm25: number;
  }>(
    getDb()
      .prepare(
        `SELECT f.request_id,
                r.cluster_id,
                r.title,
                r.description,
                COALESCE(a.underlying_need, '') AS underlying_need,
                bm25(requests_fts) AS bm25
           FROM requests_fts f
           JOIN requests r ON r.id = f.request_id
           LEFT JOIN request_analysis a ON a.request_id = f.request_id
          WHERE requests_fts MATCH ?
            AND f.request_id != ?
          ORDER BY bm25
          LIMIT ?`,
      )
      .all(ftsQuery, excludeRequestId, limit),
  ).map((r) => ({
    requestId: r.request_id,
    clusterId: r.cluster_id,
    title: r.title,
    description: r.description,
    underlyingNeed: r.underlying_need,
    bm25: r.bm25,
  }));
}
