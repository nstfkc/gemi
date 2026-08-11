import path from "node:path";
import { existsSync } from "node:fs";
import createRollupInput from "./createRollupInput";
import { loadApp } from "./loadApp";
import { runMigrate } from "./migrate";
import { gemiPlugin } from "../bun/plugin";
import { loadGemiConfig } from "../config/load";
import { build } from "vite";
import gemiVite from "../vite";

import { program } from "commander";
import { CheckModelsError, checkModels, printReport } from "./check-models";
import { ApiManifestGenerator } from "./ide/generateApiManifest";

// `bun --preload` args for the app's optional `app/preload.ts`. Preloaded (after
// gemi's own runtime plugin) before the server entry runs — so it executes
// before `httpDev`/`httpProd` start. Empty when the app has no preload file.
function appPreloadArgs(appDir: string): string[] {
  const preloadPath = path.join(appDir, "preload.ts");
  return existsSync(preloadPath) ? ["--preload", preloadPath] : [];
}

program.command("dev").action(async () => {
  console.log("Starting dev server...");
  const rootDir = path.resolve(process.cwd());
  const appDir = path.join(rootDir, "app");
  process.env.NODE_ENV = "development";
  Bun.spawn({
    cmd: [
      "bun",
      "--hot",
      "--no-clear-screen",
      // Register the gemi custom-request transform as a runtime plugin before
      // app code loads, so controllers/routes imported by the dev server get
      // their typed `Request` params default-instantiated (see bun/plugin.ts).
      // Resolved from the app's node_modules via gemi's export map, so it tracks
      // the linked source in dev and the published build in prod.
      "--preload",
      "gemi/bun/preload",
      // App-provided `app/preload.ts`, if present — runs before server.ts.
      ...appPreloadArgs(appDir),
      `${path.join(appDir, "server.ts")}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
});

program.command("build").action(async () => {
  // Bun fixes its JSX transform (prod `jsx` vs dev `jsxDEV`) at process startup
  // from NODE_ENV. `bun run build` starts without it, so the in-process
  // `Bun.build` of the server entry would emit dev `jsxDEV` calls that are
  // undefined in production react-dom and crash during SSR. Setting NODE_ENV
  // here is too late — re-exec once in a fresh process that starts with
  // NODE_ENV=production so the transform is correct from the start.
  if (process.env.GEMI_BUILD_PROD !== "1") {
    const proc = Bun.spawn({
      cmd: ["bun", process.argv[1], "build"],
      env: { ...process.env, NODE_ENV: "production", GEMI_BUILD_PROD: "1" },
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    process.exit(proc.exitCode ?? 0);
  }

  process.env.NODE_ENV = "production";
  const rootDir = path.resolve(process.cwd());
  const appDir = path.join(rootDir, "app");

  const config = await loadGemiConfig(rootDir);

  const input = await createRollupInput(appDir);

  // The gemi Vite plugin reads the entry list from `GEMI_INPUT` (see
  // `gemi/vite`). This CLI already runs under Bun, so Vite's programmatic
  // `build()` runs under Bun too — the plugin can import the app's TypeScript
  // `gemi.config.ts` directly, and there is no per-app `vite.config.mjs` to
  // discover, so the gemi plugin is passed explicitly (with `configFile: false`).
  process.env.GEMI_INPUT = JSON.stringify(input);

  console.log("Building client...");

  await build({
    configFile: false,
    plugins: [gemiVite()],
    build: { outDir: "dist/client" },
  });

  console.log("Building server...");

  // SSR build of the view entries. This emits per-view server chunks plus
  // `dist/server/.vite/manifest.json`, which `httpProd` reads to map each
  // `app/views/*.tsx` to its built server module. `build.ssr` flips Vite's
  // `isSsrBuild`, which the gemi plugin uses to externalize `gemi` from the view
  // graph (see `internal/gemiExternals`); everything else mirrors the client
  // build above — the two are mirror images.
  await build({
    configFile: false,
    plugins: [gemiVite()],
    build: { ssr: true, outDir: "dist/server" },
  });

  // Runnable server entry. `start` imports `dist/server/server.mjs`, so emit
  // exactly that file. `packages: "external"` keeps node_modules deps (sharp,
  // prisma's engine, vite/rolldown) resolving at runtime instead of being
  // bundled — bundling them breaks native addons and bloats the output. CSS is
  // loaded as opaque `text` so the bundler neither resolves `url(...)` assets
  // nor leaves a dangling runtime `import` ("Cannot find module ./main.css").
  const serverBuild = await Bun.build({
    entrypoints: ["./app/server.ts"],
    outdir: "./dist/server",
    naming: "[name].mjs",
    target: "bun",
    minify: true,
    // Emit a linked `.map` (with a `sourceMappingURL` comment) so Bun maps
    // production server stack traces back to the app's source.
    sourcemap: "linked",
    // Apply the custom-request transform (plus any app-declared Bun plugins from
    // gemi.config.ts) to controllers/routes that end up bundled into the server
    // entry. With `packages: "external"` the app's own code (imported via
    // `@/app/*`) is currently kept external and transformed at runtime by the
    // `--preload` plugin in `start` instead — so these only fire if app code is
    // ever bundled here. Kept as a safety net for that case.
    plugins: [gemiPlugin(), ...(config.bun?.plugins ?? [])],
    // Keep everything in node_modules external — resolved at runtime from the
    // app's node_modules. This avoids bundling native/dev-only deps (sharp,
    // prisma's engine, vite/rolldown) that break or bloat the server bundle.
    packages: "external",
    // App-local CSS is still bundled, so load it as opaque text (see above).
    loader: { ".css": "text" },
  });

  if (!serverBuild.success) {
    for (const message of serverBuild.logs) console.error(message);
    process.exit(1);
  }

  process.exit();
});

program.command("start").action(async () => {
  console.log("Starting server...");
  // Launch the built server entry in a FRESH Bun process with
  // `NODE_ENV=production` in its environment. Bun fixes its JSX transform (prod
  // `jsx` vs dev `jsxDEV`) and package export-condition resolution (production
  // vs development `react-dom`) at process startup — so setting
  // `process.env.NODE_ENV` here and `import()`-ing in the same process is too
  // late and leaves gemi's runtime-transpiled source on the dev JSX runtime
  // (`jsxDEV is not a function`). Spawning inherits the flag from the start,
  // same as the `dev` command.
  const rootDir = path.resolve(process.cwd());
  const appDir = path.join(rootDir, "app");
  const proc = Bun.spawn({
    cmd: [
      "bun",
      // The built `server.mjs` is a thin bootstrap: `packages: "external"` keeps
      // the app's own code (imported via the non-relative `@/app/*` alias) out of
      // the bundle, so controllers/routes are resolved from source and run by Bun
      // at runtime — exactly like dev. So the custom-request transform must run at
      // runtime here too: register it via `--preload` before the server loads
      // (same plugin as `dev`), otherwise handler `req` params stay undefined
      // (`req.input is not a function`).
      "--preload",
      "gemi/bun/preload",
      // App-provided `app/preload.ts`, if present — runs before the server entry.
      ...appPreloadArgs(appDir),
      `${rootDir}/dist/server/server.mjs`,
    ],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  await proc.exited;
});

// Everything after the command's name belongs to the command, including its
// flags. Two commander settings do that, and both are load-bearing:
//
//   - `enablePositionalOptions()` on the program, so a subcommand may own the
//     options that follow it. Program-level options must then precede the
//     subcommand name; the program declares none, so nothing changes for the
//     commands above.
//   - `passThroughOptions()` here, so everything after the first operand is an
//     operand — `gemi run send-email --queue` forwards `--queue` untouched, and
//     `gemi run send-email --help` reaches the command rather than printing
//     commander's help for `run` (`gemi run --help`, with no name, still does).
//
// NOT `allowUnknownOption()`, which was the first thing tried: commander
// collects unknown options into a separate list and concatenates it *after* the
// operands, so `gemi run job --flag value` arrives as `job value --flag`. Order
// silently mangled is the worst failure available to an argument forwarder.
//
// For the same reason this subcommand declares no options of its own. Any it
// declared would be shadowed after the first operand and would read as a
// `gemi run` flag that mysteriously does nothing; a future one goes *before* the
// name, as `gemi run --env=staging send-email`.
program.enablePositionalOptions();

program
  .command("run")
  .description(
    "Run a Command from app/commands. Everything after the name is the " +
      "command's own, including its flags. Omit the name to list them",
  )
  .argument("[name]", "The command's name")
  .argument("[args...]", "Passed through to the command untouched")
  .passThroughOptions()
  .action(async (name: string | undefined, args: string[]) => {
    const rootDir = path.resolve(process.cwd());
    const appDir = path.join(rootDir, "app");

    // Resolved from the *application's* gemi, never bundled into this binary.
    // Discovery decides what is a command by walking the prototype chain, and
    // the `Command` the app's files extend is the app's copy — a base bundled
    // in here is a different class object and would match nothing, silently.
    // `bin/check-models.ts` resolves `gemi/orm` the same way and for the same
    // reason.
    let entry: string;
    try {
      entry = Bun.resolveSync("gemi/console/run", rootDir);
    } catch {
      console.error(
        `Could not resolve \`gemi/console/run\` from ${rootDir}. Run this from ` +
          `the root of a gemi project, on a version of gemi that has console ` +
          `commands.`,
      );
      process.exit(1);
    }

    const proc = Bun.spawn({
      cmd: [
        "bun",
        // The same two preloads as `dev` and `start`, in the same order and for
        // the same reasons: a command reaches controllers and models, so the
        // custom-request transform and the app's own preload both have to be in
        // place before any of it loads.
        "--preload",
        "gemi/bun/preload",
        ...appPreloadArgs(appDir),
        entry,
        ...(name === undefined ? [] : [name]),
        ...args,
      ],
      stdout: "inherit",
      stderr: "inherit",
      // Explicit: `Bun.spawn` ignores stdin by default, and a destructive
      // command that asks for confirmation would read EOF and take the default.
      stdin: "inherit",
      // NODE_ENV is passed through unchanged rather than forced. `dev` and
      // `start` each are one mode by definition; this is not, and spawning is
      // what makes `NODE_ENV=production gemi run backfill` correct from the
      // child's first line.
      env: { ...process.env, GEMI_NO_SCHEDULE: "1" },
    });

    await proc.exited;
    process.exit(proc.exitCode ?? 1);
  });

program
  .command("migrate")
  .description(
    "Migrate an app from the 0.42 service-provider layout to the config + " +
      "container layout, flagging APIs retired since",
  )
  .option("--dry-run", "Print the plan without writing anything")
  .action(async (options: { dryRun?: boolean }) => {
    const rootDir = path.resolve(process.cwd());
    console.log(
      options.dryRun
        ? `Planning migration of ${rootDir}...`
        : `Migrating ${rootDir}...`,
    );
    await runMigrate({ rootDir, dryRun: options.dryRun });
  });

// A command group rather than a `check:models` colon name, which is the shape
// the other namespaced commands use. Those namespaces are *areas* — `app:`,
// `ide:` — and this one is a verb, so it reads with the bare verbs at the top
// level (`gemi dev`, `gemi build`) and leaves room for `gemi check <other>`.
const check = program
  .command("check")
  .description(
    "Checks that can be run in CI, on a project that is not running",
  );

check
  .command("models")
  .description(
    "Report policied model classes that the modules `Kernel.models` declares " +
      "do not register — the leak `Kernel.models` cannot see, because it can " +
      "only audit the modules it is handed. Imports every file it walks, so a " +
      "model file that does work when imported does it here; use --ignore",
  )
  .option(
    "--dir <path>",
    "Model directory to walk, relative to the project root",
    "app/models",
  )
  .option(
    "--models <paths>",
    "Module paths to register from, instead of reading `Kernel.models` — for " +
      "a Kernel whose import graph needs build-time transforms this command " +
      "cannot apply. Comma-separated, and repeatable",
    (value: string, previous: string[]) => [
      ...previous,
      ...value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ],
    [] as string[],
  )
  .option(
    "--ignore <paths>",
    "Paths under --dir to skip, for model-adjacent code that runs something " +
      "when imported. Comma-separated, and repeatable",
    // Accumulating, because a coercion that drops `previous` makes
    // `--ignore a --ignore b` keep only `b` — silently, and while reading like
    // it took both.
    (value: string, previous: string[]) => [
      ...previous,
      ...value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ],
    [] as string[],
  )
  .action(
    async (options: { dir: string; ignore: string[]; models: string[] }) => {
      try {
        const report = await checkModels({
          rootDir: path.resolve(process.cwd()),
          modelsDir: options.dir,
          ignore: options.ignore,
          models: options.models,
        });
        process.exit(printReport(report));
      } catch (error) {
        // A `CheckModelsError` is a sentence written for this moment; anything
        // else is a bug and keeps its stack.
        if (!(error instanceof CheckModelsError)) throw error;
        console.error(error.message);
        process.exit(1);
      }
    },
  );

program.command("ide:generate-api-manifest").action(async () => {
  const parser = new ApiManifestGenerator();
  await parser.run("/app/http/routes/api.ts");
});

program.command("app:component-tree").action(async () => {
  const app = await loadApp();
  console.log(app.getComponentTree());
  process.exit();
});

program.command("app:route-manifest").action(async () => {
  const app = await loadApp();
  console.log(app.getRouteManifest());
  process.exit();
});
program.parse();
