import { structuredCall } from "../claudeClient.js";
import { DuplicateAdjudicationSchema, type DuplicateAdjudication } from "../schemas.js";
import type { Candidate } from "../../../repositories/requests.repo.js";

export const STAGE = "adjudicate_duplicate";
export const PROMPT_VERSION = "v3";

const SYSTEM = `You decide whether a new feature request describes a need the team has already heard.

You are given one new request and a shortlist of existing requests that a keyword search found textually similar. Keyword overlap is why they are in front of you; it is not evidence that they are the same. Two requests can share every important word and be different needs, and two requests can share no vocabulary at all and be the same need.

Decide on the underlying need, not the wording:
- duplicate: solving one solves the other. The team would build a single thing. Merge them.
- related: genuinely adjacent - same area, same user, overlapping value - but a team could ship one and still owe the other. Do not merge.
- distinct: different needs, whatever the wording suggests.

Two traps to avoid, in order of cost:

False merges are the expensive mistake. A wrongly merged request disappears from view - its submitter is told their problem is being handled when it is not, and nobody notices until a renewal conversation. A missed merge only means a duplicate sits on the board where a human can spot it. When the evidence is genuinely balanced, choose the milder verdict.

Same-noun-different-need is the common trap. "Export to CSV" and "Export to our data warehouse" both concern export, but one is a person moving a spreadsheet and the other is an engineering team wiring up a pipeline. Different needs, different solutions, different teams. Likewise a request to change a default and a request to make that default configurable are related, not duplicate.

Use confidence honestly. Below 0.75 the merge is held for human review instead of being applied, so a low number is a useful signal, not a failure. Reserve high confidence for cases where you could defend the merge to the person who filed the request.

Cite the specific overlap or the specific difference in your rationale. "They are similar" is not a rationale.`;

export interface AdjudicateInput {
  requestId: string;
  title: string;
  description: string;
  underlyingNeed: string;
  candidates: Candidate[];
}

/**
 * Stage 2. Semantic adjudication over a lexically-retrieved shortlist.
 *
 * The retrieval half (FTS5/BM25) lives in requests.repo.ts. That split is what
 * makes this affordable: the model compares against ~8 candidates rather than
 * the whole corpus, so cost stays flat as the corpus grows.
 */
export async function adjudicateDuplicate(input: AdjudicateInput): Promise<{
  value: DuplicateAdjudication;
  model: string;
}> {
  const candidateBlock = input.candidates
    .map(
      (c) => `<candidate id="${c.requestId}">
<title>${c.title}</title>
<description>${truncate(c.description, 600)}</description>
<underlying_need>${c.underlyingNeed || "(not yet analysed)"}</underlying_need>
</candidate>`,
    )
    .join("\n");

  const user = `<new_request id="${input.requestId}">
<title>${input.title}</title>
<description>${truncate(input.description, 1200)}</description>
<underlying_need>${input.underlyingNeed}</underlying_need>
</new_request>

<candidates>
${candidateBlock}
</candidates>

Does the new request duplicate any candidate? If so, which one?`;

  const result = await structuredCall({
    stage: STAGE,
    tier: "fast",
    schema: DuplicateAdjudicationSchema,
    system: SYSTEM,
    user,
    promptVersion: PROMPT_VERSION,
    maxTokens: 1_500,
    dryRunValue: () => dryRun(input),
  });

  // The model must echo an id from the shortlist. A hallucinated or stale id
  // would otherwise merge a request into a cluster nobody chose, so treat any
  // unrecognised id as "no match" rather than trusting it.
  const known = new Set(input.candidates.map((c) => c.requestId));
  if (result.value.verdict !== "distinct" && !known.has(result.value.matchedRequestId)) {
    return {
      value: {
        ...result.value,
        verdict: "distinct",
        matchedRequestId: "",
        rationale: `${result.value.rationale} (discarded: model referenced an unknown request id)`,
      },
      model: result.model,
    };
  }

  return { value: result.value, model: result.model };
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}...`);

/**
 * BM25 is negative, and more negative means a better lexical match. The bands
 * below are calibrated to land on either side of AUTO_MERGE_CONFIDENCE so that
 * dry-run mode exercises all three downstream paths - auto-merge, human review
 * queue, and no match - rather than only the two extremes. Without a band that
 * falls below the threshold, the human-in-the-loop queue would never populate
 * and a reviewer could not see that half of the design working.
 */
function dryRun(input: AdjudicateInput): DuplicateAdjudication {
  const best = input.candidates[0];
  if (!best) {
    return {
      verdict: "distinct",
      matchedRequestId: "",
      confidence: 0.7,
      rationale: "[dry-run] No candidates were retrieved.",
      consolidatedTitle: "",
      consolidatedNeed: "",
    };
  }

  if (best.bm25 < -9) {
    return {
      verdict: "duplicate",
      matchedRequestId: best.requestId,
      confidence: 0.88,
      rationale: "[dry-run] Strong lexical overlap with the top candidate.",
      consolidatedTitle: best.title,
      consolidatedNeed: best.underlyingNeed || input.underlyingNeed,
    };
  }

  if (best.bm25 < -6.5) {
    return {
      verdict: "duplicate",
      matchedRequestId: best.requestId,
      confidence: 0.62,
      rationale:
        "[dry-run] Overlapping vocabulary, but not enough to merge without a human looking.",
      consolidatedTitle: best.title,
      consolidatedNeed: best.underlyingNeed || input.underlyingNeed,
    };
  }

  if (best.bm25 < -4.5) {
    return {
      verdict: "related",
      matchedRequestId: best.requestId,
      confidence: 0.55,
      rationale: "[dry-run] Adjacent subject matter; likely separately shippable.",
      consolidatedTitle: "",
      consolidatedNeed: "",
    };
  }

  return {
    verdict: "distinct",
    matchedRequestId: "",
    confidence: 0.7,
    rationale: "[dry-run] No candidate scored above the merge threshold.",
    consolidatedTitle: "",
    consolidatedNeed: "",
  };
}
