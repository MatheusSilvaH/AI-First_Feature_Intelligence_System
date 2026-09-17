import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The AI pipeline, job queue and SQLite handles are process-global. Running
    // files in a single fork keeps one test file from tearing down another's DB.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      ANTHROPIC_API_KEY: "sk-ant-test-key-not-used",
      AI_DRY_RUN: "true",
      AI_WORKER_ENABLED: "false",
      LOG_LEVEL: "silent",
    },
  },
});
