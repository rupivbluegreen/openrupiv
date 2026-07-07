import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { sectionForProgress } from "./sectionMapping";
import type { NetworkScene } from "../scene/NetworkScene";

gsap.registerPlugin(ScrollTrigger);

/** Wires overall page-scroll progress to NetworkScene section transitions. Call once after the page's content is in the DOM. */
export function initScrollTimeline(scene: NetworkScene, pageEl: HTMLElement): ScrollTrigger {
  return ScrollTrigger.create({
    trigger: pageEl,
    start: "top top",
    end: "bottom bottom",
    scrub: true,
    onUpdate: (self) => {
      scene.setSection(sectionForProgress(self.progress));
    },
  });
}
