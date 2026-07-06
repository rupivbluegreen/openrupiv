/**
 * Live-Postgres regression test for finding "concurrent-append-stale-tail"
 * (Phase 2 security review): two-plus truly concurrent appends must never
 * collide, and the resulting chain must verify.
 *
 * WHY THIS NEEDS A REAL POSTGRES: the bug is a specific Postgres locking
 * behavior that an in-memory fake cannot reproduce faithfully. Under READ
 * COMMITTED, `SELECT ... ORDER BY seq DESC LIMIT 1 FOR UPDATE` locks ONE
 * SPECIFIC ROW (the current tail). A second, concurrent append blocks
 * waiting for THAT row's lock. The first append does not modify that row —
 * it INSERTs a brand-new one — so once the first commits and releases the
 * lock, the second transaction's blocked statement simply resumes with the
 * SAME (now-stale) row, because nothing about that row's version changed
 * (EvalPlanQual re-checks only apply to rows that were themselves updated
 * out from under the waiter). Both transactions then compute the same next
 * seq/prevHash, and the second's INSERT collides on the seq PRIMARY KEY /
 * hash UNIQUE constraint. See src/store.ts's module doc comment and
 * `appendInTransaction`'s `pg_advisory_xact_lock` fix.
 *
 * Any in-memory fake (FakeDb, the FakePg in store.test.ts) has to choose SOME
 * concurrency model up front, and the natural one to write is "a lock is a
 * lock" — which is exactly the assumption this bug violates. That's why
 * store.test.ts's "serializes concurrent appends" test passed even before
 * the fix: it isn't exercising the real Postgres behavior at all.
 *
 * GATING: this test is opt-in. It only runs when
 * OPENRUPIV_TEST_DATABASE_URL is set AND reachable; otherwise the whole
 * describe block is skipped (consistent with scripts/e2e-quickstart.sh,
 * which likewise requires an explicitly-running stack rather than assuming
 * one). CI without a live Postgres available is unaffected. To run it
 * locally:
 *
 *   docker run --rm -d --name openrupiv-audit-live-pg \
 *     -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
 *     -p 15432:5432 postgres:16-alpine
 *   OPENRUPIV_TEST_DATABASE_URL=postgres://test:test@localhost:15432/test \
 *     pnpm --filter @openrupiv/audit test
 *
 * Deliberately NOT falling back to DATABASE_URL: this test DROPs and
 * recreates a table literally named `audit_log`, and a stray DATABASE_URL
 * left in the environment (e.g. from a compose stack) must never be
 * silently repurposed as a scratch database.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_LOG_DDL } from "../src/migration";
import { createAuditStore, type AuditStore } from "../src/store";
import { verifyChain } from "../src/chain";

const CONNECTION_STRING = process.env["OPENRUPIV_TEST_DATABASE_URL"];

async function tryConnect(connectionString: string): Promise<pg.Pool | undefined> {
  const pool = new pg.Pool({ connectionString, max: 20, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => {});
    return undefined;
  }
}

const pool = CONNECTION_STRING ? await tryConnect(CONNECTION_STRING) : undefined;
if (!CONNECTION_STRING) {
  // eslint-disable-next-line no-console
  console.warn(
    "store.live.test.ts: OPENRUPIV_TEST_DATABASE_URL not set — skipping live-Postgres concurrency test",
  );
} else if (!pool) {
  // eslint-disable-next-line no-console
  console.warn(
    `store.live.test.ts: could not connect to ${CONNECTION_STRING} — skipping live-Postgres concurrency test`,
  );
}

describe.skipIf(!pool)("createAuditStore against a live Postgres", () => {
  let store: AuditStore;

  beforeAll(async () => {
    await pool!.query("DROP TABLE IF EXISTS audit_log");
    await pool!.query(AUDIT_LOG_DDL);
    store = createAuditStore(pool!);
  });

  afterAll(async () => {
    await pool?.query("DROP TABLE IF EXISTS audit_log").catch(() => {});
    await pool?.end();
  });

  it("serializes truly concurrent appends: no collisions, sequential seqs, valid chain", async () => {
    const concurrency = 16;
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        store.append({
          event: "e2e.concurrent_append",
          actor: `u${i}`,
          actorType: "system",
          attributes: { i },
        }),
      ),
    );

    // Every append succeeded (a rejection here would have thrown out of
    // Promise.all before we got here) with distinct, contiguous seqs.
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: concurrency }, (_, i) => i + 1));

    const read = await store.read({ limit: concurrency + 1 });
    expect(read).toHaveLength(concurrency);
    expect(verifyChain(read)).toEqual({ ok: true, count: concurrency });
    expect(await store.verify()).toEqual({ ok: true, count: concurrency });
  });

  it("a fresh burst after prior appends still serializes onto the true tail", async () => {
    const before = await store.read({ limit: 1000 });
    const concurrency = 8;
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        store.append({ event: "e2e.second_burst", actor: `v${i}`, actorType: "system" }),
      ),
    );
    const after = await store.read({ limit: 1000 });
    expect(after).toHaveLength(before.length + concurrency);
    expect(verifyChain(after)).toEqual({ ok: true, count: after.length });
  });
});
