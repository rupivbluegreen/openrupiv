# @openrupiv/website

The public marketing/landing page for openRupiv — a static, dependency-free
site (Vite + TypeScript only) with a clean, technical design: a monospace/serif
type pairing, flat cards, illustrative mockups, a native `<details>` FAQ
accordion, and a native `<details>` per-category disclosure for the status
section. Sections fade/slide into view via `src/scroll/revealOnScroll.ts`, a small
native `IntersectionObserver` wrapper with no external dependencies (no
Three.js, no GSAP, no canvas). It's deployed to GitHub Pages by
`.github/workflows/deploy-pages.yml` on every push to `main` that touches
this package.

## Commands

- `pnpm --filter @openrupiv/website dev` — local dev server with hot reload.
- `pnpm --filter @openrupiv/website build` — regenerates `public/status.json`
  from the repo root's `ENTERPRISE_READINESS.md` (see `scripts/build-status.ts`),
  then builds the static site into `dist/`.
- `pnpm --filter @openrupiv/website test` — runs the unit tests for the
  logic modules (`src/scroll/revealOnScroll.ts`) and the content/status
  parsers (`src/content/renderStatus.ts`, `scripts/build-status.ts`). The
  reveal utility is fully unit-testable (it's plain DOM + IntersectionObserver
  code with injectable dependencies for tests), but final visual polish is
  still worth a quick manual browser pass (scroll through the built site;
  toggle OS-level "reduce motion"; confirm sections appear immediately with
  it enabled).

## Honesty constraint

The "what's real today" section on the page is generated from the repo
root's `ENTERPRISE_READINESS.md` table at build time — never hand-edit
status claims directly in this package's source. If the build fails with
"found zero status rows," `ENTERPRISE_READINESS.md`'s table format has
changed in a way `scripts/build-status.ts` doesn't recognize; fix the
parser, don't work around it.
