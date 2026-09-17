import { logger } from "../../lib/logger.js";
import { notFound } from "../../lib/errors.js";
import { fingerprint } from "../../lib/ids.js";

import * as requestsRepo from "../../repositories/requests.repo.js";
import * as clustersRepo from "../../repositories/clusters.repo.js";
import * as themesRepo from "../../repositories/themes.repo.js";
import * as submittersRepo from "../../repositories/submitters.repo.js";
import * as scoresRepo from "../../repositories/scores.repo.js";
import * as signalsRepo from "../../repositories/signals.repo.js";
import * as briefsRepo from "../../repositories/briefs.repo.js";
import * as eventsRepo from "../../repositories/events.repo.js";
import * as suggestionsRepo from "../../repositories/mergeSuggestions.repo.js";
import * as jobsRepo from "../../repositories/jobs.repo.js";

import { extractNeed, PROMPT_VERSION as NEED_VERSION } from "../ai/stages/extractNeed.js";
import { adjudicateDuplicate } from "../ai/stages/adjudicateDuplicate.js";
import { assignTheme } from "../ai/stages/assignTheme.js";
import { explainScore } from "../ai/stages/explainScore.js";
import { composeBrief, composeStakeholderUpdate } from "../ai/stages/composeBrief.js";
import { detectEmergingNeeds } from "../ai/stages/detectEmergingNeeds.js";

import { getScoringConfig } from "../scoring/config.js";
import { computeScore, type Contributor, type ScoreInputs } from "../scoring/compute.js";
import { JOB_TYPES } from "../../jobs/types.js";

/**
 * The AI orchestration layer: a fixed pipeline over the stages in services/ai.
 *
 * Deliberately a DAG rather than an agent loop. Every step's inputs and outputs
 * are known in advance, so each is separately testable, separately cacheable,
 * and separately re-runnable - and a bad stage can be improved without
 * re-deriving the rest. See README "Why not an agent?".
 */

/**
 * Above this the model's merge is applied automatically; below it the merge
 * becomes a suggestion a human resolves. Set from the asymmetry in
 * adjudicateDuplicate's prompt: a false merge hides someone's request, a missed
 * merge only leaves a visible duplicate.
 */
export const AUTO_MERGE_CONFIDENCE = 0.75;

// ---------------------------------------------------------------------------
// Stage group 1: analyse a single request
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
  requestId: string;
  clusterId: string;
  merged: boolean;
  suggestionId: string | null;
}

export async function analyzeRequest(requestId: string): Promise<AnalyzeResult> {
  const request = requestsRepo.findById(requestId);
  if (!request) throw notFound("request", requestId);

  const submitter = submittersRepo.findById(request.submitterId);
  if (!submitter) throw notFound("submitter", request.submitterId);

  requestsRepo.setStatus(requestId, "analyzing");

  // --- 1. underlying need ---------------------------------------------------
  const need = await extractNeed({
    requestId,
    title: request.title,
    description: request.description,
    submitter,
  });

  requestsRepo.saveAnalysis({
    requestId,
    underlyingNeed: need.value.underlyingNeed,
    jobToBeDone: need.value.jobToBeDone,
    problemSummary: need.value.problemSummary,
    severity: need.value.severity,
    urgency: need.value.urgency,
    sentiment: need.value.sentiment,
    strategicAlignment: need.value.strategicAlignment,
    suggestedTeam: need.value.suggestedTeam,
    suggestedProductArea: need.value.suggestedProductArea,
    tags: need.value.tags,
    confidence: need.value.confidence,
    reasoning: need.value.reasoning,
    model: need.model,
    promptVersion: NEED_VERSION,
  });

  eventsRepo.record({
    entityType: "request",
    entityId: requestId,
    type: "need_extracted",
    actor: `ai:${need.model}`,
    payload: {
      underlyingNeed: need.value.underlyingNeed,
      severity: need.value.severity,
      confidence: need.value.confidence,
    },
  });

  // --- 2. duplicate detection ----------------------------------------------
  // Lexical retrieval first (cheap, scales), then semantic adjudication over
  // the shortlist (accurate, bounded cost).
  const candidates = requestsRepo.findDuplicateCandidates(
    requestId,
    `${request.title} ${need.value.underlyingNeed}`,
    8,
  );

  let clusterId = request.clusterId;
  let merged = false;
  let suggestionId: string | null = null;

  if (candidates.length === 0) {
    clusterId = createClusterFor(request.id, request.title, need.value.underlyingNeed, {
      decidedBy: "ai",
      confidence: 1,
      rationale: "No textually similar prior requests existed.",
    });
  } else {
    const verdict = await adjudicateDuplicate({
      requestId,
      title: request.title,
      description: request.description,
      underlyingNeed: need.value.underlyingNeed,
      candidates,
    });

    const match = candidates.find((c) => c.requestId === verdict.value.matchedRequestId);
    const targetClusterId = match?.clusterId ?? null;

    if (
      verdict.value.verdict === "duplicate" &&
      targetClusterId &&
      verdict.value.confidence >= AUTO_MERGE_CONFIDENCE
    ) {
      requestsRepo.setCluster(requestId, targetClusterId);
      clustersRepo.recordDecision({
        clusterId: targetClusterId,
        requestId,
        decidedBy: "ai",
        confidence: verdict.value.confidence,
        rationale: verdict.value.rationale,
      });
      // The consolidated title/need describe the merged pair better than
      // whichever request happened to arrive first.
      if (verdict.value.consolidatedTitle) {
        clustersRepo.update(targetClusterId, {
          title: verdict.value.consolidatedTitle,
          canonicalNeed: verdict.value.consolidatedNeed || undefined,
        });
      }
      clusterId = targetClusterId;
      merged = true;

      eventsRepo.record({
        entityType: "cluster",
        entityId: targetClusterId,
        type: "request_merged",
        actor: `ai:${verdict.model}`,
        payload: { requestId, confidence: verdict.value.confidence, rationale: verdict.value.rationale },
      });
    } else {
      // Either genuinely distinct, or a merge the model was not confident
      // enough to apply. Both start their own cluster; the second also queues a
      // suggestion for a human.
      clusterId = createClusterFor(request.id, request.title, need.value.underlyingNeed, {
        decidedBy: "ai",
        confidence: verdict.value.confidence,
        rationale: verdict.value.rationale,
      });

      if (targetClusterId && verdict.value.verdict !== "distinct") {
        const suggestion = suggestionsRepo.create({
          requestId,
          targetClusterId,
          verdict: verdict.value.verdict,
          confidence: verdict.value.confidence,
          rationale: verdict.value.rationale,
        });
        suggestionId = suggestion.id;

        eventsRepo.record({
          entityType: "request",
          entityId: requestId,
          type: "merge_suggested",
          actor: `ai:${verdict.model}`,
          payload: {
            targetClusterId,
            verdict: verdict.value.verdict,
            confidence: verdict.value.confidence,
          },
        });
      }
    }
  }

  // --- 3. theming -----------------------------------------------------------
  await ensureTheme(clusterId!, need.value.suggestedProductArea);

  // --- 4. routing -----------------------------------------------------------
  const cluster = clustersRepo.findById(clusterId!);
  if (cluster && !cluster.owningTeam) {
    clustersRepo.update(clusterId!, { owningTeam: need.value.suggestedTeam });
  }

  requestsRepo.setStatus(requestId, "analyzed");

  // Scoring is a separate job: it depends on the whole cluster, and merging a
  // request changes the score of a cluster this request is not even in.
  jobsRepo.enqueue({
    type: JOB_TYPES.SCORE_CLUSTER,
    payload: { clusterId },
    dedupeKey: `score:${clusterId}`,
  });

  return { requestId, clusterId: clusterId!, merged, suggestionId };
}

function createClusterFor(
  requestId: string,
  title: string,
  canonicalNeed: string,
  decision: { decidedBy: "ai" | "human"; confidence: number; rationale: string },
): string {
  // Analysis is not guaranteed to run only once: a job that fails partway is
  // retried from the top, and re-analysing a request that already has a cluster
  // would strand the old one. An abandoned cluster keeps no requests, never
  // gets scored, and still appears in the ranked list as an empty row - so
  // release it here rather than leaving the list to filter it out later.
  const previousClusterId = requestsRepo.findById(requestId)?.clusterId ?? null;

  const cluster = clustersRepo.create({ title, canonicalNeed });
  requestsRepo.setCluster(requestId, cluster.id);
  clustersRepo.recordDecision({
    clusterId: cluster.id,
    requestId,
    decidedBy: decision.decidedBy,
    confidence: decision.confidence,
    rationale: decision.rationale,
  });

  if (previousClusterId && previousClusterId !== cluster.id) {
    clustersRepo.deleteIfEmpty(previousClusterId);
  }

  return cluster.id;
}

async function ensureTheme(clusterId: string, productAreaHint: string): Promise<void> {
  const cluster = clustersRepo.findById(clusterId);
  if (!cluster || cluster.themeId) return;

  const assignment = await assignTheme({
    clusterTitle: cluster.title,
    canonicalNeed: cluster.canonicalNeed,
    productAreaHint,
    existingThemes: themesRepo.listAll(),
  });

  const theme = themesRepo.upsertByName({
    name: assignment.value.themeName,
    description: assignment.value.themeDescription,
    productArea: assignment.value.productArea,
  });

  clustersRepo.update(clusterId, { themeId: theme.id });

  eventsRepo.record({
    entityType: "cluster",
    entityId: clusterId,
    type: "theme_assigned",
    actor: `ai:${assignment.model}`,
    payload: { themeId: theme.id, themeName: theme.name, isNew: assignment.value.isNewTheme },
  });
}

// ---------------------------------------------------------------------------
// Stage group 2: score a cluster
// ---------------------------------------------------------------------------

export interface ScoreResult {
  clusterId: string;
  total: number;
  skipped: boolean;
  /** How the explanation was obtained - "reused" means no model call was made. */
  rationaleSource: "generated" | "reused" | "unchanged";
}

/**
 * Recomputes a cluster's score.
 *
 * Three outcomes, in increasing cost:
 *
 * - Nothing changed          -> no write, no call.
 * - Only the weights changed -> totals recomputed locally, prior rationale
 *                               carried forward and flagged stale. No call.
 * - The evidence changed     -> full rescore including a new explanation.
 *
 * The middle case is the one that matters. Re-weighting the board touches every
 * cluster at once; if each needed a fresh Opus-tier explanation, tuning the
 * weights would cost one call per cluster and nobody would tune them. The
 * components themselves do not move when weights change - only their relative
 * contribution does - so the existing explanation still describes them
 * correctly, and `rationaleStale` tells the UI to say it predates the change.
 *
 * Pass `force` to regenerate the explanation on demand for a single cluster.
 */
export async function scoreCluster(clusterId: string, force = false): Promise<ScoreResult> {
  const cluster = clustersRepo.findById(clusterId);
  if (!cluster) throw notFound("cluster", clusterId);

  const requests = requestsRepo.findByCluster(clusterId);
  const analyses = requestsRepo.findAnalysesByCluster(clusterId);
  const signals = signalsRepo.listForCluster(clusterId);

  if (analyses.length === 0) {
    // Nothing to score on yet - the member requests have not been analysed.
    return { clusterId, total: 0, skipped: true, rationaleSource: "unchanged" };
  }

  const submitters = new Map(
    requests
      .map((r) => submittersRepo.findById(r.submitterId))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => [s.id, s]),
  );

  const contributors: Contributor[] = [
    ...requests.flatMap((r) => {
      const s = submitters.get(r.submitterId);
      return s
        ? [
            {
              submitterType: s.type,
              tier: s.tier,
              accountName: s.accountName,
              arrUsd: s.arrUsd,
              viaSupportSignal: false,
            },
          ]
        : [];
    }),
    ...signals.map((g) => ({
      submitterType: g.submitterType,
      tier: g.submitterTier,
      accountName: g.accountName,
      arrUsd: g.arrUsd,
      viaSupportSignal: true,
    })),
  ];

  const { config, version: weightsVersion } = getScoringConfig();
  const inputs: ScoreInputs = {
    contributors,
    analyses,
    requestCount: requests.length,
  };
  const breakdown = computeScore(inputs, config);

  // The evidence fingerprint covers what the model judged; the inputs
  // fingerprint adds the weights on top. Comparing them separately is what
  // distinguishes "nothing changed" from "only the weights changed".
  const evidenceFingerprint = fingerprint(inputs);
  const inputsFingerprint = fingerprint({ evidenceFingerprint, weightsVersion });
  const existing = scoresRepo.latestForCluster(clusterId);

  if (existing && existing.inputsFingerprint === inputsFingerprint && !force) {
    return { clusterId, total: existing.total, skipped: true, rationaleSource: "unchanged" };
  }

  // Only the weights moved: re-rank for free by carrying the explanation over.
  if (existing && existing.evidenceFingerprint === evidenceFingerprint && !force) {
    const saved = scoresRepo.insert({
      clusterId,
      total: breakdown.total,
      components: breakdown.components,
      rationale: existing.rationale,
      evidence: existing.evidence,
      weightsVersion,
      inputsFingerprint,
      evidenceFingerprint,
      rationaleStale: true,
      model: existing.model,
    });

    eventsRepo.record({
      entityType: "cluster",
      entityId: clusterId,
      type: "rescored_on_new_weights",
      actor: "system",
      payload: { total: saved.total, previous: existing.total, weightsVersion, modelCalls: 0 },
    });

    return { clusterId, total: saved.total, skipped: false, rationaleSource: "reused" };
  }

  const meanConfidence =
    analyses.reduce((a, x) => a + x.confidence, 0) / analyses.length;

  const rationale = await explainScore({
    clusterTitle: cluster.title,
    canonicalNeed: cluster.canonicalNeed,
    breakdown,
    weightsVersion,
    requestExcerpts: requests.slice(0, 8).map((r) => ({
      title: r.title,
      submitter: describeSubmitter(submitters.get(r.submitterId) ?? null),
      excerpt: r.description.slice(0, 300),
    })),
    supportSignals: signals.slice(0, 8).map((g) => ({
      submitter: `${g.submitterType}${g.submitterTier ? `/${g.submitterTier}` : ""}`,
      impact: g.impactText,
    })),
    meanExtractionConfidence: meanConfidence,
  });

  const evidence = [...rationale.value.evidence];
  if (rationale.value.confidenceNote && rationale.value.confidenceNote.toLowerCase() !== "none") {
    evidence.push(`Confidence note: ${rationale.value.confidenceNote}`);
  }

  const saved = scoresRepo.insert({
    clusterId,
    total: breakdown.total,
    components: breakdown.components,
    rationale: rationale.value.rationale,
    evidence,
    weightsVersion,
    inputsFingerprint,
    evidenceFingerprint,
    rationaleStale: false,
    model: rationale.model,
  });

  eventsRepo.record({
    entityType: "cluster",
    entityId: clusterId,
    type: "scored",
    actor: `ai:${rationale.model}`,
    payload: { total: saved.total, previous: existing?.total ?? null, weightsVersion },
  });

  return { clusterId, total: saved.total, skipped: false, rationaleSource: "generated" };
}

const describeSubmitter = (s: ReturnType<typeof submittersRepo.findById>): string =>
  s ? `${s.type}${s.tier ? `/${s.tier}` : ""}${s.accountName ? ` @ ${s.accountName}` : ""}` : "unknown";

// ---------------------------------------------------------------------------
// Stage group 3: briefs, updates, trends
// ---------------------------------------------------------------------------

export async function generateBrief(clusterId: string) {
  const cluster = clustersRepo.findById(clusterId);
  if (!cluster) throw notFound("cluster", clusterId);

  const requests = requestsRepo.findByCluster(clusterId);
  const signals = signalsRepo.listForCluster(clusterId);
  const score = scoresRepo.latestForCluster(clusterId);
  const theme = cluster.themeId ? themesRepo.findById(cluster.themeId) : null;

  const submitters = requests
    .map((r) => submittersRepo.findById(r.submitterId))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const segmentCounts = new Map<string, number>();
  for (const s of submitters) {
    const key = s.tier ? `${s.type}/${s.tier}` : s.type;
    segmentCounts.set(key, (segmentCounts.get(key) ?? 0) + 1);
  }

  const accounts = new Map<string, number>();
  for (const s of [...submitters, ...signals.map((g) => ({ accountName: g.accountName, arrUsd: g.arrUsd }))]) {
    if (s.accountName) accounts.set(s.accountName, Math.max(accounts.get(s.accountName) ?? 0, s.arrUsd ?? 0));
  }

  const brief = await composeBrief({
    clusterTitle: cluster.title,
    canonicalNeed: cluster.canonicalNeed,
    themeName: theme?.name ?? "unassigned",
    status: cluster.status,
    score: score?.total ?? 0,
    scoreRationale: score?.rationale ?? "Not yet scored.",
    requestCount: requests.length,
    distinctAccounts: accounts.size,
    totalArrUsd: Math.round([...accounts.values()].reduce((a, b) => a + b, 0)),
    segmentBreakdown: [...segmentCounts.entries()].map(([segment, count]) => ({ segment, count })),
    requestExcerpts: requests.slice(0, 8).map((r) => ({
      title: r.title,
      submitter: describeSubmitter(submitters.find((s) => s.id === r.submitterId) ?? null),
      excerpt: r.description.slice(0, 400),
    })),
    supportSignals: signals.slice(0, 8).map((g) => ({
      submitter: `${g.submitterType}${g.submitterTier ? `/${g.submitterTier}` : ""}`,
      impact: g.impactText,
    })),
  });

  const saved = briefsRepo.insertBrief({
    clusterId,
    problem: brief.value.problem,
    evidence: brief.value.evidence,
    affectedSegments: brief.value.affectedSegments,
    recommendedPriority: brief.value.recommendedPriority,
    suggestedNextStep: brief.value.suggestedNextStep,
    risksIfIgnored: brief.value.risksIfIgnored,
    openQuestions: brief.value.openQuestions,
    model: brief.model,
  });

  eventsRepo.record({
    entityType: "cluster",
    entityId: clusterId,
    type: "brief_generated",
    actor: `ai:${brief.model}`,
    payload: { briefId: saved.id, recommendedPriority: saved.recommendedPriority },
  });

  return saved;
}

export async function generateStakeholderUpdate(
  clusterId: string,
  audience: string,
  humanNote: string,
) {
  const cluster = clustersRepo.findById(clusterId);
  if (!cluster) throw notFound("cluster", clusterId);

  const brief = briefsRepo.latestBrief(clusterId);

  const update = await composeStakeholderUpdate({
    clusterTitle: cluster.title,
    canonicalNeed: cluster.canonicalNeed,
    status: cluster.status,
    audience,
    recommendedPriority: brief?.recommendedPriority ?? "under review",
    humanNote,
  });

  const saved = briefsRepo.insertUpdate({
    clusterId,
    audience,
    subject: update.value.subject,
    body: update.value.body,
    model: update.model,
  });

  eventsRepo.record({
    entityType: "cluster",
    entityId: clusterId,
    type: "update_drafted",
    actor: `ai:${update.model}`,
    payload: { updateId: saved.id, audience },
  });

  return saved;
}

export async function computeEmergingNeeds(windowDays = 30) {
  const clusters = clustersRepo.listAll();
  const latestScores = scoresRepo.latestForAllClusters();
  const now = Date.now();
  const windowStart = new Date(now - windowDays * 86_400_000).toISOString();
  const priorStart = new Date(now - 2 * windowDays * 86_400_000).toISOString();

  const payload = clusters.map((c) => {
    const requests = requestsRepo.findByCluster(c.id);
    const submitters = requests
      .map((r) => submittersRepo.findById(r.submitterId))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    const theme = c.themeId ? themesRepo.findById(c.themeId) : null;

    return {
      clusterId: c.id,
      title: c.title,
      need: c.canonicalNeed,
      theme: theme?.name ?? "unassigned",
      totalRequests: requests.length,
      recentRequests: requests.filter((r) => r.createdAt >= windowStart).length,
      priorRequests: requests.filter((r) => r.createdAt >= priorStart && r.createdAt < windowStart)
        .length,
      distinctAccounts: new Set(submitters.map((s) => s.accountName).filter(Boolean)).size,
      score: latestScores.get(c.id)?.total ?? 0,
      segments: [...new Set(submitters.map((s) => (s.tier ? `${s.type}/${s.tier}` : s.type)))],
    };
  });

  if (payload.length === 0) {
    return { trends: [], summary: "No clusters yet.", model: "n/a" };
  }

  const result = await detectEmergingNeeds({ windowDays, clusters: payload });
  logger.info({ trends: result.value.trends.length }, "emerging needs computed");

  return { ...result.value, model: result.model };
}
