import { structuredCall } from "../claudeClient.js";
import { NeedExtractionSchema, type NeedExtraction } from "../schemas.js";
import type { Submitter } from "../../../domain/types.js";
import { getScoringConfig } from "../../scoring/config.js";

export const STAGE = "extract_need";
export const PROMPT_VERSION = "v3";

const systemPrompt = (pillars: string[]): string => `You read raw feature requests and identify the customer problem underneath them.

People ask for solutions, not problems. "Add a CSV export button" is usually "I cannot get my data into the tool where I actually do my analysis." Your job is to recover that second sentence. A product team that only reads the first one builds the button and still has the problem.

How to work:
- Separate the ask from the need. The need is what remains true even if the proposed feature is a bad idea.
- Judge severity by the cost of the status quo, not by how forcefully it is written. A calm note describing three hours of manual reconciliation every week is a major problem. An angry message about a button colour is minor.
- Judge urgency ONLY from evidence in the text: a named deadline, a renewal or migration date, an escalation, a competitor bake-off. Do not infer urgency from tone or from the submitter's importance - the scoring layer already accounts for who they are, and counting it twice here would double-weight the same fact.
- Judge strategic alignment against the pillars below, and only those. A request can be valuable and still score low here; that is a real and useful signal, not a mistake.
- When the text is too thin to interpret, say so through a low confidence value rather than inventing detail. A confident wrong reading is far more expensive than an honest "not enough information", because everything downstream treats your output as fact.

Current product strategy pillars:
${pillars.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Write reasoning that cites the specific wording behind each judgment. A human reviewer must be able to check your work against the request text without asking you anything.`;

export interface ExtractNeedInput {
  requestId: string;
  title: string;
  description: string;
  submitter: Pick<Submitter, "type" | "tier" | "accountName" | "arrUsd">;
}

/**
 * Stage 1. Reads one request and recovers the problem behind the ask.
 *
 * Runs on the fast model: this is high-volume, runs on every submission, and is
 * an extraction task rather than a judgment call about tradeoffs.
 */
export async function extractNeed(input: ExtractNeedInput): Promise<{
  value: NeedExtraction;
  model: string;
}> {
  const { config } = getScoringConfig();

  const user = `<request id="${input.requestId}">
<title>${input.title}</title>
<description>${input.description}</description>
<submitter type="${input.submitter.type}"${input.submitter.tier ? ` tier="${input.submitter.tier}"` : ""} />
</request>

Identify the underlying need.`;

  const result = await structuredCall({
    stage: STAGE,
    tier: "fast",
    schema: NeedExtractionSchema,
    system: systemPrompt(config.strategyPillars),
    user,
    promptVersion: `${PROMPT_VERSION}:${config.strategyPillars.join("|").length}`,
    maxTokens: 2_000,
    dryRunValue: () => dryRun(input),
  });

  return { value: result.value, model: result.model };
}

/**
 * Product areas the dry-run stub recognises, most specific first.
 *
 * Keyword-driven rather than hashed, because the product area feeds the theming
 * stage: a hash would scatter related requests across arbitrary themes and make
 * the dashboard's "by theme" view meaningless in dry-run mode. This is a crude
 * classifier standing in for a real one, not a fallback anyone should rely on.
 */
const AREA_RULES: Array<{ area: string; team: string; pattern: RegExp }> = [
  { area: "Identity & access", team: "Platform", pattern: /\bsso\b|saml|okta|scim|azure ad|entra|single sign|sign-on|login|credential|password/ },
  { area: "Permissions", team: "Platform", pattern: /permission|role|access control|read-only|admin|contractor|auditor see/ },
  { area: "Data portability", team: "Integrations", pattern: /export|snowflake|bigquery|warehouse|bulk|dump|extract|csv|download/ },
  { area: "API & extensibility", team: "Platform", pattern: /\bapi\b|webhook|rate limit|endpoint|integration|poll/ },
  { area: "Audit & compliance", team: "Platform", pattern: /audit|compliance|soc 2|hipaa|history|revision|immutable|who changed/ },
  { area: "Notifications", team: "Core Product", pattern: /notif|alert|slack|email summary|digest|threshold|remind/ },
  { area: "Bulk operations", team: "Core Product", pattern: /bulk|multi-select|batch|import|at a time|one by one|archive them/ },
  { area: "Search & navigation", team: "Core Product", pattern: /search|find|filter|saved view|shortcut|keyboard|navigat/ },
  { area: "Onboarding", team: "Growth", pattern: /onboard|new hire|get started|setup|productive|learn/ },
  { area: "Accessibility & UX", team: "Core Product", pattern: /dark mode|theme|mobile|phone|undo|language|german|localis|localiz/ },
];

/**
 * Deterministic stand-in for AI_DRY_RUN. Derives its values from the input so
 * the UI and tests see varied, stable data instead of one constant row.
 */
function dryRun(input: ExtractNeedInput): NeedExtraction {
  const text = `${input.title} ${input.description}`.toLowerCase();
  const hash = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const severity = /block|cannot|broken|fail|lose|lost|churn|refuse/.test(text)
    ? "blocker"
    : /slow|manual|hours|workaround|painful|tedious|by hand/.test(text)
      ? "major"
      : hash % 3 === 0
        ? "moderate"
        : "minor";

  const matched = AREA_RULES.find((rule) => rule.pattern.test(text));

  return {
    underlyingNeed: `Users cannot accomplish "${input.title.toLowerCase()}" without manual effort.`,
    jobToBeDone: `When I use the product, I want to ${input.title.toLowerCase()} so I can keep my workflow in one place.`,
    problemSummary: `[dry-run] ${input.description.slice(0, 180)}`,
    severity,
    urgency: /deadline|renewal|urgent|asap|q[1-4]|audit|certif|blocker/.test(text)
      ? 70 + (hash % 20)
      : 25 + (hash % 25),
    sentiment: /frustrat|annoy|unacceptable|terrible|absurd|gave up/.test(text)
      ? "frustrated"
      : /love|great|excited/.test(text)
        ? "enthusiastic"
        : "neutral",
    strategicAlignment: 35 + (hash % 50),
    suggestedTeam: matched?.team ?? "Core Product",
    suggestedProductArea: matched?.area ?? "General",
    tags: ["dry-run"],
    confidence: 0.6,
    reasoning: "Dry-run mode: no model call was made. Values are derived from the request text.",
  };
}
