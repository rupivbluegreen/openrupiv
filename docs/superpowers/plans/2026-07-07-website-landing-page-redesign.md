# Website Redesign — Drop Three.js/GSAP, "Fun and Welcoming" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/website`'s Three.js/GSAP particle-network landing page with a dependency-free, warm/rounded, pain-point-led redesign, per `docs/superpowers/specs/2026-07-07-website-landing-page-redesign-design.md`.

**Architecture:** Delete the WebGL scene, the layout math behind it, and the GSAP ScrollTrigger wiring. Replace scroll-driven motion with one small native `IntersectionObserver`-based reveal utility. Rewrite `index.html`'s copy around problem→solution framing per pain point, and rewrite `main.css` with a warm palette, rounded shapes, gradient section backgrounds, and CSS-only "blob" accents. The build-time status generator (`build-status.ts`) and its render logic (`renderStatus.ts`) are untouched — only their CSS skin changes.

**Tech Stack:** TypeScript (strict, `tsconfig.base.json`), Vite, Vitest + `happy-dom`, plain CSS (custom properties), zero new dependencies.

## Global Constraints

- No new npm dependencies. `three` and `gsap` are removed from `apps/website/package.json`; nothing replaces them as a package — motion is native CSS transitions + `IntersectionObserver`.
- Once `gsap` is removed, remove its named exception from the root `scripts/check-licenses.mjs`'s `EXCEPTIONS` map (added specifically to unblock that dependency) — leaving a dead exception for a package the workspace no longer depends on is stale, undocumented risk.
- The design's palette/shape/typography decisions are fixed values for this plan (not to be re-derived): warm off-white background `#fdf6ec`, four gradient accents (coral→amber, teal→lime, violet→pink, sky→teal), generous rounded corners (`28px` panels, `999px` pills), system-font stack (no webfont). Exact hex values are given in Task 4 verbatim — use them, don't invent alternatives.
- `build-status.ts` and `renderStatus.ts`'s TypeScript logic are **not modified** in this plan — the Status section's new look comes entirely from new CSS targeting its existing `.status-section` / `.status-${level}` classes.
- Every commit: `git commit -s` (DCO).
- Test runner: `corepack pnpm --filter @openrupiv/website test` (vitest). Typecheck: `corepack pnpm --filter @openrupiv/website typecheck`.
- `apps/website`'s tests use `// @vitest-environment happy-dom` (see any existing test file) — happy-dom's `Window` does expose a global `IntersectionObserver`, but it does not perform real layout/intersection computation, so tests must inject a fake observer constructor rather than relying on real intersection detection.

---

### Task 1: `revealOnScroll` utility (new, TDD)

**Files:**
- Create: `apps/website/src/scroll/revealOnScroll.ts`
- Test: `apps/website/test/revealOnScroll.test.ts`

**Interfaces:**
- Produces: `export interface RevealOnScrollDeps { intersectionObserverCtor?: typeof IntersectionObserver; matchMedia?: (query: string) => MediaQueryList }`, `export function initRevealOnScroll(root: ParentNode = document, deps: RevealOnScrollDeps = {}): void`. Task 2's rewritten `main.ts` calls `initRevealOnScroll()` with no arguments (production defaults).

- [ ] **Step 1: Write the failing tests**

`apps/website/test/revealOnScroll.test.ts`:
```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initRevealOnScroll } from "../src/scroll/revealOnScroll";

type ObserverCallback = (entries: Array<{ target: Element; isIntersecting: boolean }>, observer: FakeObserver) => void;

class FakeObserver {
  static instances: FakeObserver[] = [];
  callback: ObserverCallback;
  options: unknown;
  observed: Element[] = [];
  unobserved: Element[] = [];

  constructor(callback: ObserverCallback, options?: unknown) {
    this.callback = callback;
    this.options = options;
    FakeObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.push(el);
  }

  unobserve(el: Element): void {
    this.unobserved.push(el);
  }

  disconnect(): void {
    // no-op — nothing in this test suite needs disconnect behavior
  }
}

function fakeMatchMedia(matches: boolean): (query: string) => MediaQueryList {
  return () => ({ matches }) as MediaQueryList;
}

function renderRevealElements(count: number): HTMLElement[] {
  document.body.innerHTML = Array.from({ length: count }, (_, i) => `<div data-reveal id="r${i}"></div>`).join("");
  return Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
}

afterEach(() => {
  document.body.innerHTML = "";
  FakeObserver.instances = [];
  vi.restoreAllMocks();
});

describe("initRevealOnScroll", () => {
  it("observes every [data-reveal] element when motion is not reduced", () => {
    const elements = renderRevealElements(2);
    initRevealOnScroll(document, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(false),
    });
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]!.observed).toEqual(elements);
  });

  it("adds is-visible and unobserves an element the callback reports intersecting", () => {
    const [el] = renderRevealElements(1);
    initRevealOnScroll(document, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(false),
    });
    const observer = FakeObserver.instances[0]!;
    observer.callback([{ target: el!, isIntersecting: true }], observer);
    expect(el!.classList.contains("is-visible")).toBe(true);
    expect(observer.unobserved).toEqual([el]);
  });

  it("does not add is-visible for an entry reported as not intersecting", () => {
    const [el] = renderRevealElements(1);
    initRevealOnScroll(document, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(false),
    });
    const observer = FakeObserver.instances[0]!;
    observer.callback([{ target: el!, isIntersecting: false }], observer);
    expect(el!.classList.contains("is-visible")).toBe(false);
    expect(observer.unobserved).toEqual([]);
  });

  it("adds is-visible to every element immediately, without constructing an observer, when reduced motion is preferred", () => {
    const elements = renderRevealElements(3);
    initRevealOnScroll(document, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(true),
    });
    expect(FakeObserver.instances).toHaveLength(0);
    for (const el of elements) expect(el.classList.contains("is-visible")).toBe(true);
  });

  it("does nothing (constructs no observer) when there are no [data-reveal] elements", () => {
    document.body.innerHTML = "<div>no reveal elements here</div>";
    initRevealOnScroll(document, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(false),
    });
    expect(FakeObserver.instances).toHaveLength(0);
  });

  it("scopes to a given root instead of the whole document", () => {
    document.body.innerHTML = `<div data-reveal id="outside"></div><section id="scope"><div data-reveal id="inside"></div></section>`;
    const scope = document.getElementById("scope")!;
    initRevealOnScroll(scope, {
      intersectionObserverCtor: FakeObserver as unknown as typeof IntersectionObserver,
      matchMedia: fakeMatchMedia(false),
    });
    const observer = FakeObserver.instances[0]!;
    expect(observer.observed.map((el) => el.id)).toEqual(["inside"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter @openrupiv/website test -- revealOnScroll`
Expected: FAIL — `Cannot find module '../src/scroll/revealOnScroll'`.

- [ ] **Step 3: Implement `revealOnScroll.ts`**

`apps/website/src/scroll/revealOnScroll.ts`:
```ts
/**
 * Native, dependency-free scroll-reveal: adds `is-visible` to every
 * `[data-reveal]` element the first time it enters the viewport, then
 * stops observing it (one-shot — no re-trigger on scroll-back, avoiding
 * flicker). Replaces the previous GSAP ScrollTrigger-driven design.
 *
 * `prefers-reduced-motion: reduce` skips IntersectionObserver entirely and
 * makes every `[data-reveal]` element visible immediately — content is
 * always fully present, never gated behind a transition.
 */

export interface RevealOnScrollDeps {
  intersectionObserverCtor?: typeof IntersectionObserver;
  matchMedia?: (query: string) => MediaQueryList;
}

const REVEAL_SELECTOR = "[data-reveal]";
const VISIBLE_CLASS = "is-visible";
const INTERSECTION_THRESHOLD = 0.15;

export function initRevealOnScroll(root: ParentNode = document, deps: RevealOnScrollDeps = {}): void {
  const matchMediaFn = deps.matchMedia ?? ((query: string) => window.matchMedia(query));
  const elements = Array.from(root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));
  if (elements.length === 0) return;

  if (matchMediaFn("(prefers-reduced-motion: reduce)").matches) {
    for (const el of elements) el.classList.add(VISIBLE_CLASS);
    return;
  }

  const ObserverCtor = deps.intersectionObserverCtor ?? IntersectionObserver;
  const observer = new ObserverCtor(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).classList.add(VISIBLE_CLASS);
        obs.unobserve(entry.target);
      }
    },
    { threshold: INTERSECTION_THRESHOLD },
  );
  for (const el of elements) observer.observe(el);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @openrupiv/website test -- revealOnScroll`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/website/src/scroll/revealOnScroll.ts apps/website/test/revealOnScroll.test.ts
git commit -s -m "website: add dependency-free reveal-on-scroll utility"
```

---

### Task 2: Remove Three.js/GSAP, rewrite `main.ts`, drop the gsap license exception

**Files:**
- Delete: `apps/website/src/scene/NetworkScene.ts`
- Delete: `apps/website/src/scene/layouts.ts`
- Delete: `apps/website/src/scroll/scrollTimeline.ts`
- Delete: `apps/website/src/scroll/collectSections.ts`
- Delete: `apps/website/test/layouts.test.ts`
- Delete: `apps/website/test/collectSections.test.ts`
- Modify: `apps/website/src/main.ts`
- Modify: `apps/website/package.json`
- Modify: `scripts/check-licenses.mjs` (repo root)

**Interfaces:**
- Consumes: `initRevealOnScroll` (Task 1), `renderStatus` (existing, `apps/website/src/content/renderStatus.ts`, unchanged).
- Produces: nothing new — `main.ts` becomes the wiring point Task 3's `index.html` boots via its `<script type="module" src="/src/main.ts">` tag.

- [ ] **Step 1: Delete the Three.js/GSAP source and test files**

```bash
git rm apps/website/src/scene/NetworkScene.ts \
  apps/website/src/scene/layouts.ts \
  apps/website/src/scroll/scrollTimeline.ts \
  apps/website/src/scroll/collectSections.ts \
  apps/website/test/layouts.test.ts \
  apps/website/test/collectSections.test.ts
rmdir apps/website/src/scene 2>/dev/null || true
```

- [ ] **Step 2: Rewrite `main.ts`**

`apps/website/src/main.ts`:
```ts
import "./styles/main.css";
import { renderStatus } from "./content/renderStatus";
import { initRevealOnScroll } from "./scroll/revealOnScroll";

function main(): void {
  const statusContainer = document.getElementById("status-content");
  if (statusContainer) {
    void renderStatus(statusContainer);
  }
  initRevealOnScroll();
}

main();
```

- [ ] **Step 3: Remove `three`/`gsap` and their type packages from `package.json`**

`apps/website/package.json` — remove the `dependencies` block's `three` and `gsap` entries, and `devDependencies`' `@types/three` entry:
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
  "devDependencies": {
    "happy-dom": "^20.10.6",
    "vite": "^5.4.11"
  }
}
```

- [ ] **Step 4: Remove the now-unused gsap license exception**

In the repo root `scripts/check-licenses.mjs`, remove the `EXCEPTIONS` map and its usage entirely (it existed solely to unblock `gsap`, which no longer exists in the workspace after Step 3). The file should read:
```js
// Dependency license allowlist gate. Fails CI if any production dependency
// carries a license outside ALLOWED. Extend the list via PR — additions are
// a reviewable decision, not a local override.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

let raw;
try {
  raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
    encoding: "utf8",
  });
} catch (err) {
  // pnpm exits non-zero when there are no dependencies at all; treat a clean
  // "no packages" report as a pass, anything else as a real failure.
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  if (/No (licenses|packages)/i.test(out)) {
    console.log("license-check: no production dependencies yet — pass");
    process.exit(0);
  }
  console.error("license-check: failed to run `pnpm licenses list`");
  console.error(out);
  process.exit(1);
}

if (!raw.trim() || /No (licenses|packages)/i.test(raw)) {
  console.log("license-check: no production dependencies yet — pass");
  process.exit(0);
}

const report = JSON.parse(raw);
const violations = [];
for (const [license, pkgs] of Object.entries(report)) {
  if (ALLOWED.has(license)) continue;
  for (const pkg of pkgs) {
    violations.push(`${pkg.name}@${(pkg.versions ?? []).join(",")} — ${license}`);
  }
}

if (violations.length > 0) {
  console.error("license-check: disallowed licenses found:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("license-check: all production dependency licenses allowed — pass");
```

- [ ] **Step 5: Reinstall so the lockfile drops `three`/`gsap`**

Run: `corepack pnpm install`
Expected: pnpm updates `pnpm-lock.yaml`, removing `three`/`gsap`/`@types/three` entries. Commit the updated lockfile in this task's commit.

- [ ] **Step 6: Run the license check for real**

Run: `pnpm check-licenses`
Expected: `license-check: all production dependency licenses allowed — pass` (gsap's non-OSI license is no longer present to trigger the old exception).

- [ ] **Step 7: Typecheck (expect it to fail until Task 3 updates `index.html`'s IDs — that's fine, note and proceed)**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: PASS — `main.ts` no longer references any deleted module, and nothing here depends on `index.html`'s contents.

- [ ] **Step 8: Run the test suite**

Run: `corepack pnpm --filter @openrupiv/website test`
Expected: PASS — `revealOnScroll.test.ts`, `renderStatus.test.ts`, `build-status.test.ts` all still pass; `layouts.test.ts`/`collectSections.test.ts` are gone, not failing.

- [ ] **Step 9: Commit**

```bash
git add apps/website/src/main.ts apps/website/package.json pnpm-lock.yaml scripts/check-licenses.mjs
git commit -s -m "website: remove three.js/gsap, wire main.ts to revealOnScroll"
```

---

### Task 3: Rewrite `index.html` — pain-point copy, icons, roadmap chips

**Files:**
- Modify: `apps/website/index.html`

**Interfaces:**
- Consumes: `main.ts`'s `#status-content` element id (unchanged) and `revealOnScroll`'s `[data-reveal]` selector (Task 1) — every `.section` gets a `data-reveal` attribute.
- Produces: the final DOM structure Task 4's CSS targets (`.hero-blob`, `.pain-section`, `.pain-icon`, `.roadmap-grid`, `.roadmap-chip`, `.chip-label` class names used here must match Task 4's selectors exactly).

- [ ] **Step 1: Rewrite `index.html`**

`apps/website/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>openRupiv — the enterprise features are the free features</title>
    <link rel="stylesheet" href="/src/styles/main.css" />
  </head>
  <body>
    <main id="page">
      <section id="hero" class="section hero-section" data-reveal>
        <div class="panel">
          <h1>openRupiv</h1>
          <p class="lede">
            An Apache-2.0, enterprise-ready, agent-native app development
            platform where the enterprise features are the free features.
          </p>
          <p>
            Built to be the app platform you'd actually enjoy trusting with
            your compliance requirements.
          </p>
        </div>
      </section>

      <section id="pillar-sso" class="section pain-section pain-section-1" data-reveal>
        <div class="panel">
          <svg class="pain-icon" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M32 6 L54 14 V30 C54 46 44 56 32 60 C20 56 10 46 10 30 V14 Z" fill="#fff" fill-opacity="0.92"/>
            <path d="M22 32 L29 39 L43 24" stroke="#e8542f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
          <h2>Sick of paying an enterprise tax for SSO?</h2>
          <p>
            SAML, OIDC, SCIM, RBAC/ABAC, audit logs, HA, and an air-gap
            installer — all in the Apache-2.0 core. Not an "enterprise
            edition."
          </p>
        </div>
      </section>

      <section id="pillar-git" class="section pain-section pain-section-2" data-reveal>
        <div class="panel">
          <svg class="pain-icon" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="16" cy="14" r="7" fill="#fff" fill-opacity="0.92"/>
            <circle cx="16" cy="50" r="7" fill="#fff" fill-opacity="0.92"/>
            <circle cx="48" cy="32" r="7" fill="#fff" fill-opacity="0.92"/>
            <path d="M16 21 V43" stroke="#0d9488" stroke-width="5" stroke-linecap="round"/>
            <path d="M16 30 C16 30 30 30 30 30 C39 30 40 31 41 32" stroke="#0d9488" stroke-width="5" stroke-linecap="round" fill="none"/>
          </svg>
          <h2>Tired of your app's real behavior living only in someone's head?</h2>
          <p>
            Describe an app in natural language, get a reviewable
            declarative spec plus generated code in a Git repo. Change
            management is a pull request. Delete the platform and your apps
            are still readable code.
          </p>
        </div>
      </section>

      <section id="pillar-compliance" class="section pain-section pain-section-3" data-reveal>
        <div class="panel">
          <svg class="pain-icon" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="26" r="18" fill="#fff" fill-opacity="0.92"/>
            <path d="M24 26 L30 32 L41 19" stroke="#9333ea" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            <path d="M22 40 L18 58 L32 50 L46 58 L42 40" fill="#fff" fill-opacity="0.92"/>
          </svg>
          <h2>Compliance evidence shouldn't be a fire drill</h2>
          <p>
            Hash-chained audit log, SIEM export, and generated EU AI Act /
            GDPR artifacts — emitted from runtime metadata, not assembled by
            hand.
          </p>
        </div>
      </section>

      <section id="pillar-agents" class="section pain-section pain-section-4" data-reveal>
        <div class="panel">
          <svg class="pain-icon" viewBox="0 0 64 64" aria-hidden="true">
            <rect x="16" y="20" width="32" height="26" rx="10" fill="#fff" fill-opacity="0.92"/>
            <circle cx="26" cy="33" r="4" fill="#0284c7"/>
            <circle cx="38" cy="33" r="4" fill="#0284c7"/>
            <path d="M32 20 V10" stroke="#fff" stroke-opacity="0.92" stroke-width="5" stroke-linecap="round"/>
            <circle cx="32" cy="7" r="4" fill="#fff" fill-opacity="0.92"/>
          </svg>
          <h2>Want AI agents that actually ask permission first?</h2>
          <p>
            Agents are governed workers with identity, policy, and
            human-in-the-loop gates. MCP client + server and A2A from v1.
          </p>
        </div>
      </section>

      <section id="roadmap" class="section" data-reveal>
        <div class="panel">
          <h2>Roadmap</h2>
          <div class="roadmap-grid">
            <div class="roadmap-chip">
              <span class="chip-label">Phase 0</span>
              <p>Pre-flight — name, license, repo scaffold.</p>
            </div>
            <div class="roadmap-chip">
              <span class="chip-label">Phase 1</span>
              <p>Core — app spec, CLI + generator, TypeScript runtime, OIDC from day one.</p>
            </div>
            <div class="roadmap-chip roadmap-chip-current">
              <span class="chip-label">Phase 2 — in progress</span>
              <p>Agents + policy + audit — agent runtime, MCP client/server, A2A, OPA policy engine, hash-chained audit log, RBAC, HITL gates.</p>
            </div>
            <div class="roadmap-chip">
              <span class="chip-label">Phase 3</span>
              <p>Enterprise identity &amp; ops — SAML, SCIM, Helm/HA, OTel, secrets, sandbox hardening.</p>
            </div>
            <div class="roadmap-chip">
              <span class="chip-label">Phase 4</span>
              <p>Compliance packs — GDPR + EU AI Act packs, Annex IV / RoPA / DPIA generators.</p>
            </div>
            <div class="roadmap-chip">
              <span class="chip-label">Phase 5</span>
              <p>Ecosystem — migration tooling, community connectors.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="status" class="section" data-reveal>
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
</html>
```

- [ ] **Step 2: Typecheck and test (should be unaffected, but confirm)**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test`
Expected: both PASS — this task only changes static markup, no `.ts` file.

- [ ] **Step 3: Commit**

```bash
git add apps/website/index.html
git commit -s -m "website: rewrite content around pain-point framing, add reveal markup"
```

---

### Task 4: Rewrite `main.css` — warm palette, rounded shapes, gradients, blobs

**Files:**
- Modify: `apps/website/src/styles/main.css`

**Interfaces:**
- Consumes: exact class names from Task 3's `index.html` (`.hero-section`, `.pain-section`, `.pain-section-1`..`.pain-section-4`, `.pain-icon`, `.roadmap-grid`, `.roadmap-chip`, `.roadmap-chip-current`, `.chip-label`, `[data-reveal]`/`.is-visible` from Task 1) and the existing, unchanged classes `renderStatus.ts` emits (`.status-section`, `.status-shipped`, `.status-in_progress`, `.status-planned`, `.status-not_planned`).

- [ ] **Step 1: Rewrite `main.css`**

`apps/website/src/styles/main.css`:
```css
:root {
  color-scheme: light;
  --bg: #fdf6ec;
  --fg: #2d2a26;
  --fg-soft: #6b6459;
  --accent: #e8542f;
  --radius-lg: 28px;
  --radius-md: 16px;
  --radius-pill: 999px;
  --shadow-soft: 0 8px 24px rgba(45, 42, 38, 0.1);

  --gradient-1: linear-gradient(135deg, #ff9a76 0%, #ffce54 100%);
  --gradient-2: linear-gradient(135deg, #4fd1c5 0%, #a3e635 100%);
  --gradient-3: linear-gradient(135deg, #a78bfa 0%, #f472b6 100%);
  --gradient-4: linear-gradient(135deg, #60c8ff 0%, #34d399 100%);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, -apple-system, sans-serif;
}

#page {
  position: relative;
}

.section {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
  position: relative;
  overflow: hidden;
}

.panel {
  max-width: 640px;
  position: relative;
  z-index: 1;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(6px);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-soft);
  padding: 2.5rem;
}

.hero-section .panel {
  background: rgba(255, 255, 255, 0.7);
  text-align: center;
}

.lede {
  font-size: 1.25rem;
  font-weight: 700;
}

/* Pain-point sections: full-viewport gradient background, blob accent, icon */
.pain-section-1 { background: var(--gradient-1); }
.pain-section-2 { background: var(--gradient-2); }
.pain-section-3 { background: var(--gradient-3); }
.pain-section-4 { background: var(--gradient-4); }

.pain-section::before {
  content: "";
  position: absolute;
  z-index: 0;
  width: 480px;
  height: 480px;
  border-radius: 42% 58% 65% 35% / 45% 45% 55% 55%;
  background: rgba(255, 255, 255, 0.18);
  top: -140px;
  right: -140px;
}

.pain-section::after {
  content: "";
  position: absolute;
  z-index: 0;
  width: 320px;
  height: 320px;
  border-radius: 58% 42% 35% 65% / 55% 55% 45% 45%;
  background: rgba(255, 255, 255, 0.14);
  bottom: -100px;
  left: -100px;
}

.pain-icon {
  width: 64px;
  height: 64px;
  margin-bottom: 1rem;
}

.pain-section .panel {
  background: rgba(255, 255, 255, 0.28);
  color: #1f1c19;
}

/* Reveal-on-scroll (revealOnScroll.ts) */
[data-reveal] {
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.4s ease-out, transform 0.4s ease-out;
}

[data-reveal].is-visible {
  opacity: 1;
  transform: translateY(0);
}

/* Roadmap: rounded chip grid */
.roadmap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.roadmap-chip {
  background: #fff;
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  box-shadow: var(--shadow-soft);
}

.roadmap-chip p {
  margin: 0.5rem 0 0;
  font-size: 0.9rem;
  color: var(--fg-soft);
}

.chip-label {
  display: inline-block;
  background: var(--bg);
  color: var(--accent);
  font-weight: 700;
  font-size: 0.8rem;
  padding: 0.25rem 0.75rem;
  border-radius: var(--radius-pill);
}

.roadmap-chip-current {
  background: var(--accent);
}

.roadmap-chip-current .chip-label {
  background: rgba(255, 255, 255, 0.85);
}

.roadmap-chip-current p {
  color: rgba(255, 255, 255, 0.92);
}

/* Status section: reskin the existing renderStatus.ts markup as rounded cards */
.status-note {
  font-size: 0.875rem;
  opacity: 0.75;
}

.status-section {
  background: #fff;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-soft);
  padding: 1.25rem 1.5rem;
  margin-bottom: 1rem;
}

.status-section h4 {
  margin-bottom: 0.25rem;
  color: var(--accent);
}

.status-section ul {
  margin: 0;
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

@media (max-width: 640px) {
  .pain-section::before,
  .pain-section::after {
    display: none;
  }
  .panel {
    padding: 1.75rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 2: Typecheck and test (unaffected by a CSS-only change, confirm nothing broke)**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test`
Expected: both PASS.

- [ ] **Step 3: Build and manually verify in a real browser**

Run: `corepack pnpm --filter @openrupiv/website build && corepack pnpm --filter @openrupiv/website preview`
Then open the printed local URL in a real browser and confirm:
- Warm off-white background, four distinct gradient pain-point sections, rounded panels/blobs visible.
- Each section fades/rises into view as you scroll to it.
- Toggle OS-level "reduce motion" (or use browser devtools' rendering-emulation panel) and reload: every section is immediately fully visible, no fade-in.
- Resize to a narrow (mobile) viewport: layout doesn't overflow horizontally, blob accents disappear per the `@media (max-width: 640px)` rule, roadmap grid collapses to fewer columns.
- Status section renders as rounded white cards grouped by section, each item's detail text visible (this is the fix already shipped in PR #6 — confirm it's still intact after the CSS rewrite).

- [ ] **Step 4: Commit**

```bash
git add apps/website/src/styles/main.css
git commit -s -m "website: warm palette, rounded shapes, gradient sections, blob accents"
```

---

### Task 5: Update README, final full verification

**Files:**
- Modify: `apps/website/README.md`

**Interfaces:** None — documentation and verification only.

- [ ] **Step 1: Check the current README for stale references**

Run: `grep -n "three\|gsap\|NetworkScene\|scrollTimeline\|collectSections\|layouts\.ts\|ScrollTrigger" apps/website/README.md`

- [ ] **Step 2: Update any matched lines**

Replace any description of the Three.js/GSAP scroll-driven scene with a short description of the redesign: static warm/rounded pain-point sections revealed via `revealOnScroll.ts` (native `IntersectionObserver`, no dependencies), keeping the existing "Honesty constraint" section describing `build-status.ts`/`renderStatus.ts` exactly as-is (that part of the README is still accurate and untouched by this redesign).

- [ ] **Step 3: Run the full package verification**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test && corepack pnpm --filter @openrupiv/website build`
Expected: all PASS, build produces `apps/website/dist`.

- [ ] **Step 4: Run the full monorepo check (confirm no cross-package regression)**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm check-licenses`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/website/README.md
git commit -s -m "website: update README for the dependency-free redesign"
```

- [ ] **Step 6: Push and confirm the `deploy-pages` CI job builds this redesign successfully**

Push the branch, open a PR, and confirm `Typecheck · lint · test`, `License allowlist`, and (once merged to `main`) `Deploy website to GitHub Pages` all report green — this is a public-facing static site, so a real green deploy is the actual proof of done, not just local `vite build` succeeding.
