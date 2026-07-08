import "./styles/main.css";
import { renderStatus } from "./content/renderStatus";
import { initRevealOnScroll } from "./scroll/revealOnScroll";

function main(): void {
  const statusContainer = document.getElementById("status-content");
  if (statusContainer) {
    void renderStatus(statusContainer);
  }
  initRevealOnScroll();
}

main();
