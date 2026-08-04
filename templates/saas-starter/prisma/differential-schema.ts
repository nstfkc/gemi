/**
 * Derives `differential.prisma` from `schema.prisma`.
 *
 * The differential harness runs every query twice — once through gemi, once
 * through Prisma — and compares. That needs a generated Prisma client, which
 * needs a `generator client` block, which is exactly what `schema.prisma` must
 * not have: it is the schema an application starts from, and a client block
 * there would make every gemi app install `@prisma/client` to run
 * `prisma generate`.
 *
 * So the block lives here instead, appended to a copy. Derived rather than
 * maintained as a second file because the two must describe the *same* models
 * or the comparison is worthless — and a hand-kept duplicate drifts silently,
 * with the failure showing up as a differential test that passes because it
 * compared the wrong thing.
 *
 * The output is committed, like the ORM artifacts and for the same reason: CI
 * needs no codegen step before it can read the schema, and the diff stays
 * reviewable. `packages/gemi/orm/app-dependencies.test.ts` fails if it falls out
 * of date — it lives in the other package, because the invariant it guards is
 * the ORM's, and it imports `SCHEMAS` and `derive` from this file.
 *
 *     bun prisma/differential-schema.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every schema that needs a Prisma counterpart, and where its client goes.
 *
 * Two, because the scalar lists (#300) cannot live in the main schema — a
 * `String[]` is a validation error on SQLite, and that schema has its provider
 * flipped between dialects — so they have their own schema, their own client and
 * their own database. Both are in the same position: an application-facing
 * schema with no `generator client`, and a derived one that has nothing else.
 *
 * The client paths are explicit rather than the default
 * `node_modules/@prisma/client`, so it is obvious that these clients belong to
 * the test harness and not to the application, and so nothing in `app/` can
 * reach one by importing the bare package name.
 */
export const SCHEMAS = [
  {
    source: "schema.prisma",
    derived: "differential.prisma",
    client: "../app/models/prisma-client",
  },
  {
    source: "postgres-only.prisma",
    derived: "postgres-only-differential.prisma",
    client: "../app/models/generated-lists/client",
  },
] as const;

const at = (name: string) => join(import.meta.dirname, name);

const banner = (source: string) => `// Generated from ${source} by prisma/differential-schema.ts. Do not edit.
//
// ${source} with its \`generator gemi\` block swapped for a \`generator client\`
// one: the same models, generating a Prisma client instead of gemi's artifacts.
// The application's schema has no client block, so that an app installs
// \`prisma\` alone; this file exists so that gemi can still compare itself against
// Prisma. Re-run:
//
//     bun prisma/differential-schema.ts
`;

const clientBlock = (output: string) => `
generator client {
  provider        = "prisma-client-js"
  output          = "${output}"
  previewFeatures = ["driverAdapters"]
}
`;

/**
 * The gemi generator block, which this file must **not** carry.
 *
 * Two reasons, and the first one bit.
 *
 * `prisma generate` resolves a generator provider by *bin name*, looked up near
 * the working directory — and this schema has to be generated from the
 * repository root, because Prisma decides whether `@prisma/client` is installed
 * by reading the **cwd's** package.json and the template's deliberately no
 * longer names it. From the root, `gemi-orm-generator` resolved to something
 * other than this checkout's freshly built binary, and quietly rewrote
 * `app/models/generated` with an older emitter's output. Leaving the block out
 * means there is no second generator to resolve and nothing to get wrong.
 *
 * It would also be redundant: `bunx prisma generate` in the template already
 * emits those artifacts from `schema.prisma`, which is the run that proves the
 * client-free path works.
 *
 * **The comment lines immediately above it go too.** They explain why the
 * source has no `generator client` — "There is no `generator client` block, and
 * that is the point" — and carrying that into a file whose first declaration
 * *is* a client block leaves a committed artifact asserting the opposite of its
 * own contents, twelve lines apart. These files are marked `Do not edit.`, so
 * `derive` is the only place the contradiction can be fixed.
 */
const GEMI_BLOCK = /(?:^\/\/[^\n]*\n)*^generator\s+gemi\s*\{[^}]*\}\n?/m;

export function derive(
  contents: string,
  { source, client }: { source: string; client: string },
): string {
  const withoutGemi = contents.replace(GEMI_BLOCK, "");

  // A silent no-op here would produce a schema with two generators, one of which
  // resolves unpredictably — exactly the failure this strip exists to prevent.
  if (GEMI_BLOCK.test(withoutGemi) || withoutGemi === contents) {
    throw new Error(
      `differential-schema: could not remove the \`generator gemi\` block from ` +
        `${source}. It must be a single block with no nested braces.`,
    );
  }

  // An application-facing schema must not have carried a client block either —
  // that is the property this whole arrangement exists to hold, and deriving
  // from a source that already had one would produce a file with two.
  if (/^generator\s+client\s*\{/m.test(withoutGemi)) {
    throw new Error(
      `differential-schema: ${source} already declares a \`generator client\` ` +
        `block. An application's schema must not, so that an app installs ` +
        `\`prisma\` alone.`,
    );
  }

  return `${banner(source)}${clientBlock(client)}\n${withoutGemi}`;
}

if (import.meta.main) {
  for (const schema of SCHEMAS) {
    const contents = readFileSync(at(schema.source), "utf8");
    writeFileSync(at(schema.derived), derive(contents, schema), "utf8");
    console.log(`wrote ${schema.derived}`);
  }
}
