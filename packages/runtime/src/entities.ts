/**
 * Entity CRUD API per the HTTP conventions in specs/phase-1-contracts.md §2:
 * `GET /api/<entity>` (list), `POST` (create), `GET /:id`, `PUT /:id`
 * (no DELETE in v0). Workflow state fields are server-set on create and
 * read-only afterwards; transitions are the only writer.
 *
 * Form-encoded POSTs (from server-rendered form pages) are coerced and, on
 * success, answered with a 303 redirect to the entity's detail/list page so
 * the browser flow stays usable; JSON requests get JSON responses.
 */

import type { AuditStore } from "@openrupiv/audit";
import type { AppSpec } from "@openrupiv/spec";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { appendOrFail } from "./audit";
import type { Db } from "./db";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";
import { columnFor, isUuid, quoteIdent } from "./naming";
import {
  buildEntityModel,
  pageFor,
  rowToRecord,
  validateBody,
  type BodySource,
  type EntityModel,
} from "./records";

function bodySource(request: FastifyRequest): BodySource {
  const contentType = request.headers["content-type"] ?? "";
  return contentType.includes("application/x-www-form-urlencoded")
    ? "form"
    : "json";
}

/**
 * Validate a create/update body; if the caller attempted to write a workflow
 * state field (ERR_STATE_FIELD_READONLY), append the contract §2 rejection
 * event `workflow.state_write_rejected` to the audit log — fail-closed —
 * before rethrowing. The append uses its own connection/transaction, so the
 * rejection evidence persists even though the request fails.
 */
async function validateBodyAudited(
  model: EntityModel,
  request: FastifyRequest,
  mode: "create" | "update",
  source: BodySource,
  audit: AuditStore,
  logger: Logger,
  recordId?: string,
): Promise<Map<string, unknown>> {
  try {
    return validateBody(model, request.body ?? {}, mode, source);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === "ERR_STATE_FIELD_READONLY") {
      const field = (error.details as { field?: unknown } | undefined)?.field;
      await appendOrFail(audit, logger, {
        event: "workflow.state_write_rejected",
        actor: request.session?.sub ?? "system",
        actorType: request.session ? "human" : "system",
        ...(recordId !== undefined ? { subject: `${model.table}:${recordId}` } : {}),
        decision: "deny",
        attributes: {
          entityTable: model.table,
          mode,
          ...(typeof field === "string" ? { field } : {}),
        },
      });
    }
    throw error;
  }
}

async function insertRecord(
  db: Db,
  model: EntityModel,
  data: Map<string, unknown>,
): Promise<Record<string, unknown>> {
  const columns: string[] = [];
  const values: unknown[] = [];

  // Server-set workflow state fields: initial value, always.
  for (const [fieldName, initial] of model.stateFields) {
    const field = model.fieldByName.get(fieldName);
    if (!field) continue; // validateSpec guarantees presence
    columns.push(columnFor(field));
    values.push(initial);
  }

  for (const [fieldName, value] of data) {
    const field = model.fieldByName.get(fieldName);
    if (!field) continue; // validateBody guarantees known fields
    columns.push(columnFor(field));
    values.push(value);
  }

  const table = quoteIdent(model.table);
  const result =
    columns.length === 0
      ? await db.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`)
      : await db.query(
          `INSERT INTO ${table} (${columns.map(quoteIdent).join(", ")}) ` +
            `VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
          values,
        );
  const row = result.rows[0];
  if (!row) {
    throw new RuntimeError("ERR_INTERNAL", `insert into ${model.table} returned no row`);
  }
  return row;
}

export function registerEntityRoutes(
  app: FastifyInstance,
  spec: AppSpec,
  db: Db,
  logger: Logger,
  audit: AuditStore,
): void {
  for (const entity of spec.entities) {
    const model = buildEntityModel(spec, entity);
    const base = `/api/${model.apiSegment}`;
    const table = quoteIdent(model.table);
    const detailPage = pageFor(spec, entity.name, "detail");
    const listPage = pageFor(spec, entity.name, "list");

    app.get(base, async (_request, reply) => {
      const result = await db.query(
        `SELECT * FROM ${table} ORDER BY created_at DESC, id`,
      );
      await reply.send(result.rows.map((row) => rowToRecord(model, row)));
    });

    app.post(base, async (request, reply) => {
      const source = bodySource(request);
      const data = await validateBodyAudited(model, request, "create", source, audit, logger);
      const row = await insertRecord(db, model, data);
      const record = rowToRecord(model, row);
      logger.info(
        {
          event: "entity.created",
          entityTable: model.table,
          recordId: record["id"],
          sub: request.session?.sub,
        },
        "record created",
      );
      if (source === "form") {
        const target = detailPage
          ? `/p/${detailPage.name}?id=${String(record["id"])}`
          : listPage
            ? `/p/${listPage.name}`
            : "/";
        await reply.redirect(target, 303);
        return;
      }
      await reply.code(201).send(record);
    });

    app.get<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => {
      const id = requireUuid(request.params.id);
      const result = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      const row = result.rows[0];
      if (!row) throw notFound(entity.name, id);
      await reply.send(rowToRecord(model, row));
    });

    app.put<{ Params: { id: string } }>(`${base}/:id`, async (request, reply) => {
      const id = requireUuid(request.params.id);
      const source = bodySource(request);
      const data = await validateBodyAudited(model, request, "update", source, audit, logger, id);
      if (data.size === 0) {
        throw new RuntimeError("ERR_VALIDATION", "no updatable fields in request body", {
          statusCode: 400,
        });
      }

      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [fieldName, value] of data) {
        const field = model.fieldByName.get(fieldName);
        if (!field) continue;
        values.push(value);
        assignments.push(`${quoteIdent(columnFor(field))} = $${values.length}`);
      }
      values.push(id);
      const result = await db.query(
        `UPDATE ${table} SET ${assignments.join(", ")}, updated_at = now() ` +
          `WHERE id = $${values.length} RETURNING *`,
        values,
      );
      const row = result.rows[0];
      if (!row) throw notFound(entity.name, id);
      logger.info(
        {
          event: "entity.updated",
          entityTable: model.table,
          recordId: id,
          sub: request.session?.sub,
        },
        "record updated",
      );
      await reply.send(rowToRecord(model, row));
    });
  }
}

function requireUuid(id: string): string {
  if (!isUuid(id)) {
    throw new RuntimeError("ERR_VALIDATION", "record id must be a UUID", {
      statusCode: 400,
    });
  }
  return id;
}

function notFound(entityName: string, id: string): RuntimeError {
  return new RuntimeError("ERR_NOT_FOUND", `${entityName} ${id} not found`, {
    statusCode: 404,
  });
}
