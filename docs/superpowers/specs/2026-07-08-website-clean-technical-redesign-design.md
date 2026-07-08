# openRupiv Landing Page — Clean/Technical Redesign

**Supersedes:** the warm/rounded/gradient visual system from
`docs/superpowers/specs/2026-07-07-website-landing-page-redesign-design.md`
(PR #8) and its FAQ/roadmap follow-up (PR #9). Content decisions from both
(pain-point framing, the 5 FAQ Q&As, roadmap phase descriptions) are kept —
this document changes the VISUAL SYSTEM and, for the one section that was
still genuinely too text-heavy, the INFORMATION ARCHITECTURE of the status
section. Hosting, deployment, and the honest-status-sourcing requirement
(CLAUDE.md #7, `build-status.ts`/`ENTERPRISE_READINESS.md`) are unchanged.

## Why this redesign

Feedback after seeing the live, merged site: still too text-heavy overall,
and the "What's real today" section specifically is "insanely text heavy" —
confirmed by screenshotting the live page: it renders as a multi-thousand-
pixel-tall wall of nested bullets, each carrying a full sentence of
implementation detail lifted verbatim from `ENTERPRISE_READINESS.md`. (Note:
the detail-rendering fix in PR #6's review made this specific section
heavier, not lighter — correct on its own terms, since the detail text was
being silently dropped before, but it surfaced this deeper information-
architecture problem.)

Direction: adopt the visual language of a real reference site the user
pointed at (intuist.ai) — bold monospace headlines paired with a softer
serif body font, a light/flat color system instead of gradients, pill-
shaped badges and tags, and "show, don't tell": small illustrative UI-
mockup artifacts in place of prose wherever a sentence can be replaced by
something visual. No brand names, taglines, or copy from that reference
site are reused — only the visual *language* (type pairing, flat palette,
mockup-over-prose pattern, pill badges, progressive disclosure).

## Non-negotiable (unchanged)

Per root `CLAUDE.md` #7: any capability status claim must be sourced from
`ENTERPRISE_READINESS.md` at build time, never hand-authored prose that can
drift. This redesign draws a **hard line**, stated explicitly because the
new "illustrative mockup" pattern below could blur it if not:

- The **Status section** is the only place this page makes real,
  data-driven capability claims — same generator (`build-status.ts`),
  same fail-loud-on-drift behavior, unchanged.
- Every other section's small UI-mockup artifacts (defined below) are
  **illustrative concept diagrams** — they show the *shape* of a feature
  (e.g., "this is what an audit log entry looks like"), not a live or
  implied status claim. They carry no ✅/🚧/📋 semantics and are not sourced
  from `ENTERPRISE_READINESS.md`. This mirrors the reference site's own
  pattern: its hero/pipeline animations are illustrative demos, while its
  distinct "scored" section is where real claims live — same split we
  already have, just now visually reinforced (mockups look playful/
  sketchy; the Status section looks like real, sourced data).
- **While rewriting the pain-point copy for the new format, also fix** the
  two pre-existing overclaims flagged (but not required to be fixed, since
  they were pre-existing/unchanged) in PR #8's whole-branch review: the
  SSO paragraph flatly stating SAML/SCIM/HA/air-gap are "all in the
  Apache-2.0 core" (per `ENTERPRISE_READINESS.md`, all four are still
  📋 planned), and the compliance paragraph's "generated EU AI Act / GDPR
  artifacts" claim (Annex IV/RoPA/DPIA generators are 📋 planned, zero
  built). New copy for both, given below, states only what's real today
  plus an explicit "planned" framing for what isn't — this redesign is
  already rewriting every section's copy, so fixing this now costs nothing
  extra and removes a standing compliance risk.

## Typography

- **Headlines:** `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`, bold, tight letter-spacing.
- **Body copy:** `Georgia, "Times New Roman", Times, serif` — a deliberate
  contrast pairing (techy mono headline / humanist serif body), matching
  the reference site's pairing without copying its literal font choices.
- System stacks only — no webfont dependency, no new license question (the
  `gsap` license exception saga earlier this project is exactly the kind of
  friction this avoids).

## Palette & shape

Replaces the warm/gradient system entirely:

```css
--bg: #fafbfc;        /* light, cool off-white page background */
--fg: #14161a;        /* near-black body text */
--fg-soft: #5b6472;   /* muted slate for secondary text/captions */
--accent: #3b5bfd;    /* single blue accent: links, CTAs, highlighted words */
--accent-soft: #eef1ff; /* light blue tint for badge/pill backgrounds */
--border: #e4e7ec;    /* hairline border for flat cards */
--radius-lg: 16px;
--radius-md: 10px;
--radius-pill: 999px;
--shadow-card: 0 1px 2px rgba(20, 22, 26, 0.05), 0 4px 12px rgba(20, 22, 26, 0.04);
```

Removed entirely: the four gradient background variables, the CSS-only
"blob" `::before`/`::after` background accents, the warm off-white base,
the larger `28px` panel radius. Cards become flat, bordered, subtly
shadowed — a "product UI" look, not a colorful marketing-block look.

## Section-by-section redesign

**Hero.** Adds a small two-line "prompt → result" mockup box above the
existing `<h1>`, illustrating the actual product flow concretely instead
of only describing it in prose:

```
You         describe an approval workflow with 4-eyes review
openRupiv   spec.json + migration + tests, committed
```

Keeps the existing thesis line (`<p class="lede">`). Drops the second
hero paragraph (already redundant with the lede). Adds a two-tier CTA row
beneath: a primary solid button ("Get started" → links to the root
`README.md`'s quickstart section on GitHub) and a secondary text link
("See what's shipped today →", anchor-scrolls to `#status`) — the page
currently has zero calls to action; this gives a visitor a concrete next
step, which is exactly the "what should a consumer do" framing driving
this whole pass.

**Four pain-point sections.** Same headlines (problem-framed, already
approved), same one-line solution paragraph — rewritten only for Issues 1
and 2 above (SSO, compliance) to remove the overclaim, kept as-is for the
other two (Git-native, agent-native — neither was flagged). Each section's
background becomes flat (`--bg`, no gradient), and each gets one small
illustrative mockup replacing/supplementing the icon:

- **SSO** (`pillar-sso`): a small row of pill badges — `OIDC` `SAML`
  `SCIM` `RBAC/ABAC` — purely illustrative (what the identity surface
  looks like conceptually), no ✅/📋 markers (that distinction lives only
  in the Status section, per the non-negotiable above).
  New copy: *"OIDC-based SSO ships today; SAML, SCIM, and HA are next on
  the roadmap — all landing in the same Apache-2.0 core, never an
  'enterprise edition.'"*
- **Git-native** (`pillar-git`): a small two-column mock artifact — left
  column labeled `spec.json` (a few illustrative truncated lines), right
  column labeled `generated/` (a mock file tree: `migration.sql`,
  `runtime.ts`, `spec.test.ts`) — illustrating "spec in, code out"
  concretely. Copy unchanged (not flagged, already accurate).
- **Compliance** (`pillar-compliance`): a small mock card — `Audit log`
  `Policy checks` `SIEM export` as pill badges — again purely
  illustrative, no status markers.
  New copy: *"A hash-chained audit log and policy-checked access ship
  today. Generated EU AI Act / GDPR artifacts are on the roadmap, built
  from the same runtime metadata, not assembled by hand."*
- **Agents** (`pillar-agents`): a small mock "proposal card" — a
  rounded card reading `Agent proposal — vendor onboarding` /
  `Awaiting human approval` — illustrating the HITL gate concept.
  Copy unchanged (not flagged).

**FAQ.** Same 5 questions/answers (content unchanged). Markup changes from
always-expanded `<dl>/<dt>/<dd>` cards to native `<details>/<summary>`
accordion items — collapsed by default, one open at a time is NOT
enforced (native `<details>` doesn't do that without JS, and forcing it
isn't worth the added script for a marketing FAQ). Zero JavaScript needed:
`<details>` is natively collapsible, keyboard-operable, and accessible.
Custom-styled disclosure marker (a `+`/`−` or chevron via CSS,
`::marker` or a `::before` on `summary`) to fit the visual system.

**Roadmap.** Changes from a grid of 6 paragraph-cards to a horizontal
"pipeline" row of phase pills (`Phase 0` → `Phase 1` → ... → `Phase 5`),
connected by a thin line, the current phase highlighted in `--accent`.
Each pill's one-line description (content unchanged from the current
grid) appears as a caption below it. On narrow viewports the row scrolls
horizontally (`overflow-x: auto`) rather than wrapping — a horizontal
scroll affordance is appropriate for a "pipeline" visual metaphor and
matches the reference site's own step-pill pattern.

**Status ("What's real today") — the main fix.** Restructures from one
long flat bullet dump into one compact `<details>` card **per category**
(Identity & access, Security, Compliance & governance, Operations,
Deployment, Docs & enablement, Legal & project hygiene — same 7 categories
`ENTERPRISE_READINESS.md` already groups items into). Each category's
`<summary>` shows the category name plus a compact, real, computed
proportion — e.g. "3 shipped · 2 in progress · 4 planned" as small colored
pill counts, computed from the exact same parsed `ReadinessItem[]` array
`renderStatus.ts` already has in memory (no new data source, no new
build-time logic — purely a rendering/grouping change in
`renderStatus.ts`, so the counts can never drift from the underlying
per-item data). The category is collapsed by default; expanding it reveals
the exact same detailed bullet list the page already renders today
(including the `item.detail` text — the thing PR #6's review fixed stays
fixed, it's just not force-shown to every visitor by default anymore).
This is the single biggest text-weight reduction on the page: a visitor
sees 7 short summary lines by default instead of scrolling past a wall of
~50 detailed bullets, while anyone who wants the full detail still gets it
one click away, with nothing hidden or removed.

**Footer.** Unchanged — already understated, already just links.

## Motion (unchanged)

`revealOnScroll.ts`'s `IntersectionObserver` + `.js`-class gating (Task 1
of the prior redesign, already reviewed and correct) is untouched. Native
`<details>` open/close is a separate, orthogonal interaction with its own
browser-native affordance — no conflict with the scroll-reveal mechanism,
since `data-reveal` stays on each top-level `<section>`, not on individual
`<details>` elements.

## Testing / QA

- `renderStatus.ts`'s test file gets new coverage for the category-count
  computation (e.g., a section with 3 shipped/2 in-progress/1 planned item
  renders a summary line with those exact counts) and for the
  `<details>`/`<summary>` markup shape, alongside its existing fetch/
  grouping/escaping/fallback tests (all of which stay relevant and
  unchanged in spirit).
- No new test surface for the hero/pain-point/roadmap mockups — these are
  static illustrative markup, same testing posture as the existing
  (untested) SVG icons: manual browser verification, not unit tests.
- Manual verification (same bar as prior redesigns, via the `gstack` skill
  since Playwright's Chrome channel isn't installed in this environment):
  screenshot each section at desktop + mobile width, confirm the FAQ
  accordion opens/closes, confirm each Status category expands to reveal
  its full detail list, confirm the roadmap pipeline scrolls horizontally
  on narrow viewports without breaking layout, confirm reveal-on-scroll
  still works unaffected.

## Out of scope

- Actual DNS/CNAME, analytics, CMS — unchanged from prior designs, still
  out of scope.
- A "single overall scorecard" alternative for the status section (option
  considered, not chosen — compact-per-category-with-expand was the
  chosen direction, preserving full detail one click away rather than
  linking out to GitHub for it).
- Enforcing only-one-`<details>`-open-at-a-time behavior (would need JS;
  not worth it for a marketing page).
- Any new webfont, icon library, or JS animation dependency — everything
  above is achievable with system fonts, plain CSS, and native HTML
  disclosure elements.
