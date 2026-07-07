import { isSectionId } from "../scene/layouts";
import type { SectionElement } from "./scrollTimeline";

/**
 * Section elements in document order, keyed by their `id` attribute.
 *
 * `.section` elements whose `id` isn't a recognized `SectionId` are skipped
 * (with a console warning naming the bad id) rather than force-cast through —
 * see `isSectionId` in `../scene/layouts` for why an unchecked cast here is
 * unsafe. Extracted out of `main.ts` so this logic is unit-testable without
 * bootstrapping the whole app entry point.
 */
export function collectSectionElements(root: ParentNode = document): SectionElement[] {
  const elements: SectionElement[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(".section"))) {
    if (isSectionId(element.id)) {
      elements.push({ id: element.id, element });
    } else {
      console.warn(`Skipping .section element with unrecognized id: "${element.id}"`);
    }
  }
  return elements;
}
