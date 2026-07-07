// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSectionElements } from "../src/scroll/collectSections";

/** Mirrors index.html's real `.section` ids, in document order. */
const REAL_SECTION_IDS = [
  "hero",
  "pillar-sso",
  "pillar-git",
  "pillar-compliance",
  "pillar-agents",
  "roadmap",
  "status",
] as const;

function renderSections(ids: readonly string[]): void {
  document.body.innerHTML = ids.map((id) => `<section id="${id}" class="section"></section>`).join("\n");
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("collectSectionElements", () => {
  it("returns all 7 real section ids, in document order", () => {
    renderSections(REAL_SECTION_IDS);
    const collected = collectSectionElements();
    expect(collected.map((s) => s.id)).toEqual(REAL_SECTION_IDS);
  });

  it("pairs each returned id with its real DOM element", () => {
    renderSections(REAL_SECTION_IDS);
    const collected = collectSectionElements();
    expect(collected).toHaveLength(REAL_SECTION_IDS.length);
    for (const { id, element } of collected) {
      expect(element.id).toBe(id);
      expect(element.classList.contains("section")).toBe(true);
    }
  });

  it("excludes a .section element with an unrecognized id, warning instead of throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderSections([...REAL_SECTION_IDS, "bogus"]);

    let result: ReturnType<typeof collectSectionElements> = [];
    expect(() => {
      result = collectSectionElements();
    }).not.toThrow();

    expect(result).toHaveLength(REAL_SECTION_IDS.length);
    expect(result.some((s) => (s.id as string) === "bogus")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bogus"));
  });
});
