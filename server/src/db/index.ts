import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

let db: Db | null = null;

function applyPragmas(conn: Db): void {
  // WAL lets the HTTP handlers read while the background AI worker writes.
  // Not applicable to :memory:, which SQLite keeps in journal mode.
  if (env.DATABASE_PATH !== ":memory:") {
    conn.exec("PRAGMA journal_mode = WAL");
  }
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec("PRAGMA busy_timeout = 5000");
  conn.exec("PRAGMA synchronous = NORMAL");
}

function migrationsDir(): string {
  // Resolves for both `tsx src/...` and the compiled `dist/...` layout, since
  // .sql files are copied next to the JS on build.
  return join(here, "migrations");
}

function runMigrations(conn: Db): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const applied = new Set(
    conn
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    conn.exec("BEGIN");
    try {
      conn.exec(sql);
      conn.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
      conn.exec("COMMIT");
      logger.info({ migration: file }, "applied migration");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

export function getDb(): Db {
  if (db) return db;

  const path = env.DATABASE_PATH;
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const conn = new DatabaseSync(path);
  applyPragmas(conn);
  runMigrations(conn);
  db = conn;
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/**
 * Runs `fn` in a transaction. SQLite here is synchronous and single-writer, so
 * `fn` must be synchronous - an async callback would let another statement
 * interleave inside the transaction.
 */
export function transaction<T>(fn: (conn: Db) => T): T {
  const conn = getDb();
  conn.exec("BEGIN");
  try {
    const result = fn(conn);
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

/** node:sqlite returns null-prototype objects; re-shape them for safe spreading. */
export function rows<T>(result: unknown[]): T[] {
  return result.map((r) => ({ ...(r as object) }) as T);
}

export function row<T>(result: unknown): T | null {
  return result === undefined || result === null ? null : ({ ...(result as object) } as T);
}
