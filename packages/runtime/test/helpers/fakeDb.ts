/**
 * In-memory fake of the narrow Db interface (src/db.ts) for unit tests —
 * no live Postgres, per specs/phase-1-contracts.md §2.
 *
 * It understands exactly the SQL statement shapes the runtime issues and
 * throws loudly on anything else, so drift between runtime SQL and the fake
 * fails tests instead of passing vacuously. Transactions snapshot the whole
 * store and restore it on throw, so rollback semantics (the n-eyes atomicity
 * guarantee) are honestly exercised.
 */

import { randomUUID } from "node:crypto";
import type { Db, Queryable, QueryResultLike } from "../../src/db";

type Row = Record<string, unknown>;

export interface FakeDbOptions {
  /** Column defaults per table, applied on INSERT when absent. */
  defaults?: Record<string, Record<string, unknown>>;
}

export class FakeDb implements Db {
  private tables = new Map<string, Map<string, Row>>();
  private seq = 0;
  /** Every statement executed, in order (assert ordering/transactionality). */
  readonly statements: { text: string; params: unknown[] }[] = [];
  private failPattern: RegExp | undefined;

  constructor(private readonly options: FakeDbOptions = {}) {
    this.tables.set("workflow_approvals", new Map());
    this.tables.set("_migrations", new Map());
  }

  /** Make the next statement matching `pattern` throw (atomicity tests). */
  failNextMatching(pattern: RegExp): void {
    this.failPattern = pattern;
  }

  table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  rows(name: string): Row[] {
    return [...this.table(name).values()];
  }

  /** Seed a row directly (bypasses SQL); returns the stored row. */
  seedRow(tableName: string, row: Row): Row {
    const id = typeof row["id"] === "string" ? row["id"] : randomUUID();
    const now = new Date().toISOString();
    const stored: Row = {
      created_at: now,
      updated_at: now,
      ...row,
      id,
      _seq: this.seq++,
    };
    this.table(tableName).set(id, stored);
    return stored;
  }

  async query(text: string, params: unknown[] = []): Promise<QueryResultLike> {
    const sql = text.trim().replace(/\s+/g, " ");
    this.statements.push({ text: sql, params });

    if (this.failPattern?.test(sql)) {
      this.failPattern = undefined;
      throw new Error(`FakeDb: injected failure for ${sql}`);
    }

    // DDL — recorded, not interpreted.
    if (/^CREATE (EXTENSION|TABLE|INDEX)/i.test(sql)) {
      return { rows: [], rowCount: null };
    }

    let m: RegExpExecArray | null;

    // Migrations bookkeeping.
    if (sql === "SELECT name FROM _migrations WHERE name = $1") {
      const name = String(params[0]);
      const hit = this.table("_migrations").get(name);
      return { rows: hit ? [{ name }] : [], rowCount: hit ? 1 : 0 };
    }
    if (sql === "INSERT INTO _migrations (name) VALUES ($1)") {
      const name = String(params[0]);
      this.table("_migrations").set(name, {
        name,
        applied_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    // n-eyes approval insert with conflict-skip on the UNIQUE constraint.
    if (
      /^INSERT INTO workflow_approvals \(entity_table, record_id, transition, approver_sub\) VALUES \(\$1, \$2, \$3, \$4\) ON CONFLICT \(entity_table, record_id, transition, approver_sub\) DO NOTHING RETURNING id$/.test(
        sql,
      )
    ) {
      const [entityTable, recordId, transition, approverSub] = params.map(String);
      const duplicate = this.rows("workflow_approvals").some(
        (r) =>
          r["entity_table"] === entityTable &&
          r["record_id"] === recordId &&
          r["transition"] === transition &&
          r["approver_sub"] === approverSub,
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const id = randomUUID();
      this.table("workflow_approvals").set(id, {
        id,
        entity_table: entityTable,
        record_id: recordId,
        transition,
        approver_sub: approverSub,
        created_at: new Date().toISOString(),
        _seq: this.seq++,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Clear a record's pending approvals on any state change (round reset).
    if (
      sql ===
      "DELETE FROM workflow_approvals WHERE entity_table = $1 AND record_id = $2"
    ) {
      const [entityTable, recordId] = params.map(String);
      const table = this.table("workflow_approvals");
      let removed = 0;
      for (const [key, r] of [...table.entries()]) {
        if (r["entity_table"] === entityTable && r["record_id"] === recordId) {
          table.delete(key);
          removed++;
        }
      }
      return { rows: [], rowCount: removed };
    }

    // Distinct approver count for one transition.
    if (
      sql ===
      "SELECT COUNT(DISTINCT approver_sub)::int AS approvals FROM workflow_approvals WHERE entity_table = $1 AND record_id = $2 AND transition = $3"
    ) {
      const [entityTable, recordId, transition] = params.map(String);
      const subs = new Set(
        this.rows("workflow_approvals")
          .filter(
            (r) =>
              r["entity_table"] === entityTable &&
              r["record_id"] === recordId &&
              r["transition"] === transition,
          )
          .map((r) => String(r["approver_sub"])),
      );
      return { rows: [{ approvals: subs.size }], rowCount: 1 };
    }

    // Grouped approval counts for a record (detail page).
    if (
      sql ===
      "SELECT transition, COUNT(DISTINCT approver_sub)::int AS approvals FROM workflow_approvals WHERE entity_table = $1 AND record_id = $2 GROUP BY transition ORDER BY transition"
    ) {
      const [entityTable, recordId] = params.map(String);
      const byTransition = new Map<string, Set<string>>();
      for (const r of this.rows("workflow_approvals")) {
        if (r["entity_table"] !== entityTable || r["record_id"] !== recordId) continue;
        const key = String(r["transition"]);
        const set = byTransition.get(key) ?? new Set<string>();
        set.add(String(r["approver_sub"]));
        byTransition.set(key, set);
      }
      const rows = [...byTransition.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([transition, subs]) => ({ transition, approvals: subs.size }));
      return { rows, rowCount: rows.length };
    }

    // Point lookup (with or without FOR UPDATE).
    m = /^SELECT \* FROM "([a-z0-9_]+)" WHERE id = \$1( FOR UPDATE)?$/.exec(sql);
    if (m) {
      const row = this.table(m[1] as string).get(String(params[0]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    // List.
    m = /^SELECT \* FROM "([a-z0-9_]+)" ORDER BY created_at DESC, id$/.exec(sql);
    if (m) {
      const rows = this.rows(m[1] as string)
        .sort((a, b) => {
          const at = new Date(String(a["created_at"])).getTime();
          const bt = new Date(String(b["created_at"])).getTime();
          if (at !== bt) return bt - at;
          return Number(b["_seq"] ?? 0) - Number(a["_seq"] ?? 0);
        })
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }

    // Insert with explicit columns.
    m = /^INSERT INTO "([a-z0-9_]+)" \(([^)]+)\) VALUES \(([^)]+)\) RETURNING \*$/.exec(sql);
    if (m) {
      const tableName = m[1] as string;
      const columns = (m[2] as string).split(", ").map((c) => c.replace(/"/g, ""));
      const id = randomUUID();
      const now = new Date().toISOString();
      const row: Row = {
        ...(this.options.defaults?.[tableName] ?? {}),
        id,
        created_at: now,
        updated_at: now,
        _seq: this.seq++,
      };
      columns.forEach((column, i) => {
        row[column] = params[i];
      });
      this.table(tableName).set(id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Insert with defaults only.
    m = /^INSERT INTO "([a-z0-9_]+)" DEFAULT VALUES RETURNING \*$/.exec(sql);
    if (m) {
      const tableName = m[1] as string;
      const id = randomUUID();
      const now = new Date().toISOString();
      const row: Row = {
        ...(this.options.defaults?.[tableName] ?? {}),
        id,
        created_at: now,
        updated_at: now,
        _seq: this.seq++,
      };
      this.table(tableName).set(id, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // Update by id.
    m = /^UPDATE "([a-z0-9_]+)" SET (.+) WHERE id = \$(\d+)( RETURNING \*)?$/.exec(sql);
    if (m) {
      const tableName = m[1] as string;
      const idIndex = Number(m[3]) - 1;
      const id = String(params[idIndex]);
      const row = this.table(tableName).get(id);
      if (!row) return { rows: [], rowCount: 0 };
      for (const assignment of (m[2] as string).split(", ")) {
        if (assignment === "updated_at = now()") {
          row["updated_at"] = new Date().toISOString();
          continue;
        }
        const am = /^"([a-z0-9_]+)" = \$(\d+)$/.exec(assignment);
        if (!am) throw new Error(`FakeDb: unhandled assignment: ${assignment}`);
        row[am[1] as string] = params[Number(am[2]) - 1];
      }
      const returning = m[4] !== undefined;
      return { rows: returning ? [{ ...row }] : [], rowCount: 1 };
    }

    throw new Error(`FakeDb: unhandled SQL: ${sql}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.tables);
    try {
      return await fn(this);
    } catch (error) {
      this.tables = snapshot; // ROLLBACK
      throw error;
    }
  }

  async end(): Promise<void> {
    // nothing to release
  }
}
