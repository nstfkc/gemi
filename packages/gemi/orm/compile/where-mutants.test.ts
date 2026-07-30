import { beforeEach, describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import { InvalidArgumentError } from "../errors";
import { account, mapped, user } from "../fixtures";
import * as registry from "../registry";
import { compileRead } from "./read";

/**
 * Three branches of `where.ts` that nothing distinguished, found by mutation.
 *
 * Flipping each operator in the file and running the unit suite killed 44 of 49
 * mutants. Of the five that lived, one is a floor by the file's own account —
 * `the planner built a 'compositeIn' with no fields` sits under a comment saying
 * "these are its bugs rather than a caller's", so no caller can reach it — and
 * the other three were genuine: a guard, a skip, and an error message, each
 * doing something no assertion cared about.
 *
 * A survivor is a question rather than a defect, so each is written here as the
 * behaviour it protects rather than as "line N is uncovered".
 */
const sqlite = new SqliteDialect();

const text = (args: unknown) =>
  compileRead(user, "findMany" as never, args as never, sqlite).text;

/** `AuditLog.payload` is the fixtures' only `Json` column. */
const json = (args: unknown) =>
  compileRead(mapped, "findMany" as never, args as never, sqlite).text;

class DbNull {
  toString() {
    return "Prisma.DbNull";
  }
}

class JsonNull {
  toString() {
    return "Prisma.JsonNull";
  }
}

class AnyNull {
  toString() {
    return "Prisma.AnyNull";
  }
}

describe("branches of where.ts that mutation found unguarded", () => {
  beforeEach(() => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Account", class { static $schema = account });
    registry.register("AuditLog", class { static $schema = mapped });
  });

  /**
   * `typeof value !== "object" || Array.isArray(value)` — the array half was
   * covered and the scalar half was not, so `!==` could become `&&` and a
   * number would reach the relation planner as if it were a filter object.
   */
  test("a relation filter given a scalar is refused, not planned", () => {
    expect(() => text({ where: { accounts: 42 } })).toThrow(InvalidArgumentError);
    expect(() => text({ where: { accounts: "some" } })).toThrow(InvalidArgumentError);
  });

  /**
   * `operand === undefined || key === "mode"` — the `mode` half was covered.
   * Without the other, an explicitly `undefined` operand stops being skipped
   * and falls through to the unknown-operator check, turning a filter Prisma
   * treats as absent into an error.
   *
   * Prisma's rule is that `undefined` means "not supplied" wherever it appears,
   * which is what lets a caller build a filter conditionally without deleting
   * keys.
   */
  test("an explicitly undefined operand is absent, not an error", () => {
    expect(() => text({ where: { email: { contains: undefined } } })).not.toThrow();

    // ...and contributes no SQL, which is the half that says it was skipped
    // rather than compiled to something vacuous.
    expect(text({ where: { email: { contains: undefined } } })).not.toContain("like");
  });

  /**
   * The refusal for a bare `Json` sentinel names **which** sentinel it got, in
   * both places the message spells one. Mutation flipped the two ternaries
   * independently and nothing failed: a caller passing `JsonNull` could be told
   * to write `equals: Prisma.DbNull`, which stores a different value — advice
   * that is worse than no advice, since following it writes SQL NULL where the
   * caller meant a JSON null.
   */
  test.each([
    ["DbNull", new DbNull(), "JsonNull"],
    ["JsonNull", new JsonNull(), "DbNull"],
    ["AnyNull", new AnyNull(), "DbNull"],
  ])("a bare %s is refused naming %s, not the other one", (name, value, other) => {
    let message = "";
    try {
      json({ where: { payload: value } });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`Prisma.${name}`);
    expect(message).not.toContain(`Prisma.${other}`);
    // Both spellings in the sentence, so flipping either ternary is caught.
    expect(message.match(new RegExp(`Prisma\\.${name}`, "g"))).toHaveLength(2);
  });

  /**
   * `AnyNull` is the union of the other two, and the only sentinel whose filter
   * is not a single comparison.
   *
   * It was recognised by neither the map nor the refusal, so it fell through to
   * the data path: `JSON.stringify(Prisma.AnyNull)` is `{}` and the filter
   * compiled to `= '{}'` — the exact complement of the rows asked for, since no
   * row holding either null holds an empty object. That is #259.
   *
   * Each half is asserted, because either alone is a wrong answer that looks
   * like a right one: `is null` alone misses the JSON nulls and `= 'null'`
   * alone misses the SQL NULLs, and both return a plausible non-empty set.
   */
  test("equals: AnyNull asks for both nulls, not one of them", () => {
    const sql = json({ where: { payload: { equals: new AnyNull() } } });

    expect(sql).toContain('where ("payload" is null or "payload" = ?)');
  });

  /**
   * Negating it is only safe because the predicate above is *total*: `is null`
   * is never NULL, and when the column is non-NULL the second half is a proper
   * boolean. So no row falls through the way `not (col = value)` drops the
   * NULLs — which is the trap `compileNot` already documents for ordinary
   * values.
   */
  test("not: AnyNull negates the union rather than dropping the NULLs", () => {
    const sql = json({ where: { payload: { not: new AnyNull() } } });

    expect(sql).toContain('where not ("payload" is null or "payload" = ?)');
  });

  /**
   * Under anything else it has no meaning — Prisma's `JsonNullableFilter`
   * admits it beside `equals` and `not` and nowhere else, and `in` is not even
   * an option there (verified against 6.19.2: *"Unknown argument `in`"*).
   *
   * Refused where the field and operation are in scope rather than left to the
   * encoder's backstop, which reports it as an ORM bug — true of the backstop's
   * own callers and wrong to say to someone who wrote the query.
   */
  test.each([
    ["in", { in: [new AnyNull()] }],
    ["notIn", { notIn: [new AnyNull()] }],
    ["lt", { lt: new AnyNull() }],
  ])("AnyNull under '%s' is refused, and says which operators take it", (_key, filter) => {
    let message = "";
    try {
      json({ where: { payload: filter } });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArgumentError);
      message = (error as Error).message;
    }

    expect(message).toContain("Prisma.AnyNull");
    expect(message).toContain("equals");
    expect(message).toContain("not");
  });
});
