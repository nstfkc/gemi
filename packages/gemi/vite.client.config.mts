import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "client/index.ts"),
      formats: ["es"],
      fileName: () => `index.js`,
    },
    minify: false,
    outDir: "dist/client",
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "gemi"],
    },
    sourcemap: true,
  },
  mode: process.env.NODE_ENV,
  define: { "import.meta.hot": "import.meta.hot" },
});
