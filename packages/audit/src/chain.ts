/**
 * The hash chain: pure, IO-free, deterministic. These functions are the
 * tamper-evidence guarantee of the audit log and are exhaustively tested
 * against every tampering mode (mutate, drop, reorder, insert, forge
 * genesis). Nothing here reads a clock, a database, or the environment.
 */

import { createHash } from "node:crypto";
import type { AuditRecord, AuditRecordBody, AuditRecordInput, VerifyResult } from "./types";

/** The prevHash of the first (genesis) record. */
export const GENESIS_HASH = "0".repeat(64);

/** Keys stripped from `attributes` defensively, even if a caller forgets. */
const SECRET_KEY_PATTERN = /pass|secret|token|authorization|cookie|apikey|api_key|\bkey\b/i;

/** Redacted marker left in place of a scrubbed value (keeps the shape auditable). */
export const REDACTED = "[redacted]";

/**
 * Remove secret-looking keys anywhere in an attributes tree. Returns the
 * scrubbed copy and whether anything was removed (so the store can warn).
 */
export function scrubAttributes(
  attributes: Record<string, unknown> | undefined,
): { attributes: Record<string, unknown>; scrubbed: string[] } {
  const scrubbed: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${k}` : k;
        if (SECRET_KEY_PATTERN.test(k)) {
          out[k] = REDACTED;
          scrubbed.push(childPath);
        } else {
          out[k] = walk(v, childPath);
        }
      }
      return out;
    }
    return value;
  };
  const result = walk(attributes ?? {}, "") as Record<string, unknown>;
  return { attributes: result, scrubbed };
}

/**
 * Canonical serialization used for hashing: recursively sorted object keys,
 * no incidental whitespace, so the hash depends only on content, not on key
 * insertion order or formatting. Arrays keep their order (order is content).
 */
export function canonicalize(body: AuditRecordBody): string {
  const canon = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) sorted[key] = canon(v);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(canon(body));
}

/** sha256 of the canonical body. */
export function hashRecord(body: AuditRecordBody): string {
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

/**
 * Build the next record in the chain from the previous record (or null for
 * genesis), the caller's input, and an injected timestamp. Attributes are
 * scrubbed here so a forgotten secret never enters the hashed body.
 */
export function appendRecord(
  prev: AuditRecord | null,
  input: AuditRecordInput,
  timestamp: string,
): AuditRecord {
  const { attributes } = scrubAttributes(input.attributes);
  const body: AuditRecordBody = {
    event: input.event,
    actor: input.actor,
    actorType: input.actorType,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    attributes,
    seq: prev ? prev.seq + 1 : 1,
    timestamp,
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  return { ...body, hash: hashRecord(body) };
}

/**
 * Verify a full chain in seq order: genesis linkage, contiguous 1-based seq,
 * correct prevHash linkage, and a recomputed hash for every record. Returns
 * the seq of the first failure and why — enough to locate a tamper.
 */
export function verifyChain(records: AuditRecord[]): VerifyResult {
  let prev: AuditRecord | null = null;
  for (const record of records) {
    const expectedSeq = prev ? prev.seq + 1 : 1;
    if (record.seq !== expectedSeq) {
      return { ok: false, failedSeq: record.seq, reason: "seq_gap" };
    }
    const expectedPrevHash = prev ? prev.hash : GENESIS_HASH;
    if (record.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        failedSeq: record.seq,
        reason: prev ? "chain_break" : "bad_genesis",
      };
    }
    const { hash, ...body } = record;
    if (hashRecord(body) !== hash) {
      return { ok: false, failedSeq: record.seq, reason: "hash_mismatch" };
    }
    prev = record;
  }
  return { ok: true, count: records.length };
}
