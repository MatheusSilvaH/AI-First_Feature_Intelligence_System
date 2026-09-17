import rateLimit from "express-rate-limit";
import { env, isTest } from "../../config/env.js";

/**
 * Public write endpoints are the ones that cost money: each accepted request
 * turns into Claude calls on the worker. Limiting them protects the API budget
 * as much as the server.
 */
export const writeLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => isTest,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many submissions from this address. Try again shortly.",
    },
  },
});

/** Generous cap on reads - mostly a guard against a runaway client. */
export const readLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX * 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * Endpoints that trigger AI work on demand (briefs, trend reports, full
 * rescores). Tight, because each call is an immediate Opus-tier spend.
 */
export const aiTriggerLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => isTest,
  message: {
    error: {
      code: "rate_limited",
      message: "Too many AI generation requests. Try again shortly.",
    },
  },
});
