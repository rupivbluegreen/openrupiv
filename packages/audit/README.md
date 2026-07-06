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
- **No forked chain under concurrency.** The Postgres store serializes
  appends on the chain tail with `SELECT … ORDER BY seq DESC LIMIT 1 FOR
  UPDATE` inside a transaction.
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
