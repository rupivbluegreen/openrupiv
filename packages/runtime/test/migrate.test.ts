import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeError } from "../src/errors";
import { applyMigrations, ensureInfraTables, INFRA_STATEMENTS } from "../src/migrate";
import { FakeDb } from "./helpers/fakeDb";
import { CapturingLogger } from "./helpers/testServer";

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openrupiv-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("ensureInfraTables", () => {
  it("creates pgcrypto, _migrations and workflow_approvals idempotently", async () => {
    const db = new FakeDb();
    await ensureInfraTables(db);
    const executed = db.statements.map((s) => s.text);
    expect(executed.some((s) => s.startsWith("CREATE EXTENSION IF NOT EXISTS pgcrypto"))).toBe(true);
    expect(executed.some((s) => s.includes("CREATE TABLE IF NOT EXISTS _migrations"))).toBe(true);
    expect(executed.some((s) => s.includes("CREATE TABLE IF NOT EXISTS workflow_approvals"))).toBe(true);
  });

  it("declares the n-eyes UNIQUE constraint exactly as contracted", () => {
    const approvals = INFRA_STATEMENTS.find((s) => s.includes("workflow_approvals"));
    expect(approvals).toContain(
      "UNIQUE (entity_table, record_id, transition, approver_sub)",
    );
  });
});

describe("applyMigrations", () => {
  it("applies *.sql files sorted ascending, each recorded in _migrations", async () => {
    const dir = await migrationsDir({
      "0002_second.sql": "CREATE TABLE IF NOT EXISTS two (id int)",
      "0001_first.sql": "CREATE TABLE IF NOT EXISTS one (id int)",
      "notes.txt": "not a migration",
    });
    const db = new FakeDb();
    const logger = new CapturingLogger();

    const applied = await applyMigrations(db, dir, logger);
    expect(applied).toEqual(["0001_first.sql", "0002_second.sql"]);

    const creates = db.statements
      .map((s) => s.text)
      .filter((s) => s.startsWith("CREATE TABLE IF NOT EXISTS"));
    expect(creates).toEqual([
      "CREATE TABLE IF NOT EXISTS one (id int)",
      "CREATE TABLE IF NOT EXISTS two (id int)",
    ]);
    expect(db.rows("_migrations").map((r) => r["name"]).sort()).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
  });

  it("is idempotent: a re-run applies nothing and re-executes nothing", async () => {
    const dir = await migrationsDir({
      "0001_first.sql": "CREATE TABLE IF NOT EXISTS one (id int)",
    });
    const db = new FakeDb();
    const logger = new CapturingLogger();

    await applyMigrations(db, dir, logger);
    const executedOnce = db.statements.filter((s) =>
      s.text.startsWith("CREATE TABLE"),
    ).length;

    const secondRun = await applyMigrations(db, dir, logger);
    expect(secondRun).toEqual([]);
    const executedTwice = db.statements.filter((s) =>
      s.text.startsWith("CREATE TABLE"),
    ).length;
    expect(executedTwice).toBe(executedOnce);
    expect(logger.findAll("migration.skipped")).toHaveLength(1);
  });

  it("rolls back and reports a typed error when a migration fails", async () => {
    const dir = await migrationsDir({
      "0001_ok.sql": "CREATE TABLE IF NOT EXISTS one (id int)",
      "0002_broken.sql": "THIS IS NOT SQL THE FAKE UNDERSTANDS",
    });
    const db = new FakeDb();
    const logger = new CapturingLogger();

    await expect(applyMigrations(db, dir, logger)).rejects.toMatchObject({
      code: "ERR_MIGRATION_FAILED",
      details: { migration: "0002_broken.sql" },
    });
    // The failed migration is not recorded; the earlier one is.
    expect(db.rows("_migrations").map((r) => r["name"])).toEqual(["0001_ok.sql"]);
  });

  it("throws ERR_APP_DIR for a missing migrations directory", async () => {
    const db = new FakeDb();
    const logger = new CapturingLogger();
    await expect(
      applyMigrations(db, "/does/not/exist", logger),
    ).rejects.toMatchObject({ code: "ERR_APP_DIR" });
    expect(db.statements).toHaveLength(0);
  });

  it("wraps each migration in its own transaction (BEGIN visible as check+run+record)", async () => {
    const dir = await migrationsDir({
      "0001_first.sql": "CREATE TABLE IF NOT EXISTS one (id int)",
    });
    const db = new FakeDb();
    await applyMigrations(db, dir, new CapturingLogger());
    const texts = db.statements.map((s) => s.text);
    expect(texts).toEqual([
      "SELECT name FROM _migrations WHERE name = $1",
      "CREATE TABLE IF NOT EXISTS one (id int)",
      "INSERT INTO _migrations (name) VALUES ($1)",
    ]);
  });
});

describe("RuntimeError.toBody", () => {
  it("serializes to the machine-readable HTTP error shape", () => {
    const error = new RuntimeError("ERR_MIGRATION_FAILED", "boom", {
      statusCode: 500,
      details: { migration: "0001.sql" },
    });
    expect(error.toBody()).toEqual({
      error: "ERR_MIGRATION_FAILED",
      message: "boom",
      details: { migration: "0001.sql" },
    });
  });
});
