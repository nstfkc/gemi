import { cp } from "node:fs/promises";

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
 * This runs as a build step rather than living only in the source because
 * **`tsc` does not preserve `/// <reference path>` into declaration output** —
 * the line at the top of `client/index.ts` is gone from
 * `dist/client/index.d.ts`. Measured, not assumed.
 */

/**
 * The source barrels, which are what makes this work *without* a build: in this
 * repository the template resolves `gemi/*` at the TypeScript sources through
 * the workspace link, so the line at the top of each of these is the only thing
 * carrying the augmentation there.
 *
 * Checked rather than assumed, because the failure is invisible from both
 * sides. Deleting line 1 of `client/index.ts` leaves the *published* package
 * perfectly correct — this script re-adds the reference to `dist/` either way —
 * while every in-repo consumer silently loses its route types. The template has
 * no `typecheck` script and its `test:types` runs with
 * `--typecheck.ignoreSourceErrors`, so nothing else would report it.
 */
const SOURCE_ENTRYPOINTS = ["client/index.ts", "facades/index.ts"];

/** Their built counterparts, which is what an installed application reads. */
const DIST_ENTRYPOINTS = ["dist/client/index.d.ts", "dist/facades/index.d.ts"];

const REFERENCE = '/// <reference path="../gemi.d.ts" />';

function refuse(reason: string): never {
  console.error(`Refusing to wire the type augmentation: ${reason}`);
  process.exit(1);
}

for (const entrypoint of SOURCE_ENTRYPOINTS) {
  const contents = await Bun.file(entrypoint).text();
  if (!contents.includes(REFERENCE)) {
    refuse(
      `${entrypoint} does not reference ../gemi.d.ts. The published package would ` +
        `still be correct, and every consumer resolving gemi at source — the ` +
        `template in this repository — would silently lose its route types.`,
    );
  }
}

await cp("gemi.d.ts", "dist/gemi.d.ts");

for (const entrypoint of DIST_ENTRYPOINTS) {
  const file = Bun.file(entrypoint);
  if (!(await file.exists())) {
    refuse(
      `${entrypoint} was not built, so nothing would reference dist/gemi.d.ts ` +
        `and every application would silently lose its route types.`,
    );
  }

  const contents = await file.text();
  if (contents.includes(REFERENCE)) continue;
  await Bun.write(entrypoint, `${REFERENCE}\n${contents}`);

  // Inserting a line invalidates the sibling declaration map: every mapping
  // group is positional, so all of them now describe the line above the one
  // they belong to. A leading `;` — one empty group for the line just added —
  // shifts them back. Cheap to do and easy to forget, and the symptom would be
  // a go-to-definition that lands one line off.
  const mapPath = `${entrypoint}.map`;
  const mapFile = Bun.file(mapPath);
  if (!(await mapFile.exists())) continue;
  const map = await mapFile.json();
  if (typeof map.mappings === "string") {
    map.mappings = `;${map.mappings}`;
    await Bun.write(mapPath, JSON.stringify(map));
  }
}

console.log(`Wired dist/gemi.d.ts into ${DIST_ENTRYPOINTS.length} entrypoints`);
