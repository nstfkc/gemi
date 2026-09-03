import { defineConfig } from "gemi/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Vite plugins/config for the client + SSR view builds.
  // `plugins` are appended after gemi's own; any other key is a Vite UserConfig
  // field merged on top of gemi's defaults.
  //
  // Tailwind is a Vite plugin rather than a PostCSS one, and on this stack that
  // is not a preference. Tailwind 4's entry is `@import "tailwindcss"`, and
  // Vite resolves the `@import`s in a stylesheet itself, before any PostCSS
  // plugin runs — so `@tailwindcss/postcss` never sees it and the build dies
  // trying to open a file called `tailwindcss` next to main.css.
  vite: {
    plugins: [react(), tailwindcss()],
  },
  // Bun plugins applied to the server build and the dev/prod runtime.
  bun: {
    plugins: [],
  },
});
