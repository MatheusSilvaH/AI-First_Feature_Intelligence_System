import { z } from "zod";
import {
  CreateRequestSchema,
  ListRequestsQuerySchema,
  SupportRequestSchema,
  SplitRequestSchema,
  UpdateClusterStatusSchema,
  ResolveSuggestionSchema,
  ReviseBriefSchema,
  GenerateUpdateSchema,
  TopClustersQuerySchema,
  ClusterPageQuerySchema,
  TrendQuerySchema,
  EmergingQuerySchema,
  UpdateScoringConfigSchema,
} from "./schemas.js";
import {
  CLUSTER_STATUSES,
  CUSTOMER_TIERS,
  REQUEST_STATUSES,
  SEVERITY_LEVELS,
  SUBMITTER_TYPES,
} from "../domain/types.js";

/**
 * OpenAPI 3.1 description of the HTTP API.
 *
 * Request bodies and query parameters are generated from the same Zod schemas
 * the server validates with, so the documentation cannot drift from what is
 * actually enforced - if a rule changes in `schemas.ts`, this changes with it.
 * Response shapes are hand-declared, because they come from repository row
 * mappers rather than from a schema object.
 */

type JsonSchema = Record<string, unknown>;

/** Zod emits a `$schema` key that OpenAPI does not want inline. */
function jsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
  const { $schema, ...rest } = z.toJSONSchema(schema, {
    io,
    // Some schemas (defaults, coercion, transforms) have no clean JSON Schema
    // equivalent. Emitting what can be represented is more useful than refusing
    // to generate anything.
    unrepresentable: "any",
  }) as JsonSchema & { $schema?: string };
  return rest;
}

/** Turns a Zod object schema into a list of OpenAPI query parameters. */
function queryParams(schema: z.ZodType): unknown[] {
  const asJson = jsonSchema(schema, "input");
  const properties = (asJson.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((asJson.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => {
    const { description, ...rest } = propertySchema;
    return {
      name,
      in: "query",
      required: required.has(name),
      description,
      schema: rest,
    };
  });
}

const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description:
    "Opaque client-generated key. Replaying the same key with the same body returns the original response with `Idempotent-Replay: true`; reusing it with a different body is a 409.",
  schema: { type: "string" },
};

const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description: string) => ({
  description,
  ...json(ref("Error")),
});

const COMMON_ERRORS = {
  "400": errorResponse("Validation failed. `error.details` lists the offending fields."),
  "404": errorResponse("No such resource."),
  "429": errorResponse("Rate limited."),
};

// --- response shapes -------------------------------------------------------

const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });

/**
 * OpenAPI 3.1 dropped `nullable: true` in favour of JSON Schema union types.
 * An enum needs the union form rather than a type array, because the `enum`
 * list itself would otherwise exclude null.
 */
const nullableEnumOf = (values: readonly string[]) => ({
  anyOf: [enumOf(values), { type: "null" }],
});

const SCHEMAS: Record<string, JsonSchema> = {
  Error: {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Stable machine-readable code, e.g. `bad_request`, `not_found`.",
          },
          message: { type: "string" },
          details: {
            type: "array",
            description: "Present on validation failures.",
            items: {
              type: "object",
              properties: { path: { type: "string" }, message: { type: "string" } },
            },
          },
        },
        required: ["code", "message"],
      },
    },
    required: ["error"],
  },

  Submitter: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: ["string", "null"] },
      type: enumOf(SUBMITTER_TYPES),
      tier: nullableEnumOf(CUSTOMER_TIERS),
      accountName: { type: ["string", "null"] },
      arrUsd: { type: ["number", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  FeatureRequest: {
    type: "object",
    properties: {
      id: { type: "string", example: "req_1f0c…" },
      title: { type: "string" },
      description: { type: "string" },
      submitterId: { type: "string" },
      clusterId: {
        type: ["string", "null"],
        description: "Null until the analysis pipeline has grouped it.",
      },
      status: enumOf(REQUEST_STATUSES),
      source: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  RequestAnalysis: {
    type: "object",
    description: "Cached output of the need-extraction stage. Null until analysis completes.",
    properties: {
      requestId: { type: "string" },
      underlyingNeed: {
        type: "string",
        description: "The problem behind the literal feature ask.",
      },
      jobToBeDone: { type: "string" },
      problemSummary: { type: "string" },
      severity: enumOf(SEVERITY_LEVELS),
      urgency: { type: "integer", minimum: 0, maximum: 100 },
      sentiment: enumOf(["frustrated", "neutral", "enthusiastic"]),
      strategicAlignment: { type: "integer", minimum: 0, maximum: 100 },
      suggestedTeam: { type: "string" },
      suggestedProductArea: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Below 0.5 means the request text was too thin to interpret confidently.",
      },
      reasoning: { type: "string", description: "Why the model read it this way." },
      model: { type: "string" },
      promptVersion: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  ScoreComponents: {
    type: "object",
    description: "Each 0-100. The total is their weighted average.",
    properties: {
      submitterWeight: { type: "number" },
      reach: { type: "number" },
      severity: { type: "number" },
      strategicAlignment: { type: "number" },
      urgency: { type: "number" },
    },
  },

  PriorityScore: {
    type: "object",
    properties: {
      id: { type: "string" },
      clusterId: { type: "string" },
      total: { type: "number", minimum: 0, maximum: 100 },
      components: ref("ScoreComponents"),
      rationale: { type: "string", description: "AI-written explanation of the score." },
      evidence: { type: "array", items: { type: "string" } },
      weightsVersion: {
        type: "string",
        description: "Content hash of the scoring config this score was computed under.",
      },
      inputsFingerprint: { type: "string" },
      evidenceFingerprint: { type: "string" },
      rationaleStale: {
        type: "boolean",
        description:
          "True when the weights changed but the explanation was carried forward rather than regenerated. The component values it describes are still accurate.",
      },
      model: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  RankedCluster: {
    type: "object",
    properties: {
      clusterId: { type: "string" },
      title: { type: "string" },
      canonicalNeed: { type: "string" },
      status: enumOf(CLUSTER_STATUSES),
      themeId: { type: ["string", "null"] },
      themeName: { type: ["string", "null"] },
      productArea: { type: ["string", "null"] },
      owningTeam: { type: ["string", "null"] },
      score: { type: "number" },
      components: ref("ScoreComponents"),
      rationale: { type: "string" },
      requestCount: { type: "integer" },
      supporterCount: { type: "integer" },
      distinctAccounts: { type: "integer" },
      totalArrUsd: { type: "integer" },
      topSegment: { type: ["string", "null"] },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  ClusterLocation: {
    type: "object",
    description:
      "Where a cluster sits in the current ranking. Lets a client holding only an id deep-link to the page the cluster is actually on.",
    properties: {
      clusterId: { type: "string" },
      found: {
        type: "boolean",
        description: "False when the id no longer exists - merged away or deleted.",
      },
      rank: { type: ["integer", "null"], description: "1-based position in the filtered ranking." },
      page: { type: ["integer", "null"] },
    },
  },

  SupportSignal: {
    type: "object",
    description: "The replacement for an upvote: a described impact, not a counter.",
    properties: {
      id: { type: "string" },
      clusterId: { type: "string" },
      requestId: { type: "string" },
      submitterId: { type: "string" },
      impactText: { type: "string" },
      currentWorkaround: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  DecisionBrief: {
    type: "object",
    properties: {
      id: { type: "string" },
      clusterId: { type: "string" },
      problem: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      affectedSegments: { type: "array", items: { type: "string" } },
      recommendedPriority: enumOf(["now", "next", "later", "decline"]),
      suggestedNextStep: { type: "string" },
      risksIfIgnored: { type: "string" },
      openQuestions: { type: "array", items: { type: "string" } },
      status: enumOf(["draft", "approved"]),
      approvedBy: { type: ["string", "null"] },
      model: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  StakeholderUpdate: {
    type: "object",
    description: "Always a draft. Never sent automatically.",
    properties: {
      id: { type: "string" },
      clusterId: { type: "string" },
      audience: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      status: enumOf(["draft", "sent"]),
      model: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  MergeSuggestion: {
    type: "object",
    description:
      "A consolidation the model proposed but was not confident enough to apply. The human-in-the-loop queue.",
    properties: {
      id: { type: "string" },
      requestId: { type: "string" },
      targetClusterId: { type: "string" },
      verdict: enumOf(["duplicate", "related"]),
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string" },
      status: enumOf(["pending", "accepted", "rejected"]),
      requestTitle: { type: "string" },
      targetClusterTitle: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  AuditEvent: {
    type: "object",
    properties: {
      id: { type: "string" },
      entityType: { type: "string" },
      entityId: { type: "string" },
      type: { type: "string", example: "need_extracted" },
      actor: { type: "string", example: "ai:claude-haiku-4-5" },
      payload: { type: "object", additionalProperties: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  OperationalMetrics: {
    type: "object",
    description: "The success metrics, computed from the audit trail rather than self-reported.",
    properties: {
      totalRequests: { type: "integer" },
      totalClusters: { type: "integer" },
      consolidationRate: {
        type: "number",
        description: "Percent of requests folded into an existing need.",
      },
      duplicatesAbsorbed: { type: "integer" },
      analysedRequests: { type: "integer" },
      pendingAnalysis: { type: "integer" },
      pendingMergeReviews: { type: "integer" },
      medianTimeToPrioritisationSeconds: { type: ["integer", "null"] },
      rationaleCompleteness: {
        type: "object",
        description: "The anti-gaming metric: can each ranking decision be reconstructed?",
        properties: {
          scoredClusters: { type: "integer" },
          withRationale: { type: "integer" },
          withEvidence: { type: "integer" },
          withBrief: { type: "integer" },
          percent: { type: "number" },
        },
      },
      aiUsageByStage: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stage: { type: "string" },
            calls: { type: "integer" },
            cacheHits: { type: "integer" },
            inputTokens: { type: "integer" },
            outputTokens: { type: "integer" },
            avgLatencyMs: { type: "integer" },
            failures: { type: "integer" },
          },
        },
      },
      jobs: { type: "object", additionalProperties: { type: "integer" } },
    },
  },
};

// --- document --------------------------------------------------------------

/**
 * Fills in the mechanical parts of every operation so they cannot be forgotten:
 * a stable `operationId` (client generators need one, and a hand-maintained
 * list drifts), and the shared error responses.
 */
function finalizeOperations(paths: Record<string, Record<string, JsonSchema>>): void {
  const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const operationIdFor = (method: string, path: string): string =>
    method +
    path
      .split("/")
      .filter(Boolean)
      .map((segment) =>
        segment.startsWith("{")
          ? `By${capitalise(segment.slice(1, -1))}`
          : capitalise(segment.replace(/-(.)/g, (_, c: string) => c.toUpperCase())),
      )
      .join("");

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      operation.operationId ??= operationIdFor(method, path);

      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      // Every operation can be rate limited, and any of them can 500. Stating
      // it once here beats 26 copies that fall out of sync.
      responses["429"] ??= errorResponse("Rate limited.");
      responses["500"] ??= errorResponse("Unexpected server error.");
      operation.responses = responses;
    }
  }
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths = buildPaths();
  finalizeOperations(paths as Record<string, Record<string, JsonSchema>>);

  return {
    openapi: "3.1.0",
    info: {
      title: "Feature Intelligence API",
      version: "1.0.0",
      // SPDX identifier for "not licensed for redistribution" - accurate for a
      // private project, and what the linter wants instead of a bare name.
      license: { name: "UNLICENSED", identifier: "LicenseRef-Proprietary" },
      description: [
        "Turns unstructured feature requests into product decisions.",
        "",
        "**The cluster, not the request, is the unit of prioritisation.** Every request belongs to exactly one cluster (a cluster of one if it is genuinely novel); scores, themes, briefs and status all hang off the cluster.",
        "",
        "**Analysis is asynchronous.** `POST /requests` returns `202` immediately and enqueues the pipeline — extraction, duplicate adjudication, theming and scoring run on a background worker. Poll the request until `status` is `analyzed`.",
        "",
        "**No authentication yet.** Mutating endpoints accept an `actor` string on trust. This is the largest gap before production and is deliberately documented rather than hidden.",
      ].join("\n"),
    },
    servers: [{ url: "/api", description: "This server" }],
    tags: [
      { name: "Requests", description: "Submission, discovery and support signals." },
      { name: "Clusters", description: "Consolidated needs, their briefs and outbound updates." },
      { name: "Review", description: "Human-in-the-loop: merges and drafts awaiting a decision." },
      { name: "Analytics", description: "The stakeholder dashboard's read models." },
      { name: "Settings", description: "Operator-tunable scoring policy." },
      { name: "System", description: "Health." },
    ],
    components: { schemas: SCHEMAS },
    // Deliberately empty, and deliberately explicit: this API has no
    // authentication yet. Declaring it as "no security required" documents the
    // real state rather than leaving a linter to guess.
    security: [],
    paths,
  };
}

function buildPaths(): Record<string, unknown> {
  return {
      "/health": {
        get: {
          tags: ["System"],
          summary: "Liveness, AI mode and queue depth",
          responses: {
            "200": {
              description: "OK",
              ...json({
                type: "object",
                properties: {
                  status: { type: "string" },
                  aiMode: {
                    ...enumOf(["live", "dry-run"]),
                    description: "`dry-run` means no Claude calls are made and stubs are returned.",
                  },
                  models: {
                    type: "object",
                    properties: { primary: { type: "string" }, fast: { type: "string" } },
                  },
                  queueDepth: { type: "integer" },
                },
              }),
            },
          },
        },
      },

      "/requests": {
        post: {
          tags: ["Requests"],
          summary: "Submit a feature request",
          description:
            "Persists the request and returns **202** — the AI analysis has not run yet. The write and the job enqueue share a transaction, so a crash cannot leave a request that never gets analysed.",
          parameters: [idempotencyHeader],
          requestBody: { required: true, ...json(jsonSchema(CreateRequestSchema)) },
          responses: {
            "202": {
              description: "Accepted and queued for analysis.",
              ...json({
                type: "object",
                properties: {
                  request: ref("FeatureRequest"),
                  submitter: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                  },
                  analysisStatus: { type: "string", example: "queued" },
                  message: { type: "string" },
                },
              }),
            },
            "409": errorResponse("Idempotency-Key reused with a different body."),
            ...COMMON_ERRORS,
          },
        },
        get: {
          tags: ["Requests"],
          summary: "Search and filter requests",
          description:
            "Full-text search runs over title, description and the extracted underlying need (SQLite FTS5).",
          parameters: queryParams(ListRequestsQuerySchema),
          responses: {
            "200": {
              description: "A page of requests with cluster context attached.",
              ...json({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      allOf: [
                        ref("FeatureRequest"),
                        {
                          type: "object",
                          properties: {
                            submitterName: { type: "string" },
                            submitterType: enumOf(SUBMITTER_TYPES),
                            underlyingNeed: { type: ["string", "null"] },
                            severity: nullableEnumOf(SEVERITY_LEVELS),
                            cluster: { type: ["object", "null"] },
                          },
                        },
                      ],
                    },
                  },
                  page: { type: "integer" },
                  pageSize: { type: "integer" },
                  total: { type: "integer" },
                  totalPages: { type: "integer" },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/requests/{id}": {
        get: {
          tags: ["Requests"],
          summary: "Full detail, including the AI's reasoning",
          parameters: [pathParam("id", "Request id, e.g. `req_1f0c…`")],
          responses: {
            "200": {
              description: "The request, its analysis, its cluster, and why it was grouped.",
              ...json({
                type: "object",
                properties: {
                  request: ref("FeatureRequest"),
                  submitter: ref("Submitter"),
                  analysis: { oneOf: [ref("RequestAnalysis"), { type: "null" }] },
                  cluster: { type: ["object", "null"] },
                  mergeDecision: {
                    type: ["object", "null"],
                    description: "Why this request was placed in its cluster, shown to the user.",
                    properties: {
                      decidedBy: enumOf(["ai", "human"]),
                      confidence: { type: "number" },
                      rationale: { type: "string" },
                    },
                  },
                  relatedRequests: { type: "array", items: { type: "object" } },
                  supportSignals: { type: "array", items: ref("SupportSignal") },
                  timeline: { type: "array", items: ref("AuditEvent") },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/requests/{id}/support": {
        post: {
          tags: ["Requests"],
          summary: "Register support, with a described impact",
          description:
            "Not an upvote. The impact text is read by the scoring and brief stages, so a bare `+1` is rejected. Unique per (cluster, submitter): re-supporting updates the description rather than inflating reach.",
          parameters: [pathParam("id", "Request id"), idempotencyHeader],
          requestBody: { required: true, ...json(jsonSchema(SupportRequestSchema)) },
          responses: {
            "201": {
              description: "Signal recorded; the cluster is queued for re-scoring.",
              ...json({
                type: "object",
                properties: { signal: ref("SupportSignal"), submitter: ref("Submitter") },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/requests/{id}/split": {
        post: {
          tags: ["Review"],
          summary: "Human override: pull a request out of its cluster",
          description:
            "The escape hatch that makes automatic merging safe to enable. Records who split it and why.",
          parameters: [pathParam("id", "Request id")],
          requestBody: { required: true, ...json(jsonSchema(SplitRequestSchema)) },
          responses: {
            "200": {
              description: "Moved to a new cluster of its own.",
              ...json({
                type: "object",
                properties: {
                  clusterId: { type: "string" },
                  previousClusterId: { type: "string" },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/clusters": {
        get: {
          tags: ["Clusters"],
          summary: "List themes",
          description:
            "Returns the AI-derived theme taxonomy. **Note:** the path is a misnomer inherited from an earlier iteration — it returns themes, not clusters. For clusters use `/analytics/clusters`.",
          responses: {
            "200": {
              description: "Themes.",
              ...json({
                type: "object",
                properties: {
                  themes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        productArea: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
      },

      "/clusters/{id}": {
        get: {
          tags: ["Clusters"],
          summary: "Cluster detail with score history and members",
          parameters: [pathParam("id", "Cluster id, e.g. `clu_789a…`")],
          responses: {
            "200": {
              description: "The consolidated need and everything hanging off it.",
              ...json({
                type: "object",
                properties: {
                  cluster: { type: "object" },
                  score: { oneOf: [ref("PriorityScore"), { type: "null" }] },
                  scoreHistory: { type: "array", items: ref("PriorityScore") },
                  brief: { oneOf: [ref("DecisionBrief"), { type: "null" }] },
                  updates: { type: "array", items: ref("StakeholderUpdate") },
                  supportSignals: { type: "array", items: ref("SupportSignal") },
                  requests: { type: "array", items: { type: "object" } },
                  timeline: { type: "array", items: ref("AuditEvent") },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/clusters/{id}/status": {
        patch: {
          tags: ["Clusters"],
          summary: "Set roadmap status",
          description: "Always a human decision. The pipeline never sets this.",
          parameters: [pathParam("id", "Cluster id")],
          requestBody: { required: true, ...json(jsonSchema(UpdateClusterStatusSchema)) },
          responses: { "200": { description: "Updated cluster." }, ...COMMON_ERRORS },
        },
      },

      "/clusters/{id}/brief": {
        post: {
          tags: ["Clusters"],
          summary: "Generate a decision brief (Opus-tier, synchronous)",
          description:
            "Synchronous on purpose: a human clicked and is waiting to read it. Rate-limited because each call is immediate spend.",
          parameters: [pathParam("id", "Cluster id")],
          responses: {
            "200": { description: "The generated brief.", ...json(ref("DecisionBrief")) },
            "503": errorResponse("The analysis service was unavailable. Nothing was lost."),
            ...COMMON_ERRORS,
          },
        },
      },

      "/clusters/{id}/updates": {
        post: {
          tags: ["Clusters"],
          summary: "Draft a stakeholder message (Opus-tier)",
          description:
            "Produces a **draft only**. Nothing is sent to a customer without a human marking it sent. Only the `note` you supply can become a commitment — the model is instructed to invent no dates.",
          parameters: [pathParam("id", "Cluster id")],
          requestBody: { required: true, ...json(jsonSchema(GenerateUpdateSchema)) },
          responses: {
            "201": { description: "Draft created.", ...json(ref("StakeholderUpdate")) },
            ...COMMON_ERRORS,
          },
        },
      },

      "/clusters/{id}/rescore": {
        post: {
          tags: ["Clusters"],
          summary: "Re-score a cluster",
          parameters: [
            pathParam("id", "Cluster id"),
            {
              name: "force",
              in: "query",
              required: false,
              description:
                "`true` also regenerates the explanation. Without it, a score whose evidence is unchanged reuses the existing rationale and costs no inference.",
              schema: { type: "string", enum: ["true", "false"] },
            },
          ],
          responses: {
            "200": {
              description: "Score result.",
              ...json({
                type: "object",
                properties: {
                  clusterId: { type: "string" },
                  total: { type: "number" },
                  skipped: { type: "boolean" },
                  rationaleSource: enumOf(["generated", "reused", "unchanged"]),
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/review/merge-suggestions": {
        get: {
          tags: ["Review"],
          summary: "Consolidations awaiting a human decision",
          description:
            "Merges the model proposed below the auto-apply confidence threshold. A false merge hides someone's request, so these wait for a person.",
          responses: {
            "200": {
              description: "Pending suggestions, most confident first.",
              ...json({
                type: "object",
                properties: {
                  suggestions: { type: "array", items: ref("MergeSuggestion") },
                },
              }),
            },
          },
        },
      },

      "/review/merge-suggestions/{id}/accept": {
        post: {
          tags: ["Review"],
          summary: "Accept a proposed merge",
          parameters: [pathParam("id", "Suggestion id")],
          requestBody: { required: true, ...json(jsonSchema(ResolveSuggestionSchema)) },
          responses: {
            "200": {
              description: "Merged; an emptied source cluster is removed.",
              ...json({
                type: "object",
                properties: { merged: { type: "boolean" }, clusterId: { type: "string" } },
              }),
            },
            "409": errorResponse("Already resolved."),
            ...COMMON_ERRORS,
          },
        },
      },

      "/review/merge-suggestions/{id}/reject": {
        post: {
          tags: ["Review"],
          summary: "Reject a proposed merge",
          parameters: [pathParam("id", "Suggestion id")],
          requestBody: { required: true, ...json(jsonSchema(ResolveSuggestionSchema)) },
          responses: {
            "200": { description: "Kept separate." },
            "409": errorResponse("Already resolved."),
            ...COMMON_ERRORS,
          },
        },
      },

      "/review/briefs/{id}/revise": {
        post: {
          tags: ["Review"],
          summary: "Edit or approve an AI-drafted brief",
          description:
            "Writes a new revision rather than mutating the original, so what the AI proposed survives the human rewrite.",
          parameters: [pathParam("id", "Brief id")],
          requestBody: { required: true, ...json(jsonSchema(ReviseBriefSchema)) },
          responses: {
            "200": { description: "The new revision.", ...json(ref("DecisionBrief")) },
            ...COMMON_ERRORS,
          },
        },
      },

      "/review/updates/{id}/sent": {
        post: {
          tags: ["Review"],
          summary: "Mark a stakeholder update as sent",
          parameters: [pathParam("id", "Update id")],
          requestBody: { required: true, ...json(jsonSchema(ResolveSuggestionSchema)) },
          responses: {
            "200": { description: "Marked sent.", ...json(ref("StakeholderUpdate")) },
            ...COMMON_ERRORS,
          },
        },
      },

      "/analytics/dashboard": {
        get: {
          tags: ["Analytics"],
          summary: "Charts and metrics in one call",
          description:
            "Deliberately excludes the ranked cluster list — that pages independently via `/analytics/clusters`, so paging does not refetch the charts.",
          parameters: queryParams(TrendQuerySchema),
          responses: {
            "200": {
              description: "Dashboard read model.",
              ...json({
                type: "object",
                properties: {
                  byTheme: { type: "array", items: { type: "object" } },
                  volumeTrend: { type: "array", items: { type: "object" } },
                  submitterMix: { type: "array", items: { type: "object" } },
                  scoreDistribution: { type: "array", items: { type: "object" } },
                  metrics: ref("OperationalMetrics"),
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/analytics/clusters": {
        get: {
          tags: ["Analytics"],
          summary: "Paged, searchable ranked cluster list",
          description: [
            "Paging and filtering run in SQL over the whole dataset, not over a previously-loaded page.",
            "",
            "`focus=<clusterId>` additionally resolves where that cluster sits in the current ranking, so a deep link carrying only an id lands on the right page in one round trip — the response serves the focused cluster's page directly. An id that no longer exists returns `focus.found: false` with the list still populated, rather than an error.",
          ].join("\n"),
          parameters: queryParams(ClusterPageQuerySchema),
          responses: {
            "200": {
              description: "One page of the ranking.",
              ...json({
                type: "object",
                properties: {
                  items: { type: "array", items: ref("RankedCluster") },
                  page: { type: "integer" },
                  pageSize: { type: "integer" },
                  total: { type: "integer" },
                  totalPages: { type: "integer" },
                  focus: { oneOf: [ref("ClusterLocation"), { type: "null" }] },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/analytics/top": {
        get: {
          tags: ["Analytics"],
          summary: "Top ranked clusters (unpaged)",
          parameters: queryParams(TopClustersQuerySchema),
          responses: {
            "200": {
              description: "Ranked clusters.",
              ...json({
                type: "object",
                properties: { clusters: { type: "array", items: ref("RankedCluster") } },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/analytics/by-theme": {
        get: {
          tags: ["Analytics"],
          summary: "Ranked needs grouped by theme",
          responses: { "200": { description: "Theme breakdown." } },
        },
      },

      "/analytics/metrics": {
        get: {
          tags: ["Analytics"],
          summary: "Operational and success metrics",
          responses: {
            "200": { description: "Metrics.", ...json(ref("OperationalMetrics")) },
          },
        },
      },

      "/analytics/activity": {
        get: {
          tags: ["Analytics"],
          summary: "Recent audit events",
          responses: {
            "200": {
              description: "Events, newest first.",
              ...json({
                type: "object",
                properties: { events: { type: "array", items: ref("AuditEvent") } },
              }),
            },
          },
        },
      },

      "/analytics/emerging": {
        get: {
          tags: ["Analytics"],
          summary: "Emerging-needs report (Opus-tier, cached)",
          description:
            "Whole-corpus trend synthesis. Serves the cached report by default; `refresh=true` recomputes and is real spend.",
          parameters: queryParams(EmergingQuerySchema),
          responses: {
            "200": {
              description: "Trends and a summary.",
              ...json({
                type: "object",
                properties: {
                  trends: { type: "array", items: { type: "object" } },
                  summary: { type: "string" },
                  model: { type: "string" },
                  cached: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },

      "/settings/scoring": {
        get: {
          tags: ["Settings"],
          summary: "Read the scoring policy",
          description:
            "Submitter weights, tier multipliers, component weights and the strategy pillars. These encode commercial policy, not fact, which is why they are configuration rather than code.",
          responses: {
            "200": {
              description: "Config plus its content-hash version.",
              ...json({
                type: "object",
                properties: {
                  config: { type: "object" },
                  version: { type: "string" },
                },
              }),
            },
          },
        },
        put: {
          tags: ["Settings"],
          summary: "Re-weight the ranking",
          description:
            "Re-ranks the whole board. Because the scoring arithmetic is deterministic and the model's judgments are cached, this costs **no inference** unless a cluster's underlying evidence also changed — affected scores carry the prior explanation forward, flagged `rationaleStale`.",
          requestBody: { required: true, ...json(jsonSchema(UpdateScoringConfigSchema)) },
          responses: {
            "200": {
              description: "Saved; a rescore is queued.",
              ...json({
                type: "object",
                properties: {
                  config: { type: "object" },
                  version: { type: "string" },
                  rescoreQueued: { type: "boolean" },
                },
              }),
            },
            ...COMMON_ERRORS,
          },
        },
      },
  };
}
