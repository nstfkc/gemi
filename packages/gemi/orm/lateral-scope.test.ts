import { beforeEach, describe, expect, test } from "vitest";

import { lateralStrategy } from "./compile/lateral";
import { compileRead } from "./compile/read";
import { PostgresDialect } from "./dialect/postgres";
import { account, organization, user } from "./fixtures";
import { applyNestedPolicies, type ModelPolicy } from "./policy";
import * as registry from "./registry";

const postgres = new PostgresDialect();

/**
 * **Where a nested scope lands in the emitted SQL under the lateral strategy.**
 *
 * `docs/orm.md` lists six paths that carry a child's policies and gives the
 * folded relation its own row — "the scope lands *inside* the subquery" —
 * because it is a distinct mechanism rather than another instance of the same
 * one. `policy.test.ts` says why: a batched nested read gets its policies by
 * recursing through the child's own `$exec`, and "a lateral join has no such
 * call, so the child's policies would never be consulted and the subquery would
 * be unscoped — a cross-tenant read through a new door."
 *
 * Two things were tested, and one was not.
 *
 * `applyNestedPolicies` is unit-tested to produce a scoped *argument* tree, and
 * the template's policy suite runs against Postgres, where lateral is the
 * default — so an outright dropped scope fails there already, as wrong rows.
 *
 * What nothing asserted is the **placement**. A predicate that moved from the
 * subquery to the outer `where` still filters, so the failure is not "no
 * filtering" — it is filtering the *parents* by a child's column instead of the
 * children. That reads downstream as a row-count difference in a database test
 * rather than as the shape change it is, and this is the cheaper place to catch
 * it.
 *
 * Compile-level and dialect-only: no database, because the question is what SQL
 * comes out.
 */
describe("a nested scope under the lateral strategy", () => {
  beforeEach(() => {
    registry.clearRegistry();
    for (const [name, schema] of [
      ["User", user],
      ["Account", account],
      ["Organization", organization],
    ] as const) {
      registry.register(name, class { static $schema = schema });
    }
  });

  const tenant: ModelPolicy = {
    scope: () => ({ organizationId: 7 }),
    onCreate: (_context, data) => data,
  };

  /** The arg tree as `$exec` hands it to the compiler: policies already applied. */
  const scoped = (args: unknown) =>
    applyNestedPolicies(
      user as never,
      args as never,
      { id: 1 },
      false,
      ((model: string) =>
        model === "Account"
          ? { policies: [tenant], schema: { name: "Account", relations: {} } }
          : undefined) as never,
    );

  const compiled = (args: unknown) =>
    compileRead(user, "findMany", scoped(args) as never, postgres, lateralStrategy).text;

  /** The subquery body, from `left join lateral (` to its matching paren. */
  const subquery = (sql: string) => {
    const open = sql.toLowerCase().indexOf("left join lateral (");
    expect(open, "no lateral join was emitted").toBeGreaterThan(-1);

    let depth = 0;
    for (let i = sql.indexOf("(", open); i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")" && --depth === 0) {
        return sql.slice(open, i + 1);
      }
    }
    throw new Error("unbalanced lateral subquery");
  };

  test("the policy rewrote the argument tree, or this asserts nothing", () => {
    expect(scoped({ include: { accounts: true } })).toEqual({
      include: { accounts: { where: { organizationId: 7 } } },
    });
  });

  test("the scope is inside the subquery", () => {
    const sql = compiled({ include: { accounts: true } });
    const inner = subquery(sql);

    expect(inner).toContain(`"Account"."organizationId" =`);
    // ...alongside the correlation, not instead of it.
    expect(inner).toContain(`"Account"."userId" = "User"."id"`);
  });

  test("...and not in the outer statement", () => {
    const sql = compiled({ include: { accounts: true } });
    const outer = sql.replace(subquery(sql), "");

    expect(outer).not.toContain(`"Account"."organizationId"`);
    // The outer statement carries no `where` at all here: the caller wrote none,
    // and a child's scope is not the parent's business.
    expect(outer.toLowerCase()).not.toContain(" where ");
  });

  /**
   * A caller's own filter on the same relation has to end up in the same place,
   * conjoined rather than replaced — the shape #105 fixed for nested writes,
   * asserted here for the read path under the strategy that folds it.
   */
  test("a caller's filter and the scope are both inside, conjoined", () => {
    const inner = subquery(
      compiled({ include: { accounts: { where: { organizationRole: 1 } } } }),
    );

    expect(inner).toContain(`"Account"."organizationRole" =`);
    expect(inner).toContain(`"Account"."organizationId" =`);
  });

  /**
   * `asSystem` suspends policies for the whole subtree — the first of the two
   * limits the docs name. Asserted here so "the scope is inside" cannot be
   * satisfied by a scope that is always there.
   */
  test("under asSystem there is no scope to place", () => {
    const unscoped = applyNestedPolicies(
      user as never,
      { include: { accounts: true } } as never,
      { id: 1 },
      true,
      ((model: string) =>
        model === "Account"
          ? { policies: [tenant], schema: { name: "Account", relations: {} } }
          : undefined) as never,
    );

    expect(unscoped).toEqual({ include: { accounts: true } });

    const inner = subquery(
      compileRead(user, "findMany", unscoped as never, postgres, lateralStrategy).text,
    );
    expect(inner).not.toContain(`"Account"."organizationId" =`);
    expect(inner).toContain(`"Account"."userId" = "User"."id"`);
  });
});
