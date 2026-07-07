import { describe, expect, it } from "vitest";
import { SECTION_ORDER, sectionForProgress } from "../src/scroll/sectionMapping";

describe("sectionForProgress", () => {
  it("returns the first section at progress 0", () => {
    expect(sectionForProgress(0)).toBe(SECTION_ORDER[0]);
  });

  it("returns the last section at progress 1", () => {
    expect(sectionForProgress(1)).toBe(SECTION_ORDER[SECTION_ORDER.length - 1]);
  });

  it("divides progress into equal bands, one per section in order", () => {
    const bandSize = 1 / SECTION_ORDER.length;
    for (let i = 0; i < SECTION_ORDER.length; i++) {
      const midpoint = i * bandSize + bandSize / 2;
      expect(sectionForProgress(midpoint)).toBe(SECTION_ORDER[i]);
    }
  });

  it("clamps out-of-range progress values instead of throwing", () => {
    expect(sectionForProgress(-0.5)).toBe(SECTION_ORDER[0]);
    expect(sectionForProgress(1.5)).toBe(SECTION_ORDER[SECTION_ORDER.length - 1]);
  });
});
