/**
 * The agent_proposals table DDL -- provisioned by the runtime's infra-table
 * step, the same way `workflow_approvals` and (per @openrupiv/audit)
 * `AUDIT_LOG_DDL` are. This package does NOT wire it into
 * packages/runtime's migration step itself -- specs/phase-2-contracts.md §4
 * ("SQL") assigns that to the runtime's infra-table step, a later stage.
 */
export const AGENT_PROPOSALS_DDL = `CREATE TABLE IF NOT EXISTS agent_proposals (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     text        NOT NULL,
  entity_table text        NOT NULL,
  record_id    uuid        NOT NULL,
  workflow     text        NOT NULL,
  transition   text        NOT NULL,
  rationale    text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_proposals_record_idx ON agent_proposals (entity_table, record_id);
CREATE INDEX IF NOT EXISTS agent_proposals_workflow_idx ON agent_proposals (workflow);`;
