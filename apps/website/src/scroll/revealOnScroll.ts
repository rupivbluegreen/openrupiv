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
