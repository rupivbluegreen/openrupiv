/**
 * In-memory fake of this package's own `Db`/`Queryable` seam (src/types.ts)
 * for unit tests -- no live Postgres, matching the pattern in
 * packages/runtime/test/helpers/fakeDb.ts.
 *
 * It understands exactly the SQL statement shapes `runtime.ts` issues
 * (`agent_proposals` insert/select) plus the exact SQL shapes
 * `appendInTransaction` (@openrupiv/audit) issues against `audit_log` --
 * these are a real dependency, not something this fake gets to invent, so
 * they are reproduced byte-for-byte from packages/audit/src/store.ts.
 * Anything else throws loudly, so drift between the two fails tests instead
 * of passing vacuously (in particular: `propose()` ever attempting to touch
 * `workflow_approvals` or any other table would surface here as an
 * "unhandled SQL" throw, not a silent no-op).
 */

import type { Db, Queryable, QueryResultLike } from "../../src/types";

type Row = Record<string, unknown>;

/** Column list used by the @openrupiv/audit store SQL (exact order). */
const AUDIT_COLUMNS =
  "seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash";

const PROPOSAL_COLUMNS =
  "id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at";

export class FakeDb implements Db {
  private tables = new Map<string, Map<string, Row>>();
  /** Every statement executed, in order (assert ordering/transactionality). */
  readonly statements: { text: string; params: unknown[] }[] = [];
  private failPattern: RegExp | undefined;
  private failSkip = 0;

  constructor() {
    this.tables.set("agent_proposals", new Map());
    this.tables.set("audit_log", new Map());
  }

  /** audit_log rows in seq order (chain order), for assertions. */
  auditRows(): Row[] {
    return this.rows("audit_log").sort((a, b) => Number(a["seq"]) - Number(b["seq"]));
  }

  /** agent_proposals rows, for assertions. */
  proposalRows(): Row[] {
    return this.rows("agent_proposals");
  }

  /**
   * Make a statement matching `pattern` throw (atomicity tests). By default
   * throws on the very next match; pass `occurrence` > 1 to let earlier
   * matches succeed and fail only the Nth one.
   */
  failNextMatching(pattern: RegExp, occurrence = 1): void {
    this.failPattern = pattern;
    this.failSkip = Math.max(occurrence, 1) - 1;
  }

  private table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  private rows(name: string): Row[] {
    return [...this.table(name).values()];
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

    // Hash-chained audit log (@openrupiv/audit store SQL, exact shapes).
    // The advisory xact lock is a no-op here: FakeDb is single-threaded, so
    // there is never a second waiter to serialize against (real concurrency
    // is @openrupiv/audit's own store.live.test.ts concern, not this
    // package's).
    if (sql === "SELECT pg_advisory_xact_lock($1)") {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (sql === `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE`) {
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
        attributes: JSON.parse(String(attributes)),
        prev_hash: prevHash,
        hash,
      });
      return { rows: [], rowCount: 1 };
    }

    // agent_proposals insert (runtime.ts's propose()).
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

    // agent_proposals select (runtime.ts's listProposals()), optional
    // `WHERE workflow = $n [AND record_id = $m]` in either combination.
    const selectMatch = new RegExp(
      `^SELECT ${PROPOSAL_COLUMNS} FROM agent_proposals(.*) ORDER BY created_at ASC, id ASC$`,
    ).exec(sql);
    if (selectMatch) {
      const whereClause = (selectMatch[1] ?? "").trim();
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
}
