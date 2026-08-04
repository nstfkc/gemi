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
 * reviewable. `differential-schema.test.ts` fails if it falls out of date.
 *
 *     bun prisma/differential-schema.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCE = join(import.meta.dirname, "schema.prisma");
export const DERIVED = join(import.meta.dirname, "differential.prisma");

/**
 * Where the harness's client is generated.
 *
 * An explicit path rather than the default `node_modules/@prisma/client`,
 * so it is obvious that this client belongs to the test harness and not to the
 * application — and so nothing in `app/` can reach it by importing the bare
 * package name.
 */
const CLIENT_OUTPUT = "../app/models/prisma-client";

const BANNER = `// Generated from schema.prisma by prisma/differential-schema.ts. Do not edit.
//
// schema.prisma with its \`generator gemi\` block swapped for a \`generator client\`
// one: the same models, generating a Prisma client instead of gemi's artifacts.
// The application's schema has no client block, so that an app installs
// \`prisma\` alone; this file exists so that gemi can still compare itself against
// Prisma. Re-run:
//
//     bun prisma/differential-schema.ts
`;

const CLIENT_BLOCK = `
generator client {
  provider        = "prisma-client-js"
  output          = "${CLIENT_OUTPUT}"
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
 */
const GEMI_BLOCK = /^generator\s+gemi\s*\{[^}]*\}\n?/m;

export function derive(source: string): string {
  const withoutGemi = source.replace(GEMI_BLOCK, "");

  // A silent no-op here would produce a schema with two generators, one of which
  // resolves unpredictably — exactly the failure this strip exists to prevent.
  if (GEMI_BLOCK.test(withoutGemi) || withoutGemi === source) {
    throw new Error(
      "differential-schema: could not remove the `generator gemi` block from " +
        "schema.prisma. It must be a single block with no nested braces.",
    );
  }

  return `${BANNER}${CLIENT_BLOCK}\n${withoutGemi}`;
}

if (import.meta.main) {
  writeFileSync(DERIVED, derive(readFileSync(SOURCE, "utf8")), "utf8");
  console.log(`wrote ${DERIVED}`);
}
