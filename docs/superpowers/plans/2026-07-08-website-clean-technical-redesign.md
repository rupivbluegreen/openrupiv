# Website Clean/Technical Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/website`'s warm/gradient visual system with a clean, monospace/serif, illustrative-mockup-driven design per `docs/superpowers/specs/2026-07-08-website-clean-technical-redesign-design.md`, and fix the "insanely text heavy" Status section with per-category `<details>` disclosure.

**Architecture:** `renderStatus.ts` gains category-level shipped/in-progress/planned counts (computed from the same parsed data, no new data source) and renders each category as a collapsed-by-default `<details>`. `index.html` gets a hero prompt-mockup + CTA, corrected pain-point copy for two sections, small illustrative mockups per pain-point, an FAQ accordion (native `<details>`), and a horizontal roadmap pipeline. `main.css` is fully rewritten: new palette/typography, flat cards instead of gradients/blobs, and styles for every new component.

**Tech Stack:** TypeScript (strict), Vite, Vitest + `happy-dom`, plain CSS, native HTML `<details>`/`<summary>` (zero new JS).

## Global Constraints

- No new dependencies of any kind (no webfont, no icon library, no JS accordion library — native `<details>` handles both FAQ and Status disclosure).
- `build-status.ts` (the parser) is **not modified** — only `renderStatus.ts`'s rendering/grouping logic changes. The counts shown must always be computed from the same `ReadinessItem[]` array already in memory; never a second, separately-maintained number.
- Pain-point section mockups (badge rows, code-split, proposal card) are **illustrative only** — no ✅/🚧/📋 semantics, no styling that implies a live status claim. The Status section remains the only place real capability claims live (CLAUDE.md #7).
- While rewriting pain-point copy, fix the two pre-existing overclaims (SSO, compliance) per the design doc's exact replacement text below — do not invent different wording.
- `revealOnScroll.ts` and its `.js`-class-gated CSS rule are unchanged; `data-reveal` stays on each top-level `<section>` only.
- Every commit: `git commit -s` (DCO).
- Test: `corepack pnpm --filter @openrupiv/website test`. Typecheck: `corepack pnpm --filter @openrupiv/website typecheck`.
- Exact class names below are binding across tasks — Task 2 (HTML) and Task 3 (CSS) must match Task 1's and each other's class names exactly, since they're written and reviewed as separate tasks.

---

### Task 1: `renderStatus.ts` — per-category counts + `<details>` disclosure

**Files:**
- Modify: `apps/website/src/content/renderStatus.ts`
- Modify: `apps/website/test/renderStatus.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: rendered markup shape `<details class="status-category"><summary><span class="status-category-name">...</span><span class="status-counts"><span class="status-count status-count-{level}">N {label}</span>...</span></summary><ul class="status-detail-list">...</ul></details>` — one per section, `<details>` without an `open` attribute (collapsed by default). Task 3 (CSS) styles exactly these class names.

- [ ] **Step 1: Write the failing/updated tests**

Replace `apps/website/test/renderStatus.test.ts` in full:
```ts
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
});
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `corepack pnpm --filter @openrupiv/website test -- renderStatus`
Expected: FAIL — the "groups items by section" test fails (no `.status-category-name` exists yet), and the three new tests fail (no `.status-category`/`.status-count` elements exist yet). The other 3 pre-existing tests still pass unchanged (detail rendering/escaping/fallback logic isn't touched by this task).

- [ ] **Step 3: Implement the updated `renderStatus.ts`**

Replace `apps/website/src/content/renderStatus.ts` in full:
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

const COUNT_LABEL: Record<ReadinessLevel, string> = {
  shipped: "shipped",
  in_progress: "in progress",
  planned: "planned",
  not_planned: "not planned",
};

const LEVEL_ORDER: ReadinessLevel[] = ["shipped", "in_progress", "planned", "not_planned"];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tallies items by level -- the ONLY source for the summary counts rendered
 * in each category's <summary>, so the counts can never drift from the
 * detailed per-item list rendered inside the same <details>. */
function countByLevel(items: ReadinessItem[]): Record<ReadinessLevel, number> {
  const counts: Record<ReadinessLevel, number> = { shipped: 0, in_progress: 0, planned: 0, not_planned: 0 };
  for (const item of items) counts[item.level] += 1;
  return counts;
}

/** Renders one pill per level with at least one item, in a fixed order; a
 * category with zero items at a given level shows no pill for it at all. */
function renderCounts(counts: Record<ReadinessLevel, number>): string {
  return LEVEL_ORDER.filter((level) => counts[level] > 0)
    .map((level) => `<span class="status-count status-count-${level}">${counts[level]} ${COUNT_LABEL[level]}</span>`)
    .join("");
}

/**
 * Fetches the build-time-generated status.json and renders it as one
 * collapsed-by-default <details> per section, each summarizing its
 * shipped/in-progress/planned counts and expanding to the full detail list.
 */
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
    .map(([section, sectionItems]) => {
      const counts = countByLevel(sectionItems);
      const detailItems = sectionItems
        .map(
          (item) =>
            `<li class="status-${item.level}"><strong>${escapeHtml(item.requirement)}:</strong> ${LEVEL_LABEL[item.level]}${
              item.detail ? ` — ${escapeHtml(item.detail)}` : ""
            }</li>`,
        )
        .join("");
      return `
        <details class="status-category">
          <summary>
            <span class="status-category-name">${escapeHtml(section)}</span>
            <span class="status-counts">${renderCounts(counts)}</span>
          </summary>
          <ul class="status-detail-list">${detailItems}</ul>
        </details>
      `;
    })
    .join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `corepack pnpm --filter @openrupiv/website test -- renderStatus`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm --filter @openrupiv/website typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/website/src/content/renderStatus.ts apps/website/test/renderStatus.test.ts
git commit -s -m "website: render status as collapsed-by-default per-category details with counts"
```

---

### Task 2: `index.html` — hero mockup+CTA, corrected pain-point copy, illustrative mockups, FAQ accordion, roadmap pipeline

**Files:**
- Modify: `apps/website/index.html`

**Interfaces:**
- Produces: every class name Task 3's CSS must target — `.prompt-mock`, `.prompt-mock-line`, `.prompt-mock-label`, `.prompt-mock-result`, `.hero-cta`, `.btn-primary`, `.btn-secondary`, `.mock-badges`/`.mock-badge`, `.mock-code-split`/`.mock-code-col`/`.mock-code-label`/`.mock-file-list`, `.mock-proposal-card`/`.mock-proposal-title`/`.mock-proposal-status`, `.faq-list`/`.faq-item` (now `<details>`), `.phase-pipeline`/`.phase-step`/`.phase-pill`/`.phase-pill-current`/`.phase-caption`.
- Consumes: `#status-content` (unchanged, Task 1's `renderStatus` targets it) and `data-reveal` (Task 1 of the *original* redesign, `revealOnScroll.ts`, unchanged).

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
          <div class="prompt-mock">
            <p class="prompt-mock-line">
              <span class="prompt-mock-label">You</span>
              describe an approval workflow with 4-eyes review
            </p>
            <p class="prompt-mock-line prompt-mock-result">
              <span class="prompt-mock-label">openRupiv</span>
              spec.json + migration + tests, committed
            </p>
          </div>
          <h1>openRupiv</h1>
          <p class="lede">
            An Apache-2.0, enterprise-ready, agent-native app development
            platform where the enterprise features are the free features.
          </p>
          <div class="hero-cta">
            <a class="btn-primary" href="https://github.com/rupivbluegreen/openrupiv#quickstart">Get started</a>
            <a class="btn-secondary" href="#status">See what's shipped today &rarr;</a>
          </div>
        </div>
      </section>

      <section id="pillar-sso" class="section pain-section" data-reveal>
        <div class="panel">
          <h2>Sick of paying an enterprise tax for SSO?</h2>
          <p>
            OIDC-based SSO ships today; SAML, SCIM, and HA are next on the
            roadmap — all landing in the same Apache-2.0 core, never an
            "enterprise edition."
          </p>
          <div class="mock-badges">
            <span class="mock-badge">OIDC</span>
            <span class="mock-badge">SAML</span>
            <span class="mock-badge">SCIM</span>
            <span class="mock-badge">RBAC/ABAC</span>
          </div>
        </div>
      </section>

      <section id="pillar-git" class="section pain-section" data-reveal>
        <div class="panel">
          <h2>Tired of your app's real behavior living only in someone's head?</h2>
          <p>
            Describe an app in natural language, get a reviewable
            declarative spec plus generated code in a Git repo. Change
            management is a pull request. Delete the platform and your apps
            are still readable code.
          </p>
          <div class="mock-code-split">
            <div class="mock-code-col">
              <span class="mock-code-label">spec.json</span>
              <ul class="mock-file-list">
                <li>entities</li>
                <li>workflows</li>
                <li>roles</li>
              </ul>
            </div>
            <div class="mock-code-col">
              <span class="mock-code-label">generated/</span>
              <ul class="mock-file-list">
                <li>migration.sql</li>
                <li>runtime.ts</li>
                <li>spec.test.ts</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section id="pillar-compliance" class="section pain-section" data-reveal>
        <div class="panel">
          <h2>Compliance evidence shouldn't be a fire drill</h2>
          <p>
            A hash-chained audit log and policy-checked access ship today.
            Generated EU AI Act / GDPR artifacts are on the roadmap, built
            from the same runtime metadata, not assembled by hand.
          </p>
          <div class="mock-badges">
            <span class="mock-badge">Audit log</span>
            <span class="mock-badge">Policy checks</span>
            <span class="mock-badge">SIEM export</span>
          </div>
        </div>
      </section>

      <section id="pillar-agents" class="section pain-section" data-reveal>
        <div class="panel">
          <h2>Want AI agents that actually ask permission first?</h2>
          <p>
            Agents are governed workers with identity, policy, and
            human-in-the-loop gates. MCP client + server and A2A from v1.
          </p>
          <div class="mock-proposal-card">
            <span class="mock-proposal-title">Agent proposal — vendor onboarding</span>
            <span class="mock-proposal-status">Awaiting human approval</span>
          </div>
        </div>
      </section>

      <section id="faq" class="section" data-reveal>
        <div class="panel">
          <h2>What people ask us first</h2>
          <div class="faq-list">
            <details class="faq-item">
              <summary>Where does our data live?</summary>
              <p>
                Wherever you run it. openRupiv is self-hosted — apps,
                database, and the audit trail all live on your
                infrastructure. There's no SaaS backend of ours in the loop.
              </p>
            </details>
            <details class="faq-item">
              <summary>Who can see what?</summary>
              <p>
                Every read and write is policy-checked against a
                deny-by-default RBAC/ABAC engine before it happens, and the
                decision is logged — not just the action.
              </p>
            </details>
            <details class="faq-item">
              <summary>What if something gets deleted or edited after the fact?</summary>
              <p>
                The audit log is hash-chained — tamper-evident by
                construction, not by promise. If a record's hash doesn't
                match, that's detectable, not deniable.
              </p>
            </details>
            <details class="faq-item">
              <summary>Can an agent take action without a human signing off?</summary>
              <p>
                No. Agents can only propose — every state-changing action
                still requires human approval through the same gates a
                person would use.
              </p>
            </details>
            <details class="faq-item">
              <summary>What happens if we stop using openRupiv?</summary>
              <p>
                Nothing dramatic — it's Apache-2.0 and apps are Git-native: a
                spec plus deterministically-generated code sitting in your
                own repo. Uninstall the runtime and the code still runs.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section id="roadmap" class="section" data-reveal>
        <div class="panel">
          <h2>Roadmap</h2>
          <div class="phase-pipeline">
            <div class="phase-step">
              <span class="phase-pill">Phase 0</span>
              <p class="phase-caption">Pre-flight — name, license, repo scaffold.</p>
            </div>
            <div class="phase-step">
              <span class="phase-pill">Phase 1</span>
              <p class="phase-caption">Core — app spec, CLI + generator, TypeScript runtime, OIDC from day one.</p>
            </div>
            <div class="phase-step phase-step-current">
              <span class="phase-pill phase-pill-current">Phase 2 — in progress</span>
              <p class="phase-caption">Agents + policy + audit — agent runtime, MCP client/server, A2A, OPA policy engine, hash-chained audit log, RBAC, HITL gates.</p>
            </div>
            <div class="phase-step">
              <span class="phase-pill">Phase 3</span>
              <p class="phase-caption">Enterprise identity &amp; ops — SAML, SCIM, Helm/HA, OTel, secrets, sandbox hardening.</p>
            </div>
            <div class="phase-step">
              <span class="phase-pill">Phase 4</span>
              <p class="phase-caption">
                Compliance packs — GDPR + EU AI Act packs, Annex IV / RoPA /
                DPIA generators, per-app identification and compliance
                verification.
              </p>
            </div>
            <div class="phase-step">
              <span class="phase-pill">Phase 5</span>
              <p class="phase-caption">
                Ecosystem — Postgres, REST/OpenAPI, webhooks,
                S3-compatible storage, and SMTP connectors (any MCP server
                works too), migration tooling, and a showcase self-healing
                operations agent built on the existing propose()/HITL gate.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="status" class="section" data-reveal>
        <div class="panel">
          <h2>What's real today</h2>
          <p class="status-note">
            Generated from this project's own honest capability ledger —
            never claimed ahead of it. Click a category for the full detail.
          </p>
          <div id="status-content"></div>
        </div>
      </section>
    </main>
    <footer class="site-footer">
      <ul class="footer-links">
        <li><a href="https://github.com/rupivbluegreen/openrupiv">GitHub</a></li>
        <li><a href="https://github.com/rupivbluegreen/openrupiv/blob/main/PLAN.md">Plan</a></li>
        <li>
          <a href="https://github.com/rupivbluegreen/openrupiv/blob/main/ENTERPRISE_READINESS.md"
            >Enterprise readiness</a
          >
        </li>
        <li><a href="https://github.com/rupivbluegreen/openrupiv/blob/main/LICENSE">Apache-2.0 license</a></li>
      </ul>
    </footer>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Note: the four `pain-section-N` gradient classes and the `pain-icon` SVGs are gone (replaced by the flat `pain-section` class and the illustrative mockups above) — this is intentional, matching the design doc's removal of the gradient system.

- [ ] **Step 2: Typecheck and test (unaffected by a markup-only change)**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test`
Expected: both PASS (Task 1's 8 `renderStatus` tests + the unaffected `revealOnScroll`/`build-status` suites).

- [ ] **Step 3: Commit**

```bash
git add apps/website/index.html
git commit -s -m "website: hero mockup+CTA, corrected pain-point copy, illustrative mockups, FAQ accordion, roadmap pipeline"
```

---

### Task 3: `main.css` — new palette, typography, and every new component's styling

**Files:**
- Modify: `apps/website/src/styles/main.css`

**Interfaces:**
- Consumes: every class name Task 1 and Task 2 produced (listed in their Interfaces sections above) — this task's only job is styling them.

- [ ] **Step 1: Rewrite `main.css`**

`apps/website/src/styles/main.css`:
```css
:root {
  color-scheme: light;
  --bg: #fafbfc;
  --fg: #14161a;
  --fg-soft: #5b6472;
  --accent: #3b5bfd;
  --accent-soft: #eef1ff;
  --border: #e4e7ec;
  --radius-lg: 16px;
  --radius-md: 10px;
  --radius-pill: 999px;
  --shadow-card: 0 1px 2px rgba(20, 22, 26, 0.05), 0 4px 12px rgba(20, 22, 26, 0.04);
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --font-serif: Georgia, "Times New Roman", Times, serif;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-serif);
}

h1, h2, h3, h4, .prompt-mock-label, .phase-pill, .chip-label {
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: -0.01em;
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
}

.panel {
  max-width: 640px;
  width: 100%;
  position: relative;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 2.5rem;
}

.hero-section .panel {
  text-align: center;
}

.lede {
  font-size: 1.25rem;
  font-weight: 700;
  font-family: var(--font-mono);
}

/* Hero: prompt-mockup */
.prompt-mock {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 0.9rem;
}

.prompt-mock-line {
  margin: 0;
  color: var(--fg-soft);
}

.prompt-mock-result {
  color: var(--fg);
}

.prompt-mock-label {
  display: inline-block;
  color: var(--accent);
  margin-right: 0.5rem;
}

.hero-cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  margin-top: 1.5rem;
  flex-wrap: wrap;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  text-decoration: none;
  padding: 0.65rem 1.5rem;
  border-radius: var(--radius-pill);
}

.btn-secondary {
  color: var(--accent);
  text-decoration: none;
  font-weight: 700;
}

.btn-primary:hover,
.btn-primary:focus-visible {
  opacity: 0.9;
}

.btn-secondary:hover,
.btn-secondary:focus-visible {
  text-decoration: underline;
}

/* Pain-point sections: flat, no gradients */
.pain-section .panel {
  text-align: left;
}

/* Illustrative mockups (badges, code split, proposal card) --
   decorative concept diagrams, never a status claim (see design doc's
   CLAUDE.md #7 "hard line": real claims live only in .status-* below). */
.mock-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.mock-badge {
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 700;
  padding: 0.3rem 0.75rem;
  border-radius: var(--radius-pill);
}

.mock-code-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-top: 1.25rem;
}

.mock-code-col {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
}

.mock-code-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 0.5rem;
}

.mock-file-list {
  margin: 0;
  padding-left: 1.1rem;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--fg-soft);
}

.mock-proposal-card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  margin-top: 1.25rem;
}

.mock-proposal-title {
  font-weight: 700;
}

.mock-proposal-status {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: var(--accent);
}

/* Reveal-on-scroll (revealOnScroll.ts) -- unchanged mechanism */
.js [data-reveal] {
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.4s ease-out, transform 0.4s ease-out;
}

[data-reveal].is-visible {
  opacity: 1;
  transform: translateY(0);
}

/* FAQ: native <details> accordion */
.faq-list {
  margin: 1.5rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.faq-item {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
}

.faq-item summary {
  cursor: pointer;
  font-weight: 700;
  list-style: none;
}

.faq-item summary::-webkit-details-marker {
  display: none;
}

.faq-item summary::before {
  content: "+ ";
  color: var(--accent);
  font-family: var(--font-mono);
}

.faq-item[open] summary::before {
  content: "\2212 ";
}

.faq-item p {
  margin: 0.75rem 0 0;
  color: var(--fg-soft);
}

/* Roadmap: horizontal phase pipeline */
.phase-pipeline {
  display: flex;
  gap: 1.5rem;
  margin-top: 1.5rem;
  padding-bottom: 0.5rem;
  overflow-x: auto;
  border-top: 2px solid var(--border);
}

.phase-step {
  flex: 0 0 200px;
  padding-top: 1rem;
}

.phase-pill {
  display: inline-block;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.75rem;
  padding: 0.25rem 0.75rem;
  border-radius: var(--radius-pill);
}

.phase-pill-current {
  background: var(--accent);
  color: #fff;
}

.phase-caption {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--fg-soft);
}

/* Status section: per-category <details> with count pills */
.status-note {
  font-size: 0.875rem;
  color: var(--fg-soft);
}

.status-category {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1rem 1.25rem;
  margin-bottom: 0.75rem;
}

.status-category summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.status-category summary::-webkit-details-marker {
  display: none;
}

.status-category-name {
  font-weight: 700;
  font-family: var(--font-mono);
}

.status-counts {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.status-count {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.6rem;
  border-radius: var(--radius-pill);
}

.status-count-shipped {
  background: #e6f6ec;
  color: #1a7f37;
}

.status-count-in_progress {
  background: #fff4e0;
  color: #9a6700;
}

.status-count-planned {
  background: var(--accent-soft);
  color: var(--accent);
}

.status-count-not_planned {
  background: #fdeeee;
  color: #cf222e;
}

.status-detail-list {
  margin: 1rem 0 0;
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

/* Footer */
.site-footer {
  padding: 2rem 1.5rem 3rem;
  text-align: center;
}

.footer-links {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem 0.25rem;
  margin: 0;
  padding: 0;
}

.footer-links li + li::before {
  content: "·";
  color: var(--fg-soft);
  margin: 0 0.5rem;
}

.footer-links a {
  color: var(--fg-soft);
  font-size: 0.875rem;
  text-decoration: none;
  border-radius: var(--radius-pill);
  padding: 0.25rem 0.5rem;
  transition: color 0.2s ease-out, background 0.2s ease-out;
}

.footer-links a:hover,
.footer-links a:focus-visible {
  color: var(--accent);
  background: var(--accent-soft);
}

@media (max-width: 640px) {
  .panel {
    padding: 1.75rem;
  }
  .mock-code-split {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}
```

- [ ] **Step 2: Typecheck and test (unaffected by a CSS-only change)**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test`
Expected: both PASS.

- [ ] **Step 3: Build and manually verify in a real browser**

Run: `corepack pnpm --filter @openrupiv/website build && corepack pnpm --filter @openrupiv/website preview`
Use the `gstack` skill (Playwright's Chrome channel isn't installed in this environment) to open the printed local URL and confirm:
- Flat white/light-gray cards, no gradients or blob shapes anywhere.
- Monospace headlines, serif body text, one blue accent color.
- Hero shows the prompt-mockup box and both CTA buttons; "Get started" links to the GitHub quickstart, "See what's shipped today" anchor-scrolls to `#status`.
- Each pain-point section shows its illustrative mockup (badge row, code-split, or proposal card) with no ✅/🚧/📋 markers anywhere outside the Status section.
- FAQ items are collapsed by default and expand/collapse on click (no JS errors in console).
- Roadmap renders as a horizontal pill pipeline; narrow the viewport and confirm it scrolls horizontally without breaking the rest of the layout.
- Status section shows compact per-category cards with count pills; click one and confirm it expands to the full detail list (including `item.detail` text), collapsed again on a second click.
- Reveal-on-scroll still works (scroll through the page, confirm sections fade/rise into view).

- [ ] **Step 4: Commit**

```bash
git add apps/website/src/styles/main.css
git commit -s -m "website: clean/technical visual system — palette, typography, all new component styles"
```

---

### Task 4: README update, final full verification

**Files:**
- Modify: `apps/website/README.md` (if it references the old gradient/pain-icon design)

**Interfaces:** None — documentation and verification only.

- [ ] **Step 1: Check the current README for stale references**

Run: `grep -n "gradient\|pain-icon\|blob\|rounded card" apps/website/README.md`

- [ ] **Step 2: Update any matched lines**

Replace any description of the warm/gradient/rounded visual system with a short, accurate description of the current one: monospace/serif type pairing, flat cards, illustrative mockups, native `<details>` for FAQ and per-category status disclosure.

- [ ] **Step 3: Run the full package verification**

Run: `corepack pnpm --filter @openrupiv/website typecheck && corepack pnpm --filter @openrupiv/website test && corepack pnpm --filter @openrupiv/website build`
Expected: all PASS, build produces `apps/website/dist`.

- [ ] **Step 4: Run the full monorepo check**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm check-licenses`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/website/README.md
git commit -s -m "website: update README for the clean/technical redesign"
```

(Skip this commit entirely if Step 1 finds no stale references.)

- [ ] **Step 6: Push and open a PR**

Push the branch and open a PR describing the redesign, its motivation (text-heavy status section, visual direction reference), and the two CLAUDE.md #7 overclaim fixes folded in. Note in the test plan that visual verification was done via the `gstack` skill (Playwright's Chrome channel unavailable in this environment) and that a repo owner should do a final look at the live deployed page after merge.
