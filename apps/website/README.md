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
