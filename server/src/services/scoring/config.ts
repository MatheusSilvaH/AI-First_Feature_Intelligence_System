import { z } from "zod";
import * as settingsRepo from "../../repositories/settings.repo.js";
import { SEVERITY_LEVELS, SUBMITTER_TYPES, CUSTOMER_TIERS } from "../../domain/types.js";

export const SCORING_CONFIG_KEY = "scoring_config";

const weightRecord = <T extends readonly string[]>(keys: T) =>
  z.object(
    Object.fromEntries(keys.map((k) => [k, z.number().min(0).max(1000)])) as {
      [K in T[number]]: z.ZodNumber;
    },
  );

export const ScoringConfigSchema = z.object({
  /**
   * Relative importance of each component. Normalised at read time, so an
   * operator can type 40/25/15/10/10 without having to make them sum to 1.
   */
  componentWeights: z.object({
    submitterWeight: z.number().min(0),
    reach: z.number().min(0),
    severity: z.number().min(0),
    strategicAlignment: z.number().min(0),
    urgency: z.number().min(0),
  }),

  /** Base authority of each submitter type, 0-100. */
  submitterTypeWeights: weightRecord(SUBMITTER_TYPES),

  /** Multiplier applied on top of the type weight for paying customers. */
  customerTierMultipliers: weightRecord(CUSTOMER_TIERS),

  /** Maps the model's categorical severity onto a 0-100 scale. */
  severityScores: weightRecord(SEVERITY_LEVELS),

  /**
   * Half-saturation constants for reach. A value of k means "this many gets
   * you 50 points"; growth past it has diminishing returns, which stops one
   * loud cluster of near-identical tickets from dominating the board.
   */
  reachSaturation: z.object({
    requests: z.number().positive(),
    accounts: z.number().positive(),
    arrUsd: z.number().positive(),
  }),

  reachMix: z.object({
    requests: z.number().min(0),
    accounts: z.number().min(0),
    arr: z.number().min(0),
  }),

  /**
   * Current product strategy, in plain language. Injected into the analysis
   * prompt so "strategic alignment" is measured against something explicit
   * rather than the model's guess at what the company cares about.
   */
  strategyPillars: z.array(z.string().min(3)).min(1),
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  componentWeights: {
    submitterWeight: 25,
    reach: 25,
    severity: 20,
    strategicAlignment: 20,
    urgency: 10,
  },
  submitterTypeWeights: {
    customer: 100,
    prospect: 70,
    support: 60,
    internal: 40,
  },
  customerTierMultipliers: {
    enterprise: 1.0,
    growth: 0.85,
    starter: 0.7,
    free: 0.5,
  },
  severityScores: {
    blocker: 100,
    major: 75,
    moderate: 45,
    minor: 20,
  },
  reachSaturation: {
    requests: 4,
    accounts: 3,
    arrUsd: 250_000,
  },
  reachMix: {
    requests: 0.4,
    accounts: 0.35,
    arr: 0.25,
  },
  strategyPillars: [
    "Enterprise readiness: SSO, audit logs, granular permissions, compliance controls",
    "Time-to-value: reduce the work required to get a first successful result",
    "Workflow integration: fit into the tools teams already run their day in",
    "Platform extensibility: public API, webhooks, and programmatic access",
  ],
};

/** Reads the operator-tunable config, seeding defaults on first access. */
export function getScoringConfig(): { config: ScoringConfig; version: string } {
  const stored = settingsRepo.get<unknown>(SCORING_CONFIG_KEY);
  if (!stored) {
    const seeded = settingsRepo.put(SCORING_CONFIG_KEY, DEFAULT_SCORING_CONFIG);
    return { config: DEFAULT_SCORING_CONFIG, version: seeded.version };
  }

  const parsed = ScoringConfigSchema.safeParse(stored.value);
  if (!parsed.success) {
    // A malformed stored config must not take scoring down; fall back to
    // defaults and let the operator see the mismatch in the settings endpoint.
    return { config: DEFAULT_SCORING_CONFIG, version: `${stored.version}-invalid` };
  }
  return { config: parsed.data, version: stored.version };
}

export function setScoringConfig(next: ScoringConfig): { config: ScoringConfig; version: string } {
  const stored = settingsRepo.put(SCORING_CONFIG_KEY, next);
  return { config: next, version: stored.version };
}
