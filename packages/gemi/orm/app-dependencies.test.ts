import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { derive } from "../../../templates/saas-starter/prisma/differential-schema";

/**
 * **A gemi application installs `prisma` and not `@prisma/client`.**
 *
 * This is a property of the *template*, checked from here because the template
 * has no test runner of its own for it and because the invariant belongs to the
 * ORM: it is the whole reason `orm/types.ts` exists.
 *
 * The coupling it replaces was one type-only import. `app/models/generated/
 * models.ts` did `import type { Prisma } from "@prisma/client"` and built every
 * signature out of `Prisma.<M>FindManyArgs` and `Prisma.<M>GetPayload<T>`. Being
 * type-only, it was erased at build and never reached a bundle — and it still
 * had to *resolve* when the app typechecked, so every gemi app carried a 95MB
 * package and an 18MB query engine for types it never ran.
 *
 * Nothing outside gemi ever required it. The `prisma` CLI depends on
 * `@prisma/config` and `@prisma/engines`; `migrate dev`, `migrate deploy`,
 * `db push` and `migrate diff` all complete against a schema with no generator
 * block at all. The requirement was gemi's own, enforced by a check in the
 * generator that refused to run without `generator client`.
 *
 * Four things have to stay true together, and each fails differently:
 *
 *  - the template's manifest must not name `@prisma/client`, or a scaffolded app
 *    installs it whatever the generated code does;
 *  - `schema.prisma` must have no `generator client`, or `prisma generate` in a
 *    fresh app fails on a missing module;
 *  - the generated artifacts must import no Prisma package;
 *  - and the differential harness must still have a client to compare against,
 *    or the guarantee is bought by deleting the tests that check correctness.
 */
const TEMPLATE = join(import.meta.dirname, "../../../templates/saas-starter");

function read(relative: string): string {
  return readFileSync(join(TEMPLATE, relative), "utf8");
}

describe("the template an app is scaffolded from", () => {
  test("does not depend on @prisma/client", () => {
    const manifest = JSON.parse(read("package.json"));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };

    expect(
      Object.keys(declared),
      "the template declares @prisma/client, so every scaffolded app installs " +
        "it. gemi's differential harness needs one, but that is a gemi " +
        "development dependency and belongs in the workspace root's manifest.",
    ).not.toContain("@prisma/client");

    // The CLI stays: Prisma still owns the schema and the migrations, and an app
    // author runs `prisma migrate dev`. Asserted so that "remove the client" is
    // never read as "remove Prisma".
    expect(Object.keys(declared)).toContain("prisma");
  });

  test("its schema has no client generator, so `prisma generate` needs no client", () => {
    const schema = read("prisma/schema.prisma");

    // Comments in this file discuss the client block at length, so the check is
    // for a *declaration* rather than for the words.
    expect(schema).not.toMatch(/^generator\s+client\s*\{/m);
    expect(schema).toMatch(/^generator\s+gemi\s*\{/m);
  });

  test("its generated artifacts import no Prisma package", () => {
    for (const file of ["models.ts", "schema.ts", "index.ts"]) {
      const source = read(`app/models/generated/${file}`);
      const imports = [
        ...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm),
      ].map((match) => match[1]);

      expect(
        imports.filter((from) => from.startsWith("@prisma/")),
        `app/models/generated/${file} imports a Prisma package`,
      ).toEqual([]);
    }
  });

  /**
   * The harness keeps its client, and keeps it from one datamodel.
   *
   * `differential.prisma` is `schema.prisma` plus a client block, derived rather
   * than maintained. A hand-kept copy would drift, and the drift is invisible in
   * the worst way: the differential tests keep passing, having compared gemi
   * against a Prisma client built from different models.
   */
  test("the differential schema is in sync with the app schema", () => {
    expect(
      read("prisma/differential.prisma"),
      "prisma/differential.prisma is stale. Re-run: bun prisma/differential-schema.ts",
    ).toBe(derive(read("prisma/schema.prisma")));
  });
});
