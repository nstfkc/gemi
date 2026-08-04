import { describe, expect, test } from "vitest";

import {
  clockCouldSkew,
  createProtocolSkewWarner,
  protocolSkewWarning,
} from "./protocol-skew";
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

/** The statement that meets every condition, so only the gate is in question. */
const SKEWING_READ = `select "id", "createdAt" from "User"`;

/**
 * The gate `Model.ts` resolves once, at module load.
 *
 * It is asked of a named zone here for the same reason `offsetMinutes` is a
 * parameter above: CI runs `TZ=UTC`, so a gate read from the ambient clock is
 * one where neither answer can be distinguished from the other. Every row below
 * runs identically on a laptop in Istanbul and on a runner in UTC.
 */
describe("the skew gate asks the zone, not today's offset", () => {
  test.each([
    // Zero every January and non-zero every July. A gate that read the clock at
    // module load would call these UTC for any process started in winter, and
    // stay silent through the summer, which is when the skew is real.
    ["Europe/London", true],
    ["Europe/Lisbon", true],
    ["Europe/Dublin", true],
    // Never anywhere near UTC, in either hemisphere's summer.
    ["America/New_York", true],
    ["Australia/Sydney", true],
    // Genuinely fixed at zero: these are the only ones that may skip the check.
    ["Africa/Accra", false],
    ["Atlantic/Reykjavik", false],
    ["UTC", false],
  ])("%s could skew: %s", (zone, expected) => {
    expect(clockCouldSkew(zone as string)).toBe(expected);
  });

  /**
   * The distinction the whole predicate exists for, stated as one assertion:
   * London and Accra are indistinguishable on New Year's Day and must not be
   * indistinguishable to the gate.
   */
  test("London and Accra are both zero in January and are told apart", () => {
    expect(clockCouldSkew("Europe/London")).not.toBe(clockCouldSkew("Africa/Accra"));
  });

  /**
   * The call site passes no zone and gets the clock. Asserting a literal here
   * would pin the suite to the runner's `TZ`; asserting agreement pins the
   * thing that has to be true on any machine.
   */
  test("with no zone it answers for this process's own zone", () => {
    expect(clockCouldSkew()).toBe(
      clockCouldSkew(Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
  });
});

/**
 * The gate and the latch, which used to live inline in `execute` where no test
 * could reach them: inverting the gate or deleting the latch left the suite
 * green, because reaching that code needs a database and CI's one database runs
 * under `TZ=UTC` — the configuration where neither branch can warn.
 */
describe("the warning is said once, and only while it is possible", () => {
  /** Records every read so "never asked the clock" is assertable, not implied. */
  const clock = (...offsets: number[]) => {
    const reads: number[] = [];
    const read = () => {
      reads.push(offsets[Math.min(reads.length, offsets.length - 1)]!);
      return reads[reads.length - 1]!;
    };
    return { read, reads };
  };

  test("a fixed-UTC process never enters the check at all", () => {
    const { read, reads } = clock(NEW_YORK);
    const warn = createProtocolSkewWarner(false, read);

    expect(warn("postgres", withDates, SKEWING_READ, [])).toBeNull();
    // Not merely silent — silent *without paying for it*, which is the whole
    // point of hoisting the gate.
    expect(reads).toEqual([]);
  });

  test("a skewing process says it once and then goes quiet", () => {
    const { read, reads } = clock(NEW_YORK);
    const warn = createProtocolSkewWarner(true, read);

    expect(warn("postgres", withDates, SKEWING_READ, [])).toContain("TZ=UTC");
    expect(warn("postgres", withDates, SKEWING_READ, [])).toBeNull();
    expect(warn("postgres", withDates, SKEWING_READ, [])).toBeNull();
    // One read, because the latch closed on the first.
    expect(reads).toEqual([NEW_YORK]);
  });

  /**
   * The latch closes on a *firing*, not on an asking. A process's first
   * statement is rarely the parameterless read, and a query that could not have
   * shown the skew is no evidence that none will.
   */
  test("a query that cannot skew does not spend the warning", () => {
    const warn = createProtocolSkewWarner(true, () => NEW_YORK);

    expect(
      warn("postgres", withDates, `select "createdAt" from "User" where "id" = $1`, [1]),
    ).toBeNull();
    expect(warn("postgres", withDates, SKEWING_READ, [])).toContain("TZ=UTC");
  });

  /**
   * The other half of the London case, at the call site: the gate is open all
   * year, so the offset has to be read when the query runs. A process that
   * captured its winter `0` would clear the gate and then be silenced by
   * `protocolSkewWarning`'s own `offsetMinutes === 0` test for the whole of BST.
   */
  test("London is silent in winter and warns once the clocks go forward", () => {
    const { read } = clock(0, -60);
    const warn = createProtocolSkewWarner(clockCouldSkew("Europe/London"), read);

    expect(warn("postgres", withDates, SKEWING_READ, [])).toBeNull();
    expect(warn("postgres", withDates, SKEWING_READ, [])).toContain("TZ=UTC");
  });
});
