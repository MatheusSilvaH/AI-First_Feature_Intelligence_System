import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { AiPipelineError } from "../../lib/errors.js";
import { fingerprint } from "../../lib/ids.js";
import * as aiCacheRepo from "../../repositories/aiCache.repo.js";

/**
 * The single point at which this system talks to Claude.
 *
 * Everything model-related lives here: credentials, model routing, retries,
 * caching, and telemetry. Nothing else in the codebase imports the Anthropic
 * SDK, so the API key never leaves the server process and swapping a model or
 * adding a budget is a one-file change. Route handlers call services; services
 * call stages; stages call this.
 */

export type ModelTier = "primary" | "fast";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      // AI work happens on a background worker, so a generous timeout is safe
      // and cheaper than re-running a stage that was nearly finished.
      timeout: 120_000,
      maxRetries: 0, // handled below, so we can log each attempt
    });
  }
  return client;
}

export function resolveModel(tier: ModelTier): string {
  return tier === "primary" ? env.ANTHROPIC_MODEL_PRIMARY : env.ANTHROPIC_MODEL_FAST;
}

export interface StructuredCallOptions<S extends z.ZodType> {
  /** Pipeline stage name - used for cache partitioning and telemetry. */
  stage: string;
  tier: ModelTier;
  schema: S;
  /** Stable instructions. Placed first so the prompt prefix stays cacheable. */
  system: string;
  /** The volatile, per-item content. */
  user: string;
  /** Bumped whenever `system` changes, so old cache entries are not reused. */
  promptVersion: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Set false for stages whose output should always be recomputed. */
  cacheable?: boolean;
  /** Deterministic stand-in used when AI_DRY_RUN=true. */
  dryRunValue: () => z.infer<S>;
}

export interface StructuredCallResult<T> {
  value: T;
  model: string;
  cacheHit: boolean;
}

const MAX_ATTEMPTS = 3;

/**
 * Runs one pipeline stage and returns schema-validated JSON.
 *
 * Structured Outputs (`output_config.format`) is used instead of parsing free
 * text or hand-rolling a tool-call round trip: the model is constrained to the
 * schema server-side, and the SDK hands back a typed object. A stage that
 * cannot produce valid output after its retries throws rather than returning a
 * half-populated record - a wrong score is worse than a missing one.
 */
export async function structuredCall<S extends z.ZodType>(
  options: StructuredCallOptions<S>,
): Promise<StructuredCallResult<z.infer<S>>> {
  type Out = z.infer<S>;
  const model = resolveModel(options.tier);
  const cacheable = options.cacheable !== false;

  const cacheKey = fingerprint({
    stage: options.stage,
    model,
    promptVersion: options.promptVersion,
    system: options.system,
    user: options.user,
  });

  if (cacheable) {
    const cached = aiCacheRepo.get<Out>(cacheKey);
    if (cached) {
      // Re-validate: a schema change since the entry was written should be a
      // cache miss, not a silently stale shape flowing into the database.
      const revalidated = options.schema.safeParse(cached.output);
      if (revalidated.success) {
        aiCacheRepo.logCall({
          stage: options.stage,
          model: cached.model,
          cacheHit: true,
          latencyMs: 0,
          ok: true,
        });
        return { value: revalidated.data as Out, model: cached.model, cacheHit: true };
      }
    }
  }

  if (env.AI_DRY_RUN) {
    const value = options.dryRunValue();
    if (cacheable) {
      aiCacheRepo.put({ cacheKey, stage: options.stage, model: "dry-run", output: value });
    }
    aiCacheRepo.logCall({
      stage: options.stage,
      model: "dry-run",
      cacheHit: false,
      latencyMs: 0,
      ok: true,
    });
    return { value, model: "dry-run", cacheHit: false };
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await getClient().messages.parse({
        model,
        max_tokens: options.maxTokens ?? 8_000,
        // Stable prefix first, marked cacheable. The system prompt for a stage
        // is identical across every request that stage processes, so this turns
        // the bulk of repeated input into ~0.1x-cost cache reads.
        system: [
          { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: options.user }],
        output_config: {
          format: zodOutputFormat(options.schema),
          effort: options.effort ?? (options.tier === "primary" ? env.ANTHROPIC_EFFORT : "low"),
        },
      });

      const latencyMs = Date.now() - startedAt;

      // A refusal returns HTTP 200 with no usable content - check before reading.
      if (response.stop_reason === "refusal") {
        throw new AiPipelineError(
          options.stage,
          `model declined the request (${response.stop_details?.category ?? "unspecified"})`,
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new AiPipelineError(
          options.stage,
          "output truncated at max_tokens; raise maxTokens for this stage",
        );
      }

      const parsed = response.parsed_output as Out | null;
      if (parsed === null || parsed === undefined) {
        throw new AiPipelineError(options.stage, "response contained no parseable JSON output");
      }

      aiCacheRepo.logCall({
        stage: options.stage,
        model,
        cacheHit: false,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        latencyMs,
        ok: true,
      });

      if (cacheable) {
        aiCacheRepo.put({
          cacheKey,
          stage: options.stage,
          model,
          output: parsed,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        });
      }

      return { value: parsed, model, cacheHit: false };
    } catch (err) {
      lastError = err;
      const latencyMs = Date.now() - startedAt;
      const retryable = isRetryable(err);

      aiCacheRepo.logCall({
        stage: options.stage,
        model,
        cacheHit: false,
        latencyMs,
        ok: false,
        error: errorMessage(err),
      });

      logger.warn(
        { stage: options.stage, attempt, retryable, err: errorMessage(err) },
        "claude call failed",
      );

      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(backoffMs(attempt, err));
    }
  }

  throw new AiPipelineError(options.stage, `failed after ${MAX_ATTEMPTS} attempts`, lastError);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status !== undefined && err.status >= 500;
  // AiPipelineError covers truncation and unparseable output. Both are worth one
  // more roll of the dice; a refusal is not, but re-asking is cheap and bounded.
  return err instanceof AiPipelineError;
}

function backoffMs(attempt: number, err: unknown): number {
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(err.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  }
  // Exponential with jitter, so a burst of failed jobs does not retry in lockstep.
  return 2 ** attempt * 500 + Math.random() * 400;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: lets the suite inject a fake without touching the network. */
export function __setClientForTesting(fake: Anthropic | null): void {
  client = fake;
}
