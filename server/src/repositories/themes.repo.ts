import { getDb, row, rows } from "../db/index.js";
import { themeId as newThemeId } from "../lib/ids.js";
import type { Theme } from "../domain/types.js";

interface ThemeRow {
  id: string;
  name: string;
  description: string;
  product_area: string;
  created_at: string;
}

const toDomain = (r: ThemeRow): Theme => ({
  id: r.id,
  name: r.name,
  description: r.description,
  productArea: r.product_area,
  createdAt: r.created_at,
});

export function listAll(): Theme[] {
  return rows<ThemeRow>(getDb().prepare("SELECT * FROM themes ORDER BY name ASC").all()).map(
    toDomain,
  );
}

export function findById(id: string): Theme | null {
  const r = row<ThemeRow>(getDb().prepare("SELECT * FROM themes WHERE id = ?").get(id));
  return r ? toDomain(r) : null;
}

export function findByName(name: string): Theme | null {
  const r = row<ThemeRow>(getDb().prepare("SELECT * FROM themes WHERE name = ?").get(name));
  return r ? toDomain(r) : null;
}

/**
 * Themes are an open vocabulary the model extends over time. We match on name
 * so the theming stage can either reuse an existing theme or mint a new one
 * without the caller needing to know which happened.
 */
export function upsertByName(input: {
  name: string;
  description: string;
  productArea: string;
}): Theme {
  const existing = findByName(input.name);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE themes
            SET description  = CASE WHEN description = '' THEN ? ELSE description END,
                product_area = CASE WHEN product_area = 'unassigned' THEN ? ELSE product_area END
          WHERE id = ?`,
      )
      .run(input.description, input.productArea, existing.id);
    return findById(existing.id)!;
  }

  const id = newThemeId();
  getDb()
    .prepare("INSERT INTO themes (id, name, description, product_area) VALUES (?, ?, ?, ?)")
    .run(id, input.name, input.description, input.productArea);
  return findById(id)!;
}
