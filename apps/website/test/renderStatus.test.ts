// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStatus } from "../src/content/renderStatus";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderStatus", () => {
  it("renders each item's detail text alongside its level label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([{ section: "Security", requirement: "SAML SSO", level: "planned", detail: "M5" }]),
      ),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    expect(container.innerHTML).toContain("SAML SSO");
    expect(container.innerHTML).toContain("Planned");
    expect(container.innerHTML).toContain("M5");
  });

  it("escapes detail text the same way requirement text is escaped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([{ section: "Security", requirement: "X", level: "shipped", detail: "<script>alert(1)</script>" }]),
      ),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    expect(container.innerHTML).not.toContain("<script>");
    expect(container.innerHTML).toContain("&lt;script&gt;");
  });

  it("omits the detail separator when detail is an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ section: "Security", requirement: "X", level: "shipped", detail: "" }])),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    expect(container.innerHTML).not.toContain(" — ");
  });

  it("shows a fallback message when the fetch response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([], false)));
    const container = document.createElement("div");
    await renderStatus(container);
    expect(container.textContent).toBe("Status unavailable.");
  });

  it("groups items by section into one <details> per section, named by that section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { section: "A", requirement: "one", level: "shipped", detail: "" },
          { section: "B", requirement: "two", level: "planned", detail: "" },
        ]),
      ),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    const categoryNames = [...container.querySelectorAll(".status-category-name")].map((el) => el.textContent);
    expect(categoryNames).toEqual(["A", "B"]);
    expect(container.querySelectorAll("details.status-category")).toHaveLength(2);
  });

  it("every category <details> is collapsed by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ section: "A", requirement: "one", level: "shipped", detail: "" }])),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    const details = container.querySelector("details.status-category") as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it("renders one count pill per non-zero level, in shipped/in_progress/planned/not_planned order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { section: "A", requirement: "one", level: "shipped", detail: "" },
          { section: "A", requirement: "two", level: "shipped", detail: "" },
          { section: "A", requirement: "three", level: "planned", detail: "" },
        ]),
      ),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    const counts = [...container.querySelectorAll(".status-count")].map((el) => el.textContent);
    expect(counts).toEqual(["2 shipped", "1 planned"]);
  });

  it("omits a count pill entirely for a level with zero items in that category", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([{ section: "A", requirement: "one", level: "shipped", detail: "" }])),
    );
    const container = document.createElement("div");
    await renderStatus(container);
    expect(container.querySelector(".status-count-in_progress")).toBeNull();
    expect(container.querySelector(".status-count-planned")).toBeNull();
    expect(container.querySelector(".status-count-not_planned")).toBeNull();
  });

  it("count pills always sum to the number of detail-list items rendered for that category", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { section: "A", requirement: "RBAC", level: "shipped", detail: "" },
          { section: "A", requirement: "OIDC SSO", level: "shipped", detail: "" },
          { section: "A", requirement: "SCIM", level: "in_progress", detail: "" },
          { section: "A", requirement: "SAML SSO", level: "planned", detail: "M5" },
          { section: "A", requirement: "HA", level: "planned", detail: "M6" },
          { section: "A", requirement: "Audit export", level: "planned", detail: "" },
        ]),
      ),
    );
    const container = document.createElement("div");
    await renderStatus(container);

    const detailItemCount = container.querySelectorAll(".status-detail-list li").length;
    const countPillSum = [...container.querySelectorAll(".status-count")]
      .map((el) => parseInt(el.textContent ?? "", 10))
      .reduce((sum, n) => sum + n, 0);

    expect(detailItemCount).toBe(6);
    expect(countPillSum).toBe(detailItemCount);
  });
});
