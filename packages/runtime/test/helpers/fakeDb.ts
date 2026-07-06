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

/** Column list used by the @openrupiv/audit store SQL (exact order). */
const AUDIT_COLUMNS =
  "seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash";

/** Column list used by @openrupiv/agents' runtime.ts SQL against agent_proposals (exact order). */
const PROPOSAL_COLUMNS =
  "id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at";

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
  private failSkip = 0;

  constructor(private readonly options: FakeDbOptions = {}) {
    this.tables.set("workflow_approvals", new Map());
    this.tables.set("_migrations", new Map());
    this.tables.set("audit_log", new Map());
    this.tables.set("agent_proposals", new Map());
    this.tables.set("a2a_tasks", new Map());
  }

  /** audit_log rows in seq order (chain order), for assertions. */
  auditRows(): Row[] {
    return this.rows("audit_log").sort(
      (a, b) => Number(a["seq"]) - Number(b["seq"]),
    );
  }

  /**
   * Make a statement matching `pattern` throw (atomicity tests). By default
   * throws on the very next match; pass `occurrence` > 1 to let earlier
   * matches succeed and fail only the Nth one (e.g. several identical
   * `INSERT INTO audit_log` statements happen per request now that PDP
   * decisions are audited up front — a test targeting the LAST one needs to
   * let the earlier ones through).
   */
  failNextMatching(pattern: RegExp, occurrence = 1): void {
    this.failPattern = pattern;
    this.failSkip = Math.max(occurrence, 1) - 1;
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
      if (this.failSkip > 0) {
        this.failSkip--;
      } else {
        this.failPattern = undefined;
        throw new Error(`FakeDb: injected failure for ${sql}`);
      }
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

    // Hash-chained audit log (@openrupiv/audit store SQL, exact shapes).
    // The advisory xact lock (finding "concurrent-append-stale-tail") is a
    // no-op here: FakeDb is single-threaded, so there is never a second
    // waiter to serialize against. Real concurrency is exercised against a
    // live Postgres in @openrupiv/audit's store.live.test.ts.
    if (sql === "SELECT pg_advisory_xact_lock($1)") {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (
      sql ===
      `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE`
    ) {
      const rows = this.auditRows();
      const tail = rows[rows.length - 1];
      return { rows: tail ? [{ ...tail }] : [], rowCount: tail ? 1 : 0 };
    }
    if (
      sql ===
      `INSERT INTO audit_log (${AUDIT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`
    ) {
      const [seq, timestamp, event, actor, actorType, subject, decision, attributes, prevHash, hash] =
        params;
      const key = String(seq);
      if (this.table("audit_log").has(key)) {
        throw new Error(`FakeDb: duplicate audit_log seq ${key}`);
      }
      this.table("audit_log").set(key, {
        seq,
        timestamp,
        event,
        actor,
        actor_type: actorType,
        subject: subject ?? null,
        decision: decision ?? null,
        // pg parses jsonb on read; the store binds a JSON string.
        attributes: JSON.parse(String(attributes)),
        prev_hash: prevHash,
        hash,
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      sql ===
      `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE seq >= $1 ORDER BY seq ASC LIMIT $2`
    ) {
      const fromSeq = Number(params[0]);
      const limit = Number(params[1]);
      const rows = this.auditRows()
        .filter((r) => Number(r["seq"]) >= fromSeq)
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }

    // agent_proposals insert (@openrupiv/agents' runtime.ts propose(), run
    // inside the SAME db.transaction() as the audit_log insert above — the
    // HITL atomicity guarantee).
    if (
      sql ===
      `INSERT INTO agent_proposals (${PROPOSAL_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`
    ) {
      const [id, agentId, entityTable, recordId, workflow, transition, rationale, createdAt] =
        params;
      this.table("agent_proposals").set(String(id), {
        id,
        agent_id: agentId,
        entity_table: entityTable,
        record_id: recordId,
        workflow,
        transition,
        rationale,
        created_at: createdAt,
      });
      return { rows: [], rowCount: 1 };
    }

    // agent_proposals select (@openrupiv/agents' runtime.ts listProposals()),
    // optional `WHERE workflow = $n [AND record_id = $m]` in either
    // combination.
    m = new RegExp(
      `^SELECT ${PROPOSAL_COLUMNS} FROM agent_proposals(.*) ORDER BY created_at ASC, id ASC$`,
    ).exec(sql);
    if (m) {
      const whereClause = (m[1] ?? "").trim();
      let matched = this.rows("agent_proposals");
      if (whereClause.length > 0) {
        if (!whereClause.startsWith("WHERE ")) {
          throw new Error(`FakeDb: unhandled proposal filter clause: ${whereClause}`);
        }
        const conditions = whereClause.slice("WHERE ".length).split(" AND ");
        for (const condition of conditions) {
          const cm = /^(workflow|record_id) = \$(\d+)$/.exec(condition.trim());
          if (!cm) throw new Error(`FakeDb: unhandled proposal filter condition: ${condition}`);
          const column = cm[1] as string;
          const index = Number(cm[2]) - 1;
          const value = params[index];
          matched = matched.filter((r) => r[column] === value);
        }
      }
      matched = [...matched].sort((a, b) => {
        const at = new Date(String(a["created_at"])).getTime();
        const bt = new Date(String(b["created_at"])).getTime();
        if (at !== bt) return at - bt;
        return String(a["id"]).localeCompare(String(b["id"]));
      });
      return { rows: matched.map((r) => ({ ...r })), rowCount: matched.length };
    }

    // a2a_tasks insert (@openrupiv/runtime's a2a.ts SendMessage handler,
    // exact column order). `result` is bound as a JSON string (a jsonb
    // param); parsed immediately on write to mirror how a real Postgres
    // jsonb column comes back already-parsed on SELECT.
    if (
      sql === "INSERT INTO a2a_tasks (id, client_id, skill, status, result) VALUES ($1,$2,$3,$4,$5)"
    ) {
      const [id, clientId, skill, status, result] = params;
      this.table("a2a_tasks").set(String(id), {
        id,
        client_id: clientId,
        skill,
        status,
        result: typeof result === "string" ? JSON.parse(result) : result,
      });
      return { rows: [], rowCount: 1 };
    }

    // a2a_tasks lookup scoped to the requesting client (a2a.ts's GetTask handler).
    if (sql === "SELECT * FROM a2a_tasks WHERE id = $1 AND client_id = $2") {
      const id = String(params[0]);
      const clientId = String(params[1]);
      const row = this.table("a2a_tasks").get(id);
      const match = row && row["client_id"] === clientId ? row : undefined;
      return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0 };
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
