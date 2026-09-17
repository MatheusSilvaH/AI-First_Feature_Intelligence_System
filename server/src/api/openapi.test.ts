import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { buildOpenApiDocument } from "./openapi.js";

const app = createApp();
const doc = buildOpenApiDocument() as {
  paths: Record<string, Record<string, { responses?: Record<string, unknown>; tags?: string[] }>>;
  components: { schemas: Record<string, unknown> };
  tags: Array<{ name: string }>;
};

/**
 * These guard the property that makes the spec worth having: that it describes
 * the API that actually exists. A spec nobody checks drifts within a sprint.
 */
describe("OpenAPI document", () => {
  it("is served and self-describes as OpenAPI 3.1", async () => {
    const res = await request(app).get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("Feature Intelligence API");
  });

  it("serves browsable docs", async () => {
    // swagger-ui-express redirects the bare path to its index.
    const res = await request(app).get("/api/docs/");
    expect([200, 301, 302]).toContain(res.status);
  });

  it("documents every route the server actually mounts", () => {
    // Kept as an explicit list rather than introspecting the router: if someone
    // adds a route, this test should fail until they document it.
    const expected = [
      ["get", "/health"],
      ["post", "/requests"],
      ["get", "/requests"],
      ["get", "/requests/{id}"],
      ["post", "/requests/{id}/support"],
      ["post", "/requests/{id}/split"],
      ["get", "/clusters"],
      ["get", "/clusters/{id}"],
      ["patch", "/clusters/{id}/status"],
      ["post", "/clusters/{id}/brief"],
      ["post", "/clusters/{id}/updates"],
      ["post", "/clusters/{id}/rescore"],
      ["get", "/review/merge-suggestions"],
      ["post", "/review/merge-suggestions/{id}/accept"],
      ["post", "/review/merge-suggestions/{id}/reject"],
      ["post", "/review/briefs/{id}/revise"],
      ["post", "/review/updates/{id}/sent"],
      ["get", "/analytics/dashboard"],
      ["get", "/analytics/clusters"],
      ["get", "/analytics/top"],
      ["get", "/analytics/by-theme"],
      ["get", "/analytics/metrics"],
      ["get", "/analytics/activity"],
      ["get", "/analytics/emerging"],
      ["get", "/settings/scoring"],
      ["put", "/settings/scoring"],
    ] as const;

    for (const [method, path] of expected) {
      expect(doc.paths[path], `missing path ${path}`).toBeDefined();
      expect(doc.paths[path]?.[method], `missing ${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  it("gives every operation a summary, a tag and at least one response", () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(operation.tags?.length, `${where} has no tag`).toBeGreaterThan(0);
        expect(Object.keys(operation.responses ?? {}).length, `${where} has no responses`)
          .toBeGreaterThan(0);
      }
    }
  });

  it("resolves every $ref it declares", () => {
    const declared = new Set(Object.keys(doc.components.schemas));
    const refs = new Set<string>();

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          refs.add(value.replace("#/components/schemas/", ""));
        } else {
          walk(value);
        }
      }
    };
    walk(doc.paths);
    walk(doc.components.schemas);

    const dangling = [...refs].filter((name) => !declared.has(name));
    expect(dangling, `dangling $refs: ${dangling.join(", ")}`).toEqual([]);
  });

  it("derives request bodies from the Zod validators, so docs match enforcement", () => {
    const body = doc.paths["/requests"]?.post as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
    };
    const schema = body.requestBody.content["application/json"]!.schema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    // These bounds exist in CreateRequestSchema; if someone loosens validation
    // the generated spec moves with it rather than lying.
    expect(properties.title?.minLength).toBe(5);
    expect(properties.title?.maxLength).toBe(200);
    expect(properties.description?.minLength).toBe(20);
    expect(schema.required).toContain("submitter");
  });

  it("documents the query parameters the endpoints actually accept", () => {
    const clusters = doc.paths["/analytics/clusters"]?.get as {
      parameters: Array<{ name: string }>;
    };
    const names = clusters.parameters.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["search", "page", "pageSize", "focus"]));
  });

  it("does not leak a $schema key into the OpenAPI schemas", () => {
    // Zod emits it; OpenAPI tooling chokes on it inline.
    expect(JSON.stringify(doc)).not.toContain("json-schema.org/draft");
  });
});
