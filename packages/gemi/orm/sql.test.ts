import { describe, expect, test } from "vitest";

import { PostgresDialect } from "./dialect/postgres";
import { SqliteDialect } from "./dialect/sqlite";
import { ParameterLimitError, UnsupportedQueryError } from "./errors";
import { AnyNull, DbNull, JsonNull } from "./json-null";
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
 * Whether a value is a fragment decides whether it reaches the *statement* or a
 * *parameter*, so answering it by shape makes that decision available to
 * anything that can name two properties — and `{"text": …, "binders": []}` is
 * two lines of JSON.
 *
 * These are the cases that were a live SQL injection through the intended call
 * site with the intended safe value:
 *
 *   const body = await request.json()
 *   DB.query(sql`select "email" from "User" where "email" = ${body.email}`)
 */
describe("only fragments this module made are spliced", () => {
  const forged = { text: `'' or 1=1`, binders: [] };

  test("a forged fragment binds as a value rather than splicing", () => {
    const { text, values } = render(sql`where "email" = ${forged}`);

    expect(text).toBe(`where "email" = $1`);
    expect(text).not.toContain("or 1=1");
    expect(values).toEqual([forged]);
  });

  test("...including one that would have leaked another column", () => {
    const attack = {
      text: `'' union select "password" from "User"`,
      binders: [],
    };
    const { text, values } = render(sql`where "email" = ${attack}`);

    expect(text).toBe(`where "email" = $1`);
    expect(text).not.toContain("password");
    expect(values).toEqual([attack]);
  });

  /**
   * `join` is the same door and slightly wider: `join(body.filters)` maps over
   * an array the caller never inspected.
   */
  test("join does not splice forged entries either", () => {
    const { text, values } = render(sql`where ${join([forged], " and ")}`);

    expect(text).toBe(`where $1`);
    expect(values).toEqual([forged]);
  });

  test("a forged fragment cannot be executed directly", () => {
    expect(() => render(forged)).toThrow(/built with 'sql'/);
  });

  /**
   * The brand has to survive composition, or the fix would trade an injection
   * for a mechanism that silently stopped nesting. `concat` and `joinFragments`
   * return *fresh* objects, which is why the registration is of what comes out
   * rather than a property on what goes in.
   */
  test("every constructor's output is spliceable, including through composition", () => {
    const nested = sql`"a" = ${1}`;
    const joined = join([sql`"b" = ${2}`, sql`"c" = ${3}`], " and ");
    const literal = unsafeSql("true");

    const { text, values } = render(
      sql`where ${nested} and ${joined} and ${literal} and ${empty}`,
    );

    expect(text).toBe(`where "a" = $1 and "b" = $2 and "c" = $3 and true and `);
    expect(values).toEqual([1, 2, 3]);
  });

  test("a fragment nested two levels deep still splices", () => {
    const inner = sql`"a" = ${1}`;
    const middle = sql`(${inner} or "b" = ${2})`;
    const { text, values } = render(sql`where ${middle}`);

    expect(text).toBe(`where ("a" = $1 or "b" = $2)`);
    expect(values).toEqual([1, 2]);
  });

  /**
   * A structurally-perfect copy of a real fragment — same text, same binders,
   * cloned rather than forged by hand. Shape cannot tell it from the original;
   * membership can.
   */
  test("a structural clone of a real fragment does not splice", () => {
    const real = sql`"a" = ${1}`;
    const clone = { text: real.text, binders: [...real.binders] };

    expect(render(sql`where ${real}`).text).toBe(`where "a" = $1`);
    expect(render(sql`where ${clone}`).text).toBe(`where $1`);
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

/**
 * ...with the one exception: a cast the caller wrote is a declared type.
 *
 * The statement that made this necessary is byte-identical under Prisma's
 * `$executeRaw` and under `DB.execute`, and did two different things — Prisma
 * sends a string parameter as `text` and lets Postgres parse it, while Bun is
 * told the parameter is `jsonb` and JSON-encodes the string, so the document is
 * stored as a jsonb *string*. `payload || $1::jsonb` then appends it as an array
 * element instead of merging. `json-param.ts` carries the measurements; these
 * pin the emitted statement, which is where the fix lives.
 */
describe("a parameter the caller cast to json", () => {
  const document = `{"version":1}`;

  test("the placeholder is retyped through text", () => {
    const fragment = sql`update "Job" set "payload" = "payload" || ${document}::jsonb where "id" = ${7}`;

    expect(render(fragment, postgres).text).toBe(
      `update "Job" set "payload" = "payload" || $1::text::jsonb where "id" = $2`,
    );
  });

  /**
   * The half a text assertion cannot see. `::text::jsonb` alone would still
   * mis-store an object — Bun sends `[object Object]` for one bound to a `text`
   * parameter — so the cast and the serialisation are one change, exactly as
   * `fieldParam` treats them.
   */
  test.each([
    ["a string is already JSON text", `{"a":1}`, `{"a":1}`],
    ["an object is serialised", { a: 1 }, `{"a":1}`],
    ["an array is serialised", [1, 2], `[1,2]`],
    ["a number is serialised", 42, `42`],
    ["a boolean is serialised", true, `true`],
    ["null stays SQL NULL", null, null],
    ["undefined stays SQL NULL", undefined, null],
  ])("%s", (_label, value, expected) => {
    expect(render(sql`${value}::jsonb`, postgres).values).toEqual([expected]);
  });

  /**
   * A string is handed over as it arrived, where `fieldParam` serialises one —
   * and that is which of the two Prisma does on each path, measured against
   * 6.19.2 rather than reasoned about:
   *
   *   create({ data: { payload: '{"a":1}' } })      -> the jsonb string
   *   $executeRaw`… values (${'{"a":1}'}::jsonb)`   -> the jsonb object
   *
   * The caller who wants the string writes the serialisation they mean.
   */
  test("a caller who wants the jsonb string serialises it themselves", () => {
    expect(render(sql`${JSON.stringify(document)}::jsonb`).values).toEqual([
      `"{\\"version\\":1}"`,
    ]);
  });

  test.each([
    ["spaces around the operator", sql`${document} :: jsonb`, `$1::text::jsonb`],
    ["the type in capitals", sql`${document}::JSONB`, `$1::text::JSONB`],
    ["json rather than jsonb", sql`${document}::json`, `$1::text::json`],
    [
      "the function spelling",
      sql`cast(${document} as jsonb)`,
      `cast($1 as text)::jsonb`,
    ],
    [
      "the spelling that was already right",
      sql`${document}::text::jsonb`,
      `$1::text::jsonb`,
    ],
  ])("%s is recognised", (_label, fragment, text) => {
    const rendered = render(fragment);
    expect(rendered.text).toBe(text);
    expect(rendered.values).toEqual([document]);
  });

  /**
   * The `::text::jsonb` row above is the one worth stating twice: the cast is
   * already correct and is left alone, but the *value* is still serialised, so
   * the two spellings mean the same thing rather than one of them being a
   * second trap.
   */
  test("an object at the already-correct spelling is serialised too", () => {
    expect(render(sql`${{ a: 1 }}::text::jsonb`).values).toEqual([`{"a":1}`]);
  });

  test.each([
    ["a cast to something else", sql`${document}::text`, [document]],
    ["an array of documents", sql`${[document]}::jsonb[]`, [[document]]],
    ["a jsonpath operand", sql`${document}::jsonpath`, [document]],
    [
      "`as jsonb)` with no cast( opening it",
      sql`select ${document} as jsonb)`,
      [document],
    ],
  ])("%s is left alone", (_label, fragment, values) => {
    expect(render(fragment).values).toEqual(values);
  });

  /**
   * **Postgres only, and the function spelling is why that had to become a
   * dialect capability rather than a property of the patterns.**
   *
   * The first version of this ran on both dialects, arguing that `::` is not
   * SQLite syntax and SQLite has no `jsonb`, so nothing could match a statement
   * SQLite could run. Half right. `::` really does not parse there — which is
   * why the `::jsonb` row below costs nothing either way and could never have
   * caught this. But SQLite's `CAST` accepts an *arbitrary* type name, so
   * `cast(? as json)` parses, runs, and means NUMERIC affinity; measured
   * through `bun:sqlite` (Bun 1.3.14):
   *
   *   select cast(? as jsonb)                            -> 0
   *   select json_set('{"a":1}','$.b', cast(? as json))   -> {"a":1,"b":2}
   *   select cast(? as text)::json                        -> unrecognized token: ":"
   *
   * So the rewrite turned a working SQLite statement into a syntax error. The
   * function-cast row is the one that pins the gate; `raw-sql.test.ts` runs the
   * same statement against a real SQLite database, because what a parser
   * accepts is not a claim emitted text can settle.
   */
  test.each([
    ["the function spelling", sql`cast(${document} as jsonb)`, `cast(? as jsonb)`],
    ["the operator spelling", sql`${document}::jsonb`, `?::jsonb`],
    ["json rather than jsonb", sql`cast(${document} as json)`, `cast(? as json)`],
  ])("%s is emitted unchanged on sqlite", (_label, fragment, text) => {
    expect(render(fragment, sqlite).text).toBe(text);
  });

  /**
   * ...and the value is not serialised either, which is the half a text
   * assertion cannot see. `cast(x as json)` on SQLite is a numeric coercion,
   * not a JSON parse, so serialising for it would be a wrong answer rather than
   * a redundant one.
   */
  test("the value is not serialised on sqlite", () => {
    expect(render(sql`cast(${document} as jsonb)`, sqlite).values).toEqual([
      document,
    ]);
    expect(render(sql`${42}::jsonb`, sqlite).values).toEqual([42]);
  });

  /**
   * The neighbour is the assertion: a `Date` still reaches `encodeUntyped`,
   * which passes one through on Postgres. Were its index in the json set it
   * would arrive as the ISO string `JSON.stringify` gives a `Date`, so the row
   * distinguishes "only the cast parameter" from "every parameter".
   */
  test("only the cast parameter is affected", () => {
    const at = new Date(1_700_000_000_000);
    const { text, values } = render(
      sql`update "Job" set "payload" = ${{ a: 1 }}::jsonb where "at" > ${at}`,
    );

    expect(text).toBe(
      `update "Job" set "payload" = $1::text::jsonb where "at" > $2`,
    );
    expect(values).toEqual([`{"a":1}`, at]);
  });

  /**
   * The cast is written by whoever assembles the *outer* statement, and the
   * value comes from a fragment built somewhere else — so this cannot be
   * decided where the value is interpolated. It is decided at render, over the
   * assembled text, which is the only place both halves exist.
   */
  test("a nested fragment's parameter is retyped by the outer cast", () => {
    const patch = sql`${{ a: 1 }}`;
    const { text, values } = render(
      sql`update "Job" set "payload" = "payload" || ${patch}::jsonb`,
    );

    expect(text).toBe(
      `update "Job" set "payload" = "payload" || $1::text::jsonb`,
    );
    expect(values).toEqual([`{"a":1}`]);
  });

  test("two of them in one statement, each retyped", () => {
    const { text, values } = render(
      sql`select cast(${{ a: 1 }} as jsonb) || ${{ b: 2 }}::jsonb`,
    );

    expect(text).toBe(`select cast($1 as text)::jsonb || $2::text::jsonb`);
    expect(values).toEqual([`{"a":1}`, `{"b":2}`]);
  });

  test.each([
    ["a bigint, which has no JSON form", 1n],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
  ])("%s is refused rather than bound", (_label, value) => {
    expect(() => render(sql`${value}::jsonb`)).toThrow(UnsupportedQueryError);
  });

  test("a circular structure names the parameter rather than JSON.stringify", () => {
    const cycle: any = {};
    cycle.self = cycle;

    expect(() => renderFragment(sql`${cycle}::jsonb`, postgres, "execute")).toThrow(
      /DB\.execute/,
    );
  });

  /**
   * Prisma's null sentinels, which `JSON.stringify` turns into `{}` — the same
   * mis-store `compile/cast.ts` handles for a typed column, reachable a second
   * way now that a raw parameter can be JSON.
   */
  test("the null sentinels mean what they mean on a typed column", () => {
    expect(render(sql`${DbNull}::jsonb`).values).toEqual([null]);
    expect(render(sql`${JsonNull}::jsonb`).values).toEqual(["null"]);
    expect(() => render(sql`${AnyNull}::jsonb`)).toThrow(UnsupportedQueryError);
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

  /**
   * The separator goes between the fragments *in the statement*, which makes it
   * the one other place a string could reach the SQL — and the module's whole
   * claim is that `unsafeSql` is the door. So it is glue or it is a fragment.
   */
  describe("the separator is text, so it is not a free string", () => {
    test.each([
      ["the default", undefined, `$1, $2`],
      ["a comma", ",", `$1,$2`],
      ["and", " and ", `$1 and $2`],
      ["or", " or ", `$1 or $2`],
      ["AND, cased differently", " AND ", `$1 AND $2`],
      ["a space", " ", `$1 $2`],
      ["nothing at all", "", `$1$2`],
      ["a newline and indentation", "\n  ", `$1\n  $2`],
    ])("%s is glue", (_label, separator, expected) => {
      const fragment =
        separator === undefined ? join([1, 2]) : join([1, 2], separator);
      expect(render(fragment).text).toBe(expected);
    });

    /**
     * The reported payload, and the reason this is an allowlist rather than a
     * blocklist: the second case carries no quote and no comment marker, so
     * "reject the dangerous characters" would have let it through.
     */
    test.each([
      [`) or 1=1 union select "password" from "User" -- `],
      [`) or 1=1 union select password from Users where 1=(1`],
      [`; drop table "User"; --`],
      [` union all select `],
    ])("%s is refused", (separator) => {
      expect(() => join([1, 2], separator)).toThrow(/may only be glue/);
      expect(() => join([1, 2], separator)).toThrow(/unsafeSql/);
    });

    test("a fragment separator is accepted, and is the escape hatch", () => {
      const { text, values } = render(
        join([sql`"a" = ${1}`, sql`"b" = ${2}`], unsafeSql(") and (")),
      );

      expect(text).toBe(`"a" = $1) and ("b" = $2`);
      expect(values).toEqual([1, 2]);
    });

    test("a fragment separator carries its own parameters, once per gap", () => {
      const { text, values } = render(join([sql`a`, sql`b`, sql`c`], sql` ${0} `));

      expect(text).toBe(`a $1 b $2 c`);
      expect(values).toEqual([0, 0]);
    });

    /**
     * A forged object is not a fragment, so it does not take the fragment path
     * — and it is not a string either, so it cannot pretend to be glue.
     */
    test("a forged fragment separator is refused rather than spliced", () => {
      expect(() =>
        join([1, 2], { text: ` or 1=1 -- `, binders: [] } as any),
      ).toThrow(/Expected a separator string or a fragment/);
    });

    test.each([
      ["a number", 7],
      ["null", null],
    ])("%s is refused", (_label, separator) => {
      expect(() => join([1, 2], separator as any)).toThrow(
        /Expected a separator string or a fragment/,
      );
    });
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
