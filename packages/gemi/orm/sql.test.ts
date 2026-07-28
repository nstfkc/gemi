import { describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { ParameterLimitError, UnsupportedQueryError } from "./errors";
import { empty, join, renderFragment, sql, unsafeSql } from "./sql";

/**
 * Composable SQL fragments.
 *
 * The property that matters is not that `sql` produces a string — it is that a
 * value *never* reaches the text, however deeply the fragments nest and however
 * many times one is reused. So every case here asserts the emitted text and the
 * bound values together: a test that checked only the text would pass for an
 * implementation that interpolated, which is the one failure this exists to
 * prevent.
 */

const postgres = new PostgresDialect();
const sqlite = new SqliteDialect();

const render = (fragment: any, dialect = postgres) =>
  renderFragment(fragment, dialect);

describe("sql", () => {
  test("a value becomes a placeholder, not text", () => {
    const { text, values } = render(sql`select * from "User" where "id" = ${7}`);

    expect(text).toBe(`select * from "User" where "id" = $1`);
    expect(values).toEqual([7]);
  });

  test("the value is never in the text, even when it looks like SQL", () => {
    const injected = `1; drop table "User"; --`;
    const { text, values } = render(sql`where "name" = ${injected}`);

    expect(text).toBe(`where "name" = $1`);
    expect(text).not.toContain("drop table");
    expect(values).toEqual([injected]);
  });

  test("fragments nest, and the placeholders renumber across them", () => {
    const a = sql`"a" = ${1}`;
    const b = sql`"b" = ${2}`;
    const { text, values } = render(sql`where ${a} and ${b} and "c" = ${3}`);

    expect(text).toBe(`where "a" = $1 and "b" = $2 and "c" = $3`);
    expect(values).toEqual([1, 2, 3]);
  });

  test("nesting is not depth-limited", () => {
    let fragment = sql`${0}`;
    for (let i = 1; i < 20; i++) fragment = sql`(${fragment} + ${i})`;

    const { values } = render(fragment);
    expect(values).toHaveLength(20);
    expect(values[0]).toBe(0);
    expect(values[19]).toBe(19);
  });

  /**
   * The hard case from the issue: one fragment built once and interpolated
   * twice, in different clauses. Its parameters have to appear at *both*
   * positions, in the right order — a fragment that cached its own placeholder
   * numbers would get the second occurrence wrong.
   */
  test("a fragment reused twice binds twice, in position", () => {
    const window = sql`"createdAt" > ${100}`;
    const { text, values } = render(
      sql`select array_agg("id") filter (where ${window}) from "Job" where ${window}`,
    );

    expect(text).toBe(
      `select array_agg("id") filter (where "createdAt" > $1) from "Job" ` +
        `where "createdAt" > $2`,
    );
    expect(values).toEqual([100, 100]);
  });

  test("an array binds as one value rather than expanding", () => {
    const { text, values } = render(sql`where "id" = any(${[1, 2, 3]})`);

    expect(text).toBe(`where "id" = any($1)`);
    expect(values).toEqual([[1, 2, 3]]);
  });

  // `undefined` is the one that is not itself on the way out — it binds as
  // `null`, since a driver has no other reading of it. The rest are values.
  test.each([
    ["null", null, null],
    ["undefined", undefined, null],
    ["a date", new Date(0), new Date(0)],
    ["false", false, false],
    ["zero", 0, 0],
    ["an empty string", "", ""],
  ])("%s is a bound value like any other", (_label, value, bound) => {
    const { text, values } = render(sql`where "x" = ${value}`);

    expect(text).toBe(`where "x" = $1`);
    expect(values).toEqual([bound]);
  });

  test("called as a function rather than a tag, it says so", () => {
    expect(() => (sql as any)(`select 1`)).toThrow(UnsupportedQueryError);
    expect(() => (sql as any)(`select 1`)).toThrow(/tagged template/);
    // ...and points at the thing the caller was probably reaching for.
    expect(() => (sql as any)(`select 1`)).toThrow(/unsafeSql/);
  });
});

describe("the dialects renumber differently, which is the whole reason for render", () => {
  test("postgres numbers, sqlite does not", () => {
    const fragment = sql`where "a" = ${1} and "b" = ${2}`;

    expect(render(fragment, postgres).text).toBe(`where "a" = $1 and "b" = $2`);
    expect(render(fragment, sqlite).text).toBe(`where "a" = ? and "b" = ?`);
  });

  /**
   * The same fragment object rendered for both dialects, in that order. A
   * fragment that memoised its rendered text — an obvious optimisation — would
   * hand the second caller the first one's placeholders, and on SQLite `$1` is
   * a syntax error rather than a wrong answer, which is at least loud. The
   * reverse order is not.
   */
  test("a fragment can be rendered for both dialects, in either order", () => {
    const fragment = sql`where "a" = ${1}`;

    expect(render(fragment, sqlite).text).toBe(`where "a" = ?`);
    expect(render(fragment, postgres).text).toBe(`where "a" = $1`);
    expect(render(fragment, sqlite).text).toBe(`where "a" = ?`);
  });

  test("the parameter ceiling applies, and names the dialect", () => {
    const many = Array.from({ length: 40_000 }, (_, i) => i);
    expect(() => render(sql`where "id" in (${join(many)})`, sqlite)).toThrow(
      ParameterLimitError,
    );
    // Postgres has the same ceiling shape at a different number; 40 000 clears
    // SQLite's 32 766 and not Postgres's 65 535, which is why this pair
    // discriminates rather than just asserting "it throws".
    expect(() =>
      render(sql`where "id" in (${join(many)})`, postgres),
    ).not.toThrow();
  });
});

/**
 * A fragment's parameters have no declared column type, so there is no `encode`
 * to run — and doing nothing at all would make the escape hatch work on one
 * dialect and throw on the other, which is the one thing "raw" must not mean.
 */
describe("values with no column type behind them", () => {
  const at = new Date(1_700_000_000_000);

  test("a Date binds as milliseconds on sqlite and as itself on postgres", () => {
    const fragment = sql`where "createdAt" > ${at}`;

    // Exactly what `SqliteDialect.encode` writes for a DateTime, so a raw
    // statement compares against ORM-written rows rather than against nothing.
    expect(render(fragment, sqlite).values).toEqual([at.getTime()]);
    // Bun's Postgres driver binds a `Date` natively; converting would be wrong.
    expect(render(fragment, postgres).values).toEqual([at]);
  });

  test("a boolean is 0/1 on sqlite and a boolean on postgres", () => {
    const fragment = sql`where "flag" = ${true} or "flag" = ${false}`;

    expect(render(fragment, sqlite).values).toEqual([1, 0]);
    expect(render(fragment, postgres).values).toEqual([true, false]);
  });

  test.each([
    ["a string", "x"],
    ["a number", 7],
    ["a bigint", 9007199254740993n],
    ["null", null],
  ])("%s is handed to the driver as it arrived", (_label, value) => {
    expect(render(sql`${value}`, sqlite).values).toEqual([value]);
    expect(render(sql`${value}`, postgres).values).toEqual([value]);
  });

  /**
   * Deliberately *not* converted. The compiler only JSON-encodes because a
   * field says `Json`; guessing from the value would turn a mistyped parameter
   * into a successfully-written string, which is worse than the driver
   * rejecting it.
   */
  test("a plain object is not JSON-encoded on the caller's behalf", () => {
    const payload = { a: 1 };

    expect(render(sql`${payload}`, sqlite).values).toEqual([payload]);
    expect(render(sql`${payload}`, postgres).values).toEqual([payload]);
  });

  test("undefined becomes null rather than reaching the driver", () => {
    expect(render(sql`${undefined}`, sqlite).values).toEqual([null]);
    expect(render(sql`${undefined}`, postgres).values).toEqual([null]);
  });
});

describe("join", () => {
  test("fragments joined by a separator", () => {
    const filters = [sql`"a" = ${1}`, sql`"b" = ${2}`, sql`"c" = ${3}`];
    const { text, values } = render(sql`where ${join(filters, " and ")}`);

    expect(text).toBe(`where "a" = $1 and "b" = $2 and "c" = $3`);
    expect(values).toEqual([1, 2, 3]);
  });

  test("plain values are bound, one placeholder each", () => {
    const { text, values } = render(sql`where "id" in (${join([1, 2, 3])})`);

    expect(text).toBe(`where "id" in ($1, $2, $3)`);
    expect(values).toEqual([1, 2, 3]);
  });

  test("the default separator is a comma", () => {
    expect(render(sql`${join([sql`a`, sql`b`])}`).text).toBe(`a, b`);
  });

  /**
   * The case the caller forgets. `join([])` has to be `empty` rather than a
   * separator or a throw, or a conditional filter list that turned out to be
   * empty emits `where ` and fails at the database instead of composing.
   */
  test("an empty list is empty, not a dangling separator", () => {
    expect(render(join([])).text).toBe("");
    expect(render(join([], " and ")).text).toBe("");
  });

  test("a mixed list of fragments and values works", () => {
    const { text, values } = render(join([sql`"a" = ${1}`, 2], " and "));

    expect(text).toBe(`"a" = $1 and $2`);
    expect(values).toEqual([1, 2]);
  });

  test("something that is not an array is refused", () => {
    expect(() => (join as any)("a and b")).toThrow(/Expected an array/);
  });
});

describe("empty", () => {
  test("contributes nothing and binds nothing", () => {
    const { text, values } = render(sql`select 1 ${empty}`);

    expect(text).toBe(`select 1 `);
    expect(values).toEqual([]);
  });

  /**
   * The shape the whole thing is for: a conditional predicate is a *value*, so
   * both branches are the same expression rather than two statements.
   */
  test("a conditional predicate is one expression either way", () => {
    const build = (q?: string) =>
      sql`select * from "Product" ${q ? sql`where "name" = ${q}` : empty}`;

    expect(render(build("axle")).values).toEqual(["axle"]);
    expect(render(build()).values).toEqual([]);
    expect(render(build()).text).toBe(`select * from "Product" `);
  });

  test("it is frozen, since every caller shares the one object", () => {
    expect(Object.isFrozen(empty)).toBe(true);
    // And composing with it does not mutate it, which is the failure freezing
    // is there to make loud rather than the reason it matters.
    render(sql`${empty} ${empty}`);
    expect(empty.text).toBe("");
    expect(empty.binders).toHaveLength(0);
  });
});

describe("unsafeSql", () => {
  test("text lands in the statement, with no parameter around it", () => {
    const { text, values } = render(
      sql`where "name" is distinct from ${unsafeSql(`'reaper'`)}`,
    );

    expect(text).toBe(`where "name" is distinct from 'reaper'`);
    expect(values).toEqual([]);
  });

  test("it composes like any other fragment", () => {
    const direction = unsafeSql("desc");
    const { text, values } = render(
      sql`select * from "Job" where "id" > ${1} order by "createdAt" ${direction}`,
    );

    expect(text).toBe(
      `select * from "Job" where "id" > $1 order by "createdAt" desc`,
    );
    expect(values).toEqual([1]);
  });

  /**
   * It is a plain call, never a tag. As a tagged template it would take
   * `${value}` interpolations and put them straight into the SQL text, which is
   * precisely the one thing it must not offer — and the mistake is invisible at
   * the call site, since both spellings read the same.
   */
  test("used as a tagged template, it refuses", () => {
    expect(() => (unsafeSql as any)`select ${1}`).toThrow(
      UnsupportedQueryError,
    );
    expect(() => (unsafeSql as any)`select ${1}`).toThrow(/not a tagged template/);
  });

  test.each([
    ["a number", 1],
    ["an object", {}],
    ["null", null],
    ["undefined", undefined],
  ])("%s is refused", (_label, value) => {
    expect(() => (unsafeSql as any)(value)).toThrow(/Expected a string literal/);
  });
});

describe("renderFragment", () => {
  /**
   * A plain string is refused rather than accepted as "obviously safe SQL".
   * Accepting one would make an interpolated template literal the path of least
   * resistance into `DB.query`, and that path is the injection every other rule
   * in the compiler exists to keep closed.
   */
  test.each([
    ["a string", `select 1`],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { text: 1 }],
  ])("%s is not a fragment", (_label, value) => {
    expect(() => render(value)).toThrow(UnsupportedQueryError);
    expect(() => render(value)).toThrow(/built with 'sql'/);
  });

  test("the operation name reaches the error", () => {
    expect(() => renderFragment("nope" as any, postgres, "execute")).toThrow(
      /DB\.execute/,
    );
  });
});
