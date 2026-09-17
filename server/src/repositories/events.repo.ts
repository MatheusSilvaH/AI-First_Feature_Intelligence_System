import { getDb, rows } from "../db/index.js";
import { parseJson } from "../db/sql.js";
import { eventId } from "../lib/ids.js";

export interface AuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
}

const toDomain = (r: EventRow): AuditEvent => ({
  id: r.id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  type: r.type,
  actor: r.actor,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  createdAt: r.created_at,
});

export function record(input: {
  entityType: string;
  entityId: string;
  type: string;
  actor?: string;
  payload?: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, entity_type, entity_id, type, actor, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId(),
      input.entityType,
      input.entityId,
      input.type,
      input.actor ?? "system",
      JSON.stringify(input.payload ?? {}),
    );
}

export function forEntity(entityType: string, entityId: string, limit = 100): AuditEvent[] {
  return rows<EventRow>(
    getDb()
      .prepare(
        `SELECT * FROM events WHERE entity_type = ? AND entity_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(entityType, entityId, limit),
  ).map(toDomain);
}

export function recent(limit = 50): AuditEvent[] {
  return rows<EventRow>(
    getDb().prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit),
  ).map(toDomain);
}
