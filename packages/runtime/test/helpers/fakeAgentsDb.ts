/**
 * Minimal in-memory Db satisfying @openrupiv/agents' structural Db seam --
 * what createAgentRuntime's propose()/listProposals() need (agent_proposals
 * table), PLUS the audit_log statements @openrupiv/agents' propose() also
 * issues on the SAME transaction via @openrupiv/audit's appendInTransaction
 * (the proposal insert and the `agent.transition_proposed` audit append
 * commit atomically together -- see packages/agents/src/runtime.ts's
 * propose()). These are a real dependency, not invented shapes: reproduced
 * from packages/audit/src/store.ts's exact SQL, mirroring the handling in
 * packages/agents/test/helpers/fakeDb.ts. Anything else throws loudly.
 */
type Row = Record<string, unknown>;

export class FakeDb {
  private proposals: Row[] = [];
  private auditLog: Row[] = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number | null }> {
    const sql = text.trim().replace(/\s+/g, " ");

    // Advisory lock is a no-op here: this fake is single-threaded, so there
    // is never a second waiter to serialize against.
    if (sql === "SELECT pg_advisory_xact_lock($1)") {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }
    if (/^SELECT .* FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE$/.test(sql)) {
      const tail = this.auditLog[this.auditLog.length - 1];
      return { rows: tail ? [{ ...tail }] : [], rowCount: tail ? 1 : 0 };
    }
    if (/^INSERT INTO audit_log/.test(sql)) {
      const [seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash] = params;
      this.auditLog.push({ seq, timestamp, event, actor, actor_type, subject, decision, attributes, prev_hash, hash });
      return { rows: [], rowCount: 1 };
    }

    if (/^INSERT INTO agent_proposals/.test(sql)) {
      const [id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at] = params;
      this.proposals.push({ id, agent_id, entity_table, record_id, workflow, transition, rationale, created_at });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT .* FROM agent_proposals/.test(sql)) {
      return { rows: [...this.proposals], rowCount: this.proposals.length };
    }

    throw new Error(`FakeDb: unhandled statement: ${sql}`);
  }

  async transaction<T>(fn: (tx: { query: FakeDb["query"] }) => Promise<T>): Promise<T> {
    return fn({ query: this.query.bind(this) });
  }
}
