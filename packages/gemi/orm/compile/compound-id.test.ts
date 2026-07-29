import { describe, expect, test } from "vitest";

import { SqliteDialect } from "../dialect/sqlite";
import { UnsupportedQueryError } from "../errors";
import { account, membership } from "../fixtures";
import { compileRead } from "./read";
import { compileWrite } from "./write";

/**
 * A compound `@@id`, which was unreachable by key at all (#80).
 *
 * Two places disagreed about what counts as a unique key: `matchUniqueKey` asks
 * `uniqueKeys()`, which includes the primary key, so the operation *compiled* —
 * and then `compileCompoundKey` searched `schema.uniques` alone, found nothing,
 * and the caller reported an unknown field. Both spellings failed and each
 * error pointed at the other:
 *
 *     where: { organizationId_userId: { … } }  ->  not a field on Membership
 *     where: { organizationId: 1, userId: 2 }  ->  needs a unique field
 *
 * It hid because the template's only compound key is `SocialAccount`'s
 * `@@unique([username, provider])` — a different path, and one that was
 * covered.
 */

const sqlite = new SqliteDialect();
const key = { organizationId_userId: { organizationId: 1, userId: 2 } };

describe("a compound @@id is a usable key", () => {
  test("findUnique compiles both members into the predicate", () => {
    const plan = compileRead(membership, "findUnique", { where: key }, sqlite);

    expect(plan.text).toContain(`"organizationId" = ?`);
    expect(plan.text).toContain(`"userId" = ?`);
    // Both members bound, in the key's declared order. The trailing 1 is
    // `findUnique`'s own `limit 1`, which every single-row read carries.
    expect(plan.bind({ where: key })).toEqual([1, 2, 1]);
  });

  test.each([
    ["update", { where: key, data: { role: 1 } }],
    ["delete", { where: key }],
    [
      "upsert",
      {
        where: key,
        create: { organizationId: 1, userId: 2 },
        update: { role: 1 },
      },
    ],
  ])("%s takes it too", (op, args) => {
    expect(() =>
      compileWrite(membership, op as never, args, sqlite),
    ).not.toThrow();
  });

  /**
   * `upsert` is the one that needs the key's *identity* rather than a yes: it
   * compiles into an `on conflict (…)` target, so naming the wrong columns
   * there would resolve conflicts against the wrong constraint.
   */
  test("upsert targets the compound key in its on-conflict clause", () => {
    const plan = compileWrite(
      membership,
      "upsert",
      {
        where: key,
        create: { organizationId: 1, userId: 2 },
        update: { role: 1 },
      },
      sqlite,
    );

    expect(plan.text).toContain(`on conflict ("organizationId", "userId")`);
  });

  /**
   * Still refused, because a composite key is only unique as a whole — a
   * partial one would quietly become a non-unique lookup, which is the failure
   * `findUnique` exists to prevent.
   */
  test("a partial compound key is refused", () => {
    expect(() =>
      compileRead(
        membership,
        "findUnique",
        { where: { organizationId_userId: { organizationId: 1 } } },
        sqlite,
      ),
    ).toThrow(/Missing 'userId'/);
  });

  test("naming the members separately is still not a unique lookup", () => {
    // Prisma does not accept this either: the compound form is the spelling.
    expect(() =>
      compileRead(
        membership,
        "findUnique",
        { where: { organizationId: 1, userId: 2 } },
        sqlite,
      ),
    ).toThrow(UnsupportedQueryError);
  });

  /**
   * The neighbouring path, so the fix cannot have been "accept any group of
   * fields joined by an underscore": a compound `@@unique` still works, and a
   * name that matches no declared key is still an unknown field.
   */
  test("a compound @@unique is unaffected, and a made-up name still fails", () => {
    expect(() =>
      compileRead(
        membership,
        "findUnique",
        { where: { organizationId_role: { organizationId: 1, role: 2 } } },
        sqlite,
      ),
    ).toThrow(/not a field on model Membership/);

    // `account` has a single-field `@unique` on publicId and no compound one.
    expect(() =>
      compileRead(account, "findUnique", { where: { publicId: "p" } }, sqlite),
    ).not.toThrow();
  });
});
