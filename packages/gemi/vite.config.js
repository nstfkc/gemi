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
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
  },
});
