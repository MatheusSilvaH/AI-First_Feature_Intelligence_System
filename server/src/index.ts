import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { startWorker, stopWorker } from "./jobs/worker.js";
import { closeDb } from "./db/index.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      aiMode: env.AI_DRY_RUN ? "dry-run" : "live",
      primaryModel: env.ANTHROPIC_MODEL_PRIMARY,
      fastModel: env.ANTHROPIC_MODEL_FAST,
    },
    "Feature Intelligence API listening",
  );
});

if (env.AI_WORKER_ENABLED) startWorker();

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  stopWorker();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Do not let an open keep-alive connection hold the process forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
