import { Router } from "express";
import { body, query, validateBody, validateQuery } from "../middleware/validate.js";
import { readLimiter, aiTriggerLimiter, writeLimiter } from "../middleware/rateLimit.js";
import {
  TopClustersQuerySchema,
  ClusterPageQuerySchema,
  TrendQuerySchema,
  EmergingQuerySchema,
  UpdateScoringConfigSchema,
} from "../schemas.js";
import * as analytics from "../../services/analytics.service.js";
import * as pipeline from "../../services/intelligence/pipeline.js";
import * as insights from "../../services/insights.service.js";
import { getScoringConfig, setScoringConfig } from "../../services/scoring/config.js";
import * as jobsRepo from "../../repositories/jobs.repo.js";
import * as eventsRepo from "../../repositories/events.repo.js";
import { JOB_TYPES } from "../../jobs/types.js";
import type { z } from "zod";

export const analyticsRouter = Router();

/**
 * One call for the whole dashboard. The alternative - five parallel requests
 * from the client - means five round trips and a page that assembles in stages.
 */
analyticsRouter.get("/dashboard", readLimiter, validateQuery(TrendQuerySchema), (req, res) => {
  const { days } = query<z.infer<typeof TrendQuerySchema>>(req);
  // The ranked cluster list is deliberately not included here any more - it is
  // paged and filtered independently via /analytics/clusters, so paging must
  // not refetch the charts and the charts must not refetch the list.
  res.json({
    byTheme: analytics.byTheme(3),
    volumeTrend: analytics.volumeTrend(days),
    submitterMix: analytics.submitterMix(),
    scoreDistribution: analytics.scoreDistribution(),
    metrics: analytics.operationalMetrics(),
  });
});

analyticsRouter.get("/top", readLimiter, validateQuery(TopClustersQuerySchema), (req, res) => {
  const q = query<z.infer<typeof TopClustersQuerySchema>>(req);
  res.json({ clusters: analytics.topClusters(q) });
});

/**
 * GET /api/analytics/clusters
 *
 * The paged, searchable ranked list behind the dashboard. Paging and filtering
 * are done in SQL over the whole dataset, not over a previously-loaded page.
 *
 * `?focus=<clusterId>` additionally resolves where that cluster sits in the
 * current ranking, so a deep link carrying only an id can land on the right
 * page. An id that no longer exists comes back as `found: false` rather than
 * an error, so the UI can say "not found" instead of rendering nothing.
 */
analyticsRouter.get(
  "/clusters",
  readLimiter,
  validateQuery(ClusterPageQuerySchema),
  (req, res) => {
    const q = query<z.infer<typeof ClusterPageQuerySchema>>(req);
    const filters = { search: q.search, themeId: q.themeId, status: q.status };

    const focus = q.focus ? analytics.locateCluster(q.focus, filters, q.pageSize) : null;

    // When a focus target resolves, serve the page it lives on. That saves the
    // client a second round trip on the deep-link path.
    const page = focus?.found && focus.page ? focus.page : q.page;

    res.json({
      ...analytics.listRankedClusters({ ...filters, page, pageSize: q.pageSize }),
      focus,
    });
  },
);

analyticsRouter.get("/by-theme", readLimiter, (_req, res) => {
  res.json({ themes: analytics.byTheme(5) });
});

analyticsRouter.get("/metrics", readLimiter, (_req, res) => {
  res.json(analytics.operationalMetrics());
});

/**
 * Emerging needs is the expensive whole-corpus call, so it serves a cached
 * report by default and only recomputes when explicitly refreshed.
 */
analyticsRouter.get(
  "/emerging",
  aiTriggerLimiter,
  validateQuery(EmergingQuerySchema),
  async (req, res) => {
    const { windowDays, refresh } = query<z.infer<typeof EmergingQuerySchema>>(req);

    if (!refresh) {
      const cached = insights.latestEmergingNeeds();
      if (cached) {
        res.json({ ...cached, cached: true });
        return;
      }
    }

    const fresh = await pipeline.computeEmergingNeeds(windowDays);
    insights.saveEmergingNeeds(fresh);
    res.json({ ...fresh, cached: false, createdAt: new Date().toISOString() });
  },
);

analyticsRouter.get("/activity", readLimiter, (_req, res) => {
  res.json({ events: eventsRepo.recent(40) });
});

// ---------------------------------------------------------------------------
// Scoring configuration - the knobs behind the ranking
// ---------------------------------------------------------------------------

export const settingsRouter = Router();

settingsRouter.get("/scoring", readLimiter, (_req, res) => {
  res.json(getScoringConfig());
});

/**
 * Changing the weights changes every score, so this fans out a rescore. Because
 * the scoring maths is deterministic and the model's judgments are cached, the
 * whole board re-ranks without a single new inference call unless a cluster's
 * underlying evidence also changed.
 */
settingsRouter.put(
  "/scoring",
  writeLimiter,
  validateBody(UpdateScoringConfigSchema),
  (req, res) => {
    const input = body<z.infer<typeof UpdateScoringConfigSchema>>(req);
    const saved = setScoringConfig(input.config);

    eventsRepo.record({
      entityType: "settings",
      entityId: "scoring",
      type: "scoring_config_changed",
      actor: input.actor,
      payload: { version: saved.version },
    });

    jobsRepo.enqueue({ type: JOB_TYPES.RESCORE_ALL, dedupeKey: "rescore_all" });
    res.json({ ...saved, rescoreQueued: true });
  },
);
