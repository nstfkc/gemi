import { rmdir } from "node:fs/promises";

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
    "./bun/plugin.ts",
    "./bun/preload.ts",
    "./config/index.ts",
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
