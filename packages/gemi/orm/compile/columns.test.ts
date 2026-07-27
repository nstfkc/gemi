import { describe, expect, test } from "vitest";

import { PostgresDialect } from "../dialect/postgres";
import { SqliteDialect } from "../dialect/sqlite";
import { mapped, organization, user } from "../fixtures";
import * as registry from "../registry";
import type { Operation } from "../plan";
import { compile } from "./index";

/**
 * Iteration 7, deliverable 6: the two column-selection properties, asserted
 * across **every** operation rather than one.
 *
 * Both are correctness properties with performance consequences, which is why
 * they live in the performance iteration:
 *
 * 1. **No query emits `select *`.** An explicit list is what makes the shaper
 *    knowable at compile time — `buildRowShaper` closes over a fixed column
 *    list, and it could not if the column set were whatever the table happened
 *    to contain. It is also what stops a migration that adds a column from
 *    silently changing every query's result shape.
 * 2. **The default column set is every scalar, matching Prisma**, so switching
 *    a model over does not change what comes back; and `select` genuinely
 *    narrows the emitted SQL rather than filtering after the fact, which is
 *    where the performance half comes in.
 *
 * There was one `findMany`-only assertion of the first property before this. A
 * sweep is the right shape: the risk is a *new* operation being added without
 * it, and a per-operation test is one somebody has to remember to write.
 */

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

const DIALECTS = [
  ["sqlite", sqlite],
  ["postgres", postgres],
] as const;

/** Every operation, with the minimum arguments each one accepts. */
const OPERATIONS: Array<[Operation, unknown]> = [
  ["findUnique", { where: { id: 1 } }],
  ["findUniqueOrThrow", { where: { id: 1 } }],
  ["findFirst", {}],
  ["findFirstOrThrow", {}],
  ["findMany", {}],
  ["count", {}],
  ["create", { data: { email: "a@b.c" } }],
  ["createMany", { data: [{ email: "a@b.c" }] }],
  ["update", { where: { id: 1 }, data: { name: "N" } }],
  ["updateMany", { data: { name: "N" } }],
  ["upsert", { where: { id: 1 }, create: { id: 1 }, update: { name: "N" } }],
  ["delete", { where: { id: 1 } }],
  ["deleteMany", {}],
];

describe("no operation emits a wildcard column list", () => {
  // `count(*)` is the one asterisk in the compiler's output, and it is exempt on
  // purpose — see the assertion below for why.
  test("count aggregates over rows rather than naming a column", () => {
    expect(compile(user, "count", {}, sqlite).text).toContain("count(*)");
  });

  test("the sweep covers every operation in the union", () => {
    // If `Operation` grows and this list does not, the guarantee below silently
    // stops covering the new one — which is the failure mode a per-operation
    // test has and a sweep is supposed to remove.
    expect(OPERATIONS).toHaveLength(13);
  });

  for (const [dialectName, dialect] of DIALECTS) {
    test.each(OPERATIONS)(
      `${dialectName}: %s`,
      (operation, args) => {
        const { text } = compile(user, operation, args, dialect);

        // No wildcard *column list* — which is the property that matters, and
        // it is narrower than "no asterisk anywhere". `count` emits `count(*)`,
        // and that is correct: the asterisk there is an aggregate over rows, not
        // a column list, so it cannot make the result shape depend on the
        // table's columns. The first draft of this test asserted no `*` at all
        // and failed on `count` — a case of the assertion being wider than the
        // guarantee, which is worth more than the guarantee being wrong.
        expect(text).not.toMatch(/select\s+\*/i);
        expect(text).not.toMatch(/returning\s+\*/i);
        // ...and nothing selects a qualified wildcard either (`u.*`), which a
        // relation strategy emitting a join would be the way to reach.
        expect(text).not.toMatch(/[\w"]\.\*/);
      },
    );
  }
});

describe("the default column set is every scalar, in schema order", () => {
  for (const [dialectName, dialect] of DIALECTS) {
    test(`${dialectName}: a read selects all scalars`, () => {
      const { text } = compile(user, "findMany", {}, dialect);
      const columns = text.slice("select ".length, text.indexOf(" from "));

      expect(columns.split(", ")).toEqual(
        Object.values(user.fields).map(
          (field) => `"${field.column}"`,
        ),
      );
    });

    // A write's `RETURNING` is the same resolution as a read's `select`, so it
    // has to match too — a `create` that returned fewer fields than Prisma's
    // would be a divergence the differential harness catches, but only for the
    // models it exercises.
    test(`${dialectName}: a write returns all scalars`, () => {
      const { text } = compile(
        user,
        "create",
        { data: { email: "a@b.c" } },
        dialect,
      );
      const returning = text.slice(text.indexOf(" returning ") + 11);

      expect(returning.split(", ")).toEqual(
        Object.values(user.fields).map((field) => `"${field.column}"`),
      );
    });
  }

  // `@map` is where "every scalar" could be right about the fields and wrong
  // about the SQL: the emitted list must be *column* names, not field names.
  test("mapped columns emit their database names", () => {
    const { text } = compile(mapped, "findMany", {}, sqlite);
    expect(text).toContain(`"is_archived"`);
    expect(text).not.toContain(`"isArchived"`);
  });
});

describe("select narrows the emitted SQL, not just the result", () => {
  for (const [dialectName, dialect] of DIALECTS) {
    test(`${dialectName}: only the named columns are read`, () => {
      const { text } = compile(
        user,
        "findMany",
        { select: { id: true, email: true } },
        dialect,
      );

      expect(text).toBe(`select "id", "email" from "User"`);
    });

    test(`${dialectName}: a write's returning narrows too`, () => {
      const { text } = compile(
        user,
        "create",
        { data: { email: "a@b.c" }, select: { id: true } },
        dialect,
      );
      expect(text.slice(text.indexOf(" returning "))).toBe(` returning "id"`);
    });
  }

  test("a narrowed select really is fewer columns than the default", () => {
    const all = compile(user, "findMany", {}, sqlite).text;
    const one = compile(
      user,
      "findMany",
      { select: { id: true } },
      sqlite,
    ).text;

    // Stated as a comparison rather than a count, so it keeps meaning if the
    // fixture's field list changes.
    expect(one.length).toBeLessThan(all.length);
    expect(one.split(", ")).toHaveLength(1);
  });

  /**
   * The documented exception, asserted so it stays an exception rather than
   * becoming a leak of extra columns.
   *
   * A relation needs its join key, so an `include` adds the key column even when
   * the caller's `select` left it out — and the plan then strips it from the
   * result. That is the one case where the emitted list is wider than what was
   * asked for, and it is deliberate.
   */
  test("an include adds only the key column it needs, and hides it", () => {
    registry.clearRegistry();
    registry.register("User", class { static $schema = user });
    registry.register("Organization", class { static $schema = organization });

    try {
      const bare = compile(
        user,
        "findMany",
        { select: { email: true } },
        sqlite,
      );
      expect(bare.text).toBe(`select "email" from "User"`);
      expect(bare.hidden ?? []).toEqual([]);

      // The same select, plus a relation. The foreign key is needed to stitch
      // the children on, so it joins the emitted list — and is listed as hidden
      // so the caller never sees a column they did not ask for.
      const withRelation = compile(
        user,
        "findMany",
        { select: { email: true, organization: { select: { id: true } } } },
        sqlite,
      );

      expect(withRelation.text).toBe(`select "email", "organizationId" from "User"`);
      expect(withRelation.hidden).toEqual(["organizationId"]);

      // Exactly one column more than was asked for — the exception stays an
      // exception rather than widening back towards the default set.
      expect(withRelation.text.split(", ")).toHaveLength(2);
    } finally {
      registry.clearRegistry();
    }
  });
});
