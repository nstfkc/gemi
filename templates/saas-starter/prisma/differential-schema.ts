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
// schema.prisma plus the \`generator client\` block that gemi's differential test
// harness needs. The application's schema has no client block, so that an app
// installs \`prisma\` alone; this file exists so that gemi can still compare
// itself against Prisma. Re-run:
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

export function derive(source: string): string {
  return `${BANNER}${CLIENT_BLOCK}\n${source}`;
}

if (import.meta.main) {
  writeFileSync(DERIVED, derive(readFileSync(SOURCE, "utf8")), "utf8");
  console.log(`wrote ${DERIVED}`);
}
