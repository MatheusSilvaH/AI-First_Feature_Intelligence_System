import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Level } from "pino";
import type { Request, Response } from "express";

import { env, isTest } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { getDb } from "./db/index.js";
import { errorHandler, notFoundHandler } from "./api/middleware/errorHandler.js";
import { requestsRouter } from "./api/routes/requests.routes.js";
import { clustersRouter, reviewRouter } from "./api/routes/clusters.routes.js";
import { analyticsRouter, settingsRouter } from "./api/routes/analytics.routes.js";
import * as jobsRepo from "./repositories/jobs.repo.js";

export function createApp() {
  // Touch the database at construction so a bad schema fails at boot rather
  // than on the first request.
  getDb();

  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: false }));
  app.use(express.json({ limit: "256kb" }));

  if (!isTest) {
    app.use(
      // The `never` custom-levels argument is required: without it TypeScript
      // infers the level union from `customLogLevel` and then rejects the
      // standard logger for not declaring those as custom levels.
      pinoHttp<Request, Response, never>({
        logger,
        // Health checks would otherwise dominate the log at info level.
        customLogLevel: (_req, res, err): Level =>
          err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        autoLogging: { ignore: (req) => req.url === "/api/health" },
      }),
    );
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      aiMode: env.AI_DRY_RUN ? "dry-run" : "live",
      models: { primary: env.ANTHROPIC_MODEL_PRIMARY, fast: env.ANTHROPIC_MODEL_FAST },
      queueDepth: jobsRepo.pendingCount(),
    });
  });

  app.use("/api/requests", requestsRouter);
  app.use("/api/clusters", clustersRouter);
  app.use("/api/review", reviewRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/settings", settingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
