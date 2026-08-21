import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      // Two entries in ONE build, deliberately: `gemi/testing` supplies the
      // contexts (`RouteStateContext`, `QueryManagerContext`, …) that the
      // components under test read through `gemi/client`. Built separately,
      // each bundle would carry its own copy of every context object — two
      // distinct `createContext` results — and a seeded `<Page>` would provide
      // values nothing consumes. Rollup emits the shared modules as a chunk
      // both entries import, so there is one instance of each.
      entry: {
        "client/index": resolve(__dirname, "client/index.ts"),
        "testing/index": resolve(__dirname, "testing/index.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    minify: false,
    outDir: "dist",
    // `dist/` already holds the output of `build:core`, `build:bin` and
    // `build:types` by the time this runs — this build adds to it.
    //
    // Which loses the sweep vite does for free on an outDir it owns, and that
    // matters now the output is content-hashed: run `build:client` twice
    // without a clean and the first run's `chunks/*-<oldhash>.js` stays on
    // disk, `build-publish.ts` copies `dist/` wholesale, and `files:
    // ["dist/**/*"]` ships the dead chunks. The `build:client` script removes
    // exactly the three directories this config writes before invoking it.
    emptyOutDir: false,
    rollupOptions: {
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
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
