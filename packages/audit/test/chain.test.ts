import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  REDACTED,
  appendRecord,
  canonicalize,
  hashRecord,
  scrubAttributes,
  verifyChain,
} from "../src/index";
import type { AuditRecord, AuditRecordInput } from "../src/index";

let tick = 0;
const clock = () => `2026-07-06T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function buildChain(inputs: AuditRecordInput[]): AuditRecord[] {
  tick = 0;
  const records: AuditRecord[] = [];
  let prev: AuditRecord | null = null;
  for (const input of inputs) {
    const record = appendRecord(prev, input, clock());
    records.push(record);
    prev = record;
  }
  return records;
}

const sample: AuditRecordInput[] = [
  { event: "auth.login", actor: "u1", actorType: "human" },
  {
    event: "workflow.transition",
    actor: "u1",
    actorType: "human",
    subject: "vendor_application:abc",
    attributes: { from: "draft", to: "submitted" },
  },
  {
    event: "workflow.approval_recorded",
    actor: "u2",
    actorType: "human",
    subject: "vendor_application:abc",
    decision: "allow",
  },
];

describe("appendRecord + verifyChain", () => {
  it("genesis record links to GENESIS_HASH with seq 1", () => {
    const [g] = buildChain(sample.slice(0, 1));
    expect(g!.seq).toBe(1);
    expect(g!.prevHash).toBe(GENESIS_HASH);
  });

  it("builds a chain that verifies", () => {
    const chain = buildChain(sample);
    expect(verifyChain(chain)).toEqual({ ok: true, count: 3 });
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.prevHash).toBe(chain[i - 1]!.hash);
      expect(chain[i]!.seq).toBe(chain[i - 1]!.seq + 1);
    }
  });

  it("is deterministic: same inputs + clock → identical hashes", () => {
    expect(buildChain(sample).map((r) => r.hash)).toEqual(
      buildChain(sample).map((r) => r.hash),
    );
  });

  it("hash depends on content, not attribute key order", () => {
    const a = appendRecord(null, { event: "e", actor: "a", actorType: "system", attributes: { x: 1, y: 2 } }, "2026-07-06T00:00:00.000Z");
    const b = appendRecord(null, { event: "e", actor: "a", actorType: "system", attributes: { y: 2, x: 1 } }, "2026-07-06T00:00:00.000Z");
    expect(a.hash).toBe(b.hash);
  });
});

describe("verifyChain detects every tamper mode", () => {
  it("mutated field → hash_mismatch at that seq", () => {
    const chain = buildChain(sample);
    chain[1] = { ...chain[1]!, actor: "attacker" };
    expect(verifyChain(chain)).toEqual({ ok: false, failedSeq: 2, reason: "hash_mismatch" });
  });

  it("mutated attribute → hash_mismatch", () => {
    const chain = buildChain(sample);
    chain[1] = { ...chain[1]!, attributes: { from: "draft", to: "approved" } };
    expect(verifyChain(chain)).toMatchObject({ ok: false, reason: "hash_mismatch" });
  });

  it("deleted record → seq_gap", () => {
    const chain = buildChain(sample);
    const tampered = [chain[0]!, chain[2]!]; // drop seq 2
    expect(verifyChain(tampered)).toEqual({ ok: false, failedSeq: 3, reason: "seq_gap" });
  });

  it("reordered records → seq_gap", () => {
    const chain = buildChain(sample);
    const tampered = [chain[0]!, chain[2]!, chain[1]!];
    expect(verifyChain(tampered)).toMatchObject({ ok: false, reason: "seq_gap" });
  });

  it("inserted forged record → chain_break (prevHash mismatch)", () => {
    const chain = buildChain(sample);
    const forged = appendRecord(chain[0]!, { event: "workflow.approval_recorded", actor: "attacker", actorType: "human" }, "2026-07-06T00:00:09.000Z");
    // Splice the forged record in at position 2 but keep the real seq numbering broken.
    const tampered = [chain[0]!, { ...forged, seq: 2 }, { ...chain[1]!, seq: 3 }];
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
  });

  it("re-hashed mutation still breaks the NEXT link (chain_break)", () => {
    // Attacker mutates seq 2 AND recomputes its hash to pass hash_mismatch —
    // but seq 3's prevHash still points at the original, so linkage breaks.
    const chain = buildChain(sample);
    const { hash: _oldHash, ...body } = chain[1]!;
    const mutatedBody = { ...body, actor: "attacker" };
    chain[1] = { ...mutatedBody, hash: hashRecord(mutatedBody) };
    expect(verifyChain(chain)).toEqual({ ok: false, failedSeq: 3, reason: "chain_break" });
  });

  it("forged genesis (wrong prevHash on seq 1) → bad_genesis", () => {
    const chain = buildChain(sample);
    const { hash: _h, ...body } = chain[0]!;
    const badBody = { ...body, prevHash: "f".repeat(64) };
    chain[0] = { ...badBody, hash: hashRecord(badBody) };
    expect(verifyChain(chain)).toEqual({ ok: false, failedSeq: 1, reason: "bad_genesis" });
  });

  it("empty chain verifies vacuously", () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0 });
  });
});

describe("scrubAttributes (defense in depth)", () => {
  it("redacts secret-looking keys anywhere in the tree and reports them", () => {
    const { attributes, scrubbed } = scrubAttributes({
      ok: "visible",
      password: "hunter2",
      nested: { apiKey: "sk-123", fine: 1 },
      list: [{ token: "t" }],
    });
    expect(attributes).toEqual({
      ok: "visible",
      password: REDACTED,
      nested: { apiKey: REDACTED, fine: 1 },
      list: [{ token: REDACTED }],
    });
    expect(scrubbed.sort()).toEqual(["list[0].token", "nested.apiKey", "password"]);
  });

  it("appendRecord scrubs before hashing (secret never enters the hash body)", () => {
    const rec = appendRecord(null, { event: "e", actor: "a", actorType: "system", attributes: { secret: "x" } }, "2026-07-06T00:00:00.000Z");
    expect(rec.attributes?.["secret"]).toBe(REDACTED);
    expect(canonicalize({ ...rec }).includes("\"x\"")).toBe(false);
  });
});
