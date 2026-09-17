import { Router } from "express";
import { body, query, pathParam, validateBody, validateQuery } from "../middleware/validate.js";
import { idempotency } from "../middleware/idempotency.js";
import { writeLimiter, readLimiter } from "../middleware/rateLimit.js";
import {
  CreateRequestSchema,
  ListRequestsQuerySchema,
  SupportRequestSchema,
  SplitRequestSchema,
} from "../schemas.js";
import * as requestsService from "../../services/requests.service.js";
import * as clustersService from "../../services/clusters.service.js";
import type { z } from "zod";

export const requestsRouter = Router();

/**
 * POST /api/requests
 * Persists the request and returns 202 - the AI analysis runs on the worker.
 * Returning 200 here would imply the analysis is done, which it is not.
 */
requestsRouter.post(
  "/",
  writeLimiter,
  idempotency,
  validateBody(CreateRequestSchema),
  (req, res) => {
    const input = body<z.infer<typeof CreateRequestSchema>>(req);
    const result = requestsService.submitRequest(input);

    res.status(202).json({
      request: result.request,
      submitter: { id: result.submitter.id, name: result.submitter.name },
      analysisStatus: result.analysisStatus,
      message:
        "Request received. It is being analysed for duplicates, underlying need and priority.",
    });
  },
);

/** GET /api/requests - search, filter, paginate. */
requestsRouter.get("/", readLimiter, validateQuery(ListRequestsQuerySchema), (req, res) => {
  const q = query<z.infer<typeof ListRequestsQuerySchema>>(req);
  res.json(requestsService.listRequests(q));
});

/** GET /api/requests/:id - full detail including the AI's reasoning. */
requestsRouter.get("/:id", readLimiter, (req, res) => {
  res.json(requestsService.getRequestDetail(pathParam(req.params, "id")));
});

/**
 * POST /api/requests/:id/support
 * The upvote replacement: supporters must describe their own impact.
 */
requestsRouter.post(
  "/:id/support",
  writeLimiter,
  idempotency,
  validateBody(SupportRequestSchema),
  (req, res) => {
    const input = body<z.infer<typeof SupportRequestSchema>>(req);
    const result = requestsService.addSupport({ requestId: pathParam(req.params, "id"), ...input });
    res.status(201).json(result);
  },
);

/** POST /api/requests/:id/split - human override of an AI merge. */
requestsRouter.post(
  "/:id/split",
  writeLimiter,
  validateBody(SplitRequestSchema),
  (req, res) => {
    const input = body<z.infer<typeof SplitRequestSchema>>(req);
    res.json(clustersService.splitRequest(pathParam(req.params, "id"), input.actor, input.reason));
  },
);
