import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * **Every relation's foreign key is indexed**, which `docs/orm.md` promises on
 * this template's behalf.
 *
 * The promise is not decorative. A relation `_count`, a relation filter and a
 * relation ordering all compile to a correlated subquery that runs **once per
 * parent row**, so without an index each run scans the child table — and Prisma
 * declares no index for a relation's foreign key on either dialect, so by
 * default there is none.
 *
 * The docs put a number on it: on SQLite the index is worth enough to *flip*
 * the advice. Unindexed, `_count` is slower than loading the children and
 * counting them in JavaScript; indexed, it is comfortably faster. So a model
 * added without one does not make the template a little slower — it makes a
 * documented recommendation wrong.
 *
 * > The starter template indexes every foreign key for this reason, so a new
 * > application starts on the right side of it.
 *
 * That sentence is what this asserts. It held when written and holds now; what
 * it lacked was anything to keep it true as models are added, which is the same
 * drift #157 caught in the prose and #164 in the export surface.
 */
const SCHEMA = join(import.meta.dirname, "../../prisma/schema.prisma");

/** A model's body, keyed by name. */
function models(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/^model (\w+) \{(.*?)^\}/gms)) {
    out.set(match[1], match[2]);
  }
  return out;
}

/** The local columns each `@relation(fields: [...])` uses. */
function foreignKeys(body: string): string[][] {
  return [...body.matchAll(/@relation\([^)]*fields:\s*\[([^\]]*)\]/g)].map((match) =>
    match[1].split(",").map((name) => name.trim()).filter(Boolean),
  );
}

/**
 * Every column list the database will have an index for.
 *
 * `@@index`, `@@unique` and `@@id` all produce one, and so does a single-field
 * `@unique` or `@id` — a foreign key that is also the primary key needs no
 * separate index, which is the shape a one-to-one takes.
 */
function indexed(body: string): string[][] {
  const lists: string[][] = [];

  for (const pattern of [/@@index\(\[([^\]]*)\]/g, /@@unique\(\[([^\]]*)\]/g, /@@id\(\[([^\]]*)\]/g]) {
    for (const match of body.matchAll(pattern)) {
      lists.push(match[1].split(",").map((name) => name.trim()).filter(Boolean));
    }
  }

  for (const match of body.matchAll(/^\s*(\w+)\s+\S+[^\n]*@(?:unique|id)\b/gm)) {
    lists.push([match[1]]);
  }

  return lists;
}

describe("the template's foreign keys", () => {
  const source = readFileSync(SCHEMA, "utf8");
  const declared = models(source);

  test("the schema was parsed, or this asserts nothing", () => {
    expect(declared.size).toBeGreaterThan(5);
    expect([...declared.values()].some((body) => foreignKeys(body).length > 0)).toBe(true);
  });

  test("every relation's foreign key is covered by an index", () => {
    const uncovered: string[] = [];

    for (const [name, body] of declared) {
      const available = indexed(body);

      for (const key of foreignKeys(body)) {
        // A **prefix** match, because that is what a composite index serves: an
        // index on [a, b] answers a lookup on [a], and one on [b] does not.
        const covered = available.some(
          (list) =>
            list.length >= key.length &&
            key.every((column, position) => list[position] === column),
        );

        if (!covered) {
          uncovered.push(
            `${name}: @relation(fields: [${key.join(", ")}]) has no index with that prefix`,
          );
        }
      }
    }

    expect(uncovered, uncovered.join("\n")).toEqual([]);
  });
});
