import * as clustersRepo from "../repositories/clusters.repo.js";
import * as requestsRepo from "../repositories/requests.repo.js";
import * as submittersRepo from "../repositories/submitters.repo.js";
import * as themesRepo from "../repositories/themes.repo.js";
import * as scoresRepo from "../repositories/scores.repo.js";
import * as signalsRepo from "../repositories/signals.repo.js";
import * as briefsRepo from "../repositories/briefs.repo.js";
import * as eventsRepo from "../repositories/events.repo.js";
import * as suggestionsRepo from "../repositories/mergeSuggestions.repo.js";
import * as jobsRepo from "../repositories/jobs.repo.js";
import { transaction } from "../db/index.js";
import { notFound, badRequest, conflict } from "../lib/errors.js";
import { JOB_TYPES } from "../jobs/types.js";
import type { ClusterStatus } from "../domain/types.js";

export function getClusterDetail(id: string) {
  const cluster = clustersRepo.findById(id);
  if (!cluster) throw notFound("cluster", id);

  const requests = requestsRepo.findByCluster(id);
  const analyses = requestsRepo.findAnalysesByCluster(id);
  const decisions = clustersRepo.decisionsForCluster(id);

  return {
    cluster: {
      ...cluster,
      theme: cluster.themeId ? themesRepo.findById(cluster.themeId) : null,
    },
    score: scoresRepo.latestForCluster(id),
    scoreHistory: scoresRepo.historyForCluster(id, 20),
    brief: briefsRepo.latestBrief(id),
    updates: briefsRepo.listUpdates(id),
    supportSignals: signalsRepo.listForCluster(id),
    requests: requests.map((r) => {
      const submitter = submittersRepo.findById(r.submitterId);
      return {
        ...r,
        submitter: submitter
          ? {
              name: submitter.name,
              type: submitter.type,
              tier: submitter.tier,
              accountName: submitter.accountName,
            }
          : null,
        analysis: analyses.find((a) => a.requestId === r.id) ?? null,
        mergeRationale: decisions.find((d) => d.requestId === r.id)?.rationale ?? null,
      };
    }),
    timeline: eventsRepo.forEntity("cluster", id, 50),
  };
}

export function updateClusterStatus(id: string, status: ClusterStatus, actor: string) {
  const cluster = clustersRepo.findById(id);
  if (!cluster) throw notFound("cluster", id);

  const updated = clustersRepo.update(id, { status });
  eventsRepo.record({
    entityType: "cluster",
    entityId: id,
    type: "status_changed",
    actor,
    payload: { from: cluster.status, to: status },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Human-in-the-loop overrides
// ---------------------------------------------------------------------------

/**
 * A human accepts an AI merge suggestion.
 *
 * The request moves to the target cluster and its former cluster is dropped if
 * it is left empty. Both sides are recorded, so the board can always answer
 * "who decided this, and on what grounds".
 */
export function acceptMergeSuggestion(suggestionId: string, actor: string) {
  const suggestion = suggestionsRepo.findById(suggestionId);
  if (!suggestion) throw notFound("merge suggestion", suggestionId);
  if (suggestion.status !== "pending") {
    throw conflict(`Suggestion was already ${suggestion.status}.`);
  }

  return transaction(() => {
    const request = requestsRepo.findById(suggestion.requestId);
    if (!request) throw notFound("request", suggestion.requestId);

    const previousClusterId = request.clusterId;
    requestsRepo.setCluster(request.id, suggestion.targetClusterId);

    clustersRepo.recordDecision({
      clusterId: suggestion.targetClusterId,
      requestId: request.id,
      decidedBy: "human",
      confidence: 1,
      rationale: `Accepted AI suggestion (model confidence ${suggestion.confidence.toFixed(2)}): ${suggestion.rationale}`,
      overriddenFromClusterId: previousClusterId,
    });

    suggestionsRepo.resolve(suggestionId, "accepted", actor);
    if (previousClusterId && previousClusterId !== suggestion.targetClusterId) {
      clustersRepo.deleteIfEmpty(previousClusterId);
    }

    eventsRepo.record({
      entityType: "cluster",
      entityId: suggestion.targetClusterId,
      type: "merge_accepted",
      actor,
      payload: { requestId: request.id, suggestionId, fromClusterId: previousClusterId },
    });

    jobsRepo.enqueue({
      type: JOB_TYPES.SCORE_CLUSTER,
      payload: { clusterId: suggestion.targetClusterId },
      dedupeKey: `score:${suggestion.targetClusterId}`,
    });

    return { merged: true, clusterId: suggestion.targetClusterId };
  });
}

export function rejectMergeSuggestion(suggestionId: string, actor: string) {
  const suggestion = suggestionsRepo.findById(suggestionId);
  if (!suggestion) throw notFound("merge suggestion", suggestionId);
  if (suggestion.status !== "pending") {
    throw conflict(`Suggestion was already ${suggestion.status}.`);
  }

  suggestionsRepo.resolve(suggestionId, "rejected", actor);
  eventsRepo.record({
    entityType: "request",
    entityId: suggestion.requestId,
    type: "merge_rejected",
    actor,
    payload: { suggestionId, targetClusterId: suggestion.targetClusterId },
  });

  return { merged: false };
}

/**
 * A human splits a request out of a cluster the AI merged it into. The reverse
 * of an auto-merge, and the escape hatch that makes auto-merging safe to enable.
 */
export function splitRequest(requestId: string, actor: string, reason: string) {
  const request = requestsRepo.findById(requestId);
  if (!request) throw notFound("request", requestId);
  if (!request.clusterId) throw badRequest("Request is not in a cluster.");

  const previousClusterId = request.clusterId;
  if (clustersRepo.memberCount(previousClusterId) <= 1) {
    throw badRequest("Request is already the only member of its cluster.");
  }

  return transaction(() => {
    const analysis = requestsRepo.findAnalysis(requestId);
    const cluster = clustersRepo.create({
      title: request.title,
      canonicalNeed: analysis?.underlyingNeed ?? "",
    });

    requestsRepo.setCluster(requestId, cluster.id);
    clustersRepo.recordDecision({
      clusterId: cluster.id,
      requestId,
      decidedBy: "human",
      confidence: 1,
      rationale: reason,
      overriddenFromClusterId: previousClusterId,
    });

    eventsRepo.record({
      entityType: "cluster",
      entityId: previousClusterId,
      type: "request_split_out",
      actor,
      payload: { requestId, newClusterId: cluster.id, reason },
    });

    for (const id of [previousClusterId, cluster.id]) {
      jobsRepo.enqueue({
        type: JOB_TYPES.SCORE_CLUSTER,
        payload: { clusterId: id },
        dedupeKey: `score:${id}`,
      });
    }

    return { clusterId: cluster.id, previousClusterId };
  });
}

export function listPendingSuggestions() {
  return suggestionsRepo.listPending(50);
}

/** A human edits an AI-drafted brief. The original is kept as its own revision. */
export function reviseBrief(
  briefId: string,
  patch: Parameters<typeof briefsRepo.reviseBrief>[1],
  approvedBy: string | null,
) {
  const source = briefsRepo.findBrief(briefId);
  if (!source) throw notFound("brief", briefId);

  const revised = briefsRepo.reviseBrief(source, patch, approvedBy);
  eventsRepo.record({
    entityType: "cluster",
    entityId: source.clusterId,
    type: approvedBy ? "brief_approved" : "brief_revised",
    actor: approvedBy ?? "human",
    payload: { fromBriefId: briefId, toBriefId: revised.id },
  });
  return revised;
}

export function markUpdateSent(updateId: string, actor: string) {
  const update = briefsRepo.findUpdate(updateId);
  if (!update) throw notFound("stakeholder update", updateId);

  const sent = briefsRepo.markUpdateSent(updateId);
  eventsRepo.record({
    entityType: "cluster",
    entityId: update.clusterId,
    type: "update_sent",
    actor,
    payload: { updateId, audience: update.audience },
  });
  return sent;
}
