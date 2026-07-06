/**
 * Admin audit routes, per specs/phase-2-contracts.md §2:
 *
 *   GET /admin/audit                  — a page of the chain + verify() status
 *   GET /admin/audit/export?format=…  — SIEM export (jsonl | otlp | syslog)
 *
 * AUTHORIZATION — human maintainer review required (CLAUDE.md).
 * Both routes sit behind the global session gate (auth.ts) AND a policy
 * decision with action `audit.read`. Roles come from the OIDC roles claim,
 * same as workflow guards; the audit log is platform infrastructure, so the
 * allowed roles are the platform-level admin-like roles below, NOT app-spec
 * roles (an app spec must not be able to grant itself audit access).
 * Every decision — allow AND deny — is itself appended to the audit log,
 * fail-closed: if the decision cannot be recorded, the request 5xxs.
 *
 * BOUNDED MEMORY (finding "audit-read-unbounded-memory"): `GET /admin/audit`
 * previously ran `audit.verify()` — a full-chain read + hash recompute of
 * EVERY record — on every single request, and `/admin/audit/export` built
 * the entire export payload as one in-memory string/array before responding.
 * Combined with the audit log's potential for unbounded growth, both routes
 * were the first to OOM or time out, precisely during an incident when
 * someone actually needs them. Full verification is now opt-in
 * (`?verify=full`); the default response omits it. Export streams
 * record-by-record (paginated reads, chunked response) instead of buffering
 * the whole chain.
 *
 * NAMESPACE COLLISION (finding "audit-role-namespace-collision"): roles here
 * and app-spec-declared roles (`spec.app.roles`) are literal strings checked
 * against the SAME flat OIDC roles claim — there is no reserved prefix or
 * separate claim distinguishing "platform admin" from "this app's admin
 * role". If an org's IdP issues the literal string "admin" to a user for an
 * app's own purposes (the app spec declares `roles: ["admin", ...]` for its
 * own domain), that string match must NOT also satisfy this file's platform
 * check — otherwise the header comment above ("an app spec must not be able
 * to grant itself audit access") is simply false. Proper namespacing (a
 * `platform:` claim prefix or a separate claim entirely) needs an OIDC/Dex
 * claim-shape change that is out of scope right now, so `authorizeAuditRead`
 * instead computes the EFFECTIVE role set for this decision by excluding
 * any role also present in `appRoles` from the subject's roles before
 * calling the PDP — never by shrinking `AUDIT_READ_ROLES` itself (an empty
 * `allowedRoles` list means "open to any authenticated subject" in the
 * shared Rego policy, so emptying it would be catastrophic, not safe). This
 * also closes the ADR-0005 dev-mode amplifier: a dev-mode user is granted
 * every app-declared role with no roles claim, so an app declaring "admin"
 * would otherwise auto-grant platform audit access to every dev-mode user.
 */

import { Readable } from "node:stream";
import {
  otlpEnvelope,
  otlpLogRecord,
  toSyslog,
  type AuditRecord,
  type AuditStore,
  type VerifyResult,
} from "@openrupiv/audit";
import type { PolicyEngine } from "@openrupiv/policy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { appendOrFail } from "./audit";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";

/**
 * Platform-level roles allowed to read the audit log (`audit.read`). Granted
 * through the IdP roles claim (OIDC_ROLES_CLAIM), exactly like workflow
 * roles. Deliberately NOT sourced from the app spec.
 */
export const AUDIT_READ_ROLES: readonly string[] = ["admin", "auditor"];

const EXPORT_FORMATS = ["jsonl", "otlp", "syslog"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Records per page while paginating the chain for export (bounded memory). */
const EXPORT_PAGE_SIZE = 1000;

/** Page through the WHOLE chain, one bounded-size batch at a time. */
async function* pagedRecords(
  audit: AuditStore,
  pageSize: number = EXPORT_PAGE_SIZE,
): AsyncGenerator<AuditRecord[]> {
  let fromSeq = 1;
  for (;;) {
    const page = await audit.read({ fromSeq, limit: pageSize });
    if (page.length === 0) return;
    yield page;
    if (page.length < pageSize) return;
    fromSeq = page[page.length - 1]!.seq + 1;
  }
}

/**
 * Stream one export `format` record-by-record: only one page of records (and
 * only the current record's rendered line) is ever in memory at once,
 * regardless of how large the chain is (finding
 * "audit-read-unbounded-memory"). Output is byte-identical to what the
 * non-streaming `toJsonl`/`toOtlpLogRecords`/`toSyslog` would have produced
 * over the same records, just paginated and chunked.
 */
function exportStream(audit: AuditStore, format: ExportFormat): Readable {
  async function* lines(): AsyncGenerator<string> {
    if (format === "otlp") {
      const { open, close } = otlpEnvelope();
      yield open;
      let first = true;
      for await (const page of pagedRecords(audit)) {
        for (const record of page) {
          yield (first ? "" : ",") + JSON.stringify(otlpLogRecord(record));
          first = false;
        }
      }
      yield close;
      return;
    }

    // jsonl / syslog: one line per record, newline-joined.
    let first = true;
    for await (const page of pagedRecords(audit)) {
      const rendered = format === "syslog" ? toSyslog(page) : page.map((r) => JSON.stringify(r));
      for (const line of rendered) {
        yield (first ? "" : "\n") + line;
        first = false;
      }
    }
  }
  return Readable.from(lines(), { objectMode: false });
}

export interface AdminAuditDeps {
  audit: AuditStore;
  policy: PolicyEngine;
  logger: Logger;
  /**
   * Roles the ACTIVE APP SPEC declares (`spec.app.roles`) for its own domain
   * purposes. Excluded from the subject's effective role set for the
   * `audit.read` decision below — see the module doc comment (finding
   * "audit-role-namespace-collision").
   */
  appRoles: readonly string[];
}

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new RuntimeError("ERR_VALIDATION", `${name} must be a positive integer`, {
      statusCode: 400,
    });
  }
  return value;
}

export function registerAdminAuditRoutes(
  app: FastifyInstance,
  deps: AdminAuditDeps,
): void {
  const { audit, policy, logger, appRoles } = deps;
  const appRoleSet = new Set(appRoles);

  /**
   * PDP gate for audit reads. The decision (allow AND deny) is audited
   * fail-closed BEFORE it is enforced, so a denial that cannot be recorded
   * never silently succeeds or silently disappears.
   */
  async function authorizeAuditRead(request: FastifyRequest): Promise<void> {
    const session = request.session;
    if (!session) {
      // The global auth gate already enforces this; do not rely on it.
      throw new RuntimeError("ERR_UNAUTHENTICATED", "authentication required", {
        statusCode: 401,
      });
    }
    // Namespace-collision fix (finding "audit-role-namespace-collision"):
    // strip any role also declared by the app spec (including ones the
    // ADR-0005 dev-mode grant handed out) from the subject's EFFECTIVE role
    // set before asking the PDP — an app can never make its own declared
    // role satisfy the platform check this way, even on a literal string
    // match like "admin". AUDIT_READ_ROLES itself is never touched: an
    // empty `allowedRoles` means "open to any authenticated subject" in the
    // shared Rego policy, so shrinking THAT list would be unsafe.
    const platformRoles = session.roles.filter((role) => !appRoleSet.has(role));
    const decision = await policy.decide({
      subject: { id: session.sub, roles: platformRoles },
      action: "audit.read",
      resource: { type: "audit_log", allowedRoles: [...AUDIT_READ_ROLES] },
    });
    logger.info(
      {
        event: "policy.decision",
        action: "audit.read",
        allow: decision.allow,
        reason: decision.reason,
        sub: session.sub,
      },
      "policy decision for audit read",
    );
    await appendOrFail(audit, logger, {
      event: "policy.decision",
      actor: session.sub,
      actorType: "human",
      subject: "audit_log",
      decision: decision.allow ? "allow" : "deny",
      attributes: {
        action: "audit.read",
        allowedRoles: [...AUDIT_READ_ROLES],
        policyId: decision.policyId,
        reason: decision.reason,
      },
    });
    if (!decision.allow) {
      throw new RuntimeError(
        "ERR_FORBIDDEN_ROLE",
        `reading the audit log requires one of roles ${JSON.stringify(AUDIT_READ_ROLES)}`,
        { statusCode: 403, details: { requiredRoles: AUDIT_READ_ROLES, reason: decision.reason } },
      );
    }
  }

  app.get<{ Querystring: { fromSeq?: string; limit?: string; verify?: string } }>(
    "/admin/audit",
    async (request, reply) => {
      await authorizeAuditRead(request);
      const fromSeq = positiveInt(request.query.fromSeq, "fromSeq", 1);
      const limit = Math.min(positiveInt(request.query.limit, "limit", 100), 500);
      // Full-chain verification is opt-in (`?verify=full`), NOT the default
      // cost of every page load (finding "audit-read-unbounded-memory"): it
      // reads the WHOLE chain into memory and recomputes every hash, which
      // does not belong on the hot path of an admin dashboard poll. Verify
      // AFTER the decision append (already recorded above, in
      // authorizeAuditRead) so the reported count covers it.
      let verify: VerifyResult | undefined;
      if (request.query.verify === "full") {
        verify = await audit.verify();
      }
      const records = await audit.read({ fromSeq, limit });
      await reply.send({
        ...(verify !== undefined ? { verify } : {}),
        page: { fromSeq, limit, count: records.length },
        records,
      });
    },
  );

  app.get<{ Querystring: { format?: string } }>(
    "/admin/audit/export",
    async (request, reply) => {
      await authorizeAuditRead(request);
      const format = (request.query.format ?? "jsonl") as ExportFormat;
      if (!EXPORT_FORMATS.includes(format)) {
        throw new RuntimeError(
          "ERR_VALIDATION",
          `format must be one of ${JSON.stringify(EXPORT_FORMATS)}`,
          { statusCode: 400 },
        );
      }
      // Streamed record-by-record (paginated reads, chunked response) rather
      // than buffered as one in-memory string/array (finding
      // "audit-read-unbounded-memory") — bounded memory regardless of chain
      // size.
      switch (format) {
        case "jsonl":
          await reply
            .header("content-type", "application/x-ndjson; charset=utf-8")
            .send(exportStream(audit, format));
          return;
        case "otlp":
          await reply
            .header("content-type", "application/json; charset=utf-8")
            .send(exportStream(audit, format));
          return;
        case "syslog":
          await reply
            .header("content-type", "text/plain; charset=utf-8")
            .send(exportStream(audit, format));
          return;
      }
    },
  );
}
