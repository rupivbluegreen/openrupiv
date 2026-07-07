import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { SectionId } from "../scene/layouts";
import type { NetworkScene } from "../scene/NetworkScene";

gsap.registerPlugin(ScrollTrigger);

export interface SectionElement {
  id: SectionId;
  element: HTMLElement;
}

/**
 * Registers one ScrollTrigger per section element — switches NetworkScene's
 * active layout whenever that section's own real DOM boundaries are
 * crossed. Unlike an equal-fraction-of-total-scroll-progress approach, this
 * is correct regardless of how tall any individual section is (sections
 * are NOT equal height in practice — e.g. `#status`'s generated content
 * list is much taller than the others).
 */
export function initScrollTimeline(scene: NetworkScene, sections: SectionElement[]): ScrollTrigger[] {
  return sections.map(({ id, element }) =>
    ScrollTrigger.create({
      trigger: element,
      start: "top center",
      end: "bottom center",
      onEnter: () => scene.setSection(id),
      onEnterBack: () => scene.setSection(id),
    }),
  );
}
