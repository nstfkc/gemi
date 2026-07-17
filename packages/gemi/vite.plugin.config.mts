import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "vite/index.ts"),
      formats: ["es"],
      fileName: () => `index.mjs`,
    },
    minify: false,
    outDir: "dist/vite",
    rollupOptions: {
      // Keep Node builtins external — this plugin runs in the Vite process
      // (Node/Bun), not the browser, so `node:path`/`node:fs` etc. must resolve
      // at runtime instead of being stubbed out by Vite's browser lib build
      // (which otherwise leaves `join`/`existsSync` undefined — see config/load).
      external: [
        /^node:/,
        "react",
        "react-dom",
        "react/jsx-runtime",
        "gemi",
        "bun",
      ],
    },
  }
});
