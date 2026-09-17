import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { resetDb, customer } from "../test/helpers.js";
import { drainQueue } from "../jobs/worker.js";
import * as requestsRepo from "../repositories/requests.repo.js";

const app = createApp();

const validBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Scheduled data export",
  description:
    "Every Monday someone on my team spends three hours copying records into a spreadsheet for our business review.",
  submitter: customer(),
  ...overrides,
});

describe("POST /api/requests", () => {
  beforeEach(() => resetDb());

  it("accepts a request with 202 and queues analysis rather than blocking", async () => {
    const res = await request(app).post("/api/requests").send(validBody());

    expect(res.status).toBe(202);
    expect(res.body.request.id).toMatch(/^req_/);
    expect(res.body.analysisStatus).toBe("queued");
    // Analysis has not run yet - the caller is not made to wait for the model.
    expect(res.body.request.status).toBe("received");
  });

  it("rejects a body that fails validation, naming the offending fields", async () => {
    const res = await request(app)
      .post("/api/requests")
      .send(validBody({ title: "no", description: "too short" }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toContain("title");
    expect(paths).toContain("description");
  });

  it("rejects an unknown submitter type", async () => {
    const res = await request(app)
      .post("/api/requests")
      .send(validBody({ submitter: customer({ type: "partner" }) }));

    expect(res.status).toBe(400);
  });

  it("replays the original response for a repeated Idempotency-Key", async () => {
    const body = validBody();
    const first = await request(app)
      .post("/api/requests")
      .set("Idempotency-Key", "key-abc-123")
      .send(body);
    const second = await request(app)
      .post("/api/requests")
      .set("Idempotency-Key", "key-abc-123")
      .send(body);

    expect(second.status).toBe(first.status);
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(second.headers["idempotent-replay"]).toBe("true");

    // Crucially: one request stored, so the AI never pays to detect a duplicate
    // that the transport layer created.
    expect(requestsRepo.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it("rejects a reused Idempotency-Key carrying a different body", async () => {
    await request(app)
      .post("/api/requests")
      .set("Idempotency-Key", "key-xyz")
      .send(validBody());

    const res = await request(app)
      .post("/api/requests")
      .set("Idempotency-Key", "key-xyz")
      .send(validBody({ title: "A completely different request title" }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });
});

describe("GET /api/requests", () => {
  beforeEach(async () => {
    resetDb();
    await request(app).post("/api/requests").send(validBody());
    await request(app)
      .post("/api/requests")
      .send(
        validBody({
          title: "Dark mode for the interface",
          description:
            "Working in the evening is uncomfortable because the interface is so bright on my screen.",
          submitter: customer({ email: "other@acme.example", type: "internal", tier: undefined }),
        }),
      );
    await drainQueue();
  });

  it("returns paginated results with cluster context attached", async () => {
    const res = await request(app).get("/api/requests?pageSize=1");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
    expect(res.body.totalPages).toBe(2);
    expect(res.body.items[0].cluster).not.toBeNull();
    expect(res.body.items[0].underlyingNeed).toBeTruthy();
  });

  it("full-text searches across title and description", async () => {
    const res = await request(app).get("/api/requests?search=evening%20bright");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toContain("Dark mode");
  });

  it("survives a search query made entirely of FTS operator characters", async () => {
    // A raw MATCH would be a syntax error here, not an empty result.
    const res = await request(app).get(`/api/requests?search=${encodeURIComponent('"*^:-()')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("filters by submitter type", async () => {
    const res = await request(app).get("/api/requests?submitterType=internal");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].submitterType).toBe("internal");
  });

  it("rejects an out-of-range page size", async () => {
    const res = await request(app).get("/api/requests?pageSize=5000");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/requests/:id", () => {
  beforeEach(() => resetDb());

  it("exposes the AI reasoning behind the grouping and score", async () => {
    const created = await request(app).post("/api/requests").send(validBody());
    await drainQueue();

    const res = await request(app).get(`/api/requests/${created.body.request.id}`);

    expect(res.status).toBe(200);
    expect(res.body.analysis.underlyingNeed).toBeTruthy();
    expect(res.body.analysis.reasoning).toBeTruthy();
    expect(res.body.cluster.score.rationale).toBeTruthy();
    expect(res.body.mergeDecision.rationale).toBeTruthy();
    expect(res.body.timeline.length).toBeGreaterThan(0);
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/requests/req_nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("POST /api/requests/:id/support", () => {
  beforeEach(() => resetDb());

  it("requires the supporter to describe their impact", async () => {
    const created = await request(app).post("/api/requests").send(validBody());
    await drainQueue();

    const res = await request(app)
      .post(`/api/requests/${created.body.request.id}/support`)
      .send({ impactText: "+1", submitter: customer({ email: "supporter@other.example" }) });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/bare vote/i);
  });

  it("records a support signal and feeds it into the next score", async () => {
    const created = await request(app).post("/api/requests").send(validBody());
    await drainQueue();

    const res = await request(app)
      .post(`/api/requests/${created.body.request.id}/support`)
      .send({
        impactText:
          "We hit this every quarter close - two analysts lose a full day assembling the same numbers.",
        currentWorkaround: "A brittle scraping script one of our engineers maintains.",
        submitter: customer({ email: "supporter@other.example", accountName: "Other Corp" }),
      });

    expect(res.status).toBe(201);
    expect(res.body.signal.impactText).toContain("quarter close");

    await drainQueue();

    const detail = await request(app).get(`/api/requests/${created.body.request.id}`);
    expect(detail.body.supportSignals).toHaveLength(1);
    // A second account raises reach, which is the whole point of the signal.
    expect(detail.body.cluster.score.components.reach).toBeGreaterThan(0);
  });

  it("counts one account once, however many times it supports", async () => {
    const created = await request(app).post("/api/requests").send(validBody());
    await drainQueue();

    const supporter = customer({ email: "repeat@other.example", accountName: "Other Corp" });
    const payload = {
      impactText: "This costs my team about a day every month in manual reconciliation work.",
      submitter: supporter,
    };

    await request(app).post(`/api/requests/${created.body.request.id}/support`).send(payload);
    await request(app)
      .post(`/api/requests/${created.body.request.id}/support`)
      .send({ ...payload, impactText: "Updated: it is closer to two days now that we have grown." });

    const detail = await request(app).get(`/api/requests/${created.body.request.id}`);
    expect(detail.body.supportSignals).toHaveLength(1);
    expect(detail.body.supportSignals[0].impactText).toMatch(/two days/);
  });
});

describe("dashboard and settings", () => {
  beforeEach(async () => {
    resetDb();
    await request(app).post("/api/requests").send(validBody());
    await drainQueue();
  });

  it("serves the whole dashboard in one call", async () => {
    const res = await request(app).get("/api/analytics/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.topClusters.length).toBeGreaterThan(0);
    expect(res.body.topClusters[0].rationale).toBeTruthy();
    expect(res.body.byTheme.length).toBeGreaterThan(0);
    expect(res.body.metrics.totalRequests).toBe(1);
    expect(res.body.submitterMix).toHaveLength(4);
  });

  it("reports consolidation as a measurable metric", async () => {
    const res = await request(app).get("/api/analytics/metrics");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("consolidationRate");
    expect(res.body).toHaveProperty("medianTimeToPrioritisationSeconds");
    expect(res.body.aiUsageByStage.length).toBeGreaterThan(0);
  });

  it("re-weighting is an API call, and queues a rescore", async () => {
    const current = await request(app).get("/api/settings/scoring");
    expect(current.status).toBe(200);

    const res = await request(app)
      .put("/api/settings/scoring")
      .send({
        config: {
          ...current.body.config,
          componentWeights: {
            submitterWeight: 10,
            reach: 10,
            severity: 60,
            strategicAlignment: 10,
            urgency: 10,
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.rescoreQueued).toBe(true);
    expect(res.body.version).not.toBe(current.body.version);
  });

  it("rejects a malformed scoring config", async () => {
    const res = await request(app)
      .put("/api/settings/scoring")
      .send({ config: { componentWeights: { severity: "a lot" } } });

    expect(res.status).toBe(400);
  });
});

describe("health", () => {
  it("reports the AI mode and queue depth", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.aiMode).toBe("dry-run");
  });
});

describe("unknown routes", () => {
  it("404s with a structured error", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
