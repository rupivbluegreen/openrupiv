/**
 * Migration runner + runtime infra tables.
 *
 * App migrations (`migrations/*.sql`, emitted by the compiler) are applied
 * in ascending filename order, each inside its own transaction, and recorded
 * in `_migrations`. Already-applied migrations are skipped (idempotent
 * re-run); there is no rollback path (forward-only, v0).
 *
 * Infra tables are created idempotently at startup, including
 * `workflow_approvals` whose UNIQUE constraint is the database-level
 * backstop for n-eyes distinct-approver enforcement.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db, Queryable } from "./db";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";

export const INFRA_STATEMENTS: readonly string[] = [
  "CREATE EXTENSION IF NOT EXISTS pgcrypto",
  `CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS workflow_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_table text NOT NULL,
  record_id uuid NOT NULL,
  transition text NOT NULL,
  approver_sub text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_table, record_id, transition, approver_sub)
)`,
];

/** Create the runtime's own tables. Safe to run on every startup. */
export async function ensureInfraTables(db: Queryable): Promise<void> {
  for (const statement of INFRA_STATEMENTS) {
    await db.query(statement);
  }
}

/**
 * Apply all `*.sql` files in `migrationsDir`, sorted ascending by filename.
 * Returns the names of migrations applied in this run (skipped ones are
 * logged but not returned). Throws ERR_APP_DIR if the directory is
 * unreadable and ERR_MIGRATION_FAILED if any migration fails (that
 * migration's transaction is rolled back and nothing is recorded for it).
 */
export async function applyMigrations(
  db: Db,
  migrationsDir: string,
  logger: Logger,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (error) {
    throw new RuntimeError(
      "ERR_APP_DIR",
      `cannot read migrations directory ${migrationsDir}: ${errorMessage(error)}`,
    );
  }

  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const name of files) {
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    let didApply: boolean;
    try {
      didApply = await db.transaction(async (tx) => {
        const seen = await tx.query(
          "SELECT name FROM _migrations WHERE name = $1",
          [name],
        );
        if (seen.rows.length > 0) return false;
        await tx.query(sql);
        await tx.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        return true;
      });
    } catch (error) {
      throw new RuntimeError(
        "ERR_MIGRATION_FAILED",
        `migration ${name} failed and was rolled back: ${errorMessage(error)}`,
        { details: { migration: name } },
      );
    }
    if (didApply) {
      applied.push(name);
      logger.info({ event: "migration.applied", migration: name }, "migration applied");
    } else {
      logger.info({ event: "migration.skipped", migration: name }, "migration already applied");
    }
  }

  return applied;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
