import { describe, expect, it } from "vitest";
import type { AppSpec } from "@openrupiv/spec";
import { fixtures, validateSpec } from "@openrupiv/spec";
import { compileApp } from "../src/index";

function migrationFor(spec: AppSpec): string {
  const result = compileApp(spec);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("unreachable");
  const file = result.files.find((f) => f.path === "app/migrations/0001_init.sql");
  if (!file) throw new Error("missing migration");
  return file.contents;
}

/** Assert an exact DDL line (two-space indent inside CREATE TABLE). */
function expectLine(sql: string, line: string): void {
  expect(sql.split("\n"), `expected exact line: ${line}`).toContain(line);
}

describe("migration — vendorOnboardingSpec DDL", () => {
  const sql = migrationFor(fixtures.vendorOnboardingSpec);

  it("starts with the pgcrypto extension", () => {
    expect(sql.startsWith("CREATE EXTENSION IF NOT EXISTS pgcrypto;\n")).toBe(true);
  });

  it("creates snake_case tables for both entities", () => {
    expect(sql).toContain("CREATE TABLE vendor (");
    expect(sql).toContain("CREATE TABLE vendor_application (");
  });

  it("gives every table the system columns", () => {
    const idLines = sql.split("\n").filter(
      (line) => line === "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),",
    );
    expect(idLines).toHaveLength(2);
    const createdLines = sql
      .split("\n")
      .filter((line) => line === "  created_at timestamptz NOT NULL DEFAULT now(),");
    expect(createdLines).toHaveLength(2);
    const updatedLines = sql
      .split("\n")
      .filter((line) => line === "  updated_at timestamptz NOT NULL DEFAULT now()");
    expect(updatedLines).toHaveLength(2);
  });

  it("maps required+unique string fields", () => {
    expectLine(sql, "  name text NOT NULL UNIQUE,");
  });

  it("maps required string fields to NOT NULL text", () => {
    expectLine(sql, "  contact_email text NOT NULL,");
  });

  it("leaves optional fields nullable", () => {
    expectLine(sql, "  country text,");
  });

  it("maps enum fields to text with a CHECK constraint and DEFAULT", () => {
    expectLine(
      sql,
      "  risk_tier text DEFAULT 'medium' CHECK (risk_tier IN ('low', 'medium', 'high')),",
    );
    expectLine(
      sql,
      "  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected')),",
    );
  });

  it("maps reference fields to _id uuid columns with FK references", () => {
    expectLine(sql, "  vendor_id uuid NOT NULL REFERENCES vendor(id),");
  });

  it("maps text and number field types", () => {
    expectLine(sql, "  justification text NOT NULL,");
    expectLine(sql, "  annual_spend double precision,");
  });

  it("creates the referenced table before the referencing table", () => {
    expect(sql.indexOf("CREATE TABLE vendor (")).toBeLessThan(
      sql.indexOf("CREATE TABLE vendor_application ("),
    );
  });
});

describe("migration — projectTrackerSpec (manyToMany, date, number)", () => {
  const sql = migrationFor(fixtures.projectTrackerSpec);

  it("maps date and number fields", () => {
    expectLine(sql, "  due_date date,");
    expectLine(sql, "  budget double precision,");
  });

  it("emits a join table with composite PK and both FKs", () => {
    expect(sql).toContain(
      [
        "CREATE TABLE project_tags (",
        "  project_id uuid NOT NULL REFERENCES project(id),",
        "  tag_id uuid NOT NULL REFERENCES tag(id),",
        "  PRIMARY KEY (project_id, tag_id)",
        ");",
      ].join("\n"),
    );
  });

  it("emits the join table after both referenced tables", () => {
    const join = sql.indexOf("CREATE TABLE project_tags (");
    expect(sql.indexOf("CREATE TABLE project (")).toBeLessThan(join);
    expect(sql.indexOf("CREATE TABLE tag (")).toBeLessThan(join);
  });
});

describe("migration — remaining field types and defaults", () => {
  const spec: AppSpec = {
    specVersion: "0.1",
    app: { name: "Types", slug: "types-demo", version: "0.1.0" },
    entities: [
      {
        name: "Sample",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "isArchived", type: "boolean", required: true, default: false },
          { name: "score", type: "number", default: 12.5 },
          { name: "startsAt", type: "datetime" },
          { name: "notes", type: "text", default: "it's fine" },
        ],
      },
    ],
  };

  it("is a valid spec (test corpus stays honest)", () => {
    const result = validateSpec(JSON.parse(JSON.stringify(spec)));
    expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
  });

  const sql = migrationFor(spec);

  it("maps boolean with a boolean DEFAULT", () => {
    expectLine(sql, "  is_archived boolean NOT NULL DEFAULT false,");
  });

  it("maps number with a numeric DEFAULT", () => {
    expectLine(sql, "  score double precision DEFAULT 12.5,");
  });

  it("maps datetime to timestamptz", () => {
    expectLine(sql, "  starts_at timestamptz,");
  });

  it("escapes single quotes in string DEFAULT literals", () => {
    expectLine(sql, "  notes text DEFAULT 'it''s fine',");
  });
});

describe("migration — reference ordering", () => {
  it("topologically sorts so referenced tables come first", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Order", slug: "order-demo", version: "0.1.0" },
      entities: [
        {
          name: "Task",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "board", type: "reference", entity: "Board", required: true },
          ],
        },
        {
          name: "Board",
          fields: [{ name: "name", type: "string", required: true }],
        },
      ],
    };
    const sql = migrationFor(spec);
    expect(sql.indexOf("CREATE TABLE board (")).toBeLessThan(sql.indexOf("CREATE TABLE task ("));
    expectLine(sql, "  board_id uuid NOT NULL REFERENCES board(id),");
  });

  it("keeps self-references inline", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Org", slug: "org-demo", version: "0.1.0" },
      entities: [
        {
          name: "Employee",
          fields: [
            { name: "fullName", type: "string", required: true },
            { name: "manager", type: "reference", entity: "Employee" },
          ],
        },
      ],
    };
    const sql = migrationFor(spec);
    expectLine(sql, "  manager_id uuid REFERENCES employee(id),");
    expect(sql).not.toContain("ALTER TABLE");
  });

  it("breaks reference cycles with deferred ALTER TABLE constraints", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Cycle", slug: "cycle-demo", version: "0.1.0" },
      entities: [
        {
          name: "Alpha",
          fields: [{ name: "beta", type: "reference", entity: "Beta", required: true }],
        },
        {
          name: "Beta",
          fields: [{ name: "alpha", type: "reference", entity: "Alpha" }],
        },
      ],
    };
    const sql = migrationFor(spec);
    // Alpha's FK is deferred: column without inline REFERENCES…
    expectLine(sql, "  beta_id uuid NOT NULL,");
    // …Beta's stays inline (alpha exists by then)…
    expectLine(sql, "  alpha_id uuid REFERENCES alpha(id),");
    // …and the deferred FK lands as an ALTER TABLE after both tables.
    expect(sql).toContain(
      "ALTER TABLE alpha\n  ADD CONSTRAINT alpha_beta_id_fkey FOREIGN KEY (beta_id) REFERENCES beta(id);",
    );
    const alter = sql.indexOf("ALTER TABLE alpha");
    expect(sql.indexOf("CREATE TABLE alpha (")).toBeLessThan(alter);
    expect(sql.indexOf("CREATE TABLE beta (")).toBeLessThan(alter);
  });
});

describe("migration — typed hard errors instead of broken DDL", () => {
  it("rejects self-referential manyToMany relations", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Self", slug: "self-demo", version: "0.1.0" },
      entities: [
        {
          name: "Node",
          fields: [{ name: "label", type: "string", required: true }],
          relations: [{ name: "links", kind: "manyToMany", to: "Node" }],
        },
      ],
    };
    const result = compileApp(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: "ERR_UNSUPPORTED_SECTION",
      path: "/entities/0/relations/0",
    });
  });

  it("rejects fields that collide with system columns", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Clash", slug: "clash-demo", version: "0.1.0" },
      entities: [
        {
          name: "Thing",
          fields: [{ name: "createdAt", type: "datetime" }],
        },
      ],
    };
    const result = compileApp(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: "ERR_DUPLICATE_NAME",
      path: "/entities/0/fields/0/name",
    });
  });

  it("rejects distinct field names that collide after snake_casing", () => {
    const spec: AppSpec = {
      specVersion: "0.1",
      app: { name: "Clash2", slug: "clash-two", version: "0.1.0" },
      entities: [
        {
          name: "Thing",
          fields: [
            { name: "vendor", type: "reference", entity: "Thing" },
            { name: "vendorId", type: "string" },
          ],
        },
      ],
    };
    const result = compileApp(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("ERR_DUPLICATE_NAME");
  });
});
