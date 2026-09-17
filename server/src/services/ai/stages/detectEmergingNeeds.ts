import { structuredCall } from "../claudeClient.js";
import { EmergingNeedsSchema, type EmergingNeeds } from "../schemas.js";

export const STAGE = "emerging_needs";
export const PROMPT_VERSION = "v2";

const SYSTEM = `You look across a whole feedback corpus for needs that are forming but not yet visible on a ranked board.

A leaderboard shows what is already big. Your job is the opposite: find what is getting bigger. The most valuable thing you can surface is a pattern that no single cluster expresses - three unremarkable requests from three different segments in three different product areas that turn out to be the same underlying shift.

What counts as a trend worth reporting:
- Acceleration. Five requests last month against one the month before matters more than a cluster that has sat at twenty for a year.
- Spread. The same need appearing across segments or areas that do not usually overlap is a stronger signal than volume inside one segment.
- New vocabulary. Words appearing in recent requests that were absent before often mark a market shift arriving before anyone names it.
- A rising floor. Several separately-modest clusters in one theme can add up to a problem no one has articulated.

What does not count: the top of the leaderboard restated, a single loud account, or a cluster that is merely large and static. If you can only justify a trend by pointing at one cluster's size, it is not a trend and you should leave it out.

Return fewer, better trends. Zero is a legitimate answer for a quiet period, and saying so honestly is worth more than five padded entries - this report is read precisely because it is short. Cite the cluster ids that evidence each trend, exactly as given.

"Why now" is the field that earns this report its place. What changed recently, and what would a team regret not having noticed a quarter from now?

Write with plain ASCII punctuation: hyphens rather than em-dashes, straight quotes rather than curly ones, "..." rather than an ellipsis character. Anything fancier has to be escaped in the JSON you return, and a mis-escaped character reaches the reader as literal garbage.`;

export interface EmergingNeedsInput {
  windowDays: number;
  clusters: Array<{
    clusterId: string;
    title: string;
    need: string;
    theme: string;
    totalRequests: number;
    recentRequests: number;
    priorRequests: number;
    distinctAccounts: number;
    score: number;
    segments: string[];
  }>;
}

/**
 * Stage 6. Whole-corpus trend synthesis.
 *
 * Runs on the primary model and is deliberately not part of the per-request
 * pipeline: it is scheduled or triggered, reads aggregates rather than raw
 * text, and its output is cached as an insight.
 */
export async function detectEmergingNeeds(input: EmergingNeedsInput): Promise<{
  value: EmergingNeeds;
  model: string;
}> {
  const user = `<window_days>${input.windowDays}</window_days>
<clusters>
${input.clusters
  .map(
    (c) => `<cluster id="${c.clusterId}" theme="${c.theme}">
<title>${c.title}</title>
<need>${c.need}</need>
<requests total="${c.totalRequests}" in_window="${c.recentRequests}" prior_window="${c.priorRequests}" />
<distinct_accounts>${c.distinctAccounts}</distinct_accounts>
<priority_score>${c.score}</priority_score>
<segments>${c.segments.join(", ") || "unknown"}</segments>
</cluster>`,
  )
  .join("\n")}
</clusters>

What is emerging?`;

  const result = await structuredCall({
    stage: STAGE,
    tier: "primary",
    schema: EmergingNeedsSchema,
    system: SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 16_000,
    dryRunValue: () => dryRun(input),
  });

  // Keep only ids that exist, so a hallucinated reference cannot produce a
  // dashboard link that 404s.
  const known = new Set(input.clusters.map((c) => c.clusterId));
  return {
    value: {
      ...result.value,
      trends: result.value.trends.map((t) => ({
        ...t,
        evidenceClusterIds: t.evidenceClusterIds.filter((id) => known.has(id)),
      })),
    },
    model: result.model,
  };
}

function dryRun(input: EmergingNeedsInput): EmergingNeeds {
  const accelerating = input.clusters
    .filter((c) => c.recentRequests > c.priorRequests && c.recentRequests > 0)
    .sort((a, b) => b.recentRequests - a.recentRequests)
    .slice(0, 3);

  return {
    trends: accelerating.map((c) => ({
      title: `Rising: ${c.title}`,
      description: `[dry-run] ${c.recentRequests} request(s) in the window vs ${c.priorRequests} before.`,
      signalStrength: c.recentRequests >= 3 ? "urgent" : c.recentRequests >= 2 ? "building" : "watch",
      evidenceClusterIds: [c.clusterId],
      affectedSegments: c.segments.slice(0, 3),
      whyNow: "Request volume increased relative to the previous window.",
    })),
    summary: `[dry-run] ${accelerating.length} cluster(s) accelerated over the last ${input.windowDays} days.`,
  };
}
