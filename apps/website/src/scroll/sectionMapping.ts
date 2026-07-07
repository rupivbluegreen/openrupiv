import type { SectionId } from "../scene/layouts";

/** Scroll order of sections, top to bottom of the page. */
export const SECTION_ORDER: SectionId[] = [
  "hero",
  "pillar-sso",
  "pillar-git",
  "pillar-compliance",
  "pillar-agents",
  "roadmap",
  "status",
];

/** Maps overall page-scroll progress (0..1) to the active section, dividing the range into equal bands. */
export function sectionForProgress(progress: number): SectionId {
  const clamped = Math.min(1, Math.max(0, progress));
  const bandSize = 1 / SECTION_ORDER.length;
  const index = Math.min(SECTION_ORDER.length - 1, Math.floor(clamped / bandSize));
  return SECTION_ORDER[index]!;
}
