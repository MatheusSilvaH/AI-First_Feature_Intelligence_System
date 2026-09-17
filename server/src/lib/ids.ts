import { randomUUID, createHash } from "node:crypto";

/**
 * Prefixed identifiers. The prefix makes IDs self-describing in logs, URLs and
 * AI prompts - when Claude echoes back `req_1f0c...` we can tell what it meant.
 */
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "")}`;

export const requestId = () => newId("req");
export const clusterId = () => newId("clu");
export const themeId = () => newId("thm");
export const submitterId = () => newId("sub");
export const scoreId = () => newId("scr");
export const signalId = () => newId("sig");
export const briefId = () => newId("brf");
export const updateId = () => newId("upd");
export const eventId = () => newId("evt");
export const jobId = () => newId("job");
export const decisionId = () => newId("dec");
export const insightId = () => newId("ins");
export const callId = () => newId("call");

export const sha256 = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

/** Stable hash of an object, insensitive to key order. */
export function fingerprint(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export const nowIso = (): string => new Date().toISOString();
