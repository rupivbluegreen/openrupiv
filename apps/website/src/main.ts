import "./styles/main.css";
import { NetworkScene, isWebGLAvailable } from "./scene/NetworkScene";
import { initScrollTimeline } from "./scroll/scrollTimeline";
import { collectSectionElements } from "./scroll/collectSections";
import { renderStatus } from "./content/renderStatus";

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
