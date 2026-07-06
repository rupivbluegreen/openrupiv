# @openrupiv/audit

Hash-chained, tamper-evident, **append-only** audit log — the substrate every
governed action in openRupiv records into. This package's entire reason to
exist is that "we have an audit log" is a claim you can *verify*, not one you
have to trust.

## Guarantees

- **Append-only by construction.** There is no update or delete anywhere in
  the API, the types, or the SQL. The store cannot mutate history.
- **Tamper-evident.** Each record's `hash` is `sha256` over its canonical
  body (including `seq`, `timestamp`, `prevHash`). `verifyChain` recomputes
  every hash and checks genesis linkage, contiguous sequence, and prev→hash
  linkage, so it detects **mutation, deletion, reordering, insertion, and a
  forged genesis** — and reports the exact `seq` and reason of the first
  failure. A re-hashed mutation still breaks the *next* record's link.
- **No forked chain under concurrency.** Every append first takes a fixed
  `pg_advisory_xact_lock`, then reads and locks the chain tail with
  `SELECT … ORDER BY seq DESC LIMIT 1 FOR UPDATE` inside a transaction. The
  advisory lock is load-bearing, not decorative: under READ COMMITTED, a
  waiter blocked on the tail row alone resumes with the SAME (now-stale) row
  it was already holding once the blocker commits — nothing rescans for the
  row the committer just inserted — so two genuinely concurrent appends can
  compute the same next `seq`/`prevHash` and collide on insert. The advisory
  lock forces the waiter to re-read the tail fresh, after the holder's
  transaction has ended. See `src/store.ts`'s module doc comment for the
  full mechanism, and `test/store.live.test.ts` for a live-Postgres
  regression reproducing the collision without the fix.
- **Defense-in-depth redaction.** `append` scrubs secret-looking attribute
  keys (`password`, `secret`, `token`, `authorization`, `apiKey`, …) anywhere
  in the tree before hashing, so a caller's mistake never enters the log.

## Surface

Pure core (no IO — exhaustively unit-tested, including every tamper mode):
`appendRecord`, `verifyChain`, `hashRecord`, `canonicalize`, `scrubAttributes`,
`GENESIS_HASH`.

Store: `createAuditStore(pool)` → `{ append, read, verify }` (append-only).
`AUDIT_LOG_DDL` is applied by the runtime's infra-table step.

SIEM export: `toJsonl`, `toOtlpLogRecords` (OTLP logs JSON), `toSyslog`
(RFC 5424).

## Usage

```ts
import { createAuditStore } from "@openrupiv/audit";

const audit = createAuditStore(pool);
await audit.append({ event: "workflow.transition", actor: sub, actorType: "human", subject });
const status = await audit.verify(); // { ok: true, count } | { ok: false, failedSeq, reason }
```

## Tests

```bash
pnpm --filter @openrupiv/audit test
```

The suite above never needs a live Postgres (an in-memory fake `Pool`
exercises the tail-lock semantics). `test/store.live.test.ts` is a real
concurrency regression against a genuine Postgres and is opt-in only, so CI
without one available is unaffected:

```bash
docker run --rm -d --name openrupiv-audit-live-pg \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test \
  -p 15432:5432 postgres:16-alpine
OPENRUPIV_TEST_DATABASE_URL=postgres://test:test@localhost:15432/test \
  pnpm --filter @openrupiv/audit test
```

It deliberately does NOT fall back to `DATABASE_URL` — it `DROP`s and
recreates a table named `audit_log`, and a stray `DATABASE_URL` left in the
environment must never be silently repurposed as a scratch database.
