/**
 * Workflow transition enforcement, including n-eyes approvals.
 *
 * SECURITY-CRITICAL — human maintainer review required (CLAUDE.md).
 *
 * Enforcement ORDER inside a single transaction with the record row locked
 * (SELECT ... FOR UPDATE), per specs/phase-1-contracts.md §2:
 *   1. state matches the transition's `from`      → else 409 ERR_BAD_STATE
 *   2. guard roles                                → else 403 ERR_FORBIDDEN_ROLE
 *   3. guard field predicates                     → else 409 ERR_GUARD_FAILED
 *   4. approval rule (n-eyes):
 *        - approver roles (approval.roles, defaulting to guard roles)
 *        - one approval per (entity_table, record_id, transition,
 *          approver_sub); a second approval by the SAME sub → 409
 *          ERR_DUPLICATE_APPROVER + structured warn log. The database UNIQUE
 *          constraint on workflow_approvals backs this under concurrency.
 *        - when COUNT(DISTINCT approver_sub) reaches approval.count the
 *          state flips IN THE SAME TRANSACTION as the final approval.
 *
 * Any thrown error rolls the whole transaction back — an approval is never
 * recorded unless every check before it passed, and a state change is never
 * visible without its final approval.
 */

import type {
  FieldDef,
  FieldPredicate,
  TransitionDef,
  WorkflowDef,
} from "@openrupiv/spec";
import type { AppSpec } from "@openrupiv/spec";
import type { FastifyInstance } from "fastify";
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
}

function hasAnyRole(userRoles: string[], required: string[]): boolean {
  return required.some((role) => userRoles.includes(role));
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
 * atomic.
 */
export async function executeTransition(
  input: ExecuteTransitionInput,
): Promise<TransitionOutcome> {
  const { db, logger, model, workflow, transition, recordId, user } = input;
  const table = model.table;
  const stateColumn = toSnakeCase(workflow.stateField);

  return db.transaction(async (tx) => {
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

    // 1. State must match the transition's `from`.
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

    // 2. Guard roles.
    const guardRoles = transition.guard?.roles;
    if (guardRoles && guardRoles.length > 0 && !hasAnyRole(user.roles, guardRoles)) {
      throw new RuntimeError(
        "ERR_FORBIDDEN_ROLE",
        `transition ${JSON.stringify(transition.name)} requires one of roles ` +
          `${JSON.stringify(guardRoles)}`,
        { statusCode: 403, details: { requiredRoles: guardRoles } },
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

    // No approval rule: flip state now, same transaction.
    if (!transition.approval) {
      await setState(tx, table, stateColumn, transition.to, recordId);
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

    // 4. n-eyes approval rule.
    const approvalRoles = transition.approval.roles ?? transition.guard?.roles;
    if (
      approvalRoles &&
      approvalRoles.length > 0 &&
      !hasAnyRole(user.roles, approvalRoles)
    ) {
      throw new RuntimeError(
        "ERR_FORBIDDEN_ROLE",
        `approving ${JSON.stringify(transition.name)} requires one of roles ` +
          `${JSON.stringify(approvalRoles)}`,
        { statusCode: 403, details: { requiredRoles: approvalRoles } },
      );
    }

    const inserted = await tx.query(
      "INSERT INTO workflow_approvals (entity_table, record_id, transition, approver_sub) " +
        "VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (entity_table, record_id, transition, approver_sub) DO NOTHING " +
        "RETURNING id",
      [table, recordId, transition.name, user.sub],
    );
    if (inserted.rows.length === 0) {
      // Same sub approving twice — rejected and logged (audit substrate).
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
      // Final approval: state flips in the SAME transaction.
      await setState(tx, table, stateColumn, transition.to, recordId);
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
