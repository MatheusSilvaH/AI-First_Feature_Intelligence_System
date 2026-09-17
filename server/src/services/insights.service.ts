import { getDb, row } from "../db/index.js";
import { parseJson } from "../db/sql.js";
import { insightId } from "../lib/ids.js";
import type { EmergingNeeds } from "./ai/schemas.js";

const KIND = "emerging_needs";

export interface StoredEmergingNeeds extends EmergingNeeds {
  model: string;
  createdAt: string;
}

export function saveEmergingNeeds(input: EmergingNeeds & { model: string }): void {
  getDb()
    .prepare("INSERT INTO insights (id, kind, content, model) VALUES (?, ?, ?, ?)")
    .run(insightId(), KIND, JSON.stringify({ trends: input.trends, summary: input.summary }), input.model);
}

export function latestEmergingNeeds(): StoredEmergingNeeds | null {
  const r = row<{ content: string; model: string; created_at: string }>(
    getDb()
      .prepare(
        "SELECT content, model, created_at FROM insights WHERE kind = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(KIND),
  );
  if (!r) return null;

  const content = parseJson<EmergingNeeds | null>(r.content, null);
  if (!content) return null;

  return { ...content, model: r.model, createdAt: r.created_at };
}
