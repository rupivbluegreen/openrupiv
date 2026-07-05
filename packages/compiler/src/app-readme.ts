/**
 * Generated-app README emitter (`app/README.md`) — human documentation for
 * the compiled app directory: entities and their SQL mapping, workflow
 * state machines (guards, n-eyes approvals), pages, and the HTTP routes the
 * runtime serves for this spec (specs/phase-1-contracts.md §2 HTTP
 * conventions).
 */

import type {
  AppSpec,
  EntityDef,
  FieldDef,
  FieldPredicate,
  TransitionDef,
  WorkflowDef,
} from "@openrupiv/spec";
import { columnName, joinTableName, kebabCase, tableName } from "./naming";

/** Escape `|` so free-text never breaks a Markdown table row. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function codeList(items: readonly string[]): string {
  return items.map((item) => `\`${item}\``).join(", ");
}

function formatValue(value: string | number | boolean | undefined): string {
  return JSON.stringify(value ?? null);
}

function formatPredicate(predicate: FieldPredicate): string {
  switch (predicate.op) {
    case "set":
      return `${predicate.field} is set`;
    case "notSet":
      return `${predicate.field} is not set`;
    case "eq":
      return `${predicate.field} = ${formatValue(predicate.value)}`;
    case "ne":
      return `${predicate.field} != ${formatValue(predicate.value)}`;
    case "gt":
      return `${predicate.field} > ${formatValue(predicate.value)}`;
    case "gte":
      return `${predicate.field} >= ${formatValue(predicate.value)}`;
    case "lt":
      return `${predicate.field} < ${formatValue(predicate.value)}`;
    case "lte":
      return `${predicate.field} <= ${formatValue(predicate.value)}`;
  }
}

function fieldTypeLabel(field: FieldDef): string {
  if (field.type === "enum") {
    return `enum(${(field.values ?? []).join(", ")})`;
  }
  if (field.type === "reference") {
    return `reference → ${field.entity ?? "?"}`;
  }
  return field.type;
}

function sqlTypeLabel(field: FieldDef): string {
  switch (field.type) {
    case "string":
    case "text":
    case "enum":
      return "text";
    case "number":
      return "double precision";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "reference":
      return "uuid";
  }
}

function renderEntity(entity: EntityDef): string[] {
  const lines: string[] = [];
  lines.push(`### ${entity.name}`, "");
  if (entity.description !== undefined) lines.push(entity.description, "");
  lines.push(`SQL table: \`${tableName(entity.name)}\` · API base path: \`/api/${kebabCase(entity.name)}\``, "");
  lines.push("| Field | Type | Column | SQL type | Constraints | Default |");
  lines.push("|---|---|---|---|---|---|");
  for (const field of entity.fields) {
    const constraints: string[] = [];
    if (field.required) constraints.push("required");
    if (field.unique) constraints.push("unique");
    lines.push(
      `| \`${field.name}\` | ${cell(fieldTypeLabel(field))} | \`${columnName(field)}\` | \`${sqlTypeLabel(field)}\` | ${
        constraints.join(", ") || "—"
      } | ${field.default !== undefined ? `\`${JSON.stringify(field.default)}\`` : "—"} |`,
    );
  }
  lines.push("");

  const relations = entity.relations ?? [];
  if (relations.length > 0) {
    lines.push("Relations:", "");
    lines.push("| Relation | Kind | Target | Join table |");
    lines.push("|---|---|---|---|");
    for (const relation of relations) {
      lines.push(
        `| \`${relation.name}\` | ${relation.kind} | ${relation.to} | \`${joinTableName(entity.name, relation.name)}\` |`,
      );
    }
    lines.push("");
  }
  return lines;
}

function transitionLabel(transition: TransitionDef): string {
  const notes: string[] = [];
  if (transition.guard?.roles !== undefined) {
    notes.push(`roles: ${transition.guard.roles.join(", ")}`);
  }
  if (transition.guard?.require !== undefined) {
    notes.push(transition.guard.require.map(formatPredicate).join(" and "));
  }
  if (transition.approval !== undefined) {
    notes.push(`${transition.approval.count} distinct approvers`);
  }
  return notes.length > 0 ? `   [${notes.join("] [")}]` : "";
}

function renderWorkflow(workflow: WorkflowDef): string[] {
  const lines: string[] = [];
  lines.push(`### \`${workflow.name}\` — ${workflow.entity}.${workflow.stateField}`, "");
  lines.push(
    `State machine on \`${workflow.entity}.${workflow.stateField}\`; initial state \`${workflow.initial}\`.`,
    `The \`${workflow.stateField}\` field is read-only through the create/update API:`,
    "the server sets the initial value on create, and the transitions below are",
    "the only writer.",
    "",
  );

  lines.push("```");
  lines.push(`[*] --> ${workflow.initial}`);
  for (const transition of workflow.transitions) {
    lines.push(
      `${transition.from} --${transition.name}--> ${transition.to}${transitionLabel(transition)}`,
    );
  }
  lines.push("```", "");

  lines.push(
    "| Transition | From | To | Guard roles | Guard predicates | Approvals required |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const transition of workflow.transitions) {
    const guardRoles = transition.guard?.roles;
    const predicates = transition.guard?.require;
    let approvals = "—";
    if (transition.approval !== undefined) {
      const approverRoles = transition.approval.roles ?? guardRoles;
      approvals = `${transition.approval.count} distinct approvers${
        approverRoles !== undefined ? ` (${codeList(approverRoles)})` : ""
      }`;
    }
    lines.push(
      `| \`${transition.name}\` | \`${transition.from}\` | \`${transition.to}\` | ${
        guardRoles !== undefined ? codeList(guardRoles) : "—"
      } | ${
        predicates !== undefined
          ? cell(predicates.map(formatPredicate).join(" and "))
          : "—"
      } | ${cell(approvals)} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderRoutes(spec: AppSpec): string[] {
  const lines: string[] = [];
  lines.push(
    "Served by `@openrupiv/runtime`. Every route requires an authenticated OIDC",
    "session except `/healthz`, `/auth/login`, and `/auth/callback`. There is no",
    "DELETE in v0. Workflow state fields cannot be written through create/update.",
    "",
  );
  lines.push("| Method | Path | Purpose |");
  lines.push("|---|---|---|");
  lines.push("| GET | `/healthz` | Liveness probe (no auth) |");
  lines.push("| GET | `/auth/login` | Start OIDC login (Authorization Code + PKCE) |");
  lines.push("| GET | `/auth/callback` | OIDC redirect target; establishes the session |");
  lines.push("| POST | `/auth/logout` | Destroy the session |");
  lines.push("| GET | `/` | Index of pages |");
  for (const entity of spec.entities) {
    const base = `/api/${kebabCase(entity.name)}`;
    lines.push(`| GET | \`${base}\` | List ${entity.name} records |`);
    lines.push(`| POST | \`${base}\` | Create a ${entity.name} |`);
    lines.push(`| GET | \`${base}/:id\` | Fetch one ${entity.name} |`);
    lines.push(`| PUT | \`${base}/:id\` | Update a ${entity.name} |`);
  }
  for (const workflow of spec.workflows ?? []) {
    const base = `/api/${kebabCase(workflow.entity)}`;
    for (const transition of workflow.transitions) {
      lines.push(
        `| POST | \`${base}/:id/transitions/${transition.name}\` | Fire \`${transition.name}\` (${transition.from} → ${transition.to}) |`,
      );
    }
  }
  for (const page of spec.pages ?? []) {
    lines.push(
      `| GET | \`/p/${page.name}\` | Page \`${page.name}\` (${page.type} of ${page.entity}) |`,
    );
  }
  lines.push("");

  if ((spec.workflows ?? []).length > 0) {
    lines.push(
      "Transition endpoints respond `{ \"status\": \"pending\", \"approvals\": k, \"required\": n }`",
      "while approvals are outstanding and `{ \"status\": \"transitioned\", \"state\": \"<to>\" }` on",
      "completion. Failures: 403 `ERR_FORBIDDEN_ROLE`; 409 `ERR_BAD_STATE`,",
      "`ERR_GUARD_FAILED`, or `ERR_DUPLICATE_APPROVER` (the same user may not",
      "approve twice — approvals must come from distinct authenticated users).",
      "",
    );
  }
  return lines;
}

function renderPages(spec: AppSpec): string[] {
  const pages = spec.pages ?? [];
  const lines: string[] = [];
  if (pages.length === 0) {
    lines.push("This app declares no pages.", "");
    return lines;
  }
  lines.push("| Page | Route | Type | Entity | Title | Fields |");
  lines.push("|---|---|---|---|---|---|");
  for (const page of pages) {
    lines.push(
      `| \`${page.name}\` | \`/p/${page.name}\` | ${page.type} | ${page.entity} | ${cell(
        page.title ?? page.name,
      )} | ${page.fields !== undefined ? codeList(page.fields) : "all fields"} |`,
    );
  }
  lines.push("");
  return lines;
}

export function renderAppReadme(spec: AppSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.app.name}`, "");
  if (spec.app.description !== undefined) lines.push(spec.app.description, "");
  lines.push(
    "Generated by `@openrupiv/compiler` from [`spec.json`](./spec.json). Do not",
    "edit these files by hand — edit the spec and recompile; the same spec always",
    "produces byte-identical output (ADR-0001).",
    "",
  );

  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Slug | \`${spec.app.slug}\` |`);
  lines.push(`| App version | \`${spec.app.version}\` |`);
  lines.push(`| Spec version | \`${spec.specVersion}\` |`);
  lines.push(
    `| Roles | ${spec.app.roles !== undefined ? codeList(spec.app.roles) : "none declared"} |`,
  );
  lines.push("");

  lines.push("## Contents", "");
  lines.push("| File | Purpose |");
  lines.push("|---|---|");
  lines.push("| `spec.json` | Canonical app spec — the contract |");
  lines.push("| `migrations/0001_init.sql` | Database schema (versioned, forward-only) |");
  lines.push("| `package.json`, `test/` | Standalone invariant tests — `node --test`, zero dependencies |");
  lines.push("| `server.mjs` | Optional entry: serve this directory with `@openrupiv/runtime` |");
  lines.push("");

  lines.push("## Entities", "");
  for (const entity of spec.entities) {
    lines.push(...renderEntity(entity));
  }
  lines.push(
    "Every entity table also carries `id uuid` (primary key), `created_at`, and",
    "`updated_at` — set by the database, never by clients.",
    "",
  );

  lines.push("## Workflows", "");
  const workflows = spec.workflows ?? [];
  if (workflows.length === 0) {
    lines.push("This app declares no workflows.", "");
  } else {
    for (const workflow of workflows) {
      lines.push(...renderWorkflow(workflow));
    }
  }

  lines.push("## Pages", "");
  lines.push(...renderPages(spec));

  lines.push("## HTTP routes", "");
  lines.push(...renderRoutes(spec));

  lines.push("## Running this app", "");
  lines.push(
    "- **Tests** (zero installs, Node ≥ 20): `node --test`",
    "- **Serve with the runtime library:** install `@openrupiv/runtime`, then",
    "  `node server.mjs`. Configuration comes from the environment:",
    "  `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,",
    "  `SESSION_SECRET`, `BASE_URL`. Authentication is OIDC only — there is no",
    "  local-password mode (ADR-0003).",
    "- **Or via the workspace Compose stack:** `docker compose up` from the",
    "  workspace root (bundles Postgres and a dev-only Dex IdP, ADR-0002).",
    "",
  );

  return lines.join("\n");
}
