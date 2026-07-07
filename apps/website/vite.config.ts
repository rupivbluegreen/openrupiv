import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built output works both at the default GitHub
  // Pages project-page path (https://rupivbluegreen.github.io/openrupiv/)
  // and, later, at a custom domain's root (https://rupiv.ai/) once DNS is
  // configured — an absolute base like "/openrupiv/" would need to change
  // when that happens; "./" never does.
  base: "./",
  build: {
    outDir: "dist",
  },
});
