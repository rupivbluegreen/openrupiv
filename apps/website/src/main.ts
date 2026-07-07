import "./styles/main.css";
import { NetworkScene, isWebGLAvailable } from "./scene/NetworkScene";
import type { SectionId } from "./scene/layouts";
import { initScrollTimeline, type SectionElement } from "./scroll/scrollTimeline";
import { renderStatus } from "./content/renderStatus";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Section elements in document order, keyed by their `id` attribute (a valid SectionId per the HTML structure). */
function collectSectionElements(): SectionElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".section")).map((element) => ({
    id: element.id as SectionId,
    element,
  }));
}

function main(): void {
  const canvas = document.getElementById("network-canvas") as HTMLCanvasElement | null;
  const statusContainer = document.getElementById("status-content");

  if (statusContainer) {
    void renderStatus(statusContainer);
  }

  if (!canvas) return;

  if (prefersReducedMotion() || !isWebGLAvailable()) {
    canvas.remove();
    document.body.classList.add("static-fallback");
    return;
  }

  const scene = new NetworkScene(canvas);
  scene.start();
  initScrollTimeline(scene, collectSectionElements());
}

main();
