import { describe, expect, test } from "vitest";

import { protocolSkewWarning } from "./protocol-skew";
import type { ModelSchema } from "./schema";

/**
 * The conditions under which a `DateTime` read is silently wrong, asserted one
 * at a time.
 *
 * Every one of them has to hold, and the reason to test them individually is
 * that three of the four are cheap comparisons which a later edit could reorder
 * or drop without any behavioural test noticing: the warning not firing is what
 * a correctly configured process looks like, so "no warning" cannot distinguish
 * a working guard from a deleted one.
 *
 * `offsetMinutes` is a parameter rather than read from the clock so these run
 * the same in CI — which sets `TZ=UTC`, the configuration where the fault does
 * not occur, and would otherwise be the one environment unable to test it.
 */
const field = (name: string, type: string) => ({
  name,
  column: name,
  type: type as never,
  nullable: false,
  isId: false,
  isUpdatedAt: false,
});

const withDates: ModelSchema = {
  name: "User",
  table: "User",
  fields: {
    id: field("id", "Int"),
    createdAt: field("createdAt", "DateTime"),
    updatedAt: field("updatedAt", "DateTime"),
  },
  primaryKey: ["id"],
  uniques: [],
  relations: {},
};

const noDates: ModelSchema = {
  ...withDates,
  name: "Tag",
  fields: { id: field("id", "Int"), label: field("label", "String") },
};

/** New York in March: five hours behind UTC. */
const NEW_YORK = 300;

describe("the protocol-skew warning fires only when the read is wrong", () => {
  test("a parameterless Postgres select of a DateTime, off UTC", () => {
    const warning = protocolSkewWarning(
      "postgres",
      withDates,
      `select "id", "createdAt" from "User"`,
      [],
      NEW_YORK,
    );

    expect(warning).toContain("User");
    expect(warning).toContain("createdAt");
    // The actionable half. A warning that only says something is wrong costs
    // the reader the same search this note exists to save them.
    expect(warning).toContain("TZ=UTC");
    expect(warning).toContain("binds no parameters");
  });

  test.each([
    ["SQLite is unaffected — it stores milliseconds", "sqlite", withDates, `select "createdAt" from "User"`, [], NEW_YORK],
    ["a bound parameter takes the extended protocol", "postgres", withDates, `select "createdAt" from "User" where "id" = $1`, [1], NEW_YORK],
    ["a UTC process decodes both paths alike", "postgres", withDates, `select "createdAt" from "User"`, [], 0],
    ["a model with no DateTime has nothing to skew", "postgres", noDates, `select "label" from "Tag"`, [], NEW_YORK],
    ["a write binds its values, and returns none unasked", "postgres", withDates, `delete from "User"`, [], NEW_YORK],
  ])("silent: %s", (_label, dialect, schema, text, values, offset) => {
    expect(
      protocolSkewWarning(dialect as string, schema as ModelSchema, text as string, values as unknown[], offset as number),
    ).toBeNull();
  });

  /** East of UTC as well as west: the sign is not what decides it. */
  test("fires for a positive offset too", () => {
    expect(
      protocolSkewWarning("postgres", withDates, `select "createdAt" from "User"`, [], -60),
    ).not.toBeNull();
  });
});
