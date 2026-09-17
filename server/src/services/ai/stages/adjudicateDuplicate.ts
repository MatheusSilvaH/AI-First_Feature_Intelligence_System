import { structuredCall } from "../claudeClient.js";
import { DuplicateAdjudicationSchema, type DuplicateAdjudication } from "../schemas.js";
import type { Candidate } from "../../../repositories/requests.repo.js";

export const STAGE = "adjudicate_duplicate";
export const PROMPT_VERSION = "v5";

const SYSTEM = `You decide whether a new feature request describes a need the team has already heard.

You are given one new request and a shortlist of existing requests that a keyword search found textually similar. Keyword overlap is why they are in front of you; it is not evidence that they are the same. Two requests can share every important word and be different needs, and two requests can share no vocabulary at all and be the same need.

Group at the level a product team would plan at, not the level an engineer would ship at. The question is: **would these appear as one line item on a roadmap, or two?**

- duplicate: one line item. The same underlying problem, and a team deciding to solve it would pick up all of these requests together. Delivering it may well take several separate changes - that does not make them separate needs.
- related: two line items that sit near each other. A team could fund one and genuinely not have addressed the other, because the problems differ even though the area is shared.
- distinct: different problems, not even adjacent.

The distinction that matters, and the one most easily got wrong:

**Different mechanism is not a different need.** "Enforce SAML SSO through Okta", "we need SCIM auto-provisioning", "add Azure AD / Entra support", and "the CISO says directory sync is a blocker" are four descriptions of one problem: this company cannot manage identity centrally and their security team will not sign off. SAML and SCIM are different pieces of engineering; they are not different needs. Merge them. A product leader wants to see one row reading "enterprise identity - four requests, three enterprise accounts" and then decide scope, not four rows of one request each that they have to reassemble by hand. Splitting on vendor, protocol, or technical layer is the single most common way to make this system useless.

The same applies elsewhere: "scheduled CSV to my inbox", "nightly dump into BigQuery", and "a customer needs six months of history extracted" are one need - getting data out in bulk without manual work - described by three people with different technical vocabularies.

Two errors to avoid, and they are different errors:

Merging different needs hides one of them. The request disappears into a cluster, its submitter is told their problem is being handled when it is not, and nobody notices until a renewal conversation.

Failing to merge the same need defeats the entire point of this system. If four people describe one problem in four vocabularies and you return four separate needs, a product team is left doing by hand exactly the work you were asked to do. "Related" is not a safe middle answer - it is a wrong answer when the requests are in fact the same need, and choosing it to avoid committing is the more common failure, not the rarer one.

The trap that actually causes bad merges is same-noun-different-need, and the test is who the user is and what they walk away with. "Let our employees sign in with SSO" and "let our customers sign into the portal we built on your platform" share their most distinctive vocabulary and are different products serving different people - one is internal IT, the other is a feature the customer resells. Likewise "email this one report to a client as a PDF" is presentation for a single document, not bulk data extraction, however much the word "export" appears in both. When the user or the outcome differs, the shared noun is a coincidence.

Confidence is your genuine probability that the merge is right, nothing else. Calibrate it: around 0.9 when you would comfortably defend the merge to the person who filed the request, around 0.5 when you truly cannot tell, low when you are reaching. Do not reserve a margin for safety and do not aim at any particular value - the number is used to decide whether a human reviews this, and systematically understating it just moves your work onto their desk.

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
