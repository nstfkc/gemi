/**
 * The entry point `gemi run` spawns.
 *
 * Exposed through the exports map as `gemi/console/run` and resolved by the CLI
 * out of the *application's* `node_modules`, the same way `dev` and `start`
 * resolve `gemi/bun/preload`. That indirection is the point: the runner has to
 * be the application's copy of gemi, not the one bundled into `dist/bin/gemi.js`
 * — see the note at the top of `runner.ts`.
 *
 * Nothing but argv handling lives here, so that everything worth testing lives
 * in `runConsole`, which returns an exit code instead of taking one.
 */
import { processWriters } from "./context";
import { runConsole } from "./runner";

// The tail is forwarded exactly as commander handed it over, `--` and all.
// commander passes a `--` through as a literal operand (verified: `gemi run x --
// --weird` arrives as `["--", "--weird"]`), and `parse.ts` already treats a `--`
// as "everything after this is positional". Stripping it here — which an earlier
// draft did — consumed the escape hatch before the only thing that reads it,
// leaving `-- --weird` reported as an unknown option and `-- --` the only way to
// pass a flag-shaped value.
const [name, ...argv] = process.argv.slice(2);

const writers = processWriters();

// `.then` rather than a top-level `await`, so this file typechecks under the
// package's inherited `module: NodeNext` — the same TS1309 that keeps `bun/` out
// of tsconfig.json's `include`. Bun runs it as ESM either way; this just avoids
// buying a nested tsconfig for two lines.
runConsole({ rootDir: process.cwd(), name, argv, writers }).then(
  async (code) => {
    // Everything written has to reach the OS before the exit below discards it —
    // see `processWriters` for what that costs when it is skipped.
    await writers.flush();

    // Explicit, and not belt-and-braces. `kernel.destroy()` stops the scheduler,
    // but an open database pool, a Redis client or an unref'd timer will happily
    // hold the loop open after the work is done — a command that finishes and then
    // sits there, which is the failure `kernel/exit.test.ts` exists for and the
    // one `orm/context.test.ts` names by example.
    process.exit(code);
  },
);
