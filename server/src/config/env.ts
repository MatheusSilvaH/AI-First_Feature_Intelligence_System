import "dotenv/config";
import { z } from "zod";

/** Env vars are always strings; accept the usual truthy spellings. */
const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return fallback;
      return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
    });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_PATH: z.string().min(1).default("./data/feature-intelligence.db"),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL_PRIMARY: z.string().min(1).default("claude-opus-5"),
    ANTHROPIC_MODEL_FAST: z.string().min(1).default("claude-haiku-4-5"),
    ANTHROPIC_EFFORT: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .default("high"),

    AI_DRY_RUN: booleanish(false),
    AI_WORKER_ENABLED: booleanish(true),
    AI_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    AI_WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    AI_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

    CORS_ORIGINS: z
      .string()
      .default("http://localhost:5173")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  .superRefine((cfg, ctx) => {
    // A missing key is only fatal when we actually intend to call Claude. Dry-run
    // mode exists precisely so CI and UI work need no credentials.
    if (!cfg.AI_DRY_RUN && !cfg.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message:
          "ANTHROPIC_API_KEY is required unless AI_DRY_RUN=true. Copy .env.example to .env and set it.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function load(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
