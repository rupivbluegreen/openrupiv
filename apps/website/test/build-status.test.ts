import { describe, expect, it } from "vitest";
import { parseReadiness } from "../scripts/build-status";

const FIXTURE = `# Enterprise Readiness — honest status

This page is the project's claim ledger. **We never market ahead of this
table.** Statuses: ✅ shipped (enforced, logged, evidenced) · 🚧 in progress ·
📋 planned (target milestone) · ❌ not planned for v1.

## Identity & access

| Requirement | Status |
|---|---|
| OIDC SSO | ✅ runtime v0 — Authorization Code + PKCE |
| SAML SSO | 📋 M5 |
| RBAC | 🚧 runtime enforcement implemented + tested |

## Security

| Requirement | Status |
|---|---|
| TLS everywhere | 📋 M3 |
| Air-gap installer | ❌ not planned for v1 |
`;

describe("parseReadiness", () => {
  it("parses each section's requirement rows with the correct status level and detail", () => {
    const items = parseReadiness(FIXTURE);
    expect(items).toContainEqual({
      section: "Identity & access",
      requirement: "OIDC SSO",
      level: "shipped",
      detail: "runtime v0 — Authorization Code + PKCE",
    });
    expect(items).toContainEqual({
      section: "Identity & access",
      requirement: "SAML SSO",
      level: "planned",
      detail: "M5",
    });
    expect(items).toContainEqual({
      section: "Security",
      requirement: "Air-gap installer",
      level: "not_planned",
      detail: "not planned for v1",
    });
  });

  it("skips the table header and separator rows", () => {
    const items = parseReadiness(FIXTURE);
    expect(items.some((i) => i.requirement === "Requirement")).toBe(false);
    expect(items.some((i) => i.requirement.startsWith("---"))).toBe(false);
  });

  it("assigns every item to the section heading it appeared under", () => {
    const items = parseReadiness(FIXTURE);
    const security = items.filter((i) => i.section === "Security");
    expect(security).toHaveLength(2);
    const identity = items.filter((i) => i.section === "Identity & access");
    expect(identity).toHaveLength(3);
  });

  it("throws loudly if the markdown has no recognizable status rows at all", () => {
    expect(() => parseReadiness("# Just a heading\n\nSome prose, no tables.")).toThrow(/zero status rows/);
  });
});
