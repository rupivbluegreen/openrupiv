/**
 * Workflow transition enforcement, including n-eyes approvals.
 *
 * SECURITY-CRITICAL — human maintainer review required (CLAUDE.md).
 * Maintainer signed off on the Phase 2 PDP/audit wiring in this file
 * (2026-07-06, specs/phase-2-contracts.md §3 "RBAC wiring into the runtime").
 * Restructured 2026-07-06 for finding "post-commit-flush-ordering" (Phase 2
 * security review) — see below; HUMAN REVIEW REQUIRED before merge.
 *
 * Enforcement ORDER as observed by the caller, per specs/phase-1-contracts.md
 * §2, is unchanged by the restructuring below:
 *   1. state matches the transition's `from`      → else 409 ERR_BAD_STATE
 *   2. guard roles — via PolicyEngine.decide      → else 403 ERR_FORBIDDEN_ROLE
 *   3. guard field predicates                     → else 409 ERR_GUARD_FAILED
 *   4. approval rule (n-eyes):
 *        - approver roles (approval.roles, defaulting to guard roles), also
 *          via PolicyEngine.decide
 *        - one approval per (entity_table, record_id, transition,
 *          approver_sub); a second approval by the SAME sub → 409
 *          ERR_DUPLICATE_APPROVER + structured warn log. The database UNIQUE
 *          constraint on workflow_approvals backs this under concurrency.
 *        - when COUNT(DISTINCT approver_sub) reaches approval.count the
 *          state flips IN THE SAME TRANSACTION as the final approval.
 * One deliberate, non-observable reordering: the approval-role decision (4)
 * is now resolved before guard predicates (3) are evaluated (both moved
 * ahead of the state-write transaction — see below) rather than after. No
 * shipped spec combines guard predicates with an approval rule on the same
 * transition, so this is not exercised by any test today; flagged here for
 * the human reviewer because a future spec could make it observable.
 *
 * Any thrown error rolls the whole transaction back — an approval is never
 * recorded unless every check before it passed, and a state change is never
 * visible without its final approval.
 *
 * AUDIT (specs/phase-2-contracts.md §2, restructured for finding
 * "post-commit-flush-ordering"):
 * - Guard/approval-role PDP decisions (`policy.decision`, allow AND deny) do
 *   NOT depend on the row locked below — only on static transition config
 *   and the caller's session — so they are decided and appended (fail-
 *   closed, via the `audit` store's own connection/transaction) BEFORE the
 *   state-write transaction opens, via `decide()`. This fixes a real bug: the
 *   previous design queued these decisions and flushed them only AFTER the
 *   transaction resolved, so a successful transition could COMMIT and then
 *   have its causing decision fail to append afterward — the client got a
 *   500 for an action that had actually already succeeded, and a crash in
 *   that window silently lost the allow-decision record forever. Appending
 *   up front instead means: (a) cause (`policy.decision`) always precedes
 *   effect (`workflow.transition` / `workflow.approval_recorded`) in the
 *   chain, (b) an append failure aborts BEFORE any DB write happens — no
 *   committed-but-500 window — and (c) once the state-write transaction
 *   opens, there is no more post-transaction audit work left for the allow
 *   path, so there is nothing left to lose to a crash. A second, smaller
 *   benefit: the audit append acquires its own pooled connection, so doing
 *   it before opening the write transaction avoids holding two connections
 *   per in-flight request (a nested acquire while the write transaction's
 *   connection is already checked out risks exhausting the pool under load).
 *   A pre-transaction (unlocked) read of the row still runs first, purely so
 *   a bad state still outranks a forbidden role in the response (see
 *   enforcement order above) — it is NOT the authoritative check; the row is
 *   re-read and locked FOR UPDATE inside the transaction, which is.
 * - `workflow.transition` and `workflow.approval_recorded` are still appended
 *   via `appendInTransaction(tx, …)` inside the SAME transaction as their
 *   side effect — the state change / approval and its audit record commit or
 *   roll back atomically. An append failure therefore rolls the side effect
 *   back (fail closed).
 * - Only the rejection event `workflow.duplicate_approver` is discoverable
 *   solely inside the row-locked transaction (via the database's own
 *   UNIQUE-constraint race guard) and so must survive ITS OWN rollback: it
 *   is collected during the transaction and appended after it resolves, on a
 *   separate connection, fail-closed — via `appendAllOrFail`, which attempts
 *   every queued event even if an earlier one in the same batch failed
 *   (finding "flush-drops-later-events").
 */

import {
  appendInTransaction,
  type AuditRecordInput,
  type AuditStore,
} from "@openrupiv/audit";
import type { PolicyDecision, PolicyEngine } from "@openrupiv/policy";
import type {
  FieldDef,
  FieldPredicate,
  TransitionDef,
  WorkflowDef,
} from "@openrupiv/spec";
import type { AppSpec } from "@openrupiv/spec";
import type { FastifyInstance } from "fastify";
import { appendAllOrFail, appendOrFail } from "./audit";
import type { Db, Queryable } from "./db";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";
import { columnFor, isUuid, quoteIdent, toSnakeCase } from "./naming";
import { buildEntityModel, pageFor, type EntityModel } from "./records";
import type { SessionData } from "./session";

export type TransitionOutcome =
  | { status: "transitioned"; state: string }
  | { status: "pending"; approvals: number; required: number };

export interface ExecuteTransitionInput {
  db: Db;
  logger: Logger;
  model: EntityModel;
  workflow: WorkflowDef;
  transition: TransitionDef;
  recordId: string;
  user: Pick<SessionData, "sub" | "roles">;
  /** Deny-by-default PDP (ADR-0006); decides guard and approval role checks. */
  policy: PolicyEngine;
  /** Separate-connection audit store for events that must survive rollback. */
  audit: AuditStore;
}

/** Evaluate one guard predicate against the current row. */
export function evaluatePredicate(
  predicate: FieldPredicate,
  field: FieldDef,
  row: Record<string, unknown>,
): boolean {
  const raw = row[columnFor(field)];
  const isSet = raw !== null && raw !== undefined;

  switch (predicate.op) {
    case "set":
      return isSet;
    case "notSet":
      return !isSet;
    default:
      break;
  }

  if (!isSet) return false;

  if (predicate.op === "eq" || predicate.op === "ne") {
    const equal = looseEquals(raw, predicate.value, field);
    return predicate.op === "eq" ? equal : !equal;
  }

  // gt / gte / lt / lte — validateSpec guarantees number/date/datetime.
  const left = toComparable(raw, field);
  const right = toComparable(predicate.value, field);
  if (left === undefined || right === undefined) return false;
  switch (predicate.op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
  }
}

function looseEquals(raw: unknown, expected: unknown, field: FieldDef): boolean {
  if (field.type === "number") {
    return typeof expected === "number" && Number(raw) === expected;
  }
  if (field.type === "boolean") {
    return typeof expected === "boolean" && raw === expected;
  }
  if (field.type === "date" || field.type === "datetime") {
    const left = toComparable(raw, field);
    const right = toComparable(expected, field);
    return left !== undefined && left === right;
  }
  return typeof raw === "string" && raw === expected;
}

function toComparable(value: unknown, field: FieldDef): number | undefined {
  if (field.type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  // date / datetime
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * Execute a workflow transition for `user` on `recordId`. Returns the
 * outcome or throws a typed RuntimeError; either way the transaction is
 * atomic, and every policy decision plus any rejection event is persisted to
 * the audit log on a separate connection (fail-closed).
 */
export async function executeTransition(
  input: ExecuteTransitionInput,
): Promise<TransitionOutcome> {
  const { db, logger, model, workflow, transition, recordId, user, policy, audit } =
    input;
  const table = model.table;
  const stateColumn = toSnakeCase(workflow.stateField);
  const subject = `${table}:${recordId}`;

  // Resolve one PDP decision and append it NOW, fail-closed, via the audit
  // store's own connection/transaction — see the module doc comment for why
  // this must happen before the state-write transaction opens rather than
  // being queued for a batched flush afterward.
  const decide = async (
    action: string,
    allowedRoles: readonly string[],
  ): Promise<PolicyDecision> => {
    const decision = await policy.decide({
      subject: { id: user.sub, roles: user.roles },
      action,
      resource: { type: "workflow.transition", id: subject, allowedRoles: [...allowedRoles] },
    });
    logger.info(
      {
        event: "policy.decision",
        action,
        allow: decision.allow,
        reason: decision.reason,
        policyId: decision.policyId,
        sub: user.sub,
      },
      "policy decision for workflow transition",
    );
    await appendOrFail(audit, logger, {
      event: "policy.decision",
      actor: user.sub,
      actorType: "human",
      subject,
      decision: decision.allow ? "allow" : "deny",
      attributes: {
        action,
        allowedRoles: [...allowedRoles],
        policyId: decision.policyId,
        reason: decision.reason,
        workflow: workflow.name,
        transition: transition.name,
      },
    });
    return decision;
  };

  // Events discoverable only inside the row-locked transaction, which must
  // survive ITS OWN rollback: today, just the duplicate-approver rejection
  // (found via the database's UNIQUE-constraint race guard). Collected
  // during the transaction, appended after it resolves — commit OR rollback
  // — on a separate connection, fail-closed. `appendAllOrFail` attempts
  // every queued event even if an earlier one failed (finding
  // "flush-drops-later-events"), rather than abandoning the rest untraced.
  const independentEvents: AuditRecordInput[] = [];
  const flushIndependentEvents = (): Promise<void> =>
    appendAllOrFail(audit, logger, independentEvents.splice(0, independentEvents.length));

  // Pre-transaction (unlocked) read — NOT the enforcement point; it exists
  // only so a bad state still outranks a forbidden role in the response,
  // matching the documented enforcement order, even though role decisions
  // below are now resolved and durably audited before any write transaction
  // opens. The row is re-read and locked FOR UPDATE inside the transaction
  // below, which is the race-safe, authoritative check.
  const peek = await db.query(
    `SELECT * FROM ${quoteIdent(table)} WHERE id = $1`,
    [recordId],
  );
  const peekRow = peek.rows[0];
  if (!peekRow) {
    throw new RuntimeError(
      "ERR_NOT_FOUND",
      `${model.entity.name} ${recordId} not found`,
      { statusCode: 404 },
    );
  }
  if (peekRow[stateColumn] !== transition.from) {
    throw new RuntimeError(
      "ERR_BAD_STATE",
      `transition ${JSON.stringify(transition.name)} requires state ` +
        `${JSON.stringify(transition.from)} but record is in ` +
        `${JSON.stringify(peekRow[stateColumn])}`,
      {
        statusCode: 409,
        details: { expected: transition.from, actual: peekRow[stateColumn] },
      },
    );
  }

  // 2. Guard roles — resolved through the PDP (deny-by-default; an empty
  // role list permits any authenticated subject, matching Phase 1).
  const guardRoles = transition.guard?.roles ?? [];
  const guardDecision = await decide(
    `workflow.transition:${transition.name}`,
    guardRoles,
  );
  if (!guardDecision.allow) {
    throw new RuntimeError(
      "ERR_FORBIDDEN_ROLE",
      `transition ${JSON.stringify(transition.name)} requires one of roles ` +
        `${JSON.stringify(guardRoles)}`,
      {
        statusCode: 403,
        details: { requiredRoles: guardRoles, reason: guardDecision.reason },
      },
    );
  }

  // 4a. Approval roles (only when this transition has an approval rule) —
  // resolved and audited up front for the same reason as guard roles above.
  if (transition.approval) {
    const approvalRoles = transition.approval.roles ?? transition.guard?.roles ?? [];
    const approvalDecision = await decide(
      `workflow.approve:${transition.name}`,
      approvalRoles,
    );
    if (!approvalDecision.allow) {
      throw new RuntimeError(
        "ERR_FORBIDDEN_ROLE",
        `approving ${JSON.stringify(transition.name)} requires one of roles ` +
          `${JSON.stringify(approvalRoles)}`,
        {
          statusCode: 403,
          details: { requiredRoles: approvalRoles, reason: approvalDecision.reason },
        },
      );
    }
  }

  let outcome: TransitionOutcome;
  try {
    outcome = await db.transaction(async (tx) => {
      const found = await tx.query(
        `SELECT * FROM ${quoteIdent(table)} WHERE id = $1 FOR UPDATE`,
        [recordId],
      );
      const row = found.rows[0];
      if (!row) {
        throw new RuntimeError(
          "ERR_NOT_FOUND",
          `${model.entity.name} ${recordId} not found`,
          { statusCode: 404 },
        );
      }

      // 1. State must match the transition's `from` — re-checked here,
      // race-safe under the row lock. The pre-transaction peek above is not
      // authoritative: this is the check a concurrent transition must
      // respect.
      const currentState = row[stateColumn];
      if (currentState !== transition.from) {
        throw new RuntimeError(
          "ERR_BAD_STATE",
          `transition ${JSON.stringify(transition.name)} requires state ` +
            `${JSON.stringify(transition.from)} but record is in ` +
            `${JSON.stringify(currentState)}`,
          {
            statusCode: 409,
            details: { expected: transition.from, actual: currentState },
          },
        );
      }

      // 3. Guard predicates.
      for (const predicate of transition.guard?.require ?? []) {
        const field = model.fieldByName.get(predicate.field);
        if (!field) {
          // validateSpec makes this unreachable; fail loudly if it ever isn't.
          throw new RuntimeError(
            "ERR_INTERNAL",
            `guard predicate references unknown field ${JSON.stringify(predicate.field)}`,
          );
        }
        if (!evaluatePredicate(predicate, field, row)) {
          throw new RuntimeError(
            "ERR_GUARD_FAILED",
            `guard predicate failed: ${predicate.field} ${predicate.op}` +
              (predicate.value !== undefined ? ` ${JSON.stringify(predicate.value)}` : ""),
            { statusCode: 409, details: { predicate } },
          );
        }
      }

      // No approval rule: flip state now, same transaction — with the audit
      // record appended in that SAME transaction (atomic with the side effect).
      if (!transition.approval) {
        await setState(tx, table, stateColumn, transition.to, recordId);
        await appendInTransaction(tx, {
          event: "workflow.transition",
          actor: user.sub,
          actorType: "human",
          subject,
          decision: "allow",
          attributes: {
            workflow: workflow.name,
            transition: transition.name,
            from: transition.from,
            to: transition.to,
          },
        });
        logger.info(
          {
            event: "workflow.transitioned",
            workflow: workflow.name,
            entityTable: table,
            recordId,
            transition: transition.name,
            from: transition.from,
            to: transition.to,
            sub: user.sub,
          },
          "workflow transition applied",
        );
        return { status: "transitioned", state: transition.to };
      }

      // 4b. n-eyes approval attempt (approver roles were already resolved
      // and audited above, before this transaction opened).
      const inserted = await tx.query(
        "INSERT INTO workflow_approvals (entity_table, record_id, transition, approver_sub) " +
          "VALUES ($1, $2, $3, $4) " +
          "ON CONFLICT (entity_table, record_id, transition, approver_sub) DO NOTHING " +
          "RETURNING id",
        [table, recordId, transition.name, user.sub],
      );
      if (inserted.rows.length === 0) {
        // Same sub approving twice — rejected, logged, and audited. The audit
        // event must survive this transaction's rollback, so it goes through
        // the independent (separate-connection) path.
        logger.warn(
          {
            event: "workflow.duplicate_approver",
            workflow: workflow.name,
            entityTable: table,
            recordId,
            transition: transition.name,
            approverSub: user.sub,
          },
          "duplicate approval attempt rejected",
        );
        independentEvents.push({
          event: "workflow.duplicate_approver",
          actor: user.sub,
          actorType: "human",
          subject,
          decision: "deny",
          attributes: { workflow: workflow.name, transition: transition.name },
        });
        throw new RuntimeError(
          "ERR_DUPLICATE_APPROVER",
          `user has already approved transition ${JSON.stringify(transition.name)} ` +
            "for this record; approvals must come from distinct users",
          { statusCode: 409 },
        );
      }

      const counted = await tx.query(
        "SELECT COUNT(DISTINCT approver_sub)::int AS approvals FROM workflow_approvals " +
          "WHERE entity_table = $1 AND record_id = $2 AND transition = $3",
        [table, recordId, transition.name],
      );
      const approvals = Number(counted.rows[0]?.["approvals"] ?? 0);
      const required = transition.approval.count;

      if (approvals >= required) {
        // Final approval: state flips in the SAME transaction, and the audit
        // record commits or rolls back with it.
        await setState(tx, table, stateColumn, transition.to, recordId);
        await appendInTransaction(tx, {
          event: "workflow.transition",
          actor: user.sub,
          actorType: "human",
          subject,
          decision: "allow",
          attributes: {
            workflow: workflow.name,
            transition: transition.name,
            from: transition.from,
            to: transition.to,
            approvals,
            required,
          },
        });
        logger.info(
          {
            event: "workflow.transitioned",
            workflow: workflow.name,
            entityTable: table,
            recordId,
            transition: transition.name,
            from: transition.from,
            to: transition.to,
            sub: user.sub,
            approvals,
            required,
          },
          "workflow transition applied after required approvals",
        );
        return { status: "transitioned", state: transition.to };
      }

      // Non-final approval: the approval row and its audit record are atomic.
      await appendInTransaction(tx, {
        event: "workflow.approval_recorded",
        actor: user.sub,
        actorType: "human",
        subject,
        decision: "allow",
        attributes: {
          workflow: workflow.name,
          transition: transition.name,
          approvals,
          required,
        },
      });
      logger.info(
        {
          event: "workflow.approval_recorded",
          workflow: workflow.name,
          entityTable: table,
          recordId,
          transition: transition.name,
          approverSub: user.sub,
          approvals,
          required,
        },
        "approval recorded; transition pending",
      );
      return { status: "pending", approvals, required };
    });
  } catch (error) {
    // The transaction rolled back; decisions and rejection events still
    // persist (separate connection, fail-closed).
    await flushIndependentEvents();
    throw error;
  }
  await flushIndependentEvents();
  return outcome;
}

async function setState(
  tx: Queryable,
  table: string,
  stateColumn: string,
  to: string,
  recordId: string,
): Promise<void> {
  const updated = await tx.query(
    `UPDATE ${quoteIdent(table)} SET ${quoteIdent(stateColumn)} = $1, updated_at = now() WHERE id = $2`,
    [to, recordId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new RuntimeError(
      "ERR_INTERNAL",
      `state update affected ${String(updated.rowCount)} rows for ${table} ${recordId}`,
    );
  }
  // Any state change ends the current approval round: pending approvals were
  // gathered for a transition out of the state we are LEAVING (step 1
  // guarantees approvals only exist for the current state), so they are now
  // stale. Clearing them means a record that re-enters an approval's `from`
  // state must collect a fresh set of N distinct approvers — closing the
  // revision-loop bypass where stale approvals let one fresh approver
  // complete an n-eyes transition.
  await tx.query(
    "DELETE FROM workflow_approvals WHERE entity_table = $1 AND record_id = $2",
    [table, recordId],
  );
}

/**
 * Register `POST /api/<entity>/:id/transitions/<transition-name>` for every
 * transition of every workflow in the spec.
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  spec: AppSpec,
  db: Db,
  logger: Logger,
  policy: PolicyEngine,
  audit: AuditStore,
): void {
  for (const workflow of spec.workflows ?? []) {
    const entity = spec.entities.find((e) => e.name === workflow.entity);
    if (!entity) {
      // validateSpec makes this unreachable; refuse to serve if it isn't.
      throw new RuntimeError(
        "ERR_APP_SPEC_INVALID",
        `workflow ${workflow.name} references unknown entity ${workflow.entity}`,
      );
    }
    const model = buildEntityModel(spec, entity);
    const detailPage = pageFor(spec, entity.name, "detail");

    for (const transition of workflow.transitions) {
      app.post<{ Params: { id: string } }>(
        `/api/${model.apiSegment}/:id/transitions/${transition.name}`,
        async (request, reply) => {
          const session = request.session;
          if (!session) {
            // The global auth hook already enforces this; do not rely on it.
            throw new RuntimeError("ERR_UNAUTHENTICATED", "authentication required", {
              statusCode: 401,
            });
          }
          const recordId = request.params.id;
          if (!isUuid(recordId)) {
            throw new RuntimeError("ERR_VALIDATION", "record id must be a UUID", {
              statusCode: 400,
            });
          }

          const outcome = await executeTransition({
            db,
            logger,
            model,
            workflow,
            transition,
            recordId,
            user: session,
            policy,
            audit,
          });

          const contentType = request.headers["content-type"] ?? "";
          if (
            contentType.includes("application/x-www-form-urlencoded") &&
            detailPage
          ) {
            await reply.redirect(`/p/${detailPage.name}?id=${recordId}`, 303);
            return;
          }
          await reply.send(outcome);
        },
      );
    }
  }
}
