import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { resetDb, customer, aiCallCount } from "../../test/helpers.js";
import { setScoringConfig, DEFAULT_SCORING_CONFIG } from "../scoring/config.js";
import * as requestsService from "../requests.service.js";
import * as clustersService from "../clusters.service.js";
import * as requestsRepo from "../../repositories/requests.repo.js";
import * as clustersRepo from "../../repositories/clusters.repo.js";
import * as scoresRepo from "../../repositories/scores.repo.js";
import * as suggestionsRepo from "../../repositories/mergeSuggestions.repo.js";
import { drainQueue } from "../../jobs/worker.js";
import { analyzeRequest, AUTO_MERGE_CONFIDENCE } from "./pipeline.js";
import type { DuplicateAdjudication } from "../ai/schemas.js";

/**
 * Pipeline behaviour with the model stubbed.
 *
 * The suite runs with AI_DRY_RUN=true, so every stage returns its deterministic
 * stand-in and no network call is made. Where a specific verdict matters, the
 * adjudication stage is overridden directly - that is the seam where a wrong
 * answer does real damage, so it is worth driving explicitly rather than hoping
 * the dry-run heuristic happens to produce the case.
 */

const verdict = vi.hoisted(() => ({
  next: null as DuplicateAdjudication | null,
}));

vi.mock("../ai/stages/adjudicateDuplicate.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../ai/stages/adjudicateDuplicate.js")>();
  return {
    ...actual,
    adjudicateDuplicate: async (input: Parameters<typeof actual.adjudicateDuplicate>[0]) =>
      verdict.next
        ? { value: verdict.next, model: "test-stub" }
        : actual.adjudicateDuplicate(input),
  };
});

/** Forces the next duplicate adjudication to return this exact verdict. */
const willAdjudicate = (result: { model: string; value: DuplicateAdjudication }) => {
  verdict.next = result.value;
};

const submit = (title: string, description: string, submitterOverrides = {}) =>
  requestsService.submitRequest({
    title,
    description,
    submitter: customer(submitterOverrides),
  });

describe("request analysis pipeline", () => {
  beforeEach(() => { resetDb(); verdict.next = null; });
  afterEach(() => { verdict.next = null; });

  it("extracts a need, clusters the request and queues a score", async () => {
    const { request } = submit(
      "Export data to CSV",
      "Every week I manually copy records into a spreadsheet for our business review. It takes hours.",
    );

    await drainQueue();

    const stored = requestsRepo.findById(request.id)!;
    expect(stored.status).toBe("analyzed");
    expect(stored.clusterId).not.toBeNull();

    const analysis = requestsRepo.findAnalysis(request.id)!;
    expect(analysis.underlyingNeed).toBeTruthy();
    expect(analysis.severity).toBeTruthy();
    expect(analysis.confidence).toBeGreaterThan(0);

    const score = scoresRepo.latestForCluster(stored.clusterId!)!;
    expect(score.total).toBeGreaterThan(0);
    expect(score.rationale).toBeTruthy();
    expect(score.evidence.length).toBeGreaterThan(0);
  });

  it("merges a confident duplicate into the existing cluster", async () => {
    const first = submit(
      "Scheduled CSV export",
      "We need an automated weekly export of all our records so nobody has to assemble it by hand.",
    );
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "duplicate",
        matchedRequestId: first.request.id,
        confidence: 0.95,
        rationale: "Both describe automating a recurring manual data export.",
        consolidatedTitle: "Automated recurring data export",
        consolidatedNeed: "Teams cannot get their data out on a schedule without manual work.",
      },
    });

    const second = submit(
      "Automate our weekly data pull",
      "Someone spends three hours every Monday exporting records into a spreadsheet for reporting.",
      { email: "second@acme.example" },
    );
    await drainQueue();

    const firstStored = requestsRepo.findById(first.request.id)!;
    const secondStored = requestsRepo.findById(second.request.id)!;

    expect(secondStored.clusterId).toBe(firstStored.clusterId);
    expect(clustersRepo.memberCount(firstStored.clusterId!)).toBe(2);

    // The consolidated title replaces whichever request happened to arrive first.
    const cluster = clustersRepo.findById(firstStored.clusterId!)!;
    expect(cluster.title).toBe("Automated recurring data export");

    // And the reason is recorded, so a user can see why their request moved.
    const decisions = clustersRepo.decisionsForCluster(cluster.id);
    const decision = decisions.find((d) => d.requestId === second.request.id)!;
    expect(decision.decidedBy).toBe("ai");
    expect(decision.rationale).toContain("manual data export");
  });

  it("parks a low-confidence duplicate for human review instead of merging it", async () => {
    const first = submit(
      "Single sign-on support",
      "Our security team requires SAML SSO before we can roll out more widely across the company.",
    );
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "duplicate",
        matchedRequestId: first.request.id,
        confidence: AUTO_MERGE_CONFIDENCE - 0.1,
        rationale: "Possibly the same identity need, but the second is about external users.",
        consolidatedTitle: "Identity management",
        consolidatedNeed: "Login is not centrally managed.",
      },
    });

    const second = submit(
      "Let our own customers log into the portal",
      "This is about the companies we serve authenticating into the portal we built on your platform.",
      { email: "second@acme.example" },
    );
    await drainQueue();

    const secondStored = requestsRepo.findById(second.request.id)!;
    const firstStored = requestsRepo.findById(first.request.id)!;

    // Not merged - it keeps its own cluster.
    expect(secondStored.clusterId).not.toBe(firstStored.clusterId);

    const pending = suggestionsRepo.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe(second.request.id);
    expect(pending[0]!.targetClusterId).toBe(firstStored.clusterId);
  });

  it("discards a merge that names a request outside the candidate shortlist", async () => {
    submit("Dark mode", "The interface is too bright when I work in the evening for long stretches.");
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "duplicate",
        matchedRequestId: "req_does_not_exist",
        confidence: 0.99,
        rationale: "Hallucinated match.",
        consolidatedTitle: "Nope",
        consolidatedNeed: "Nope",
      },
    });

    const second = submit(
      "Night theme for the dashboard",
      "A darker colour scheme would make long evening sessions much easier on the eyes.",
      { email: "second@acme.example" },
    );
    await drainQueue();

    // A phantom id must never move a request into a cluster nobody chose.
    const stored = requestsRepo.findById(second.request.id)!;
    expect(stored.clusterId).toBeTruthy();
    expect(clustersRepo.memberCount(stored.clusterId!)).toBe(1);
    expect(suggestionsRepo.listPending()).toHaveLength(0);
  });

  it("re-scores without a new model call when nothing relevant changed", async () => {
    const { request } = submit(
      "Audit log",
      "We need to know who changed what and when, with before and after values, for compliance.",
    );
    await drainQueue();

    const stored = requestsRepo.findById(request.id)!;
    const before = scoresRepo.latestForCluster(stored.clusterId!)!;

    const { scoreCluster } = await import("./pipeline.js");
    const result = await scoreCluster(stored.clusterId!);

    expect(result.skipped).toBe(true);
    expect(result.rationaleSource).toBe("unchanged");
    expect(scoresRepo.historyForCluster(stored.clusterId!)).toHaveLength(1);
    expect(scoresRepo.latestForCluster(stored.clusterId!)!.id).toBe(before.id);
  });

  it("re-weights the board without buying a new explanation", async () => {
    const { request } = submit(
      "Granular permissions",
      "Contractors can currently see every project, so we maintain a second account as a workaround.",
    );
    await drainQueue();

    const clusterId = requestsRepo.findById(request.id)!.clusterId!;
    const before = scoresRepo.latestForCluster(clusterId)!;
    const callsBefore = aiCallCount();

    // Severity-dominant weights: the totals must move...
    setScoringConfig({
      ...DEFAULT_SCORING_CONFIG,
      componentWeights: {
        submitterWeight: 0,
        reach: 0,
        severity: 100,
        strategicAlignment: 0,
        urgency: 0,
      },
    });

    const { scoreCluster } = await import("./pipeline.js");
    const result = await scoreCluster(clusterId);

    expect(result.skipped).toBe(false);
    expect(result.total).not.toBe(before.total);
    expect(result.total).toBe(before.components.severity);

    // ...while the explanation is carried forward, flagged, and costs nothing.
    const after = scoresRepo.latestForCluster(clusterId)!;
    expect(after.rationale).toBe(before.rationale);
    expect(after.rationaleStale).toBe(true);
    expect(result.rationaleSource).toBe("reused");
    expect(aiCallCount()).toBe(callsBefore);
  });

  it("forcing a rescore does regenerate the explanation", async () => {
    const { request } = submit(
      "Bulk edit",
      "Updating two hundred records means two hundred clicks, so I do it in batches to avoid losing my place.",
    );
    await drainQueue();

    const clusterId = requestsRepo.findById(request.id)!.clusterId!;
    const callsBefore = aiCallCount();

    const { scoreCluster } = await import("./pipeline.js");
    const result = await scoreCluster(clusterId, true);

    expect(result.rationaleSource).toBe("generated");
    expect(scoresRepo.latestForCluster(clusterId)!.rationaleStale).toBe(false);
    expect(aiCallCount()).toBeGreaterThan(callsBefore);
  });
});

describe("human-in-the-loop overrides", () => {
  beforeEach(() => { resetDb(); verdict.next = null; });
  afterEach(() => { verdict.next = null; });

  it("accepting a suggestion moves the request and drops the emptied cluster", async () => {
    const first = submit("SSO", "Our security team requires SAML single sign-on for the rollout.");
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "duplicate",
        matchedRequestId: first.request.id,
        confidence: 0.6,
        rationale: "Probably the same identity need.",
        consolidatedTitle: "SSO",
        consolidatedNeed: "Centralised login",
      },
    });

    const second = submit(
      "Okta integration",
      "We want to provision and deprovision users automatically through our identity provider.",
      { email: "second@acme.example" },
    );
    await drainQueue();

    const orphanClusterId = requestsRepo.findById(second.request.id)!.clusterId!;
    const suggestion = suggestionsRepo.listPending()[0]!;

    const result = clustersService.acceptMergeSuggestion(suggestion.id, "pm@acme.example");

    expect(result.merged).toBe(true);
    expect(requestsRepo.findById(second.request.id)!.clusterId).toBe(suggestion.targetClusterId);
    expect(clustersRepo.findById(orphanClusterId)).toBeNull();
    expect(suggestionsRepo.findById(suggestion.id)!.status).toBe("accepted");
  });

  it("splitting a request out records who did it and why", async () => {
    const first = submit("Export", "Weekly manual export of all our records into a spreadsheet.");
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "duplicate",
        matchedRequestId: first.request.id,
        confidence: 0.95,
        rationale: "Same export need.",
        consolidatedTitle: "Export",
        consolidatedNeed: "Bulk data access",
      },
    });

    const second = submit(
      "Warehouse sync",
      "We want a connector that keeps our Snowflake warehouse in sync continuously.",
      { email: "second@acme.example" },
    );
    await drainQueue();

    const mergedClusterId = requestsRepo.findById(second.request.id)!.clusterId!;
    expect(clustersRepo.memberCount(mergedClusterId)).toBe(2);

    const result = clustersService.splitRequest(
      second.request.id,
      "pm@acme.example",
      "Warehouse sync is a pipeline, not a spreadsheet export.",
    );

    expect(result.previousClusterId).toBe(mergedClusterId);
    expect(clustersRepo.memberCount(mergedClusterId)).toBe(1);

    const decisions = clustersRepo.decisionsForCluster(result.clusterId);
    const decision = decisions.find((d) => d.requestId === second.request.id)!;
    expect(decision.decidedBy).toBe("human");
    expect(decision.overriddenFromClusterId).toBe(mergedClusterId);
    expect(decision.rationale).toContain("pipeline");
  });

  it("refuses to split a request that is already alone", async () => {
    const { request } = submit("Dark mode", "The interface is too bright during evening work.");
    await drainQueue();

    expect(() => clustersService.splitRequest(request.id, "pm@acme.example", "because")).toThrow(
      /only member/i,
    );
  });

  it("refuses to resolve a suggestion twice", async () => {
    const first = submit("SSO", "Our security team requires SAML single sign-on for the rollout.");
    await drainQueue();

    willAdjudicate({
      model: "test",
      value: {
        verdict: "related",
        matchedRequestId: first.request.id,
        confidence: 0.5,
        rationale: "Adjacent identity concern.",
        consolidatedTitle: "",
        consolidatedNeed: "",
      },
    });

    submit("SCIM provisioning", "Automatic user provisioning from our directory would help a lot.", {
      email: "second@acme.example",
    });
    await drainQueue();

    const suggestion = suggestionsRepo.listPending()[0]!;
    clustersService.rejectMergeSuggestion(suggestion.id, "pm@acme.example");

    expect(() => clustersService.acceptMergeSuggestion(suggestion.id, "pm@acme.example")).toThrow(
      /already rejected/i,
    );
  });
});

describe("analyzeRequest", () => {
  beforeEach(() => { resetDb(); verdict.next = null; });

  it("throws for an unknown request rather than creating an empty cluster", async () => {
    await expect(analyzeRequest("req_missing")).rejects.toThrow(/not found/i);
    expect(clustersRepo.listAll()).toHaveLength(0);
  });
});
