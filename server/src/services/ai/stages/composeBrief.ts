import { structuredCall } from "../claudeClient.js";
import {
  DecisionBriefSchema,
  StakeholderUpdateSchema,
  type DecisionBriefOutput,
  type StakeholderUpdateOutput,
} from "../schemas.js";

export const BRIEF_STAGE = "decision_brief";
export const UPDATE_STAGE = "stakeholder_update";
export const PROMPT_VERSION = "v2";

const BRIEF_SYSTEM = `You write one-page decision briefs for a product leader who has about ninety seconds and several of these to get through.

They do not need to be convinced. They need to decide. Give them the problem, what the evidence actually supports, and the one action that would move this forward - then stop.

Rules that matter:

Every claim traces to the supplied material. If the input does not say how many accounts are affected, you do not either. Inventing a number to make a brief feel substantial is the single worst thing you can do here, because it will be repeated in a roadmap review by someone who trusts you and cannot check.

Recommend a real priority, including "decline" when that is the honest read. A brief that recommends "now" for everything is noise, and a leader who notices that pattern stops reading. Low scores are not failures - a well-argued decline saves more time than another maybe.

Distinguish what you know from what you are inferring. Where the evidence is thin, put the gap in open questions rather than papering over it with confident prose. "Three enterprise accounts mention this; unclear whether the two self-serve reports describe the same problem" is more useful than a smooth sentence that hides the seam.

The next step is one concrete action a named person could take this week - a call, a prototype, a data pull. Not "prioritise accordingly".

Write in plain sentences. No headings inside fields, no bullet symbols, no hedging stacks like "it may potentially be worth considering".`;

export interface ComposeBriefInput {
  clusterTitle: string;
  canonicalNeed: string;
  themeName: string;
  status: string;
  score: number;
  scoreRationale: string;
  requestCount: number;
  distinctAccounts: number;
  totalArrUsd: number;
  segmentBreakdown: Array<{ segment: string; count: number }>;
  requestExcerpts: Array<{ title: string; submitter: string; excerpt: string }>;
  supportSignals: Array<{ submitter: string; impact: string }>;
}

/** Stage 5a. Synthesises the evidence into a decision-ready brief. */
export async function composeBrief(input: ComposeBriefInput): Promise<{
  value: DecisionBriefOutput;
  model: string;
}> {
  const user = `<cluster title="${input.clusterTitle}" theme="${input.themeName}" status="${input.status}">
<underlying_need>${input.canonicalNeed}</underlying_need>
<priority_score>${input.score}</priority_score>
<score_rationale>${input.scoreRationale}</score_rationale>
</cluster>

<evidence>
<request_count>${input.requestCount}</request_count>
<distinct_accounts>${input.distinctAccounts}</distinct_accounts>
<total_arr_usd>${input.totalArrUsd}</total_arr_usd>
<segments>
${input.segmentBreakdown.map((s) => `<segment name="${s.segment}" requests="${s.count}" />`).join("\n")}
</segments>
<requests>
${input.requestExcerpts
  .map((r) => `<request submitter="${r.submitter}"><title>${r.title}</title><excerpt>${r.excerpt}</excerpt></request>`)
  .join("\n")}
</requests>
<support_signals>
${
  input.supportSignals.length > 0
    ? input.supportSignals.map((s) => `<signal submitter="${s.submitter}">${s.impact}</signal>`).join("\n")
    : "(none)"
}
</support_signals>
</evidence>

Write the decision brief.`;

  const result = await structuredCall({
    stage: BRIEF_STAGE,
    tier: "primary",
    schema: DecisionBriefSchema,
    system: BRIEF_SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 3_000,
    dryRunValue: () => dryRunBrief(input),
  });

  return { value: result.value, model: result.model };
}

// ---------------------------------------------------------------------------

const UPDATE_SYSTEM = `You write short status updates sent back to the people who asked for a feature.

The reader is a customer, a prospect, or a colleague in support who relayed their problem. They took the time to tell you something and have heard nothing since. Write the message they deserve.

What that requires:

Show you understood the problem, in their terms. One specific sentence proving you read what they wrote beats any amount of appreciation language. Skip "thank you for your valuable feedback" entirely.

State the decision and the actual reason. If it is not being built this quarter, say so and say why - other work is ahead of it, or it affects fewer accounts than expected. People accept "no" far better than they accept vagueness, and vagueness is what makes them escalate.

Promise nothing that is not in the input. No dates, no releases, no "it's on the roadmap" unless the status says exactly that. An invented commitment here becomes a real expectation, and someone else will have to break it.

Never expose internal machinery: no priority scores, no ARR, no other customers' names, no team-internal debate. The reader should not be able to tell an automated pipeline produced this.

Six sentences at most. Warm, direct, and finished - no invitation to reply unless there is a genuine question to ask.`;

export interface ComposeUpdateInput {
  clusterTitle: string;
  canonicalNeed: string;
  status: string;
  audience: string;
  recommendedPriority: string;
  humanNote: string;
}

/** Stage 5b. Drafts the outbound message. Always drafted, never auto-sent. */
export async function composeStakeholderUpdate(input: ComposeUpdateInput): Promise<{
  value: StakeholderUpdateOutput;
  model: string;
}> {
  const user = `<request_topic>${input.clusterTitle}</request_topic>
<underlying_need>${input.canonicalNeed}</underlying_need>
<current_status>${input.status}</current_status>
<internal_recommendation>${input.recommendedPriority}</internal_recommendation>
<audience>${input.audience}</audience>
<note_from_product_team>${input.humanNote || "(none)"}</note_from_product_team>

Write the update.`;

  const result = await structuredCall({
    stage: UPDATE_STAGE,
    tier: "primary",
    schema: StakeholderUpdateSchema,
    system: UPDATE_SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 1_500,
    // Each send is a distinct communication act; reusing a cached body would
    // resend stale wording after the status moved on.
    cacheable: false,
    dryRunValue: () => ({
      subject: `Update on: ${input.clusterTitle}`,
      body: `[dry-run] We looked at your request about ${input.canonicalNeed.toLowerCase()} It is currently ${input.status.replace(/_/g, " ")}. ${input.humanNote}`.trim(),
      toneCheck: "fine",
    }),
  });

  return { value: result.value, model: result.model };
}

function dryRunBrief(input: ComposeBriefInput): DecisionBriefOutput {
  return {
    problem: `[dry-run] ${input.canonicalNeed}`,
    evidence: [
      `${input.requestCount} request(s) from ${input.distinctAccounts} account(s).`,
      `Priority score ${input.score}.`,
      ...input.requestExcerpts.slice(0, 2).map((r) => `${r.submitter}: ${r.excerpt.slice(0, 100)}`),
    ],
    affectedSegments:
      input.segmentBreakdown.length > 0
        ? input.segmentBreakdown.map((s) => s.segment)
        : ["Unknown"],
    recommendedPriority:
      input.score >= 70 ? "now" : input.score >= 50 ? "next" : input.score >= 30 ? "later" : "decline",
    suggestedNextStep: "Review the consolidated requests with the owning team.",
    risksIfIgnored: "Unaddressed requests continue to accumulate in this theme.",
    openQuestions: ["Dry-run mode: no model reasoning was performed."],
  };
}
