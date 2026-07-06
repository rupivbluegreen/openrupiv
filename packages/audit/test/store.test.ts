import { describe, expect, it, vi } from "vitest";
import { appendInTransaction, createAuditStore, verifyChain } from "../src/index";
import type { AuditRecord } from "../src/index";
import type { Pool, PoolClient } from "../src/index";

/**
 * In-memory fake of the narrow Pool/PoolClient seam with real chain-tail
 * locking semantics: a client holding the tail lock blocks another client's
 * FOR UPDATE until it commits, so we can prove concurrent appends serialize
 * instead of forking the chain.
 */
class FakePg implements Pool {
  rows: Record<string, unknown>[] = [];
  private locked = false;
  private waiters: Array<() => void> = [];

  private toRow(r: AuditRecord): Record<string, unknown> {
    return {
      seq: r.seq,
      timestamp: r.timestamp,
      event: r.event,
      actor: r.actor,
      actor_type: r.actorType,
      subject: r.subject ?? null,
      decision: r.decision ?? null,
      attributes: r.attributes,
      prev_hash: r.prevHash,
      hash: r.hash,
    };
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    return this.run(text, params, false);
  }

  private async acquireTail(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
  }
  private releaseTail(): void {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async run(text: string, params: unknown[], inTxn: boolean): Promise<{ rows: unknown[] }> {
    void inTxn;
    if (text.includes("ORDER BY seq DESC")) {
      await this.acquireTail();
      const last = this.rows[this.rows.length - 1];
      return { rows: last ? [last] : [] };
    }
    if (text.startsWith("INSERT")) {
      const [seq, timestamp, event, actor, actorType, subject, decision, attributes, prevHash, hash] =
        params as [number, string, string, string, string, string | null, string | null, string, string, string];
      if (this.rows.some((r) => r["hash"] === hash)) throw new Error("duplicate hash (unique violation)");
      this.rows.push({
        seq,
        timestamp,
        event,
        actor,
        actor_type: actorType,
        subject,
        decision,
        attributes: JSON.parse(attributes),
        prev_hash: prevHash,
        hash,
      });
      return { rows: [] };
    }
    if (text.includes("WHERE seq >=")) {
      const [from, limit] = params as [number, number];
      const rows = this.rows.filter((r) => Number(r["seq"]) >= from).slice(0, limit);
      return { rows };
    }
    return { rows: [] };
  }

  async connect(): Promise<PoolClient> {
    const self = this;
    let holdsTail = false;
    return {
      async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          if ((text === "COMMIT" || text === "ROLLBACK") && holdsTail) {
            holdsTail = false;
            self.releaseTail();
          }
          return { rows: [] };
        }
        if (text.includes("ORDER BY seq DESC")) holdsTail = true;
        return self.run(text, params, true);
      },
      release() {
        if (holdsTail) {
          holdsTail = false;
          self.releaseTail();
        }
      },
    };
  }

  records(): AuditRecord[] {
    return this.rows.map((r) => {
      const base = {
        seq: Number(r["seq"]),
        timestamp: String(r["timestamp"]),
        event: String(r["event"]),
        actor: String(r["actor"]),
        actorType: String(r["actor_type"]) as AuditRecord["actorType"],
        attributes: r["attributes"] as Record<string, unknown>,
        prevHash: String(r["prev_hash"]),
        hash: String(r["hash"]),
      };
      return {
        ...base,
        ...(r["subject"] != null ? { subject: String(r["subject"]) } : {}),
        ...(r["decision"] != null ? { decision: r["decision"] as "allow" | "deny" } : {}),
      };
    });
  }
}

let t = 0;
const clock = () => `2026-07-06T01:00:${String(t++).padStart(2, "0")}.000Z`;

describe("createAuditStore", () => {
  it("appends a verifiable chain and reads it back in order", async () => {
    t = 0;
    const pg = new FakePg();
    const store = createAuditStore(pg, { clock });
    await store.append({ event: "auth.login", actor: "u1", actorType: "human" });
    await store.append({ event: "workflow.transition", actor: "u1", actorType: "human", subject: "x" });
    await store.append({ event: "auth.logout", actor: "u1", actorType: "human" });

    const read = await store.read();
    expect(read.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(await store.verify()).toEqual({ ok: true, count: 3 });
    expect(verifyChain(pg.records())).toEqual({ ok: true, count: 3 });
  });

  it("serializes concurrent appends via the tail lock (no forked chain)", async () => {
    t = 0;
    const pg = new FakePg();
    const store = createAuditStore(pg, { clock });
    // Fire many appends concurrently; the fake's FOR UPDATE lock forces order.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append({ event: "e", actor: `u${i}`, actorType: "system" }),
      ),
    );
    const records = pg.records();
    expect(records).toHaveLength(20);
    expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyChain(records)).toEqual({ ok: true, count: 20 });
  });

  it("rolls back and surfaces the error if the insert fails", async () => {
    t = 0;
    const pg = new FakePg();
    const store = createAuditStore(pg, { clock });
    await store.append({ event: "e", actor: "u1", actorType: "system" });
    vi.spyOn(pg, "connect").mockImplementationOnce(async () => {
      const real = await FakePg.prototype.connect.call(pg);
      return {
        query: async (text: string, params?: unknown[]) => {
          if (text.startsWith("INSERT")) throw new Error("disk full");
          return real.query(text, params);
        },
        release: real.release,
      };
    });
    await expect(store.append({ event: "e2", actor: "u2", actorType: "system" })).rejects.toThrow("disk full");
    // Chain is unharmed: still just the first record.
    expect(pg.records()).toHaveLength(1);
    expect(await store.verify()).toEqual({ ok: true, count: 1 });
  });

  it("scrubs secret-looking attributes and reports via onScrub", async () => {
    t = 0;
    const pg = new FakePg();
    const onScrub = vi.fn();
    const store = createAuditStore(pg, { clock, onScrub });
    const rec = await store.append({
      event: "agent.tool_call",
      actor: "agent-1",
      actorType: "agent",
      attributes: { tool: "http", authorization: "Bearer secret" },
    });
    expect(rec.attributes?.["authorization"]).toBe("[redacted]");
    expect(onScrub).toHaveBeenCalledWith("agent.tool_call", ["authorization"]);
  });
});

describe("appendInTransaction (same-transaction append)", () => {
  it("appends within a caller-owned transaction, chaining onto existing records", async () => {
    t = 0;
    const pg = new FakePg();
    const store = createAuditStore(pg, { clock });
    await store.append({ event: "seed", actor: "sys", actorType: "system" });

    // Simulate the runtime's db.transaction(tx => ...) using a pool client.
    const client = await pg.connect();
    await client.query("BEGIN");
    const rec = await appendInTransaction(
      client,
      { event: "workflow.transitioned", actor: "u1", actorType: "human", subject: "x" },
      { clock },
    );
    await client.query("COMMIT");
    client.release();

    expect(rec.seq).toBe(2);
    expect(rec.prevHash).toBe(pg.records()[0]!.hash);
    expect(verifyChain(pg.records())).toEqual({ ok: true, count: 2 });
  });
});
