/**
 * The entry `gemi stats` (and `gemi build --stats`) spawns to read the app's
 * route table: `bun --preload gemi/bun/preload stats/route-table.ts <out>`.
 *
 * `gemi build` deliberately never boots the app (see `bin/createRollupInput`).
 * This doesn't either, in the sense that matters: it imports the Kernel and
 * runs only its synchronous `boot()`, which registers providers and constructs
 * nothing that does I/O. No provider `boot()`, no service, no database, no
 * queue claiming and no scheduler. Importing the app's route files is the one
 * side effect, the same one `gemi app:route-manifest` has.
 *
 * Exposed as `gemi/stats/route-table` and resolved from the application's
 * `node_modules`, like `gemi/console/run`: the routers the app's files extend
 * are the app's copy of gemi, so the code reading them has to be as well.
 *
 * The table is written to the file named by the first argument rather than to
 * stdout, which app code is free to log to while it is imported.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import type { Kernel } from "../kernel/Kernel";
import { collectRouteTable } from "./routeTable";

const out = process.argv[2];

async function main() {
  if (!out) throw new Error("usage: route-table <out.json>");
  const kernelPath = path.resolve(process.cwd(), "app/kernel/Kernel.ts");
  const module: { default?: new () => Kernel } = await import(kernelPath);
  if (typeof module.default !== "function") {
    throw new Error(`${kernelPath} has no default export (the Kernel subclass).`);
  }
  const kernel = new module.default();
  kernel.boot();
  try {
    writeFileSync(out, JSON.stringify(collectRouteTable(kernel)));
  } finally {
    kernel.destroy();
  }
}

// `.then` rather than a top-level `await`; see `console/run.ts`.
main().then(
  () => process.exit(0),
  (error) => {
    console.error((error as Error)?.stack ?? String(error));
    process.exit(1);
  },
);
