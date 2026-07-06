/**
 * The audit_log table DDL. Applied by the runtime's infra-table step. Note
 * the absence of any column that would enable mutation semantics and the
 * UNIQUE on hash: a replayed or duplicated record is rejected at the DB.
 */
export const AUDIT_LOG_DDL = `CREATE TABLE IF NOT EXISTS audit_log (
  seq         bigint PRIMARY KEY,
  timestamp   timestamptz NOT NULL,
  event       text        NOT NULL,
  actor       text        NOT NULL,
  actor_type  text        NOT NULL CHECK (actor_type IN ('human','agent','system')),
  subject     text,
  decision    text        CHECK (decision IN ('allow','deny')),
  attributes  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash   char(64)    NOT NULL,
  hash        char(64)    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_log_event_idx ON audit_log (event);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor);`;
