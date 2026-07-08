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
