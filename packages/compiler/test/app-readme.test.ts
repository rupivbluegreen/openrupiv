import { describe, expect, it } from "vitest";
import type { AppSpec } from "@openrupiv/spec";
import { fixtures } from "@openrupiv/spec";
import { compileApp, kebabCase, snakeCase } from "../src/index";

function readmeFor(spec: AppSpec): string {
  const result = compileApp(spec);
  expect(result.ok, !result.ok ? JSON.stringify(result.errors, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("unreachable");
  const file = result.files.find((f) => f.path === "app/README.md");
  if (!file) throw new Error("missing app/README.md");
  return file.contents;
}

describe("generated app README — vendorOnboardingSpec", () => {
  const readme = readmeFor(fixtures.vendorOnboardingSpec);

  it("titles the app and carries its description", () => {
    expect(readme.startsWith("# Vendor Onboarding\n")).toBe(true);
    expect(readme).toContain("4-eyes review");
  });

  it("documents every entity with its SQL table and field rows", () => {
    expect(readme).toContain("### Vendor");
    expect(readme).toContain("### VendorApplication");
    expect(readme).toContain("SQL table: `vendor`");
    expect(readme).toContain("SQL table: `vendor_application`");
    expect(readme).toContain("| Field | Type | Column | SQL type | Constraints | Default |");
    expect(readme).toContain("| `contactEmail` | string | `contact_email` | `text` | required | — |");
    expect(readme).toContain(
      "| `riskTier` | enum(low, medium, high) | `risk_tier` | `text` | — | `\"medium\"` |",
    );
    expect(readme).toContain("| `vendor` | reference → Vendor | `vendor_id` | `uuid` | required | — |");
  });

  it("documents the workflow with guard roles and approval counts", () => {
    expect(readme).toContain("### `vendor-approval` — VendorApplication.status");
    expect(readme).toContain(
      "| Transition | From | To | Guard roles | Guard predicates | Approvals required |",
    );
    expect(readme).toContain(
      "| `submit` | `draft` | `submitted` | `requester` | — | — |",
    );
    expect(readme).toContain(
      "| `approve` | `in_review` | `approved` | `reviewer`, `compliance` | — | 2 distinct approvers (`reviewer`, `compliance`) |",
    );
    expect(readme).toContain("ERR_DUPLICATE_APPROVER");
  });

  it("includes a text state diagram", () => {
    expect(readme).toContain("[*] --> draft");
    expect(readme).toContain("in_review --approve--> approved");
  });

  it("lists the HTTP routes per the runtime conventions", () => {
    expect(readme).toContain("| GET | `/healthz` | Liveness probe (no auth) |");
    expect(readme).toContain("| GET | `/auth/login` |");
    expect(readme).toContain("| POST | `/auth/logout` |");
    expect(readme).toContain("| GET | `/api/vendor-application` | List VendorApplication records |");
    expect(readme).toContain("| PUT | `/api/vendor-application/:id` | Update a VendorApplication |");
    expect(readme).toContain(
      "| POST | `/api/vendor-application/:id/transitions/approve` | Fire `approve` (in_review → approved) |",
    );
    expect(readme).toContain("| GET | `/p/application-detail` |");
    expect(readme).not.toContain("| DELETE |");
  });

  it("documents pages with routes and field selections", () => {
    expect(readme).toContain(
      "| `applications` | `/p/applications` | list | VendorApplication | Applications | `vendor`, `status`, `annualSpend` |",
    );
    expect(readme).toContain("all fields");
  });
});

describe("generated app README — other specs", () => {
  it("documents guard predicates for projectTrackerSpec", () => {
    const readme = readmeFor(fixtures.projectTrackerSpec);
    expect(readme).toContain("budget > 0");
    expect(readme).toContain("dueDate is set");
    expect(readme).toContain("| `tags` | manyToMany | Tag | `project_tags` |");
  });

  it("states explicitly when there are no workflows or pages (minimalSpec)", () => {
    const readme = readmeFor(fixtures.minimalSpec);
    expect(readme).toContain("This app declares no workflows.");
    expect(readme).toContain("This app declares no pages.");
    expect(readme).toContain("| Roles | none declared |");
  });
});

describe("naming projections", () => {
  it("snake_cases PascalCase and camelCase including acronyms", () => {
    expect(snakeCase("VendorApplication")).toBe("vendor_application");
    expect(snakeCase("contactEmail")).toBe("contact_email");
    expect(snakeCase("HTTPServer")).toBe("http_server");
    expect(snakeCase("Note")).toBe("note");
  });

  it("kebab-cases entity names for API paths", () => {
    expect(kebabCase("VendorApplication")).toBe("vendor-application");
    expect(kebabCase("Note")).toBe("note");
  });
});
