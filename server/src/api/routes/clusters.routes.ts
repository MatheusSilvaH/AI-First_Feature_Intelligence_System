import { Router } from "express";
import { body, pathParam, validateBody } from "../middleware/validate.js";
import { readLimiter, writeLimiter, aiTriggerLimiter } from "../middleware/rateLimit.js";
import {
  UpdateClusterStatusSchema,
  ResolveSuggestionSchema,
  ReviseBriefSchema,
  GenerateUpdateSchema,
} from "../schemas.js";
import * as clustersService from "../../services/clusters.service.js";
import * as pipeline from "../../services/intelligence/pipeline.js";
import * as themesRepo from "../../repositories/themes.repo.js";
import type { z } from "zod";

export const clustersRouter = Router();

clustersRouter.get("/", readLimiter, (_req, res) => {
  res.json({ themes: themesRepo.listAll() });
});

clustersRouter.get("/:id", readLimiter, (req, res) => {
  res.json(clustersService.getClusterDetail(pathParam(req.params, "id")));
});

clustersRouter.patch(
  "/:id/status",
  writeLimiter,
  validateBody(UpdateClusterStatusSchema),
  (req, res) => {
    const input = body<z.infer<typeof UpdateClusterStatusSchema>>(req);
    res.json(clustersService.updateClusterStatus(pathParam(req.params, "id"), input.status, input.actor));
  },
);

/**
 * POST /api/clusters/:id/brief
 * Synchronous on purpose: a human clicked "generate brief" and is waiting to
 * read it, so queueing would just mean polling. Rate-limited because it is an
 * on-demand Opus-tier call.
 */
clustersRouter.post("/:id/brief", aiTriggerLimiter, async (req, res) => {
  res.json(await pipeline.generateBrief(pathParam(req.params, "id")));
});

clustersRouter.post(
  "/:id/updates",
  aiTriggerLimiter,
  validateBody(GenerateUpdateSchema),
  async (req, res) => {
    const input = body<z.infer<typeof GenerateUpdateSchema>>(req);
    const update = await pipeline.generateStakeholderUpdate(
      pathParam(req.params, "id"),
      input.audience,
      input.note,
    );
    res.status(201).json(update);
  },
);

/**
 * Re-run scoring on demand. `?force=true` also regenerates the explanation,
 * which is how a reader refreshes a rationale that was carried over from before
 * a weight change.
 */
clustersRouter.post("/:id/rescore", aiTriggerLimiter, async (req, res) => {
  const force = req.query.force === "true";
  res.json(await pipeline.scoreCluster(pathParam(req.params, "id"), force));
});

export const reviewRouter = Router();

/** The human-in-the-loop queue: merges the model was not confident enough to apply. */
reviewRouter.get("/merge-suggestions", readLimiter, (_req, res) => {
  res.json({ suggestions: clustersService.listPendingSuggestions() });
});

reviewRouter.post(
  "/merge-suggestions/:id/accept",
  writeLimiter,
  validateBody(ResolveSuggestionSchema),
  (req, res) => {
    const input = body<z.infer<typeof ResolveSuggestionSchema>>(req);
    res.json(clustersService.acceptMergeSuggestion(pathParam(req.params, "id"), input.actor));
  },
);

reviewRouter.post(
  "/merge-suggestions/:id/reject",
  writeLimiter,
  validateBody(ResolveSuggestionSchema),
  (req, res) => {
    const input = body<z.infer<typeof ResolveSuggestionSchema>>(req);
    res.json(clustersService.rejectMergeSuggestion(pathParam(req.params, "id"), input.actor));
  },
);

reviewRouter.post(
  "/briefs/:id/revise",
  writeLimiter,
  validateBody(ReviseBriefSchema),
  (req, res) => {
    const { approve, actor, ...patch } = body<z.infer<typeof ReviseBriefSchema>>(req);
    res.json(clustersService.reviseBrief(pathParam(req.params, "id"), patch, approve ? actor : null));
  },
);

reviewRouter.post(
  "/updates/:id/sent",
  writeLimiter,
  validateBody(ResolveSuggestionSchema),
  (req, res) => {
    const input = body<z.infer<typeof ResolveSuggestionSchema>>(req);
    res.json(clustersService.markUpdateSent(pathParam(req.params, "id"), input.actor));
  },
);
