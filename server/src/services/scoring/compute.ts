import type {
  CustomerTier,
  RequestAnalysis,
  ScoreComponents,
  SubmitterType,
} from "../../domain/types.js";
import type { ScoringConfig } from "./config.js";

/**
 * Deterministic scoring.
 *
 * The model supplies *judgments* (how severe, how urgent, how strategic) which
 * are cached on each request. This module supplies the *arithmetic*. Keeping
 * them apart is the point: product leadership can re-weight the board and see
 * the new ranking instantly, with no LLM calls, no cost, and no risk that a
 * re-run quietly changes the underlying judgments at the same time.
 */

export interface Contributor {
  submitterType: SubmitterType;
  tier: CustomerTier | null;
  accountName: string | null;
  arrUsd: number | null;
  /** True when this person supported an existing cluster rather than filing. */
  viaSupportSignal: boolean;
}

export interface ScoreInputs {
  contributors: Contributor[];
  analyses: Array<Pick<RequestAnalysis, "severity" | "urgency" | "strategicAlignment">>;
  requestCount: number;
}

export interface ScoreBreakdown {
  total: number;
  components: ScoreComponents;
  /** Normalised weights actually applied, for display next to the score. */
  appliedWeights: Record<keyof ScoreComponents, number>;
  facts: {
    requestCount: number;
    distinctAccounts: number;
    totalArrUsd: number;
    topContributor: { type: SubmitterType; tier: CustomerTier | null; weight: number } | null;
    severityPeak: number;
    meanUrgency: number;
    meanStrategicAlignment: number;
  };
}

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));

/** Diminishing returns: returns 50 at x === k, approaches 100 as x grows. */
const saturate = (x: number, k: number): number => (x <= 0 ? 0 : (100 * x) / (x + k));

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function contributorWeight(c: Contributor, config: ScoringConfig): number {
  const base = config.submitterTypeWeights[c.submitterType] ?? 0;
  // Tier only modulates paying/paying-soon voices. An internal stakeholder has
  // no tier, and applying a customer multiplier to them would be meaningless.
  const multiplier =
    (c.submitterType === "customer" || c.submitterType === "prospect") && c.tier
      ? (config.customerTierMultipliers[c.tier] ?? 1)
      : 1;
  return clamp(base * multiplier);
}

export function computeScore(inputs: ScoreInputs, config: ScoringConfig): ScoreBreakdown {
  const { contributors, analyses, requestCount } = inputs;

  // --- submitter authority -------------------------------------------------
  // The strongest voice wins rather than the average. A blocked enterprise
  // customer is not made less blocked by ten internal "nice to have" notes,
  // and averaging would let volume from low-weight sources dilute exactly the
  // signal the tier hierarchy exists to protect.
  const weights = contributors.map((c) => contributorWeight(c, config));
  const submitterWeight = weights.length === 0 ? 0 : Math.max(...weights);

  const topIndex = weights.indexOf(submitterWeight);
  const top = topIndex >= 0 ? contributors[topIndex] : undefined;

  // --- reach ---------------------------------------------------------------
  const accounts = new Set(
    contributors.map((c) => c.accountName).filter((a): a is string => Boolean(a)),
  );
  // ARR is per account, not per contributor - two people from the same account
  // must not count their company's revenue twice.
  const arrByAccount = new Map<string, number>();
  for (const c of contributors) {
    if (c.accountName && typeof c.arrUsd === "number") {
      arrByAccount.set(c.accountName, Math.max(arrByAccount.get(c.accountName) ?? 0, c.arrUsd));
    }
  }
  const totalArr = [...arrByAccount.values()].reduce((a, b) => a + b, 0);

  const mix = config.reachMix;
  const mixTotal = mix.requests + mix.accounts + mix.arr || 1;
  const reach = clamp(
    (saturate(requestCount, config.reachSaturation.requests) * mix.requests +
      saturate(accounts.size, config.reachSaturation.accounts) * mix.accounts +
      saturate(totalArr, config.reachSaturation.arrUsd) * mix.arr) /
      mixTotal,
  );

  // --- model judgments -----------------------------------------------------
  const severityValues = analyses.map((a) => config.severityScores[a.severity] ?? 0);
  const severity = severityValues.length === 0 ? 0 : Math.max(...severityValues);
  const urgency = clamp(mean(analyses.map((a) => a.urgency)));
  const strategicAlignment = clamp(mean(analyses.map((a) => a.strategicAlignment)));

  const components: ScoreComponents = {
    submitterWeight: round(submitterWeight),
    reach: round(reach),
    severity: round(severity),
    strategicAlignment: round(strategicAlignment),
    urgency: round(urgency),
  };

  // --- weighted total ------------------------------------------------------
  const cw = config.componentWeights;
  const weightSum =
    cw.submitterWeight + cw.reach + cw.severity + cw.strategicAlignment + cw.urgency || 1;

  const appliedWeights = {
    submitterWeight: cw.submitterWeight / weightSum,
    reach: cw.reach / weightSum,
    severity: cw.severity / weightSum,
    strategicAlignment: cw.strategicAlignment / weightSum,
    urgency: cw.urgency / weightSum,
  };

  const total = round(
    components.submitterWeight * appliedWeights.submitterWeight +
      components.reach * appliedWeights.reach +
      components.severity * appliedWeights.severity +
      components.strategicAlignment * appliedWeights.strategicAlignment +
      components.urgency * appliedWeights.urgency,
  );

  return {
    total,
    components,
    appliedWeights,
    facts: {
      requestCount,
      distinctAccounts: accounts.size,
      totalArrUsd: Math.round(totalArr),
      topContributor: top
        ? { type: top.submitterType, tier: top.tier, weight: round(submitterWeight) }
        : null,
      severityPeak: round(severity),
      meanUrgency: round(urgency),
      meanStrategicAlignment: round(strategicAlignment),
    },
  };
}

const round = (n: number): number => Math.round(n * 10) / 10;
