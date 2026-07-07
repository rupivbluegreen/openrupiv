# openRupiv Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a scroll-driven marketing landing page for openRupiv
at `apps/website`, hosted on GitHub Pages via GitHub Actions, with a Three.js
particle-network animation that reconfigures per section as the visitor
scrolls.

**Architecture:** A Vite + TypeScript static site with zero backend. All the
decision logic (which network layout applies to which scroll position, how
`ENTERPRISE_READINESS.md`'s status table maps to structured data) is pulled
out into small, pure, unit-tested functions; the Three.js rendering and GSAP
ScrollTrigger wiring are thin integration layers over those pure functions,
verified by manual browser QA (per this plan's own testing approach — there
is no server-side logic and no business rules beyond the two pure modules,
so a from-scratch unit-test harness for the rendering loop itself would test
Three.js/GSAP, not this project's code).

**Tech Stack:** Vite, TypeScript (strict, extending the repo's
`tsconfig.base.json`), Three.js, GSAP + ScrollTrigger, Vitest, `tsx` (already
a hoisted root devDependency, used to run the build-time status parser).

## Global Constraints

- Node ≥ 20; pnpm via corepack (`corepack pnpm ...` if pnpm is not on PATH).
- TypeScript strict mode everywhere (`tsconfig.base.json`): `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are all already on in
  the base config this package extends — write code that satisfies them
  (e.g. non-null assertions or explicit checks on array indexing, since
  `noUncheckedIndexedAccess` makes `arr[i]` type as `T | undefined`).
- `pnpm typecheck && pnpm lint && pnpm test` (recursive, `--if-present`) must
  pass — this new package's own `typecheck`/`test` scripts get picked up by
  those root scripts automatically once added.
- Every commit is DCO-signed: `git commit -s`.
- Never claim ahead of `ENTERPRISE_READINESS.md` (CLAUDE.md #7) — the page's
  "what's real today" section is generated from that file's own table, not
  hand-written prose, and the build fails loudly if the table can't be
  parsed rather than shipping stale/empty content (CLAUDE.md #2, "no silent
  no-op").
- `prefers-reduced-motion: reduce` and WebGL-unavailable browsers both get a
  static fallback — this is an accessibility/robustness requirement, not
  optional polish.
- This is a new, independent workspace package (`apps/website`, using the
  `apps/*` glob the root `pnpm-workspace.yaml` already reserves) — it must
  not modify any existing `packages/*` code.

---

### Task 1: Scaffold `apps/website` — Vite + TypeScript, builds a placeholder page

**Files:**
- Create: `apps/website/package.json`
- Create: `apps/website/tsconfig.json`
- Create: `apps/website/vite.config.ts`
- Create: `apps/website/index.html`
- Create: `apps/website/src/main.ts`
- Create: `apps/website/README.md`

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundation).
- Produces: a working `pnpm --filter @openrupiv/website build`/`dev`/`test`/`typecheck`
  pipeline that every later task builds on. `main.ts` is the entry point
  every later task adds to.

- [ ] **Step 1: Create the package manifest**

Create `apps/website/package.json`:

```json
{
  "name": "@openrupiv/website",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsx scripts/build-status.ts && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "three": "^0.169.0",
    "gsap": "^3.12.5"
  },
  "devDependencies": {
    "@types/three": "^0.169.0",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

Create `apps/website/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "scripts", "test", "vite.config.ts"]
}
```

(The root `tsconfig.base.json` only has `"lib": ["ES2022"]` — no DOM types,
since no other package runs in a browser. This override adds them just for
this package.)

- [ ] **Step 3: Create the Vite config**

Create `apps/website/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built output works both at the default GitHub
  // Pages project-page path (https://rupivbluegreen.github.io/openrupiv/)
  // and, later, at a custom domain's root (https://rupiv.ai/) once DNS is
  // configured — an absolute base like "/openrupiv/" would need to change
  // when that happens; "./" never does.
  base: "./",
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 4: Create a placeholder entry point and HTML shell**

Create `apps/website/src/main.ts`:

```ts
console.log("openRupiv website — scaffold OK");
```

Create `apps/website/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>openRupiv — the enterprise features are the free features</title>
  </head>
  <body>
    <div id="page">
      <h1>openRupiv</h1>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Install dependencies and verify the build**

Run: `corepack pnpm install` (from the repo root)
Expected: installs `three`, `gsap`, `@types/three`, `vite` into
`apps/website/node_modules` (symlinked via the workspace).

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS (no type errors in the placeholder).

Run: `corepack pnpm --filter @openrupiv/website build`
Expected: FAILS at this step — `tsx scripts/build-status.ts` doesn't exist
yet (that's Task 2). This is expected; confirm the failure is specifically
"module not found" for `scripts/build-status.ts`, not something else.

- [ ] **Step 6: Temporarily simplify the build script to confirm the Vite half works**

This step exists only to prove Vite itself is wired correctly before Task 2
adds the real prebuild step. Temporarily change `package.json`'s `build`
script to just `"build": "vite build"`, run:

Run: `corepack pnpm --filter @openrupiv/website build`
Expected: PASS — produces `apps/website/dist/index.html` and a bundled JS
file.

Then revert `package.json`'s `build` script back to
`"tsx scripts/build-status.ts && vite build"` (Task 2 will make this pass
for real) — do not commit the temporary simplified version.

- [ ] **Step 7: Add the package README**

Create `apps/website/README.md`:

```markdown
# @openrupiv/website

The public marketing/landing page for openRupiv — a scroll-driven static
site (Vite + TypeScript + Three.js + GSAP ScrollTrigger), deployed to GitHub
Pages by `.github/workflows/deploy-pages.yml` on every push to `main` that
touches this package.

## Commands

- `pnpm --filter @openrupiv/website dev` — local dev server with hot reload.
- `pnpm --filter @openrupiv/website build` — regenerates `public/status.json`
  from the repo root's `ENTERPRISE_READINESS.md` (see `scripts/build-status.ts`),
  then builds the static site into `dist/`.
- `pnpm --filter @openrupiv/website test` — runs the unit tests for the two
  pure logic modules (`src/scene/layouts.ts`, `src/scroll/sectionMapping.ts`)
  and the status-table parser (`scripts/build-status.ts`). There is no
  broader unit-test suite for the Three.js rendering/GSAP wiring itself —
  those are verified by manual browser QA (scroll through the built site;
  toggle OS-level "reduce motion"; confirm the animation reconfigures at
  each section).

## Honesty constraint

The "what's real today" section on the page is generated from the repo
root's `ENTERPRISE_READINESS.md` table at build time — never hand-edit
status claims directly in this package's source. If the build fails with
"found zero status rows," `ENTERPRISE_READINESS.md`'s table format has
changed in a way `scripts/build-status.ts` doesn't recognize; fix the
parser, don't work around it.
```

- [ ] **Step 8: Commit**

```bash
git add apps/website/package.json apps/website/tsconfig.json apps/website/vite.config.ts apps/website/index.html apps/website/src/main.ts apps/website/README.md pnpm-lock.yaml
git commit -s -m "website: scaffold apps/website (Vite + TypeScript)"
```

---

### Task 2: Build-time `ENTERPRISE_READINESS.md` status parser

**Files:**
- Create: `apps/website/scripts/build-status.ts`
- Test: `apps/website/test/build-status.test.ts`

**Interfaces:**
- Consumes: the repo root's `ENTERPRISE_READINESS.md` (read at build time,
  not imported as a module).
- Produces: `ReadinessLevel` (`"shipped" | "in_progress" | "planned" |
  "not_planned"`), `ReadinessItem { section: string; requirement: string;
  level: ReadinessLevel; detail: string }`, `parseReadiness(markdown:
  string): ReadinessItem[]` (pure, throws on unparseable input),
  `buildStatusJson(readinessMarkdownPath: string, outputJsonPath: string):
  void` (the I/O wrapper). Task 7 (content rendering) fetches the emitted
  `public/status.json` at runtime and expects exactly this `ReadinessItem[]`
  shape.

`ENTERPRISE_READINESS.md`'s real, current structure (confirmed by reading
the file directly) is: a legend line defining 4 status emoji (`✅` shipped,
`🚧` in progress, `📋` planned, `❌` not planned), then repeated `## Section
Name` headings each followed by a `| Requirement | Status |` / `|---|---|`
markdown table whose rows are `| <requirement text> | <emoji> <detail
text> |`.

- [ ] **Step 1: Write the failing tests**

Create `apps/website/test/build-status.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @openrupiv/website test -- build-status.test.ts`
Expected: FAIL — `../scripts/build-status` doesn't exist yet.

- [ ] **Step 3: Implement the parser**

Create `apps/website/scripts/build-status.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ReadinessLevel = "shipped" | "in_progress" | "planned" | "not_planned";

export interface ReadinessItem {
  section: string;
  requirement: string;
  level: ReadinessLevel;
  detail: string;
}

const LEVEL_BY_EMOJI: Record<string, ReadinessLevel> = {
  "✅": "shipped",
  "🚧": "in_progress",
  "📋": "planned",
  "❌": "not_planned",
};

/**
 * Parses ENTERPRISE_READINESS.md's `## Section` + `| Requirement | Status |`
 * table structure into structured items. Throws if the file's format has
 * drifted in a way this parser can't recognize — this build step must fail
 * loudly rather than silently ship stale/empty status (CLAUDE.md #2).
 */
export function parseReadiness(markdown: string): ReadinessItem[] {
  const lines = markdown.split("\n");
  const items: ReadinessItem[] = [];
  let currentSection = "";

  for (const line of lines) {
    const sectionMatch = /^## (.+)$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      continue;
    }

    const rowMatch = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!rowMatch || !currentSection) continue;

    const requirement = rowMatch[1]!.trim();
    const statusText = rowMatch[2]!.trim();
    if (requirement === "Requirement" || /^-+$/.test(requirement.replace(/\s/g, ""))) continue;

    const matchedEmoji = Object.keys(LEVEL_BY_EMOJI).find((emoji) => statusText.startsWith(emoji));
    if (!matchedEmoji) continue;

    items.push({
      section: currentSection,
      requirement,
      level: LEVEL_BY_EMOJI[matchedEmoji]!,
      detail: statusText.slice(matchedEmoji.length).trim(),
    });
  }

  if (items.length === 0) {
    throw new Error(
      "parseReadiness: found zero status rows — ENTERPRISE_READINESS.md's format may have changed; refusing to ship an empty status section",
    );
  }
  return items;
}

export function buildStatusJson(readinessMarkdownPath: string, outputJsonPath: string): void {
  const markdown = readFileSync(readinessMarkdownPath, "utf8");
  const items = parseReadiness(markdown);
  writeFileSync(outputJsonPath, JSON.stringify(items, null, 2));
}

// CLI entry point: `tsx scripts/build-status.ts`, run from apps/website/.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildStatusJson(
    fileURLToPath(new URL("../../../ENTERPRISE_READINESS.md", import.meta.url)),
    fileURLToPath(new URL("../public/status.json", import.meta.url)),
  );
  // eslint-disable-next-line no-console
  console.log("apps/website/public/status.json regenerated from ENTERPRISE_READINESS.md");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @openrupiv/website test -- build-status.test.ts`
Expected: PASS (all 4 tests).

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 5: Verify the CLI entry point works against the real file**

Run (from `apps/website/`): `mkdir -p public && npx tsx scripts/build-status.ts`
Expected: prints the regeneration message and creates `apps/website/public/status.json`
containing real entries parsed from the repo root's actual
`ENTERPRISE_READINESS.md` (e.g. an item with `requirement: "OIDC SSO"`,
`level: "shipped"`). Inspect the file to confirm.

- [ ] **Step 6: Confirm the full build script now works**

Run: `corepack pnpm --filter @openrupiv/website build`
Expected: PASS — runs the status build then Vite build; `dist/status.json`
exists in the output (Vite copies `public/` contents verbatim).

- [ ] **Step 7: Commit**

```bash
git add apps/website/scripts/build-status.ts apps/website/test/build-status.test.ts apps/website/.gitignore
git commit -s -m "website: build-time ENTERPRISE_READINESS.md status parser"
```

(Add `apps/website/.gitignore` containing `public/status.json` and `dist/`
first if it doesn't exist — this file is generated, not hand-maintained,
and must never be committed since it would drift from the real
`ENTERPRISE_READINESS.md` the moment that file changes again.)

---

### Task 3: Pure network-layout math (deterministic node positions per section)

**Files:**
- Create: `apps/website/src/scene/layouts.ts`
- Test: `apps/website/test/layouts.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `SectionId` (`"hero" | "pillar-sso" | "pillar-git" |
  "pillar-compliance" | "pillar-agents" | "roadmap" | "status"`), `Vec3Like {
  x: number; y: number; z: number }`, `computeLayout(section: SectionId,
  index: number, total: number): Vec3Like`. Task 4 (`sectionMapping.ts`)
  imports `SectionId`. Task 5 (`NetworkScene.ts`) imports both `SectionId`
  and `computeLayout`.

- [ ] **Step 1: Write the failing tests**

Create `apps/website/test/layouts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @openrupiv/website test -- layouts.test.ts`
Expected: FAIL — `../src/scene/layouts` doesn't exist yet.

- [ ] **Step 3: Implement the layout functions**

Create `apps/website/src/scene/layouts.ts`:

```ts
export type SectionId =
  | "hero"
  | "pillar-sso"
  | "pillar-git"
  | "pillar-compliance"
  | "pillar-agents"
  | "roadmap"
  | "status";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Deterministic, evenly-distributed scatter across a sphere (Fibonacci sphere) — the ambient "hero" state. */
function fibonacciSphere(index: number, total: number, radius: number): Vec3Like {
  const y = total > 1 ? 1 - (index / (total - 1)) * 2 : 0;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index;
  return { x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius };
}

/** Which node indices belong to which pillar cluster — deterministic partition by index modulo 4. */
function pillarMembers(total: number, pillarIndex: number): number[] {
  const members: number[] = [];
  for (let i = 0; i < total; i++) {
    if (i % 4 === pillarIndex) members.push(i);
  }
  return members;
}

const PILLAR_ORDER: readonly SectionId[] = ["pillar-sso", "pillar-git", "pillar-compliance", "pillar-agents"];

const PILLAR_CENTERS: Record<string, Vec3Like> = {
  "pillar-sso": { x: -3, y: 1, z: 0 },
  "pillar-git": { x: 3, y: 1, z: 0 },
  "pillar-compliance": { x: -3, y: -1, z: 0 },
  "pillar-agents": { x: 3, y: -1, z: 0 },
};

/** Nodes belonging to this pillar arrange in a ring around `center`; other nodes drift to a faint outer sphere. */
function clusterLayout(
  index: number,
  total: number,
  memberIndices: number[],
  center: Vec3Like,
  clusterRadius: number,
  fallbackRadius: number,
): Vec3Like {
  const memberPos = memberIndices.indexOf(index);
  if (memberPos === -1) {
    return fibonacciSphere(index, total, fallbackRadius);
  }
  const angle = GOLDEN_ANGLE * memberPos;
  const ringR = clusterRadius * (0.3 + 0.7 * (memberPos / Math.max(1, memberIndices.length - 1)));
  return {
    x: center.x + Math.cos(angle) * ringR,
    y: center.y + Math.sin(angle) * ringR * 0.6,
    z: center.z + Math.sin(angle * 0.5) * ringR * 0.4,
  };
}

/** Evenly spaced along x into 6 phase columns (Phase 0–5), nodes distributed round-robin into columns. */
function roadmapLayout(index: number, total: number): Vec3Like {
  const phase = index % 6;
  const withinPhase = Math.floor(index / 6);
  const countInPhase = Math.ceil(total / 6);
  const x = -5 + phase * 2;
  const y = countInPhase > 1 ? -1.5 + (withinPhase / (countInPhase - 1)) * 3 : 0;
  return { x, y, z: 0 };
}

/** A calm settled grid — the "status" state. */
function statusLayout(index: number, total: number): Vec3Like {
  const cols = Math.ceil(Math.sqrt(total));
  const row = Math.floor(index / cols);
  const col = index % cols;
  return { x: (col - cols / 2) * 1.2, y: (row - cols / 2) * 1.2, z: 0 };
}

export function computeLayout(section: SectionId, index: number, total: number): Vec3Like {
  if (section === "hero") return fibonacciSphere(index, total, 5);
  if (section === "roadmap") return roadmapLayout(index, total);
  if (section === "status") return statusLayout(index, total);

  const pillarIndex = PILLAR_ORDER.indexOf(section);
  const members = pillarMembers(total, pillarIndex);
  return clusterLayout(index, total, members, PILLAR_CENTERS[section]!, 1.6, 6);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @openrupiv/website test -- layouts.test.ts`
Expected: PASS (all 5 tests).

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/scene/layouts.ts apps/website/test/layouts.test.ts
git commit -s -m "website: pure deterministic network-layout math per section"
```

---

### Task 4: Pure scroll-progress-to-section mapping

**Files:**
- Create: `apps/website/src/scroll/sectionMapping.ts`
- Test: `apps/website/test/sectionMapping.test.ts`

**Interfaces:**
- Consumes: `SectionId` from `../scene/layouts` (Task 3).
- Produces: `SECTION_ORDER: SectionId[]`, `sectionForProgress(progress:
  number): SectionId`. Task 6 (`scrollTimeline.ts`) calls
  `sectionForProgress` on every scroll update.

- [ ] **Step 1: Write the failing tests**

Create `apps/website/test/sectionMapping.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @openrupiv/website test -- sectionMapping.test.ts`
Expected: FAIL — `../src/scroll/sectionMapping` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/website/src/scroll/sectionMapping.ts`:

```ts
import type { SectionId } from "../scene/layouts";

/** Scroll order of sections, top to bottom of the page. */
export const SECTION_ORDER: SectionId[] = [
  "hero",
  "pillar-sso",
  "pillar-git",
  "pillar-compliance",
  "pillar-agents",
  "roadmap",
  "status",
];

/** Maps overall page-scroll progress (0..1) to the active section, dividing the range into equal bands. */
export function sectionForProgress(progress: number): SectionId {
  const clamped = Math.min(1, Math.max(0, progress));
  const bandSize = 1 / SECTION_ORDER.length;
  const index = Math.min(SECTION_ORDER.length - 1, Math.floor(clamped / bandSize));
  return SECTION_ORDER[index]!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @openrupiv/website test -- sectionMapping.test.ts`
Expected: PASS (all 4 tests).

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/website/src/scroll/sectionMapping.ts apps/website/test/sectionMapping.test.ts
git commit -s -m "website: pure scroll-progress-to-section mapping"
```

---

### Task 5: `NetworkScene` — the Three.js particle-network renderer

**Files:**
- Create: `apps/website/src/scene/NetworkScene.ts`

**Interfaces:**
- Consumes: `computeLayout`, `SectionId` from `./layouts` (Task 3).
- Produces: `class NetworkScene { constructor(canvas: HTMLCanvasElement);
  setSection(section: SectionId): void; start(): void; stop(): void }`,
  `isWebGLAvailable(): boolean`. Task 6 (`scrollTimeline.ts`) calls
  `scene.setSection(...)`. Task 8 (`main.ts`) constructs the scene and calls
  `isWebGLAvailable()`/`start()`.

**No unit-test cycle for this task** — this is a WebGL rendering integration
layer with no `jsdom`/Node-runnable canvas context in this repo's test
setup, and all the actual decision logic it depends on (`computeLayout`) is
already unit-tested in Task 3. Verify this task by manual browser QA (Step
3 below), per this plan's stated testing approach.

- [ ] **Step 1: Implement the scene**

Create `apps/website/src/scene/NetworkScene.ts`:

```ts
import * as THREE from "three";
import { computeLayout, type SectionId } from "./layouts";

const NODE_COUNT = 48;
const CONNECT_DISTANCE = 2.2;
const LERP_FACTOR = 0.04;

export class NetworkScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private points: THREE.Points;
  private lines: THREE.LineSegments;
  private positions: THREE.Vector3[];
  private targets: THREE.Vector3[];
  private currentSection: SectionId = "hero";
  private rafHandle: number | null = null;
  private readonly onResize = (): void => this.resize();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.z = 12;

    this.positions = Array.from({ length: NODE_COUNT }, (_, i) => {
      const p = computeLayout("hero", i, NODE_COUNT);
      return new THREE.Vector3(p.x, p.y, p.z);
    });
    this.targets = this.positions.map((v) => v.clone());

    const pointGeometry = new THREE.BufferGeometry().setFromPoints(this.positions);
    const pointMaterial = new THREE.PointsMaterial({ color: 0x38bdf8, size: 0.12, transparent: true, opacity: 0.9 });
    this.points = new THREE.Points(pointGeometry, pointMaterial);
    this.scene.add(this.points);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
    this.scene.add(this.lines);

    this.resize();
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private resize(): void {
    const { innerWidth, innerHeight } = window;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Called by the scroll timeline whenever the active section changes. */
  setSection(section: SectionId): void {
    if (section === this.currentSection) return;
    this.currentSection = section;
    this.targets = this.positions.map((_, i) => {
      const p = computeLayout(section, i, NODE_COUNT);
      return new THREE.Vector3(p.x, p.y, p.z);
    });
  }

  private updateLines(): void {
    const linePositions: number[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      for (let j = i + 1; j < NODE_COUNT; j++) {
        if (this.positions[i]!.distanceTo(this.positions[j]!) < CONNECT_DISTANCE) {
          linePositions.push(this.positions[i]!.x, this.positions[i]!.y, this.positions[i]!.z);
          linePositions.push(this.positions[j]!.x, this.positions[j]!.y, this.positions[j]!.z);
        }
      }
    }
    this.lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
  }

  private readonly tick = (): void => {
    for (let i = 0; i < NODE_COUNT; i++) {
      this.positions[i]!.lerp(this.targets[i]!, LERP_FACTOR);
    }
    this.points.geometry.setFromPoints(this.positions);
    this.updateLines();
    this.renderer.render(this.scene, this.camera);
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  start(): void {
    if (this.rafHandle === null) this.tick();
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /** Releases listeners and GPU resources — call if the scene is ever torn down (not needed for this single-page app's lifetime, included for correctness). */
  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.points.geometry.dispose();
    this.lines.geometry.dispose();
    this.renderer.dispose();
  }
}

/** True if this browser can create a WebGL context. */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 3: Manual smoke test via a temporary dev harness**

This class isn't wired into `main.ts` until Task 8 — to sanity-check it
compiles and renders BEFORE that integration, temporarily replace
`apps/website/src/main.ts`'s contents with:

```ts
import { NetworkScene, isWebGLAvailable } from "./scene/NetworkScene";

const canvas = document.createElement("canvas");
document.body.appendChild(canvas);
canvas.style.position = "fixed";
canvas.style.inset = "0";

if (isWebGLAvailable()) {
  const scene = new NetworkScene(canvas);
  scene.start();
  setTimeout(() => scene.setSection("pillar-git"), 2000);
  setTimeout(() => scene.setSection("roadmap"), 4000);
}
```

Run: `corepack pnpm --filter @openrupiv/website dev`
Expected: opens a dev server; visiting it in a browser shows a dark canvas
with ~48 glowing blue dots connected by faint lines, initially scattered in
a sphere, that visibly reconfigure into a clustered arrangement after 2s and
a column arrangement after 4s.

Revert `main.ts` back to its Task 1 placeholder content afterward — do not
commit this temporary harness.

- [ ] **Step 4: Commit**

```bash
git add apps/website/src/scene/NetworkScene.ts
git commit -s -m "website: Three.js particle-network scene with per-section layout transitions"
```

---

### Task 6: GSAP ScrollTrigger wiring

**Files:**
- Create: `apps/website/src/scroll/scrollTimeline.ts`

**Interfaces:**
- Consumes: `sectionForProgress` from `./sectionMapping` (Task 4);
  `NetworkScene` from `../scene/NetworkScene` (Task 5, only its
  `setSection` method).
- Produces: `initScrollTimeline(scene: NetworkScene, pageEl: HTMLElement):
  ScrollTrigger`. Task 8 (`main.ts`) calls this once, after constructing the
  scene.

No dedicated unit test — this is a 6-line direct call into GSAP's own
`ScrollTrigger.create`, and the actual progress→section decision it uses is
already tested in Task 4. Verified by the same manual browser QA as Task 5.

- [ ] **Step 1: Implement**

Create `apps/website/src/scroll/scrollTimeline.ts`:

```ts
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { sectionForProgress } from "./sectionMapping";
import type { NetworkScene } from "../scene/NetworkScene";

gsap.registerPlugin(ScrollTrigger);

/** Wires overall page-scroll progress to NetworkScene section transitions. Call once after the page's content is in the DOM. */
export function initScrollTimeline(scene: NetworkScene, pageEl: HTMLElement): ScrollTrigger {
  return ScrollTrigger.create({
    trigger: pageEl,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      scene.setSection(sectionForProgress(self.progress));
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/website/src/scroll/scrollTimeline.ts
git commit -s -m "website: GSAP ScrollTrigger wiring for section-driven network transitions"
```

---

### Task 7: Content sections, styles, and status rendering

**Files:**
- Modify: `apps/website/index.html`
- Create: `apps/website/src/styles/main.css`
- Create: `apps/website/src/content/renderStatus.ts`

**Interfaces:**
- Consumes: `ReadinessItem` shape from Task 2's emitted `public/status.json`
  (fetched at runtime, not imported — the type is redeclared locally since
  this is a separate runtime/build-time boundary, matching how the rest of
  this repo treats generated JSON as data, not a compile-time import).
- Produces: `renderStatus(containerEl: HTMLElement): Promise<void>`. Task 8
  (`main.ts`) calls this once, targeting the status section's container.

Real copy pulled from the repo root's `README.md` (its thesis and four
pillars) and `PLAN.md` §6 (the phase roadmap) — not placeholder text.

- [ ] **Step 1: Write the page markup**

Replace `apps/website/index.html`'s `<body>` contents with:

```html
  <body>
    <canvas id="network-canvas"></canvas>
    <main id="page">
      <section id="hero" class="section">
        <div class="panel">
          <h1>openRupiv</h1>
          <p class="lede">
            An Apache-2.0, enterprise-ready, agent-native app development
            platform where the enterprise features are the free features.
          </p>
          <p>
            Every commercial app platform gates SSO, SCIM, RBAC, audit logs,
            HA, and compliance reporting behind enterprise tiers. This
            project doesn't.
          </p>
        </div>
      </section>

      <section id="pillar-sso" class="section">
        <div class="panel">
          <h2>Zero SSO tax</h2>
          <p>
            SAML, OIDC, SCIM, RBAC/ABAC, audit logs, HA, and an air-gap
            installer — all in the Apache-2.0 core. Not an "enterprise
            edition."
          </p>
        </div>
      </section>

      <section id="pillar-git" class="section">
        <div class="panel">
          <h2>Apps are Git artifacts, not database rows</h2>
          <p>
            Describe an app in natural language, get a reviewable
            declarative spec plus generated code in a Git repo. Change
            management is a pull request. Delete the platform and your apps
            are still readable code.
          </p>
        </div>
      </section>

      <section id="pillar-compliance" class="section">
        <div class="panel">
          <h2>Compliance evidence as a byproduct</h2>
          <p>
            Hash-chained audit log, SIEM export, and generated EU AI Act /
            GDPR artifacts — emitted from runtime metadata, not assembled by
            hand.
          </p>
        </div>
      </section>

      <section id="pillar-agents" class="section">
        <div class="panel">
          <h2>Agent-native and interop-native</h2>
          <p>
            Agents are governed workers with identity, policy, and
            human-in-the-loop gates. MCP client + server and A2A from v1.
          </p>
        </div>
      </section>

      <section id="roadmap" class="section">
        <div class="panel">
          <h2>Roadmap</h2>
          <ol class="roadmap-list">
            <li><strong>Phase 0 — Pre-flight.</strong> Name, license, repo scaffold.</li>
            <li><strong>Phase 1 — Core.</strong> App spec, CLI + generator, TypeScript runtime, OIDC from day one.</li>
            <li class="current"><strong>Phase 2 — Agents + policy + audit (in progress).</strong> Agent runtime, MCP client/server, A2A, OPA policy engine, hash-chained audit log, RBAC, HITL gates.</li>
            <li><strong>Phase 3 — Enterprise identity &amp; ops.</strong> SAML, SCIM, Helm/HA, OTel, secrets, sandbox hardening.</li>
            <li><strong>Phase 4 — Compliance packs.</strong> GDPR + EU AI Act packs, Annex IV / RoPA / DPIA generators.</li>
            <li><strong>Phase 5 — Ecosystem.</strong> Migration tooling, community connectors.</li>
          </ol>
        </div>
      </section>

      <section id="status" class="section">
        <div class="panel">
          <h2>What's real today</h2>
          <p class="status-note">
            Generated from this project's own honest capability ledger —
            never claimed ahead of it.
          </p>
          <div id="status-content"></div>
        </div>
      </section>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
```

Also update the `<head>` to load the stylesheet — add this line inside
`<head>`, after the existing `<title>`:

```html
    <link rel="stylesheet" href="/src/styles/main.css" />
```

- [ ] **Step 2: Write the stylesheet**

Create `apps/website/src/styles/main.css`:

```css
:root {
  color-scheme: dark;
  --bg: #0a0e14;
  --fg: #e2e8f0;
  --accent: #38bdf8;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

#network-canvas {
  position: fixed;
  inset: 0;
  z-index: 0;
}

#page {
  position: relative;
  z-index: 1;
}

.section {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
}

.panel {
  max-width: 640px;
  background: rgba(10, 14, 20, 0.72);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 12px;
  padding: 2rem;
}

.lede {
  font-size: 1.25rem;
  font-weight: 600;
}

.roadmap-list li {
  margin-bottom: 0.75rem;
}

.roadmap-list li.current {
  color: var(--accent);
}

.status-note {
  font-size: 0.875rem;
  opacity: 0.75;
}

.status-section h4 {
  margin-bottom: 0.25rem;
  color: var(--accent);
}

.status-section ul {
  margin: 0 0 1rem;
  padding-left: 1.25rem;
}

.status-shipped::marker {
  content: "✅ ";
}

.status-in_progress::marker {
  content: "🚧 ";
}

.status-planned::marker {
  content: "📋 ";
}

.status-not_planned::marker {
  content: "❌ ";
}

/* Reduced-motion / no-WebGL fallback: no fixed canvas, sections read as a plain static document. */
body.static-fallback #network-canvas {
  display: none;
}

body.static-fallback .panel {
  background: rgba(15, 20, 28, 0.95);
}

@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 3: Implement status rendering**

Create `apps/website/src/content/renderStatus.ts`:

```ts
type ReadinessLevel = "shipped" | "in_progress" | "planned" | "not_planned";

interface ReadinessItem {
  section: string;
  requirement: string;
  level: ReadinessLevel;
  detail: string;
}

const LEVEL_LABEL: Record<ReadinessLevel, string> = {
  shipped: "Shipped",
  in_progress: "In progress",
  planned: "Planned",
  not_planned: "Not planned",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fetches the build-time-generated status.json and renders it, grouped by section, into `containerEl`. */
export async function renderStatus(containerEl: HTMLElement): Promise<void> {
  const res = await fetch("./status.json");
  if (!res.ok) {
    containerEl.textContent = "Status unavailable.";
    return;
  }
  const items = (await res.json()) as ReadinessItem[];

  const bySection = new Map<string, ReadinessItem[]>();
  for (const item of items) {
    const list = bySection.get(item.section) ?? [];
    list.push(item);
    bySection.set(item.section, list);
  }

  containerEl.innerHTML = [...bySection.entries()]
    .map(
      ([section, sectionItems]) => `
        <div class="status-section">
          <h4>${escapeHtml(section)}</h4>
          <ul>
            ${sectionItems
              .map(
                (item) =>
                  `<li class="status-${item.level}"><strong>${escapeHtml(item.requirement)}:</strong> ${LEVEL_LABEL[item.level]}</li>`,
              )
              .join("")}
          </ul>
        </div>
      `,
    )
    .join("");
}
```

(`escapeHtml` guards against `ENTERPRISE_READINESS.md` ever containing
characters that would break the generated HTML — the content is
maintainer-controlled today, but this costs nothing and removes a class of
future bug if that ever changes.)

- [ ] **Step 4: Typecheck**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/website/index.html apps/website/src/styles/main.css apps/website/src/content/renderStatus.ts
git commit -s -m "website: content sections, styling, and status-table rendering"
```

---

### Task 8: Wire `main.ts` — integrate scene, scroll timeline, status, and fallbacks

**Files:**
- Modify: `apps/website/src/main.ts`

**Interfaces:**
- Consumes: `NetworkScene`, `isWebGLAvailable` (Task 5); `initScrollTimeline`
  (Task 6); `renderStatus` (Task 7).
- Produces: nothing further downstream — this is the final integration
  point.

No dedicated unit test (pure integration/glue, every decision it makes is
already tested in the modules it calls). Verified by manual browser QA.

- [ ] **Step 1: Implement**

Replace `apps/website/src/main.ts`'s contents entirely with:

```ts
import "./styles/main.css";
import { NetworkScene, isWebGLAvailable } from "./scene/NetworkScene";
import { initScrollTimeline } from "./scroll/scrollTimeline";
import { renderStatus } from "./content/renderStatus";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function main(): void {
  const canvas = document.getElementById("network-canvas") as HTMLCanvasElement | null;
  const page = document.getElementById("page");
  const statusContainer = document.getElementById("status-content");

  if (statusContainer) {
    void renderStatus(statusContainer);
  }

  if (!canvas || !page) return;

  if (prefersReducedMotion() || !isWebGLAvailable()) {
    canvas.remove();
    document.body.classList.add("static-fallback");
    return;
  }

  const scene = new NetworkScene(canvas);
  scene.start();
  initScrollTimeline(scene, page);
}

main();
```

- [ ] **Step 2: Typecheck and build**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS.

Run: `corepack pnpm --filter @openrupiv/website build`
Expected: PASS — produces `dist/index.html`, bundled JS/CSS, and
`dist/status.json`.

- [ ] **Step 3: Manual end-to-end QA (this is the real verification for this task)**

Run: `corepack pnpm --filter @openrupiv/website preview` (serves the built
`dist/` output)

In a real browser, visiting the printed local URL:
- Scroll from top to bottom of the page. Confirm the particle network
  visibly reconfigures at each section boundary (scattered sphere → 4
  distinct pillar clusters in sequence → a column/timeline arrangement → a
  settled grid).
- Confirm every section's text panel stays legible throughout (the
  `backdrop-filter: blur()` panel should keep text readable against the
  animation).
- Confirm the "What's real today" section renders real content pulled from
  `ENTERPRISE_READINESS.md` (spot-check one item, e.g. "OIDC SSO: Shipped").
- In your OS/browser settings, enable "reduce motion," reload the page.
  Confirm the canvas is removed entirely and the page reads as a plain
  static document with no animation.
- Open browser DevTools console — confirm no errors are logged during
  normal scrolling.

- [ ] **Step 4: Commit**

```bash
git add apps/website/src/main.ts
git commit -s -m "website: wire NetworkScene, scroll timeline, and status rendering into main.ts"
```

---

### Task 9: GitHub Pages deployment workflow

**Files:**
- Create: `.github/workflows/deploy-pages.yml`
- Create: `apps/website/public/CNAME`
- Create: `apps/website/.gitignore` (if not already created in Task 2)

**Interfaces:** none — this is infrastructure, consumes the `dist/` output
`apps/website/build` already produces (Tasks 1–8).

This is the one task in this plan that MUST be exercised end-to-end (an
actual GitHub Actions run), not just code-reviewed — a Pages deploy pipeline
is easy to get subtly wrong (wrong artifact path, missing permissions,
Pages not enabled in repo settings).

- [ ] **Step 1: Add the CNAME file (inert until DNS is configured later)**

Create `apps/website/public/CNAME`:

```
rupiv.ai
```

(No trailing content beyond the domain name — this is GitHub Pages'
required format. Vite copies everything in `public/` verbatim into `dist/`,
so this ships in every build. It has no effect until the `rupiv.ai`
registrar's DNS is pointed at GitHub Pages — that DNS configuration is
explicitly out of scope for this plan, per the design spec.)

- [ ] **Step 2: Ensure the website package's generated/build output is gitignored**

Create `apps/website/.gitignore` (skip this step if Task 2 already created
it):

```
dist/
public/status.json
node_modules/
```

- [ ] **Step 3: Write the deploy workflow**

Create `.github/workflows/deploy-pages.yml`:

```yaml
name: Deploy website to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - "apps/website/**"
      - ".github/workflows/deploy-pages.yml"
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @openrupiv/website build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: apps/website/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-pages.yml apps/website/public/CNAME apps/website/.gitignore
git commit -s -m "website: add GitHub Pages deploy workflow + CNAME"
```

- [ ] **Step 5: Exercise the workflow end-to-end**

This step cannot be fully completed until this branch's PR is open (GitHub
Actions needs the workflow file present on a ref it can run against) and,
separately, GitHub Pages needs to be enabled once in this repo's Settings →
Pages → Source: "GitHub Actions" (a one-time manual step in the GitHub UI,
not something a commit can do). Flag both of these explicitly in the PR
description:

1. Ask the repo owner to enable Pages (Settings → Pages → Source: GitHub
   Actions) if not already done.
2. After the PR merges (or via `workflow_dispatch` on this branch, if the
   repo owner wants to test before merging), confirm the workflow run is
   green in the Actions tab and the printed `page_url` (from the `deploy`
   job's output) actually serves the site.

Do not mark this task complete in the plan tracker until a real workflow
run has been observed succeeding — a workflow file that merely parses as
valid YAML is not the same as one that has actually deployed successfully.

---

### Task 10: Link the live site from the repo's own docs

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a link**

In the repo root `README.md`, add a line right after the existing badge/blockquote
at the top of the file (after the existing `> ⚠️ **Early development...**`
blockquote, before the `**An Apache-2.0, enterprise-ready...**` paragraph):

```markdown
**[openrupiv.dev →](https://rupivbluegreen.github.io/openrupiv/)** — the
project's landing page (built with this same repo, `apps/website`).
```

(Replace the URL with the actual `page_url` confirmed working in Task 9,
Step 5, in case it differs from the predicted default.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -s -m "docs: link the live landing page from the root README"
```

---

## Self-Review Notes (completed during plan authoring)

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-07-website-landing-page-design.md`
  is covered: hosting/deployment (Task 9), tech stack (Task 1), content
  structure (Task 7), data sourcing/honesty (Task 2), visual/interaction
  design (Tasks 3, 5, 6), testing/QA approach (each task's own verification
  step, matching the spec's stated "unit-test the pure logic, manually QA
  the rendering" approach), error handling (Task 2's loud-throw parser;
  Task 5's `isWebGLAvailable` fallback path wired in Task 8), out-of-scope
  items (DNS not touched, no CMS, no analytics — none appear in any task).
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code
  or an exact manual-verification procedure.
- **Type consistency:** `SectionId` (Task 3) is used identically in Task 4
  (`sectionMapping.ts`) and Task 5 (`NetworkScene.ts`); `computeLayout`'s
  signature `(section, index, total)` matches every call site across Tasks
  3 and 5; `ReadinessItem`'s shape in Task 2's parser matches the shape
  `renderStatus` (Task 7) expects when it fetches and parses the same JSON.
- **Note on Task 9's exit criterion:** deliberately left as a real,
  observed workflow run rather than "workflow file committed" — a Pages
  deploy that silently fails (wrong path, Pages not enabled) would
  otherwise look identical to success in this plan's own tracking.
