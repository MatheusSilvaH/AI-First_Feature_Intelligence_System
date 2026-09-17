import { getDb, row } from "../db/index.js";
import { parseJson } from "../db/sql.js";
import { sha256, stableStringify } from "../lib/ids.js";

export interface StoredSetting<T> {
  value: T;
  version: string;
  updatedAt: string;
}

export function get<T>(key: string): StoredSetting<T> | null {
  const r = row<{ value: string; version: string; updated_at: string }>(
    getDb().prepare("SELECT value, version, updated_at FROM settings WHERE key = ?").get(key),
  );
  if (!r) return null;
  const parsed = parseJson<T | null>(r.value, null);
  if (parsed === null) return null;
  return { value: parsed, version: r.version, updatedAt: r.updated_at };
}

/**
 * The version is a content hash, not a counter. Scores record the weights
 * version they were computed under, so "this ranking used the old weights" is
 * answerable without a separate changelog.
 */
export function put<T>(key: string, value: T): StoredSetting<T> {
  const version = sha256(stableStringify(value)).slice(0, 12);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, version)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         version = excluded.version,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(key, JSON.stringify(value), version);
  return get<T>(key)!;
}
