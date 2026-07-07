# openRupiv Landing Page — Redesign (drop Three.js, "fun and welcoming")

**Supersedes:** `docs/superpowers/specs/2026-07-07-website-landing-page-design.md`
(the Three.js/GSAP particle-network design). This document replaces that
design's tech stack, visual direction, and content framing. Hosting,
deployment, and the honest-status-sourcing requirement are unchanged and
carried forward as-is.

## Why this redesign

The shipped page (PR #6) used a Three.js WebGL particle-network scene
scroll-driven by GSAP ScrollTrigger. Feedback after seeing it live: drop
the Three.js/GSAP dependency entirely, and the visual style itself needs to
change — the goal is "fun and welcoming," not the previous dark,
enterprise-serious tone.

## Purpose & audience (unchanged)

Advertising, not documentation. Audience: engineers and technical
decision-makers evaluating open-source enterprise app platforms. Still
technically honest about what's built vs. planned — "fun and welcoming"
changes the tone and visual treatment, not the truthfulness of any claim.

**Non-negotiable (per root `CLAUDE.md` #7 — never claim ahead of
`ENTERPRISE_READINESS.md`):** unchanged from the original design. The
Status section's content is still generated at build time from
`ENTERPRISE_READINESS.md` by `apps/website/scripts/build-status.ts`; this
redesign only changes that section's visual skin, never its data source or
fail-loudly-on-drift behavior.

## Hosting & deployment (unchanged)

Same `apps/website` Vite/TypeScript package, same
`.github/workflows/deploy-pages.yml`, same GitHub Pages target
(`https://rupivbluegreen.github.io/openrupiv/`, `rupiv.ai` CNAME inert
until DNS is pointed there). None of this is touched by this redesign.

## Tech stack changes

- **Removed:** `three` and `gsap` as dependencies (both currently in
  `apps/website/package.json`). Once `gsap` is gone, the named exception in
  `scripts/check-licenses.mjs`'s `EXCEPTIONS` map (added to unblock exactly
  this dependency) is removed too — no non-OSI license anywhere in this
  package after this redesign.
- **Removed:** `apps/website/src/scene/NetworkScene.ts` (Three.js scene),
  `apps/website/src/scene/layouts.ts` (Fibonacci-sphere/cluster/roadmap/
  status layout math for the particle scene), `apps/website/src/scroll/
  scrollTimeline.ts` (GSAP ScrollTrigger wiring). Their tests
  (`test/layouts.test.ts`) are removed with them.
- **Kept, simplified:** the idea behind `apps/website/src/scroll/
  collectSections.ts` (collect `.section` DOM elements, validate ids)
  survives as the basis for the new reveal-on-scroll utility, but the
  original file's shape (returning ordered `{id, element}` pairs for a
  scroll-scrubbed timeline) is replaced — see "Reveal-on-scroll" below.
- **No new dependencies added.** Motion is native CSS transitions +
  `IntersectionObserver` (both browser built-ins). Typography stays on the
  system font stack (see "Typography," below, for why this is the
  recommendation and what upgrading later would look like).
- **Kept as-is:** `apps/website/scripts/build-status.ts` and
  `apps/website/src/content/renderStatus.ts`'s data-fetching/grouping logic
  (only its rendered HTML/CSS classes change, to match the new visual
  language — see "Status section," below).

## Content: pain-point framing (replaces "four pillars")

Same four topics, reframed as problem → solution instead of a feature list.
Exact final copy is a content-writing detail for the implementation plan,
not locked here, but the framing pattern and example headlines are:

1. **Hero.** Keep the existing thesis line from `README.md` ("An
   Apache-2.0, enterprise-ready, agent-native app development platform
   where the enterprise features are the free features"), with a
   friendlier, warmer visual treatment (see below) and one short,
   welcoming subhead.
2. **Pain point: SSO tax.** Headline framed as the frustration ("Sick of
   paying an enterprise tax for SSO?"), one short solution line (SAML,
   OIDC, SCIM, RBAC/ABAC, audit logs, HA, air-gap — all in the Apache-2.0
   core), one friendly icon.
3. **Pain point: spec/code drift.** ("Tired of your app's real behavior
   living only in someone's head?"), solution line about Git-native specs
   + generated code, one friendly icon.
4. **Pain point: compliance fire drills.** ("Compliance evidence shouldn't
   be a fire drill"), solution line about the hash-chained audit log + SIEM
   export + generated compliance artifacts, one friendly icon.
5. **Pain point: ungoverned agents.** ("Want AI agents that actually ask
   permission first?"), solution line about the HITL propose-only model,
   one friendly icon.
6. **Roadmap.** Phases 0–5 from `PLAN.md` §6, presented as a row/column of
   rounded "milestone chip" badges (pill-shaped, matching the rest of the
   redesign) rather than the previous timeline-shaped animation state.
   Current phase (Phase 2) visually marked (e.g., a filled/accent-colored
   chip vs. outline chips for future phases).
7. **Status.** Unchanged data/logic; re-skinned as rounded cards grouped by
   section, matching the new visual language (see below).
8. **Footer.** Unchanged: GitHub repo, `PLAN.md`, `ENTERPRISE_READINESS.md`,
   license links.

## Visual direction: "fun and welcoming"

- **Palette:** warm, soft base (off-white/cream, e.g. `#fdf6ec`-family),
  not stark black. Each pain-point section gets its own vibrant gradient
  background drawn from a small rotating palette (e.g. coral→amber,
  teal→lime, violet→pink, sky→teal) — warm and energetic, not the
  previous near-black/cyan enterprise-dark scheme. Exact hex values are an
  implementation-plan-level detail (a small `--gradient-1`..`--gradient-4`
  set of CSS custom properties), not fixed in this design doc.
- **Shape language:** generous border-radius everywhere (section panels,
  status cards, roadmap chips), pill-shaped badges/buttons, soft drop
  shadows, and 1–2 large organic "blob" SVG shapes as background accents
  per section (simple hand-authored `<svg>` paths, not an illustration
  library) — replacing the previous sharp-edged panel-over-canvas look.
- **Typography:** a friendly system-font stack (e.g. `ui-rounded,
  "SF Pro Rounded", "Segoe UI", system-ui, sans-serif` so Apple platforms
  get an actually-rounded system face, others fall back to their normal
  system sans), generous weight/size on headlines. **Recommendation:** do
  not add a webfont dependency for this redesign — self-hosting an
  OFL-licensed rounded font (e.g. Quicksand, Baloo 2) as static `.woff2`
  files (not an npm package — an OFL-licensed npm font package would
  fail `check-licenses.mjs`'s allowlist the same way `gsap` initially did,
  and self-hosting static font *files* isn't a `pnpm`-managed dependency at
  all, so it never reaches that check) is a clean future upgrade if more
  typographic personality is wanted later, but isn't needed to hit "fun and
  welcoming" out of the gate.
- **Icons/illustrations:** one simple, friendly, hand-authored inline SVG
  per pain-point section (flat-style, rounded, 2-3 colors max) — e.g. a
  rounded shield for SSO, a branching git-graph glyph for Git-native, a
  friendly seal/checkmark badge for compliance, a simple friendly
  robot/network glyph for agent-native. Authored directly in this repo
  (no icon-library dependency, sidestepping any future license question
  the same way GSAP raised one).
- **Copy tone:** playful, conversational headlines; solution lines stay
  precise and technically honest (no exaggeration of shipped-vs-planned
  status — CLAUDE.md #7 still applies in full to any capability claim,
  pain-point or not).

## Motion: reveal-on-scroll (replaces GSAP ScrollTrigger)

- **New module:** `apps/website/src/scroll/revealOnScroll.ts`. A single
  exported function, `initRevealOnScroll(root: ParentNode = document):
  void`, that:
  1. Selects every element carrying a `data-reveal` attribute under
     `root`.
  2. Creates one `IntersectionObserver` (threshold ~0.15) that adds an
     `is-visible` CSS class to an element the first time it enters the
     viewport, then unobserves it (one-shot reveal, not re-triggered on
     scroll-back — simpler and avoids flicker).
  3. If `window.matchMedia("(prefers-reduced-motion: reduce)").matches`,
     adds `is-visible` to every `data-reveal` element immediately instead
     of observing — content is present and fully visible with no motion,
     never gated behind a transition that respects reduced-motion by being
     instant-but-still-technically-a-transition.
- **CSS:** `[data-reveal]` starts at `opacity: 0` + a small
  `translateY(12px)`; `.is-visible` transitions both to their resting state
  over ~400ms. Plain CSS, no JS animation loop.
- **No scroll-scrubbing, no persistent canvas, no per-frame render loop.**
  This is strictly lighter-weight than the previous design at runtime.

## Testing / QA approach

- `apps/website/scripts/build-status.ts` and its existing test
  (`test/build-status.test.ts`) are unchanged — untouched by this redesign.
- `apps/website/test/renderStatus.test.ts` is unchanged in what it tests
  (data fetching, grouping, detail rendering, escaping, fallback) — only
  the HTML class names it may assert on change to match new markup, if at
  all.
- New: `apps/website/test/revealOnScroll.test.ts` — the one piece of this
  redesign with real logic worth unit testing: elements without
  `data-reveal` are untouched, `prefers-reduced-motion` makes every element
  visible immediately without ever constructing an observer, and (using a
  fake/mock `IntersectionObserver`, matching this project's existing
  fake-dependency test style) an element gets `is-visible` added exactly
  once when the mock reports it intersecting.
- `test/layouts.test.ts` (Three.js layout math) is deleted — there is no
  equivalent logic in the new design; this matches the project's "don't
  add tests for scenarios that can't happen" principle in reverse (remove
  tests for scenarios that no longer exist).
- `test/collectSections.test.ts` is replaced by whatever
  `revealOnScroll.test.ts` needs from section-collection, if anything — an
  implementation-plan-level call once the exact `revealOnScroll.ts`
  internals are written (it may not need a separate collection step at
  all, since it can just query `[data-reveal]` directly).
- Manual verification before considering this done (same bar as the
  original design, adjusted for the new mechanism): `pnpm --filter
  @openrupiv/website build` succeeds; load the built output in a real
  browser and confirm each section fades/rises into view once scrolled to,
  confirm the reduced-motion fallback shows everything immediately with no
  animation, confirm mobile viewport width doesn't break the layout;
  confirm the GitHub Actions `deploy-pages` workflow stays green (no
  workflow changes are anticipated, but this is the one thing that must be
  exercised end-to-end per the original design's same reasoning).

## Error handling (unchanged from original design)

- Build-time: `build-status.ts` still fails the build loudly on an
  unparseable `ENTERPRISE_READINESS.md`.
- Runtime: no WebGL capability check is needed anymore (nothing in this
  design uses a `<canvas>`) — this entire failure mode from the original
  design is eliminated, not just handled.

## Out of scope (for this redesign)

- Actual DNS configuration for `rupiv.ai` (unchanged — user/registrar-side).
- A CMS or non-code content editing mechanism (unchanged).
- Analytics/telemetry (unchanged — separate decision).
- Self-hosting a custom webfont (documented above as a clean future
  upgrade, not part of this redesign).
- Finalizing exact pain-point copy word-for-word, exact gradient hex
  values, and exact SVG icon paths — these are implementation-plan-level
  content/detail decisions within the framing and direction fixed above,
  not further design-level decisions.
