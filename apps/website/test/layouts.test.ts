import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/scene/layouts";

const TOTAL = 48;

describe("computeLayout", () => {
  it("hero layout produces finite coordinates for every node index", () => {
    for (let i = 0; i < TOTAL; i++) {
      const p = computeLayout("hero", i, TOTAL);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
  });

  it("is deterministic — same section/index/total always returns the same position", () => {
    const a = computeLayout("hero", 5, TOTAL);
    const b = computeLayout("hero", 5, TOTAL);
    expect(a).toEqual(b);
  });

  it("each pillar cluster centers on a distinct point (index 0 of each)", () => {
    const centers = (["pillar-sso", "pillar-git", "pillar-compliance", "pillar-agents"] as const).map((s) =>
      computeLayout(s, 0, TOTAL),
    );
    const unique = new Set(centers.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`));
    expect(unique.size).toBe(4);
  });

  it("roadmap layout places earlier-phase nodes at a smaller x than later-phase nodes", () => {
    const phase0X = computeLayout("roadmap", 0, TOTAL).x;
    const phase5X = computeLayout("roadmap", 5, TOTAL).x;
    expect(phase0X).toBeLessThan(phase5X);
  });

  it("status layout arranges every node at a unique grid position", () => {
    const positions = Array.from({ length: TOTAL }, (_, i) => computeLayout("status", i, TOTAL));
    const unique = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(unique.size).toBe(TOTAL);
  });
});
