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
      external: ["react", "react-dom", "react/jsx-runtime", "gemi", "bun"],
    },
  }
});
