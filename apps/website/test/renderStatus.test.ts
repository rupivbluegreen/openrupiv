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
        jsonResponse([
          { section: "Security", requirement: "SAML SSO", level: "planned", detail: "M5" },
        ]),
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
        jsonResponse([
          { section: "Security", requirement: "X", level: "shipped", detail: "<script>alert(1)</script>" },
        ]),
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
      vi.fn().mockResolvedValue(
        jsonResponse([{ section: "Security", requirement: "X", level: "shipped", detail: "" }]),
      ),
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

  it("groups items by section", async () => {
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
    const headings = [...container.querySelectorAll("h4")].map((el) => el.textContent);
    expect(headings).toEqual(["A", "B"]);
  });
});
