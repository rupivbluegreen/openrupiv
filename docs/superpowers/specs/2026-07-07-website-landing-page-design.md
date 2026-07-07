# openRupiv Landing Page — Design

**Goal:** A public, scroll-driven marketing/landing page for openRupiv, hosted
on GitHub Pages, that advertises the project's thesis, four pillars, phased
roadmap, and honest current capability status — with a Three.js particle-network
animation that reconfigures as the visitor scrolls.

## Purpose & audience

This is advertising, not documentation. Audience: engineers and technical
decision-makers evaluating open-source enterprise app platforms (the same
audience `README.md`/`PLAN.md` target). Tone matches the existing README:
direct, technical, honest about what's built vs. planned — no marketing
fluff that oversells current status.

**Non-negotiable (per root `CLAUDE.md` #7 — never claim ahead of
`ENTERPRISE_READINESS.md`):** any per-capability status shown on the page
(what's built vs. coming) must be sourced from `ENTERPRISE_READINESS.md` at
build time, not hand-copied prose that can drift out of sync as the project
progresses.

## Hosting & deployment

- New workspace package: `apps/website` (the root `pnpm-workspace.yaml`
  already reserves `apps/*`; this is the first package to use it).
- Built with Vite; deployed via a new GitHub Actions workflow
  (`.github/workflows/deploy-pages.yml`) that builds `apps/website` and
  publishes to GitHub Pages on every push to `main` that touches
  `apps/website/**`.
- Launches at the default GitHub Pages URL
  (`https://rupivbluegreen.github.io/openrupiv/`) for now. A `CNAME` file
  (containing `rupiv.ai`) ships in the build output so pointing the
  already-registered `rupiv.ai` domain here later is a DNS-record change,
  not a rebuild — but DNS itself is out of scope (the user manages the
  registrar; the CNAME file is inert until DNS points at GitHub Pages).
- GitHub Pages itself must be enabled in the repo's Settings (Pages →
  Source: GitHub Actions) — this is a one-time manual repo-settings step
  the workflow cannot do on its own; call this out explicitly when the PR
  is ready.

## Tech stack

- **Vite** (dev server + build), **TypeScript** (strict mode, matching
  every other package's convention), **Three.js** (WebGL scene), **GSAP +
  ScrollTrigger** (scroll-linked timeline — free as of GSAP's 2024 licensing
  change, no paid tier).
- No framework (React/Vue/etc.) — a single continuous scene with HTML/CSS
  text overlays doesn't need component-model overhead, and no other part of
  this monorepo uses a UI framework this page would need to match.
- Zero backend: pure static output (`apps/website/dist`), no API calls, no
  build-time secrets.

## Content structure (single long-scroll page)

Four sections, matching the earlier-agreed content scope:

1. **Hero** — the thesis line from `README.md` ("An Apache-2.0,
   enterprise-ready, agent-native app development platform where the
   enterprise features are the free features"), with the network animation
   at its sparsest/most ambient state.
2. **Four pillars** — one sub-section per pillar (Zero SSO tax / Git-native
   apps / compliance-as-byproduct / agent-native), copy adapted from
   `README.md`'s existing four-pillar list. As each pillar scrolls into
   view, the network animation clusters its nodes into a shape/highlight
   representing that pillar (e.g., a lock/shield formation for "zero SSO
   tax", a branching tree for "Git-native", a chain for "compliance
   evidence", a mesh of connected agents for "agent-native").
3. **Roadmap** — a horizontal or vertical timeline of Phases 0–5 from
   `PLAN.md` §6, each phase's one-line milestone, with the current phase
   (Phase 2, in progress) visually marked. The network animation unfurls
   into a left-to-right timeline layout for this section.
4. **Status** — an honest "what's real today" strip, generated from
   `ENTERPRISE_READINESS.md`'s existing capability table at build time (see
   Data Sourcing below), not hand-written. Network animation settles into a
   steady "pulse" state here.

A footer with links: GitHub repo, `PLAN.md`, `ENTERPRISE_READINESS.md`,
license (Apache-2.0).

## Data sourcing (keeping "status" honest and non-drifting)

A small build-time script (`apps/website/scripts/build-status.ts`, run by
Vite via a plugin or a `prebuild` step) parses `ENTERPRISE_READINESS.md`'s
existing markdown table and emits a JSON file the page's status section
renders from. This is a **parser, not a duplicate source of truth** — if the
table's format doesn't parse cleanly, the build fails loudly (matching this
project's "no silent no-op" convention) rather than silently shipping stale
content. Exact table-parsing approach (regex vs. a markdown-table library)
is an implementation-plan-level decision, not a design-level one.

## Visual & interaction design

- **Palette:** near-black background (`#0a0e14`), cyan/blue nodes and
  connective lines (`#38bdf8` family), matching the approved mockup.
- **Scene:** one persistent `<canvas>` (fixed position, full-viewport,
  behind all content) owned by a single `NetworkScene` class. 40–60
  particle nodes connected by proximity-based lines (mirrors the approved
  mockup's algorithm, promoted from 2D canvas to a real Three.js
  `Points`/`LineSegments` scene in 3D so it can be looked at from a very
  slightly shifting camera angle for depth).
- **Scroll-driving:** one GSAP `ScrollTrigger` timeline (`scrub: true`)
  spanning the whole page, with labeled sections corresponding to the 4
  content sections above. The timeline drives each node's *target* position
  (nodes always lerp toward their current target every frame, so scrubbing
  back and forth is smooth, not jumpy).
- **Content overlay:** HTML/CSS sections positioned in normal document flow
  above the fixed canvas, each with enough opacity/backdrop treatment
  (e.g. a subtle `backdrop-filter: blur()` panel behind text) that copy
  stays readable regardless of what's happening in the animation behind it.
- **Reduced motion:** a `prefers-reduced-motion: reduce` media query check
  disables the scroll-scrubbed animation entirely (static, most-legible
  frame of the network shown instead) and skips GSAP's scroll hijacking —
  this is an accessibility requirement, not optional polish.
- **Performance:** cap the particle count and use `requestAnimationFrame`
  correctly (pause the render loop via `IntersectionObserver` if the canvas
  scrolls fully out of view — shouldn't happen given it's fixed/full-page,
  but pause on tab-hidden via the Page Visibility API at minimum).

## Testing / QA approach

This is a static marketing page, not application logic — no unit-test
suite is warranted (matches this project's "don't add tests for scenarios
that can't happen" principle; there's no business logic to unit test
beyond the status-table build-time parser, which DOES get a test: feed it
a known `ENTERPRISE_READINESS.md`-shaped fixture, assert the emitted JSON
shape). Manual verification before considering this done:
- `pnpm --filter @openrupiv/website build` succeeds and produces working
  static output.
- Load the built output in a real browser: scroll through the whole page,
  confirm the animation reconfigures at each section boundary, confirm text
  stays legible throughout.
- Toggle OS-level "reduce motion" and confirm the animation-disabled
  fallback renders sanely.
- Confirm the GitHub Actions workflow runs green on a test push before
  calling this done (this is the one thing that must actually be exercised
  end-to-end, not just code-reviewed, since a GitHub Pages deploy pipeline
  is easy to get subtly wrong — wrong base path, wrong artifact directory,
  etc.).

## Error handling

- Build-time: the status-parser step fails the build loudly on an
  unparseable `ENTERPRISE_READINESS.md` (per the "no silent no-op" rule
  above) rather than shipping an empty/stale status section.
- Runtime: if WebGL is unavailable (very old browser, disabled hardware
  acceleration), fall back to the same static/no-animation treatment used
  for `prefers-reduced-motion` — detect via a Three.js capability check,
  don't let a WebGL context-creation failure throw an unhandled error that
  blanks the page.

## Out of scope (for this design)

- Actual DNS configuration for `rupiv.ai` (user-managed, registrar-side).
- A CMS or any mechanism for non-code-based content edits — this is a
  hand-maintained static page, edited via normal PRs like the rest of the
  monorepo.
- Analytics/telemetry on the page itself (separate decision, not bundled
  into this work).
- Mobile-specific alternate animation (the design should be responsive and
  degrade reasonably on mobile viewports, but a bespoke mobile-only
  animation treatment is future scope if the desktop version doesn't
  translate well).
