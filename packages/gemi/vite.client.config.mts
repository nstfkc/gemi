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
      // React & friends are peer deps the consuming app provides — they must
      // stay external so the app's single copy is used. A plain string array is
      // exact-match, which silently missed subpaths: `react-dom/client`
      // (`hydrateRoot`/`createRoot` in client/init.tsx) and `scheduler` fell
      // through and got bundled as react-dom's CJS build, leaving `require("react")`
      // shims in dist/client/index.js. Those throw under Vite's dev optimizeDeps
      // ("Calling require for react") so hydration never runs in `gemi dev`.
      // Match the whole react/react-dom family (any subpath) plus scheduler. See #17.
      external: (id) =>
        id === "react" ||
        id === "react-dom" ||
        id === "scheduler" ||
        id.startsWith("react/") ||
        id.startsWith("react-dom/") ||
        id === "gemi" ||
        id === "sharp",
    },
    sourcemap: true,
  },
  mode: process.env.NODE_ENV,
  define: { "import.meta.hot": "import.meta.hot" },
});
