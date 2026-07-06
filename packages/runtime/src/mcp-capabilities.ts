/**
 * The single MCP-exposed platform capability for v0.2
 * (specs/phase-2-contracts.md §5, open question 8, PROPOSED + needs
 * maintainer product sign-off on fit for the demo): read-only
 * workflow-instance status. Deliberately NOT audit-log read, and NOT any
 * write/transition-firing capability.
 */
import type { PolicySubject } from "@openrupiv/policy";
import type { AppSpec } from "@openrupiv/spec";
import type { ExposedCapability } from "@openrupiv/mcp";
import type { Db } from "./db";
import { buildEntityModels, rowToRecord } from "./records";
import { isUuid, quoteIdent } from "./naming";

export function workflowInstanceStatusCapability(spec: AppSpec, db: Db): ExposedCapability {
  const models = buildEntityModels(spec);
  const workflowTables = new Map(
    [...models.values()].filter((m) => m.workflows.length > 0).map((m) => [m.table, m]),
  );

  return {
    name: "workflow-instance-status",
    description: "Read-only: current workflow state of an entity record, by table + id.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        entityTable: { type: "string" },
        id: { type: "string" },
      },
      required: ["entityTable", "id"],
      additionalProperties: false,
    },
    allowedRoles: [],
    async handler(args: Record<string, unknown>, _subject: PolicySubject): Promise<unknown> {
      const entityTable = String(args["entityTable"] ?? "");
      const id = String(args["id"] ?? "");
      const model = workflowTables.get(entityTable);
      if (!model) {
        throw new Error(`unknown or non-workflow entity table ${JSON.stringify(entityTable)}`);
      }
      if (!isUuid(id)) {
        throw new Error("id must be a UUID");
      }
      const result = await db.query(`SELECT * FROM ${quoteIdent(entityTable)} WHERE id = $1`, [id]);
      const row = result.rows[0];
      if (!row) {
        throw new Error(`no record ${id} in ${entityTable}`);
      }
      const record = rowToRecord(model, row);
      const stateField = model.workflows[0]?.stateField;
      return { entityTable, id, status: stateField ? record[stateField] : null };
    },
  };
}
