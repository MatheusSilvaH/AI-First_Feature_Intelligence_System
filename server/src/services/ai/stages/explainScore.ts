import { structuredCall } from "../claudeClient.js";
import { ScoreRationaleSchema, type ScoreRationale } from "../schemas.js";
import type { ScoreBreakdown } from "../../scoring/compute.js";

export const STAGE = "explain_score";
export const PROMPT_VERSION = "v2";

const SYSTEM = `You explain priority scores to product leaders who will act on them.

The score has already been computed. You are not re-deciding it and you are not defending it - you are making it legible, including where it looks wrong.

The arithmetic is fixed and deterministic: each component is 0-100, and the total is their weighted average using the weights shown. Your explanation must be consistent with the numbers you are given. Never introduce a figure that is not in the input - no invented customer counts, no invented revenue, no guesses at how many accounts "probably" care.

Lead with what actually moved this score. Usually one or two components dominate and the rest are noise; say which, and say what the number represents in human terms. "Reach is 34 because four requests came from three accounts" tells a reader something. "Reach is 34" does not.

Say what held it back, in the same concrete way.

Then flag anything that makes the score untrustworthy, and be willing to undercut it. A high score resting on one request from one account is worth less than a middling score drawn from twelve accounts across two segments, and the total does not show that difference. If the extraction confidence was low, if every contributor is internal, if the support signals all arrived the same afternoon - say so plainly in the confidence note. A leader who cannot tell a solid 70 from a fragile 70 will eventually stop trusting all of them.

Draw evidence bullets only from the supplied requests and support signals. Quote or closely paraphrase real submitter wording; it is the part a leader remembers.

Write with plain ASCII punctuation: hyphens rather than em-dashes, straight quotes rather than curly ones, "..." rather than an ellipsis character. Anything fancier has to be escaped in the JSON you return, and a mis-escaped character reaches the reader as literal garbage.`;

export interface ExplainScoreInput {
  clusterTitle: string;
  canonicalNeed: string;
  breakdown: ScoreBreakdown;
  weightsVersion: string;
  requestExcerpts: Array<{ title: string; submitter: string; excerpt: string }>;
  supportSignals: Array<{ submitter: string; impact: string }>;
  meanExtractionConfidence: number;
}

/**
 * Stage 4. Turns a computed score into an auditable explanation.
 *
 * Runs on the primary model: this is the artefact a leader reads before
 * committing a quarter of engineering time, and the one place where a
 * plausible-but-wrong sentence does the most damage.
 */
export async function explainScore(input: ExplainScoreInput): Promise<{
  value: ScoreRationale;
  model: string;
}> {
  const { breakdown } = input;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  const user = `<cluster>
<title>${input.clusterTitle}</title>
<underlying_need>${input.canonicalNeed}</underlying_need>
</cluster>

<score total="${breakdown.total}" weights_version="${input.weightsVersion}">
<component name="submitter_weight" value="${breakdown.components.submitterWeight}" weight="${pct(breakdown.appliedWeights.submitterWeight)}" />
<component name="reach" value="${breakdown.components.reach}" weight="${pct(breakdown.appliedWeights.reach)}" />
<component name="severity" value="${breakdown.components.severity}" weight="${pct(breakdown.appliedWeights.severity)}" />
<component name="strategic_alignment" value="${breakdown.components.strategicAlignment}" weight="${pct(breakdown.appliedWeights.strategicAlignment)}" />
<component name="urgency" value="${breakdown.components.urgency}" weight="${pct(breakdown.appliedWeights.urgency)}" />
</score>

<facts>
<requests>${breakdown.facts.requestCount}</requests>
<distinct_accounts>${breakdown.facts.distinctAccounts}</distinct_accounts>
<total_arr_usd>${breakdown.facts.totalArrUsd}</total_arr_usd>
<strongest_voice>${
    breakdown.facts.topContributor
      ? `${breakdown.facts.topContributor.type}${breakdown.facts.topContributor.tier ? ` / ${breakdown.facts.topContributor.tier}` : ""} (weight ${breakdown.facts.topContributor.weight})`
      : "none"
  }</strongest_voice>
<mean_extraction_confidence>${input.meanExtractionConfidence.toFixed(2)}</mean_extraction_confidence>
</facts>

<requests>
${input.requestExcerpts
  .map((r) => `<request submitter="${r.submitter}"><title>${r.title}</title><excerpt>${r.excerpt}</excerpt></request>`)
  .join("\n")}
</requests>

<support_signals>
${
  input.supportSignals.length > 0
    ? input.supportSignals
        .map((s) => `<signal submitter="${s.submitter}">${s.impact}</signal>`)
        .join("\n")
    : "(none)"
}
</support_signals>

Explain this score.`;

  const result = await structuredCall({
    stage: STAGE,
    tier: "primary",
    schema: ScoreRationaleSchema,
    system: SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 16_000,
    dryRunValue: () => dryRun(input),
  });

  return { value: result.value, model: result.model };
}

function dryRun(input: ExplainScoreInput): ScoreRationale {
  const c = input.breakdown.components;
  const dominant = (Object.entries(c) as Array<[string, number]>).sort((a, b) => b[1] - a[1])[0];
  return {
    rationale: `[dry-run] Scored ${input.breakdown.total}/100, led by ${dominant?.[0] ?? "severity"} at ${dominant?.[1] ?? 0}. Drawn from ${input.breakdown.facts.requestCount} request(s) across ${input.breakdown.facts.distinctAccounts} account(s).`,
    evidence: input.requestExcerpts
      .slice(0, 3)
      .map((r) => `${r.submitter}: ${r.excerpt.slice(0, 120)}`)
      .concat(input.requestExcerpts.length === 0 ? ["No request excerpts available."] : []),
    confidenceNote:
      input.meanExtractionConfidence < 0.5
        ? "Extraction confidence was low; treat this score as provisional."
        : "none",
  };
}
