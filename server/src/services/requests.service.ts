import * as requestsRepo from "../repositories/requests.repo.js";
import * as submittersRepo from "../repositories/submitters.repo.js";
import * as clustersRepo from "../repositories/clusters.repo.js";
import * as themesRepo from "../repositories/themes.repo.js";
import * as scoresRepo from "../repositories/scores.repo.js";
import * as signalsRepo from "../repositories/signals.repo.js";
import * as eventsRepo from "../repositories/events.repo.js";
import * as jobsRepo from "../repositories/jobs.repo.js";
import { transaction } from "../db/index.js";
import { notFound, badRequest } from "../lib/errors.js";
import { JOB_TYPES } from "../jobs/types.js";
import type { CustomerTier, SubmitterType, RequestStatus } from "../domain/types.js";

export interface SubmitRequestInput {
  title: string;
  description: string;
  submitter: {
    name: string;
    email?: string | null;
    type: SubmitterType;
    tier?: CustomerTier | null;
    accountName?: string | null;
    arrUsd?: number | null;
  };
  source?: string;
}

/**
 * Accepts a request and returns immediately.
 *
 * The write and the enqueue share a transaction, so a crash between them cannot
 * leave a request that never gets analysed. The AI work then happens on the
 * worker - the submitter is not made to wait on it.
 */
export function submitRequest(input: SubmitRequestInput) {
  const { request, submitter } = transaction(() => {
    const submitter = submittersRepo.upsertByEmail(input.submitter);
    const request = requestsRepo.create({
      title: input.title,
      description: input.description,
      submitterId: submitter.id,
      source: input.source,
    });

    jobsRepo.enqueue({
      type: JOB_TYPES.ANALYZE_REQUEST,
      payload: { requestId: request.id },
      dedupeKey: `analyze:${request.id}`,
    });

    eventsRepo.record({
      entityType: "request",
      entityId: request.id,
      type: "submitted",
      actor: `submitter:${submitter.id}`,
      payload: { title: request.title, submitterType: submitter.type },
    });

    return { request, submitter };
  });

  return { request, submitter, analysisStatus: "queued" as const };
}

export interface ListRequestsQuery {
  search?: string;
  status?: RequestStatus;
  submitterType?: SubmitterType;
  themeId?: string;
  clusterId?: string;
  page: number;
  pageSize: number;
}

export function listRequests(query: ListRequestsQuery) {
  const { items, total } = requestsRepo.list({
    search: query.search,
    status: query.status,
    submitterType: query.submitterType,
    themeId: query.themeId,
    clusterId: query.clusterId,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });

  // Attach the cluster-level signals the browse view needs, in bulk rather than
  // per row.
  const latestScores = scoresRepo.latestForAllClusters();
  const signalCounts = signalsRepo.countsByCluster();
  const clusterCache = new Map<string, ReturnType<typeof clustersRepo.findById>>();

  const enriched = items.map((r) => {
    if (r.clusterId && !clusterCache.has(r.clusterId)) {
      clusterCache.set(r.clusterId, clustersRepo.findById(r.clusterId));
    }
    const cluster = r.clusterId ? clusterCache.get(r.clusterId) : null;
    const analysis = requestsRepo.findAnalysis(r.id);

    return {
      ...r,
      underlyingNeed: analysis?.underlyingNeed ?? null,
      severity: analysis?.severity ?? null,
      cluster: cluster
        ? {
            id: cluster.id,
            title: cluster.title,
            status: cluster.status,
            themeId: cluster.themeId,
            score: latestScores.get(cluster.id)?.total ?? null,
            supporterCount: signalCounts.get(cluster.id) ?? 0,
            memberCount: clustersRepo.memberCount(cluster.id),
          }
        : null,
    };
  });

  return {
    items: enriched,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Everything the request-detail view shows, including the AI's reasoning. */
export function getRequestDetail(id: string) {
  const request = requestsRepo.findById(id);
  if (!request) throw notFound("request", id);

  const submitter = submittersRepo.findById(request.submitterId);
  const analysis = requestsRepo.findAnalysis(id);
  const cluster = request.clusterId ? clustersRepo.findById(request.clusterId) : null;
  const theme = cluster?.themeId ? themesRepo.findById(cluster.themeId) : null;
  const score = cluster ? scoresRepo.latestForCluster(cluster.id) : null;
  const siblings = cluster
    ? requestsRepo.findByCluster(cluster.id).filter((r) => r.id !== id)
    : [];
  const decisions = cluster ? clustersRepo.decisionsForCluster(cluster.id) : [];
  const signals = cluster ? signalsRepo.listForCluster(cluster.id) : [];

  return {
    request,
    submitter,
    analysis,
    cluster: cluster
      ? {
          ...cluster,
          theme,
          score,
          memberCount: siblings.length + 1,
          supporterCount: signals.length,
        }
      : null,
    // The consolidation decision, shown verbatim in the UI so a user can see
    // why their request was merged with someone else's.
    mergeDecision: decisions.find((d) => d.requestId === id) ?? null,
    relatedRequests: siblings.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      rationale: decisions.find((d) => d.requestId === s.id)?.rationale ?? null,
    })),
    supportSignals: signals,
    timeline: eventsRepo.forEntity("request", id, 50),
  };
}

export interface SupportInput {
  requestId: string;
  impactText: string;
  currentWorkaround?: string | null;
  submitter: {
    name: string;
    email?: string | null;
    type: SubmitterType;
    tier?: CustomerTier | null;
    accountName?: string | null;
    arrUsd?: number | null;
  };
}

/**
 * The replacement for an upvote.
 *
 * A supporter must say how the problem affects them. That text becomes evidence
 * the scoring and brief stages actually read, which is what makes support
 * informative rather than merely countable - and the per-account uniqueness
 * constraint stops one enthusiastic team from manufacturing consensus.
 */
export function addSupport(input: SupportInput) {
  const request = requestsRepo.findById(input.requestId);
  if (!request) throw notFound("request", input.requestId);
  if (!request.clusterId) {
    throw badRequest(
      "This request is still being analysed. Support can be registered once it has been grouped.",
    );
  }

  return transaction(() => {
    const submitter = submittersRepo.upsertByEmail(input.submitter);
    const signal = signalsRepo.upsert({
      clusterId: request.clusterId!,
      requestId: request.id,
      submitterId: submitter.id,
      impactText: input.impactText,
      currentWorkaround: input.currentWorkaround,
    });

    eventsRepo.record({
      entityType: "cluster",
      entityId: request.clusterId!,
      type: "support_added",
      actor: `submitter:${submitter.id}`,
      payload: { requestId: request.id, submitterType: submitter.type },
    });

    // New evidence changes the score. Dedupe means a burst of supporters
    // collapses into one rescore rather than one per click.
    jobsRepo.enqueue({
      type: JOB_TYPES.SCORE_CLUSTER,
      payload: { clusterId: request.clusterId },
      dedupeKey: `score:${request.clusterId}`,
    });

    return { signal, submitter };
  });
}
