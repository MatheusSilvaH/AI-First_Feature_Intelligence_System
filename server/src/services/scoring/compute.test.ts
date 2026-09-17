import { describe, it, expect } from "vitest";
import { computeScore, contributorWeight, type Contributor } from "./compute.js";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config.js";

/**
 * The scoring maths is the one part of the ranking that must be exactly
 * predictable, because it is what a product leader is implicitly trusting when
 * they reorder a roadmap. These tests pin the properties that make the score
 * defensible, not just the arithmetic.
 */

const config = DEFAULT_SCORING_CONFIG;

const contributor = (over: Partial<Contributor> = {}): Contributor => ({
  submitterType: "customer",
  tier: "enterprise",
  accountName: "Acme",
  arrUsd: 100_000,
  viaSupportSignal: false,
  ...over,
});

const analysis = (over: Partial<{ severity: "blocker" | "major" | "moderate" | "minor"; urgency: number; strategicAlignment: number }> = {}) => ({
  severity: "major" as const,
  urgency: 50,
  strategicAlignment: 50,
  ...over,
});

describe("contributorWeight", () => {
  it("ranks submitter types in the configured order", () => {
    const base = { tier: null, accountName: null, arrUsd: null, viaSupportSignal: false };
    const asType = (type: Contributor["submitterType"]) =>
      contributorWeight({ ...base, submitterType: type }, config);

    expect(asType("customer")).toBeGreaterThan(asType("prospect"));
    expect(asType("prospect")).toBeGreaterThan(asType("support"));
    expect(asType("support")).toBeGreaterThan(asType("internal"));
  });

  it("scales a paying customer by tier", () => {
    const enterprise = contributorWeight(contributor({ tier: "enterprise" }), config);
    const free = contributorWeight(contributor({ tier: "free" }), config);
    expect(enterprise).toBeGreaterThan(free);
  });

  it("ignores tier for internal submitters, who have no commercial tier", () => {
    const withTier = contributorWeight(
      contributor({ submitterType: "internal", tier: "enterprise" }),
      config,
    );
    const withoutTier = contributorWeight(
      contributor({ submitterType: "internal", tier: null }),
      config,
    );
    expect(withTier).toBe(withoutTier);
  });
});

describe("computeScore", () => {
  it("returns zero for a cluster with no evidence", () => {
    const result = computeScore({ contributors: [], analyses: [], requestCount: 0 }, config);
    expect(result.total).toBe(0);
  });

  it("keeps every component and the total within 0-100", () => {
    const result = computeScore(
      {
        contributors: Array.from({ length: 50 }, () => contributor({ arrUsd: 5_000_000 })),
        analyses: Array.from({ length: 50 }, () => analysis({ severity: "blocker", urgency: 100, strategicAlignment: 100 })),
        requestCount: 50,
      },
      config,
    );

    expect(result.total).toBeLessThanOrEqual(100);
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("does not let volume from low-weight sources dilute a high-weight voice", () => {
    // This is the property the tier hierarchy exists to protect: one blocked
    // enterprise customer must not be averaged away by internal chatter.
    const enterpriseOnly = computeScore(
      { contributors: [contributor()], analyses: [analysis()], requestCount: 1 },
      config,
    );
    const enterprisePlusNoise = computeScore(
      {
        contributors: [
          contributor(),
          ...Array.from({ length: 10 }, () =>
            contributor({ submitterType: "internal", tier: null, accountName: null, arrUsd: null }),
          ),
        ],
        analyses: [analysis()],
        requestCount: 11,
      },
      config,
    );

    expect(enterprisePlusNoise.components.submitterWeight).toBe(
      enterpriseOnly.components.submitterWeight,
    );
  });

  it("counts each account's ARR once, however many people from it contribute", () => {
    const one = computeScore(
      {
        contributors: [contributor({ accountName: "Acme", arrUsd: 100_000 })],
        analyses: [analysis()],
        requestCount: 1,
      },
      config,
    );
    const threeFromSameAccount = computeScore(
      {
        contributors: [
          contributor({ accountName: "Acme", arrUsd: 100_000 }),
          contributor({ accountName: "Acme", arrUsd: 100_000 }),
          contributor({ accountName: "Acme", arrUsd: 100_000 }),
        ],
        analyses: [analysis()],
        requestCount: 1,
      },
      config,
    );

    expect(threeFromSameAccount.facts.totalArrUsd).toBe(one.facts.totalArrUsd);
    expect(threeFromSameAccount.facts.distinctAccounts).toBe(1);
  });

  it("gives reach diminishing returns rather than growing without bound", () => {
    const reachAt = (n: number) =>
      computeScore(
        {
          contributors: Array.from({ length: n }, (_, i) =>
            contributor({ accountName: `Account ${i}`, arrUsd: 50_000 }),
          ),
          analyses: [analysis()],
          requestCount: n,
        },
        config,
      ).components.reach;

    const firstJump = reachAt(4) - reachAt(2);
    const laterJump = reachAt(22) - reachAt(20);

    expect(firstJump).toBeGreaterThan(laterJump);
    expect(reachAt(100)).toBeLessThanOrEqual(100);
  });

  it("takes the worst severity in the cluster, not the average", () => {
    const result = computeScore(
      {
        contributors: [contributor()],
        analyses: [analysis({ severity: "minor" }), analysis({ severity: "blocker" })],
        requestCount: 2,
      },
      config,
    );
    expect(result.components.severity).toBe(config.severityScores.blocker);
  });

  it("re-weighting changes the ranking without changing the underlying judgments", () => {
    const inputs = {
      contributors: [contributor({ submitterType: "internal", tier: null })],
      analyses: [analysis({ severity: "blocker", urgency: 10, strategicAlignment: 20 })],
      requestCount: 1,
    };

    const severityHeavy: ScoringConfig = {
      ...config,
      componentWeights: {
        submitterWeight: 0,
        reach: 0,
        severity: 100,
        strategicAlignment: 0,
        urgency: 0,
      },
    };
    const urgencyHeavy: ScoringConfig = {
      ...config,
      componentWeights: {
        submitterWeight: 0,
        reach: 0,
        severity: 0,
        strategicAlignment: 0,
        urgency: 100,
      },
    };

    const a = computeScore(inputs, severityHeavy);
    const b = computeScore(inputs, urgencyHeavy);

    expect(a.total).toBe(100);
    expect(b.total).toBe(10);
    // Same model judgments, different totals - no inference call in between.
    expect(a.components.severity).toBe(b.components.severity);
  });

  it("normalises weights that do not sum to 100", () => {
    const doubled: ScoringConfig = {
      ...config,
      componentWeights: {
        submitterWeight: 50,
        reach: 50,
        severity: 40,
        strategicAlignment: 40,
        urgency: 20,
      },
    };
    const inputs = {
      contributors: [contributor()],
      analyses: [analysis()],
      requestCount: 3,
    };

    expect(computeScore(inputs, doubled).total).toBeCloseTo(
      computeScore(inputs, config).total,
      5,
    );
  });
});
