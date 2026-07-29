import { beforeEach, describe, expect, test } from "vitest";

import { READ_ARGS } from "./compile/read";
import { WRITE_ARGS } from "./compile/write";
import { SqliteDialect } from "./dialect/sqlite";
import { account, organization, user } from "./fixtures";
import { clearPlanCache, getOrCompile, planKey, type Operation } from "./plan";
import * as registry from "./registry";

/**
 * A rule, rather than another row.
 *
 * Three separate changes have now shipped the same bug: an argument whose
 * *value* reaches the SQL text, left out of `LITERAL_KEYS`, so two calls that
 * compile differently share one cache entry and the second caller runs the
 * first one's statement.
 *
 *   - `aggregate`'s `_count` / `_sum` / … — `{ email: true }` against
 *     `{ email: false }` counted a column the caller switched off.
 *   - `createMany`'s `skipDuplicates` — `true` against `false` decided whether
 *     conflicts raise.
 *   - `findMany`'s `omit` — `{ password: true }` against `{ password: false }`,
 *     where the *permissive* call warms the cache and the one asking to hide
 *     the column gets it back.
 *
 * Each was caught by someone thinking to look. That is not a mechanism, so this
 * file is the mechanism: it walks **every argument every operation accepts**,
 * compiles two calls that differ only in that argument's literal content, and
 * asserts the plan key separates them whenever the SQL does.
 *
 * The property is exactly the cache's contract, stated once:
 *
 *     two argument shapes that compile to different statements
 *     must not share a plan key.
 *
 * Its value is in the *coverage* check below rather than in any single case: an
 * argument added to `READ_ARGS` or `WRITE_ARGS` without a probe here fails this
 * suite, so the fourth instance of the bug is a failing test at the time it is
 * written instead of a review comment afterwards.
 */

const sqlite = new SqliteDialect();

beforeEach(() => {
  clearPlanCache();
  registry.clearRegistry();
  registry.register("User", class { static $schema = user });
  registry.register("Account", class { static $schema = account });
  registry.register("Organization", class { static $schema = organization });
});

/**
 * Two argument trees per key that differ **only** in that key's literal
 * content — never in a bound value, which is what the cache is allowed to
 * share. Where an argument cannot change the statement at all, the pair is
 * identical and the assertion below tolerates it.
 */
const PROBES: Record<string, [unknown, unknown]> = {
  // Values, so these legitimately share a plan.
  where: [{ where: { email: "a" } }, { where: { email: "b" } }],
  data: [{ data: { email: "a" } }, { data: { email: "b" } }],
  take: [{ take: 1 }, { take: 2 }],
  skip: [{ skip: 1 }, { skip: 2 }],

  // Structure: each of these changes the statement.
  orderBy: [{ orderBy: { id: "asc" } }, { orderBy: { id: "desc" } }],
  select: [{ select: { id: true } }, { select: { email: true } }],
  omit: [{ omit: { password: true } }, { omit: { password: false } }],
  include: [{ include: { accounts: true } }, { include: { organization: true } }],
  skipDuplicates: [
    { data: [{ email: "a" }], skipDuplicates: true },
    { data: [{ email: "a" }], skipDuplicates: false },
  ],
  create: [{ create: { email: "a" } }, { create: { email: "a", name: "n" } }],
  update: [{ update: { name: "a" } }, { update: { name: "a", locale: "l" } }],
  cursor: [{ cursor: { id: 1 } }, { cursor: { id: 2 } }],
  distinct: [{ distinct: ["email"] }, { distinct: ["name"] }],
};

/** What each operation needs beside the argument under test to compile at all. */
const BASE: Record<string, Record<string, unknown>> = {
  findUnique: { where: { id: 1 } },
  findUniqueOrThrow: { where: { id: 1 } },
  create: { data: { email: "base" } },
  createMany: { data: [{ email: "base" }] },
  update: { where: { id: 1 }, data: { name: "base" } },
  updateMany: { where: { id: 1 }, data: { name: "base" } },
  delete: { where: { id: 1 } },
  deleteMany: { where: { id: 1 } },
  upsert: {
    where: { id: 1 },
    create: { email: "base" },
    update: { name: "base" },
  },
};

const OPERATIONS: [string, Set<string>][] = [
  ...Object.entries(READ_ARGS),
  ...Object.entries(WRITE_ARGS),
];

describe("the plan key separates every argument that changes the statement", () => {
  /**
   * The guard that makes this a rule: an argument the compiler accepts and this
   * file does not probe is a hole exactly the size of the last three bugs.
   */
  test("every accepted argument has a probe", () => {
    const missing: string[] = [];
    for (const [operation, allowed] of OPERATIONS) {
      for (const key of allowed) {
        if (!(key in PROBES)) missing.push(`${operation}.${key}`);
      }
    }

    expect(
      missing,
      `add a two-value probe to PROBES for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test.each(OPERATIONS)("%s", (operation, allowed) => {
    for (const key of allowed) {
      const [a, b] = PROBES[key];
      const base = BASE[operation] ?? {};

      // The probe replaces the base's own value for that key, so `data` and
      // `where` are tested rather than shadowed.
      const argsA = { ...base, ...(a as object) };
      const argsB = { ...base, ...(b as object) };

      let textA: string;
      let textB: string;
      try {
        // **Compiled in isolation, and this is the whole trick.** Sharing the
        // cache here would make the test agree with the bug: when the two keys
        // collide, the second call is a cache *hit*, so both plans are the same
        // object, the texts match, and the check below skips the very case it
        // exists to catch. Clearing between them forces two real compiles, so
        // "the statements differ" is a fact about the compiler rather than
        // about what the cache happened to return.
        clearPlanCache();
        textA = getOrCompile(user, operation as Operation, argsA, sqlite).text;
        clearPlanCache();
        textB = getOrCompile(user, operation as Operation, argsB, sqlite).text;
      } catch {
        // The argument is refused for this operation — `distinct` on a write,
        // say. A refusal cannot mis-cache.
        continue;
      }

      if (textA === textB) continue;

      expect(
        planKey(sqlite, "User", operation as Operation, argsA),
        `${operation}.${key} compiles to two different statements but shares ` +
          `one plan key — add it to LITERAL_KEYS in plan.ts`,
      ).not.toBe(planKey(sqlite, "User", operation as Operation, argsB));
    }
  });

  /**
   * The converse, so the rule cannot be satisfied by making everything
   * structural: an argument that only carries *values* must still share a plan,
   * or the cache stops being a cache.
   */
  test("arguments that only carry values still share one plan", () => {
    for (const [a, b] of [PROBES.where, PROBES.take, PROBES.skip]) {
      const argsA = { ...(a as object) };
      const argsB = { ...(b as object) };
      expect(
        getOrCompile(user, "findMany", argsA, sqlite).text,
        JSON.stringify(argsA),
      ).toBe(getOrCompile(user, "findMany", argsB, sqlite).text);
      expect(planKey(sqlite, "User", "findMany", argsA)).toBe(
        planKey(sqlite, "User", "findMany", argsB),
      );
    }
  });
});
