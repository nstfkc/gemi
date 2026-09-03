import { defineConfig, reactCompiler } from "gemi/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Vite plugins/config for the client + SSR view builds.
  // `plugins` are appended after gemi's own; any other key is a Vite UserConfig
  // field merged on top of gemi's defaults. The React plugin lives here (rather
  // than in a standalone `vite.config.mjs`, which gemi no longer uses) so gemi
  // owns the base Vite setup and the app only contributes plugins/config.
  vite: {
    // The React Compiler, run through oxc (the Rust port in
    // `oxc-transform-react`) instead of Babel, so auto-memoization costs a
    // native transform rather than a second parse per module. The plugin only
    // memoizes for client environments — the SSR view build gets the plain JSX
    // transform, which is what gemi wants since server rendering is one pass.
    //
    // `reactCompiler()` is on unless `GEMI_REACT_COMPILER=off` is set, so a
    // compiler-shaped bug can be bisected without editing this file:
    //
    //   GEMI_REACT_COMPILER=off bun dev
    //
    // Replace it with a plain `true`/`false` to pin the choice, or pass options
    // through it (`reactCompiler({ compilationMode: "annotation" })`).
    plugins: [react({ compiler: reactCompiler() })],
  },
  // Bun plugins applied to the server build and the dev/prod runtime.
  bun: {
    plugins: [],
  },
});
