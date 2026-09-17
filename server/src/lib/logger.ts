import { pino } from "pino";
import { env, isProduction } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // Never let an API key reach the log stream, however it got attached.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "apiKey",
      "*.apiKey",
      "ANTHROPIC_API_KEY",
    ],
    censor: "[redacted]",
  },
  ...(isProduction || env.LOG_LEVEL === "silent"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});

export type Logger = typeof logger;
