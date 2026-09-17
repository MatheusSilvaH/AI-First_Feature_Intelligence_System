/**
 * node:sqlite only binds null | number | bigint | string | Uint8Array. These
 * helpers keep that coercion in one place instead of at every call site.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export const nullable = (v: string | null | undefined): string | null =>
  v === undefined || v === null ? null : v;

export const num = (v: number | null | undefined): number | null =>
  v === undefined || v === null || Number.isNaN(v) ? null : v;

export const bool = (v: boolean): number => (v ? 1 : 0);

export const fromBool = (v: unknown): boolean => v === 1 || v === true;

export const json = (v: unknown): string => JSON.stringify(v ?? null);

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Escapes user text for an FTS5 MATCH expression. FTS5 treats characters like
 * `"`, `*`, `:`, `-`, `(`, `^` as operators; a raw user query containing them
 * is a syntax error, not a no-op. Quoting each token as a literal phrase and
 * OR-ing them gives "any of these words" semantics safely.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
