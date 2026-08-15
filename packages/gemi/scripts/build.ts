import { rmdir } from "node:fs/promises";

// A note on `sideEffects`, because its absence from package.json looks like an
// oversight and is not.
//
// Declaring it — `false`, or any list that leaves gemi's own modules out — makes
// this build emit a broken `dist/services/index.js`. Under Bun 1.3.14 with
// `splitting: true`, the barrel keeps re-exporting `filesystemConfigDefaults`
// while the chunk that declared it drops the binding, so importing the built
// barrel dies with `Exported binding 'Mk' needs to refer to a top-level declared
// variable`. `SharpDriver`'s class body disappears the same way. `["**/*"]`
// (i.e. "everything has side effects", the same as saying nothing) builds fine,
// which is what identifies this as elimination rather than a stale artifact.
//
// The field is a bundler hint for *consumers*, so it earns nothing here until
// that is fixed upstream — and the lazy imports in #403 are what actually
// removed the weight, for test runners as well as bundlers.

try {
  await rmdir("dist", { recursive: true });
} catch (err) {}

const result = await Bun.build({
  entrypoints: [
    "./http/index.ts",
    "./app/index.ts",
    "./facades/index.ts",
    "./email/index.ts",
    "./vite/index.ts",
    "./server/index.ts",
    "./kernel/index.ts",
    "./services/index.ts",
    "./broadcasting/index.ts",
    "./i18n/index.ts",
    "./i18n/dictionaryRuntime.ts",
    "./bun/plugin.ts",
    "./bun/preload.ts",
    "./config/index.ts",
    "./container/index.ts",
    "./foundation/index.ts",
    "./support/index.ts",
    "./database/index.ts",
    "./orm/index.ts",
    // The entry `gemi run` spawns. It belongs in *this* build rather than one of
    // its own: `splitting: true` is what puts the `Command` base class in a
    // chunk shared with `dist/services/index.js`, so the published runner and
    // the `gemi/services` an application imports from hold the same class
    // object. Discovery decides what is a command by walking the prototype
    // chain, so two copies would mean the runner finds nothing.
    "./console/run.ts",
  ],
  outdir: "./dist",
  external: [
    "vite",
    "react",
    "react-dom",
    "react/jsx-runtime",
    "bun",
    "jsx-email",
    "sharp",
    // Optional peer: only present when an app uses AzureBlobDriver.
    "@azure/storage-blob",
  ],
  target: "bun",
  format: "esm",
  minify: true,
  splitting: true,
  sourcemap: "external",
  // The framework build runs under `NODE_ENV=production` (so Bun emits the
  // production JSX transform — see the `build` script). But Bun's bundler also
  // constant-folds every literal `process.env.NODE_ENV` to that build-time
  // value and dead-code-eliminates the losing branch. That baked `"production"`
  // into the *published* bundle for every runtime check — most visibly
  // `Server.start`, whose `NODE_ENV === "production"` switch had its whole dev
  // branch (Vite dev server / HMR in `httpDev`) deleted, so `gemi dev` silently
  // ran `httpProd` and served the prebuilt `dist/client` with no rebuild/HMR.
  // Redirect the read to `Bun.env.NODE_ENV` (which Bun does NOT fold) so mode is
  // resolved at RUNTIME — the same published artifact then serves dev and prod
  // correctly. JSX selection is unaffected (it follows the env var, not this).
  define: { "process.env.NODE_ENV": "Bun.env.NODE_ENV" },
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) {
    // Bun will pretty print the message object
    console.error(message);
  }
} else {
  result.logs.forEach((message) => {
    console.log(message);
  });

  result.outputs.forEach((output) => {
    console.log(output.path);
  });

  console.log("Build succeeded");
}
