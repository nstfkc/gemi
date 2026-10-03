import { Database } from "bun:sqlite";
import { describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { InvalidArgumentError } from "../errors";
import { userWithProfile } from "../fixtures";
import { planKey } from "../plan";
import { compileRead } from "./read";

/**
 * The JSON key-exists filters (#664): `has_key`, `has_some_keys` and
 * `has_every_key`, on the column and at a `path`. The rows they select on a
 * real database are `templates/saas-starter/app/models/json-keys.test.ts`, on
 * both dialects; this file pins the SQL and the plan key.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

function where(args: any, dialect: any) {
  const { text } = compileRead(userWithProfile, "findMany", args, dialect);
  return text.slice(text.indexOf(" where ") + 7);
}

function bind(args: any, dialect: any) {
  return compileRead(userWithProfile, "findMany", args, dialect).bind(args);
}

describe("postgres", () => {
  test("has_key is `?` behind an object check", () => {
    const args = { where: { metadata: { has_key: "plan" } } };
    expect(where(args, postgres)).toBe(
      `(jsonb_typeof(("metadata")::jsonb) = 'object' and ("metadata")::jsonb ? $1::text)`,
    );
    expect(bind(args, postgres)).toEqual(["plan"]);
  });

  test("the list forms bind one text[] whatever their length", () => {
    const some = { where: { metadata: { has_some_keys: ["a", "b,c"] } } };
    expect(where(some, postgres)).toContain(`("metadata")::jsonb ?| $1::text[]`);
    expect(bind(some, postgres)).toEqual([`{"a","b,c"}`]);

    const every = { where: { metadata: { has_every_key: ["a"] } } };
    expect(where(every, postgres)).toContain(`("metadata")::jsonb ?& $1::text[]`);

    expect(
      planKey(postgres, "User", "findMany", { where: { metadata: { has_some_keys: ["a"] } } }),
    ).toBe(
      planKey(postgres, "User", "findMany", {
        where: { metadata: { has_some_keys: ["a", "b", "c"] } },
      }),
    );
  });

  test("at a path, the extracted value is tested", () => {
    const args = { where: { metadata: { path: ["billing"], has_key: "plan" } } };
    expect(where(args, postgres)).toBe(
      `(jsonb_typeof(("metadata" #> $1)::jsonb) = 'object' and ` +
        `("metadata" #> $2)::jsonb ? $3::text)`,
    );
    expect(bind(args, postgres)).toEqual([`{"billing"}`, `{"billing"}`, "plan"]);
  });
});

describe("sqlite", () => {
  test("has_key is a bound path lookup behind an object check", () => {
    const args = { where: { metadata: { has_key: "plan" } } };
    expect(where(args, sqlite)).toBe(
      `(json_type("metadata", ?) = 'object' and (json_type("metadata", ?) is not null))`,
    );
    expect(bind(args, sqlite)).toEqual(["$", `$."plan"`]);
  });

  test("a key is one quoted label, whatever it holds, and never SQL text", () => {
    const key = `a.b"c'); drop table x; --`;
    const args = { where: { metadata: { has_key: key } } };
    expect(where(args, sqlite)).not.toContain("drop");
    expect(bind(args, sqlite)[1]).toBe(`$.${JSON.stringify(key)}`);
  });

  test("the list forms are one term per key, joined by or / and", () => {
    const some = { where: { metadata: { has_some_keys: ["a", "b"] } } };
    expect(where(some, sqlite)).toBe(
      `(json_type("metadata", ?) = 'object' and ` +
        `(json_type("metadata", ?) is not null or json_type("metadata", ?) is not null))`,
    );
    expect(bind(some, sqlite)).toEqual(["$", `$."a"`, `$."b"`]);

    const every = { where: { metadata: { has_every_key: ["a", "b"] } } };
    expect(where(every, sqlite)).toContain(" is not null and json_type(");

    // One term per key, so the length is part of the plan key here.
    expect(
      planKey(sqlite, "User", "findMany", { where: { metadata: { has_some_keys: ["a"] } } }),
    ).not.toBe(
      planKey(sqlite, "User", "findMany", { where: { metadata: { has_some_keys: ["a", "b"] } } }),
    );
  });

  test("empty lists: some is false, every is 'is an object'", () => {
    expect(where({ where: { metadata: { has_some_keys: [] } } }, sqlite)).toBe(
      `(json_type("metadata", ?) = 'object' and (0))`,
    );
    expect(where({ where: { metadata: { has_every_key: [] } } }, sqlite)).toBe(
      `(json_type("metadata", ?) = 'object' and (1))`,
    );
  });

  test("at a path, the key is appended to it", () => {
    const args = { where: { metadata: { path: "$.billing", has_key: "plan" } } };
    expect(bind(args, sqlite)).toEqual(["$.billing", `$.billing."plan"`]);
  });

  /**
   * The SQL above, run. Includes a column named `value`, which is why the
   * lookup is a path rather than a correlated `json_each`: inside that subquery
   * `value` resolves to `json_each`'s own column and nothing matches.
   */
  test("selects the rows it says it does", () => {
    const db = new Database(":memory:");
    db.run(`create table t (id integer, "value" text)`);
    const rows: [number, unknown][] = [
      [1, { a: 1, b: null }],
      [2, { c: 1 }],
      [3, ["a"]],
      [4, { x: { a: 1 } }],
      [5, "a"],
      [6, null],
    ];
    for (const [id, doc] of rows) {
      db.run(`insert into t values (?, ?)`, [id, doc === null ? null : JSON.stringify(doc)]);
    }

    const ids = (fragment: { text: string; values: unknown[] }) =>
      (db.query(`select id from t where ${fragment.text} order by id`).all(
        ...(fragment.values as never[]),
      ) as { id: number }[]).map((row) => row.id);

    const run = (filter: Record<string, unknown>) => {
      const schema = {
        ...userWithProfile,
        table: "t",
        fields: {
          ...userWithProfile.fields,
          metadata: { ...userWithProfile.fields.metadata, column: "value" },
        },
      };
      const args = { where: { metadata: filter } };
      const plan = compileRead(schema, "findMany", args, sqlite);
      return ids({
        text: plan.text.slice(plan.text.indexOf(" where ") + 7),
        values: plan.bind(args),
      });
    };

    expect(run({ has_key: "a" })).toEqual([1]);
    expect(run({ has_key: "b" })).toEqual([1]); // a key holding null exists
    expect(run({ has_some_keys: ["b", "c"] })).toEqual([1, 2]);
    expect(run({ has_every_key: ["a", "b"] })).toEqual([1]);
    expect(run({ has_every_key: [] })).toEqual([1, 2, 4]);
    expect(run({ has_some_keys: [] })).toEqual([]);
    expect(run({ path: "$.x", has_key: "a" })).toEqual([4]);
    // `not` keeps the NULL column, as it does for every nullable filter.
    expect(run({ not: { has_key: "a" } })).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("both dialects", () => {
  test.each([
    ["has_key", 1],
    ["has_key", ["a"]],
    ["has_some_keys", "a"],
    ["has_every_key", [1]],
  ])("%s refuses %j when bound", (key, operand) => {
    for (const dialect of [sqlite, postgres]) {
      const args = { where: { metadata: { [key]: operand } } };
      expect(() => {
        bind(args, dialect);
      }).toThrow(InvalidArgumentError);
    }
  });

  test("only on a Json column", () => {
    for (const dialect of [sqlite, postgres]) {
      expect(() =>
        compileRead(userWithProfile, "findMany", { where: { name: { has_key: "a" } } }, dialect),
      ).toThrow(InvalidArgumentError);
    }
  });

  test("combines with another JSON filter on the same column", () => {
    const args = { where: { metadata: { has_key: "a", not: { equals: { a: 1 } } } } };
    expect(where(args, postgres)).toContain(" and ");
    expect(where(args, sqlite)).toContain(" and ");
  });
});
