import { describe, expect, test } from "vitest";

import { assertPageArgument } from "./compile/paginate";
import { InvalidArgumentError } from "./errors";
import { MAX_SKIP, paginate } from "./page-args";

/**
 * The hostile inputs, which are the point of the whole file.
 *
 * Every entry is a value a query string can actually deliver — `req.search.get`
 * returns `string | string[]`, and a JSON body returns whatever was sent — and
 * every entry breaks `Number(...)` in its own way. They are listed once and used
 * by both suites below, because "the arithmetic is right" and "the compiler
 * accepts the result" are two different claims about the same set of values, and
 * the second is the one this helper exists to make.
 */
const HOSTILE: Array<[label: string, value: unknown]> = [
  ["a fraction", "2.5"],
  ["a negative", "-1"],
  ["a large negative", "-999999"],
  ["a word", "abc"],
  ["the empty string, which Number() reads as 0", ""],
  ["whitespace", "   "],
  ["an overflowing exponent, which Number() reads as Infinity", "1e400"],
  ["zero", "0"],
  ["absent", undefined],
  ["explicitly null, as JSON delivers it", null],
  ["a repeated query param", ["1", "2"]],
  ["a single repeated param, which Number() does coerce", ["2"]],
  ["an object", { page: 2 }],
  ["a boolean, which Number() reads as 1", true],
  ["a number that is already fractional", 2.5],
  ["NaN itself", Number.NaN],
  ["Infinity itself", Number.POSITIVE_INFINITY],
  ["a page past the exact-integer boundary", "1e300"],
  ["scientific notation a browser can send", "1e2"],
  ["a leading-plus integer", "+3"],
  ["a hex literal, which Number() accepts", "0x10"],
];

/**
 * **The assertion this file is for.**
 *
 * `assertPageArgument` (`compile/paginate.ts:64`) is the refusal `paginate`
 * exists to make unreachable: an integer `take`, an integer `skip`, and no
 * negative `skip`. Running the real validator over the real output — rather than
 * re-checking the arithmetic against a second copy of the same rules — is what
 * makes this a guarantee rather than a pair of implementations that agree.
 *
 * It is run over the cross product, because `page` and `perPage` reach different
 * clamps and the failure that motivated the helper is a *product*: `page: 0`
 * with a valid `perPage` computes `skip: -25`, which is refused, and no single
 * argument in that call is wrong on its own.
 */
describe("paginate cannot produce a value the compiler refuses", () => {
  const accepts = (args: { take: number; skip: number }) => {
    assertPageArgument("Post", "findMany", "take", "take", args.take);
    assertPageArgument("Post", "findMany", "skip", "skip", args.skip);
  };

  test.each(HOSTILE)("page: %s", (_label, page) => {
    expect(() => accepts(paginate({ page }))).not.toThrow();
  });

  test.each(HOSTILE)("perPage: %s", (_label, perPage) => {
    expect(() => accepts(paginate({ perPage }))).not.toThrow();
  });

  test.each(HOSTILE)("page and perPage both: %s", (_label, value) => {
    expect(() =>
      accepts(paginate({ page: value, perPage: value })),
    ).not.toThrow();
  });

  /**
   * ...including when the *options* are wrong, which is the case a caller
   * cannot see. `perPage: 0` there would otherwise return `take: 0` — an
   * integer, so nothing refuses it, and every page is empty for ever.
   */
  test.each(HOSTILE)("with a bad options.perPage: %s", (_label, value) => {
    expect(() =>
      accepts(paginate({ page: "2" }, { perPage: value as number })),
    ).not.toThrow();
  });

  test.each(HOSTILE)("with a bad options.maxPerPage: %s", (_label, value) => {
    expect(() =>
      accepts(paginate({ perPage: "50" }, { maxPerPage: value as number })),
    ).not.toThrow();
  });

  /**
   * The other half of the guarantee: a page is never empty. `take: 0` passes
   * `assertPageArgument` — it is an integer — so the check above cannot catch
   * it, and it is the quieter of the two failures.
   */
  test.each(HOSTILE)("take is at least 1, for %s", (_label, value) => {
    expect(paginate({ page: value, perPage: value }).take).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The proof that the suite above is not vacuous: the naive spelling gemi's own
 * documentation used to teach *does* get refused, for three of these inputs.
 *
 * Without this, "paginate's output is accepted" would pass equally well against
 * a helper that returned `{ take: 25, skip: 0 }` and ignored its arguments.
 */
describe("the spelling paginate replaces is refused", () => {
  test.each([
    ["a fraction", "2.5", "take"],
    ["an overflowing exponent", "1e400", "take"],
    ["a word", "abc", "take"],
  ] as const)("Number(%s) is not a take", (_label, raw, key) => {
    expect(() =>
      assertPageArgument("Post", "findMany", key, key, Number(raw)),
    ).toThrow(InvalidArgumentError);
  });

  /**
   * The `|| 1` in `Number(req.search.get("page")) || 1` rescues `?page=` and
   * `?page=0`, because both coerce to a falsy `0`. It does not rescue a
   * *negative* one, which is where that idiom turns a hand-edited link into a
   * refused `skip`.
   */
  test("a negative page through the naive arithmetic is a negative skip", () => {
    const perPage = 25;
    const page = Number("-1") || 1;
    expect(() =>
      assertPageArgument("Post", "findMany", "skip", "skip", (page - 1) * perPage),
    ).toThrow(InvalidArgumentError);

    // ...and the same query string through the helper is page one.
    expect(paginate({ page: "-1" })).toEqual({ take: 25, skip: 0 });
    expect(paginate({ page: "" })).toEqual({ take: 25, skip: 0 });
  });
});

/** The arithmetic itself, on the values a working link actually carries. */
describe("paginate's page arithmetic", () => {
  test.each([
    ["the first page", { page: "1" }, { take: 25, skip: 0 }],
    ["the second", { page: "2" }, { take: 25, skip: 25 }],
    ["the tenth", { page: "10" }, { take: 25, skip: 225 }],
    ["a number rather than a string", { page: 3 }, { take: 25, skip: 50 }],
    ["no arguments at all", {}, { take: 25, skip: 0 }],
    ["a page size", { page: "3", perPage: "10" }, { take: 10, skip: 20 }],
  ])("%s", (_label, args, expected) => {
    expect(paginate(args)).toEqual(expected);
  });

  test("a fractional page truncates toward zero, as Prisma does with take", () => {
    expect(paginate({ page: "2.9" })).toEqual(paginate({ page: "2" }));
    expect(paginate({ perPage: "10.9" }).take).toBe(10);
  });

  test.each([
    ["zero", "0"],
    ["negative", "-4"],
    ["a word", "abc"],
    ["empty", ""],
  ])("page %s is page one rather than a refusal", (_label, page) => {
    expect(paginate({ page })).toEqual({ take: 25, skip: 0 });
  });
});

describe("paginate's page size", () => {
  test("defaults to 25 — the number docs/controllers.md already taught", () => {
    expect(paginate({}).take).toBe(25);
  });

  test("a request cannot ask for the whole table", () => {
    expect(paginate({ perPage: "1000000" }).take).toBe(100);
  });

  test("an endpoint can raise the ceiling at the call site", () => {
    expect(paginate({ perPage: "500" }, { maxPerPage: 500 }).take).toBe(500);
  });

  /**
   * `Infinity` is the natural spelling of "no ceiling", and it used to be read
   * by the same rule that refuses a non-finite *request* — so an internal
   * export written to opt out of the cap silently got the default 100 back,
   * returned a plausible first page, and lost the rest without a word.
   *
   * The distinction is who wrote it: `?perPage=1e400` is hostile input and is
   * still refused, and this is the application saying so on purpose.
   */
  test("Infinity lifts the ceiling rather than falling back to the default", () => {
    expect(paginate({ perPage: "1000" }, { maxPerPage: Infinity }).take).toBe(1000);
  });

  test("...and the request still cannot spell Infinity itself", () => {
    // The guarantee has to survive the lifted ceiling: whatever comes back is
    // an integer the ORM accepts, so a hostile `perPage` falls to the default
    // rather than through the gap the option just opened.
    const lifted = paginate({ perPage: "1e400" }, { maxPerPage: Infinity });
    expect(lifted.take).toBe(25);
    expect(Number.isSafeInteger(lifted.take)).toBe(true);
  });

  test("the caller's default is used when the request names none", () => {
    expect(paginate({}, { perPage: 10 })).toEqual({ take: 10, skip: 0 });
    expect(paginate({ page: "2" }, { perPage: 10 })).toEqual({
      take: 10,
      skip: 10,
    });
  });

  /**
   * A default above the ceiling is a contradiction the caller wrote, and the
   * ceiling wins — the alternative is an `options` object whose two fields
   * disagree and whose behaviour depends on which one the reader noticed.
   */
  test("a default above the ceiling is clamped to the ceiling", () => {
    expect(paginate({}, { perPage: 500, maxPerPage: 50 }).take).toBe(50);
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 10.7],
  ])("a %s options.perPage still yields a usable page", (_label, perPage) => {
    const { take } = paginate({}, { perPage });
    expect(Number.isInteger(take)).toBe(true);
    expect(take).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The cap, which exists because `?page=1e300` is finite and therefore survives
 * every other check. Measured through Bun against SQLite: an offset of `1e18`
 * binds, `9223372036854775807` and `1e20` raise `SQLiteError: datatype
 * mismatch` — the same `SQLITE_MISMATCH` the fractional-`take` note records,
 * reached from the other end.
 */
describe("paginate caps skip at the exact-integer boundary", () => {
  test("a page nobody can count to is capped rather than bound", () => {
    const { skip } = paginate({ page: "1e300" });
    expect(skip).toBe(MAX_SKIP);
    expect(Number.isSafeInteger(skip)).toBe(true);
  });

  test.each(HOSTILE)("skip stays a safe integer, for %s", (_label, value) => {
    const { skip } = paginate({ page: value, perPage: value });
    expect(Number.isSafeInteger(skip)).toBe(true);
    expect(skip).toBeGreaterThanOrEqual(0);
  });

  test("an ordinary large page is not capped", () => {
    expect(paginate({ page: "1000000" })).toEqual({
      take: 25,
      skip: 24_999_975,
    });
  });
});

/**
 * `paginate` is reachable from `gemi/orm`, which is the only import path an
 * application has. The helper being correct and unexported would be the same
 * failure as not shipping it.
 */
describe("paginate is on the public surface", () => {
  test("gemi/orm exports it", async () => {
    const orm = await import("./index");
    expect(orm.paginate).toBe(paginate);
  });
});
