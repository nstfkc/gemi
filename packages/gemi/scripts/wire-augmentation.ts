import { cp } from "node:fs/promises";
import { join } from "node:path";

/**
 * Puts `gemi.d.ts` into `dist/`, and points the built entrypoints at it.
 *
 * `gemi.d.ts` is what gives an application its own route, view and dictionary
 * types — it augments `RPC` / `ViewRPC` with `CreateRPC<Api>` and friends. An
 * application should never have to wire that up: it is entirely conventional,
 * the developer contributes nothing to it, and a new capability added here
 * would otherwise mean asking every application to edit a file it never wrote.
 *
 * So the entrypoints reference it themselves, and importing anything from
 * `gemi/client` or `gemi/facades` is all it takes.
 *
 * This runs as a build step rather than living in the source because **`tsc`
 * does not preserve `/// <reference path>` into declaration output** — the line
 * at the top of `client/index.ts` is gone from `dist/client/index.d.ts`.
 * Measured, not assumed. The source copies are still worth having: in this
 * repository the template resolves `gemi/*` at the TypeScript sources through
 * the workspace link, so they are what makes the template work without a build.
 */
const ENTRYPOINTS = ["dist/client/index.d.ts", "dist/facades/index.d.ts"];
const REFERENCE = '/// <reference path="../gemi.d.ts" />';

await cp("gemi.d.ts", "dist/gemi.d.ts");

for (const entrypoint of ENTRYPOINTS) {
  const file = Bun.file(entrypoint);
  if (!(await file.exists())) {
    console.error(
      `Refusing to wire the type augmentation: ${entrypoint} was not built, so ` +
        `nothing would reference dist/gemi.d.ts and every application would ` +
        `silently lose its route types.`,
    );
    process.exit(1);
  }
  const contents = await file.text();
  if (contents.includes(REFERENCE)) continue;
  await Bun.write(entrypoint, `${REFERENCE}\n${contents}`);
}

console.log(`Wired dist/gemi.d.ts into ${ENTRYPOINTS.length} entrypoints`);
