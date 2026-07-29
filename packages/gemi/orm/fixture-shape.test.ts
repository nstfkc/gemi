import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A template test that builds a table named after a real model builds the same
 * table.
 *
 * The Postgres suites share one database, run with `--no-file-parallelism`, and
 * several of them create their own tables with raw DDL. Two things follow from
 * that, and only one of them was true.
 *
 * `relations.many-to-many.test.ts` creates `Post`, `Tag` and `_PostToTag`.
 * Those are real models in `schema.prisma`, and the DDL mirrors them exactly —
 * `id`/`title` and `id`/`label`. Dropping and recreating them is a no-op in
 * shape, which is why it works and why it is fine.
 *
 * `redact-strategies.test.ts` created a `Ledger` of `id`, `bookId`, `label`,
 * `secret`. The real `Ledger` is `tenantId`, `code`, `title` with a composite
 * primary key and a `LedgerEntry` pointing at it. That test could not run at
 * all — `cannot drop table "Ledger" because other objects depend on it` (#205)
 * — and had it dropped the dependants too, it would have replaced a table two
 * other suites write to with one of a different shape, and taken
 * `LedgerEntry`'s foreign key with it.
 *
 * The name collision is not the defect on its own; the shape mismatch is. So
 * that is what this checks, rather than banning the names — banning them would
 * fail the many-to-many suite, which is doing the right thing.
 *
 * It is a static comparison on purpose. The failure it exists to catch was
 * invisible for as long as the suite that would have hit it never ran, and a
 * check that needs a database to notice would have been just as quiet.
 */
const TEMPLATE = join(import.meta.dirname, "../../../templates/saas-starter");
const MODELS = join(TEMPLATE, "app/models");

/** Every model in the Prisma schema, to its scalar field names. */
const schemaModels = (() => {
  const source = readFileSync(join(TEMPLATE, "prisma/schema.prisma"), "utf8");
  const models = new Map<string, Set<string>>();

  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const fields = new Set<string>();
    for (const line of match[2].split("\n")) {
      const field = line.trim().match(/^(\w+)\s+\w/);
      // Relation fields carry a model type and no column; `@@id`/`@@index`
      // start with `@` and are skipped by the same rule.
      if (field && !/\[\]/.test(line)) fields.add(field[1]);
    }
    models.set(match[1], fields);
  }

  return models;
})();

/** Every `CREATE TABLE "X" (...)` in the template's tests, to its columns. */
const created = readdirSync(MODELS)
  .filter((file) => file.endsWith(".test.ts"))
  .flatMap((file) => {
    const source = readFileSync(join(MODELS, file), "utf8");
    return [
      ...source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"\s*\(([^`]*?)\)\s*`/gs),
    ].map(([, table, body]) => ({
      file,
      table,
      columns: new Set(
        body
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE)\b/i.test(line))
          .map((line) => line.match(/^"(\w+)"/)?.[1])
          .filter((name): name is string => Boolean(name)),
      ),
    }));
  });

/** Tables a test creates that share a name with a real model. */
const shadowing = created.filter(({ table }) => schemaModels.has(table));

describe("fixture tables named after real models match them", () => {
  test("the schema and the test DDL were both parsed", () => {
    expect(schemaModels.size).toBeGreaterThan(5);
    expect(created.length).toBeGreaterThan(5);
  });

  /**
   * Not an assertion that none exist — `Post` and `Tag` are deliberate, and the
   * many-to-many suite needs them. This only pins that the set is understood,
   * so a new one arrives as a visible change here rather than silently.
   */
  test("the shadowing set is the known one", () => {
    expect([...new Set(shadowing.map((entry) => entry.table))].sort()).toEqual([
      "Post",
      "Tag",
    ]);
  });

  test.each(shadowing.map((entry) => [`${entry.file}: ${entry.table}`, entry] as const))(
    "%s",
    (_label, entry) => {
      const model = schemaModels.get(entry.table)!;
      const missing = [...model].filter((field) => !entry.columns.has(field));
      const extra = [...entry.columns].filter((column) => !model.has(column));

      expect(
        { missing, extra },
        `${entry.file} creates a table called "${entry.table}", which is a real model in ` +
          `schema.prisma, with different columns. The Postgres suites share one database, ` +
          `so this replaces the real table for every suite that runs after it.`,
      ).toEqual({ missing: [], extra: [] });
    },
  );
});
