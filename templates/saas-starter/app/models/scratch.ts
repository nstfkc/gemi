import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * How a model suite gets a database to run against, and nothing else.
 *
 * **Why this is not in `differential.ts`.** Both exports below used to live
 * there, next to `createDifferential`. Thirteen of the twenty suites in this
 * directory import from that module and only two of them want the differential
 * harness — the other eleven want an environment variable and a `CREATE TABLE`
 * runner. But `differential.ts` imports `@prisma/client` at module scope, so
 * every one of those eleven pulled a Prisma client into its worker *at
 * collection time*, before a single `describe` ran, to read
 * `process.env.TEST_POSTGRES_URL`.
 *
 * That is worth undoing on its own merits — the import is pure cost, paid once
 * per worker, in the phase where a failure takes the whole file's tests out of
 * the run rather than failing one of them. It is also the last removable
 * suspect for #217, whose failure is at import: a file whose 15 tests are
 * *absent* from the total rather than counted as skipped did not get as far as
 * a hook. This does not claim to be that bug's cause. It makes the surface it
 * could hide in eleven files smaller instead of thirteen.
 *
 * The rule that keeps it that way is asserted, not just written down here:
 * `packages/gemi/orm/template-import-graph.test.ts` fails if a suite imports
 * `./differential` without using `createDifferential`.
 *
 * So the constraint on this file is its import list: `bun`, `node:fs`,
 * `node:path`. Anything that needs a Prisma client belongs in `differential.ts`.
 */

/**
 * The scratch Postgres database the Postgres suites run against, or `undefined`
 * when only SQLite is being covered.
 *
 * The contract is that it names a database the suites may truncate: they clear
 * the tables they seed between cases, and several drop and recreate tables of
 * their own. Every suite gated on this skips loudly when it is unset — a
 * silently skipped dialect reads as a passing one.
 */
export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

/**
 * Replays the committed migrations into a fresh SQLite file, in name order —
 * which is Prisma's own ordering, since it prefixes every directory with a
 * timestamp. Statements are split on `;` at end of line, which is enough for
 * the DDL Prisma emits and involves no SQL parsing.
 *
 * Deliberately not `prisma db push --force-reset`: that command is destructive
 * by design, and a test has no business running it — this way there is never a
 * database that could be harmed, only one that is created.
 */
export async function applyMigrations(path: string): Promise<void> {
  const root = join(import.meta.dirname, "../../prisma/migrations");
  const sql = new SQL(`sqlite://${path}`);

  try {
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const directory of directories) {
      const file = join(root, directory, "migration.sql");
      const source = readFileSync(file, "utf8");
      for (const statement of source.split(/;\s*$/m)) {
        if (statement.trim() === "") continue;
        await sql.unsafe(statement);
      }
    }
  } finally {
    await sql.close();
  }
}
