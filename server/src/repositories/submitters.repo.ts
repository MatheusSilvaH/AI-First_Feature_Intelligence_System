import { getDb, row, rows } from "../db/index.js";
import { nullable, num } from "../db/sql.js";
import { submitterId } from "../lib/ids.js";
import type { CustomerTier, Submitter, SubmitterType } from "../domain/types.js";

interface SubmitterRow {
  id: string;
  name: string;
  email: string | null;
  type: SubmitterType;
  tier: CustomerTier | null;
  account_name: string | null;
  arr_usd: number | null;
  created_at: string;
}

const toDomain = (r: SubmitterRow): Submitter => ({
  id: r.id,
  name: r.name,
  email: r.email,
  type: r.type,
  tier: r.tier,
  accountName: r.account_name,
  arrUsd: r.arr_usd,
  createdAt: r.created_at,
});

export interface SubmitterInput {
  name: string;
  email?: string | null;
  type: SubmitterType;
  tier?: CustomerTier | null;
  accountName?: string | null;
  arrUsd?: number | null;
}

export function findById(id: string): Submitter | null {
  const r = row<SubmitterRow>(getDb().prepare("SELECT * FROM submitters WHERE id = ?").get(id));
  return r ? toDomain(r) : null;
}

export function findByEmail(email: string): Submitter | null {
  const r = row<SubmitterRow>(
    getDb().prepare("SELECT * FROM submitters WHERE email = ?").get(email),
  );
  return r ? toDomain(r) : null;
}

export function listAll(): Submitter[] {
  return rows<SubmitterRow>(
    getDb().prepare("SELECT * FROM submitters ORDER BY created_at DESC").all(),
  ).map(toDomain);
}

export function create(input: SubmitterInput): Submitter {
  const id = submitterId();
  getDb()
    .prepare(
      `INSERT INTO submitters (id, name, email, type, tier, account_name, arr_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      nullable(input.email),
      input.type,
      nullable(input.tier),
      nullable(input.accountName),
      num(input.arrUsd),
    );
  return findById(id)!;
}

/**
 * Submitters arrive attached to requests rather than through a signup flow, so
 * the email is the natural identity. Re-submitting with richer account context
 * (e.g. support later supplies the ARR) upgrades the stored record instead of
 * creating a second identity that would double-count reach in scoring.
 */
export function upsertByEmail(input: SubmitterInput): Submitter {
  if (!input.email) return create(input);

  const existing = findByEmail(input.email);
  if (!existing) return create(input);

  getDb()
    .prepare(
      `UPDATE submitters
          SET name         = ?,
              type         = ?,
              tier         = COALESCE(?, tier),
              account_name = COALESCE(?, account_name),
              arr_usd      = COALESCE(?, arr_usd)
        WHERE id = ?`,
    )
    .run(
      input.name,
      input.type,
      nullable(input.tier),
      nullable(input.accountName),
      num(input.arrUsd),
      existing.id,
    );

  return findById(existing.id)!;
}
