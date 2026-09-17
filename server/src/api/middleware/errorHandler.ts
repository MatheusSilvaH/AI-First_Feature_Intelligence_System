import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, AiPipelineError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { isProduction } from "../../config/env.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: `No route for ${req.method} ${req.path}` },
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof AiPipelineError) {
    // The pipeline failed, not the caller's request. 503 signals "try again",
    // which is the correct advice: the job queue will also be retrying.
    logger.error({ stage: err.stage, cause: err.cause }, "AI pipeline error surfaced to HTTP");
    res.status(503).json({
      error: {
        code: "ai_unavailable",
        message: "The analysis service is temporarily unavailable. The request was saved.",
        stage: err.stage,
      },
    });
    return;
  }

  // SQLite surfaces constraint violations as plain Errors with a code field.
  const sqliteCode = (err as { code?: string }).code;
  if (typeof sqliteCode === "string" && sqliteCode.startsWith("SQLITE_CONSTRAINT")) {
    res.status(409).json({
      error: { code: "constraint_violation", message: "That change conflicts with existing data." },
    });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "Something went wrong.",
      // Stacks are useful locally and a disclosure risk in production.
      ...(isProduction ? {} : { detail: err instanceof Error ? err.message : String(err) }),
    },
  });
};
