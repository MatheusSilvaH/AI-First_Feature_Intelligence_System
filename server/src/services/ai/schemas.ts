import { z } from "zod";
import { SEVERITY_LEVELS, SENTIMENTS } from "../../domain/types.js";

/**
 * Output contracts for every Claude call in the system.
 *
 * These are passed to `output_config.format`, so the model is constrained to
 * the shape server-side rather than being asked politely for JSON. They are
 * also the validation boundary: nothing reaches a repository without passing
 * through one of these. Kept flat and enum-heavy - structured outputs are most
 * reliable on simple shapes, and every field here has to survive a round trip
 * into SQLite anyway.
 */

export const NeedExtractionSchema = z.object({
  underlyingNeed: z
    .string()
    .describe(
      "The real problem behind the literal feature ask, in one sentence. Describe the problem, never the proposed solution.",
    ),
  jobToBeDone: z
    .string()
    .describe("What the person is ultimately trying to accomplish, phrased as 'When I... I want to... so I can...'"),
  problemSummary: z
    .string()
    .describe("Two or three sentences a product manager could paste into a planning doc."),
  severity: z
    .enum(SEVERITY_LEVELS)
    .describe(
      "blocker = work is impossible; major = costly workaround in use; moderate = friction; minor = polish.",
    ),
  urgency: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "0-100 time pressure evidenced IN THE TEXT: stated deadlines, renewal or churn risk, escalation language. Absent evidence, stay near 30.",
    ),
  sentiment: z.enum(SENTIMENTS),
  strategicAlignment: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("0-100 fit with the strategy pillars listed in the system prompt."),
  suggestedTeam: z
    .string()
    .describe("Owning team best placed to act, e.g. 'Platform', 'Billing', 'Growth'."),
  suggestedProductArea: z
    .string()
    .describe("Short product-area label, e.g. 'Authentication', 'Reporting', 'Integrations'."),
  tags: z.array(z.string()).max(6),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this reading. Use below 0.5 when the request text is too thin to interpret."),
  reasoning: z
    .string()
    .describe("Why you read it this way, citing the wording that drove each judgment."),
});
export type NeedExtraction = z.infer<typeof NeedExtractionSchema>;

export const DuplicateAdjudicationSchema = z.object({
  verdict: z
    .enum(["duplicate", "related", "distinct"])
    .describe(
      "duplicate = same underlying need, solving one solves both; related = adjacent but separately shippable; distinct = different needs.",
    ),
  matchedRequestId: z
    .string()
    .describe(
      "The id of the candidate this matches, exactly as given. Empty string when the verdict is 'distinct'.",
    ),
  confidence: z.number().min(0).max(1),
  rationale: z
    .string()
    .describe("One or two sentences naming what the two requests share, or why they differ."),
  consolidatedTitle: z
    .string()
    .describe(
      "If merging, a neutral title covering both requests. Empty string when the verdict is 'distinct'.",
    ),
  consolidatedNeed: z
    .string()
    .describe("If merging, the shared underlying need. Empty string when the verdict is 'distinct'."),
});
export type DuplicateAdjudication = z.infer<typeof DuplicateAdjudicationSchema>;

export const ThemeAssignmentSchema = z.object({
  themeName: z
    .string()
    .describe(
      "Reuse an existing theme name verbatim when one fits; only invent a new one when none does.",
    ),
  themeDescription: z.string().describe("One sentence on what belongs in this theme."),
  productArea: z.string(),
  isNewTheme: z.boolean(),
  rationale: z.string(),
});
export type ThemeAssignment = z.infer<typeof ThemeAssignmentSchema>;

export const ScoreRationaleSchema = z.object({
  rationale: z
    .string()
    .describe(
      "Explain the score to a product leader in 3-5 sentences: what drove it up, what held it down, and the single fact that matters most. Reference the component values you were given; never invent new numbers.",
    ),
  evidence: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe("Short factual bullets drawn only from the supplied requests and support signals."),
  confidenceNote: z
    .string()
    .describe("Anything that makes this score less trustworthy, or 'none' if nothing does."),
});
export type ScoreRationale = z.infer<typeof ScoreRationaleSchema>;

export const DecisionBriefSchema = z.object({
  problem: z.string().describe("The customer problem, not the feature. Two or three sentences."),
  evidence: z.array(z.string()).min(1).max(8),
  affectedSegments: z
    .array(z.string())
    .min(1)
    .max(6)
    .describe("Who is affected, e.g. 'Enterprise admins', 'Self-serve trials'."),
  recommendedPriority: z
    .enum(["now", "next", "later", "decline"])
    .describe("now = this quarter; next = next quarter; later = backlog; decline = say no."),
  suggestedNextStep: z
    .string()
    .describe("One concrete action, e.g. 'Run a 30-minute discovery call with the three enterprise accounts'."),
  risksIfIgnored: z.string(),
  openQuestions: z
    .array(z.string())
    .max(5)
    .describe("What a human still needs to determine. Empty array if nothing is outstanding."),
});
export type DecisionBriefOutput = z.infer<typeof DecisionBriefSchema>;

export const StakeholderUpdateSchema = z.object({
  subject: z.string().max(120),
  body: z
    .string()
    .describe(
      "Plain language, no internal jargon, no invented commitments or dates. Acknowledge the problem, state the decision and its reasoning, say what happens next.",
    ),
  toneCheck: z
    .string()
    .describe("One line on how this reads to a frustrated customer, or 'fine'."),
});
export type StakeholderUpdateOutput = z.infer<typeof StakeholderUpdateSchema>;

export const EmergingNeedsSchema = z.object({
  trends: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        signalStrength: z
          .enum(["watch", "building", "urgent"])
          .describe("watch = early; building = accelerating; urgent = act now."),
        evidenceClusterIds: z.array(z.string()).max(10),
        affectedSegments: z.array(z.string()).max(5),
        whyNow: z
          .string()
          .describe("What changed recently. This is the part a leaderboard cannot show."),
      }),
    )
    .max(5),
  summary: z.string().describe("Two or three sentences a product leader reads first."),
});
export type EmergingNeeds = z.infer<typeof EmergingNeedsSchema>;
